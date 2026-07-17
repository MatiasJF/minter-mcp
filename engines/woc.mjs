/**
 * WhatsOnChain UTXO + broadcast helpers, shared by every mint protocol.
 *
 * The module-scoped `recentlyUsedOutpoints` Set defends against the WoC
 * indexing lag window: a tx we broadcast moments ago may not yet show
 * up as spent in `/address/{addr}/unspent`, leading the next mint to
 * pick the same UTXO and produce a `txn-mempool-conflict`. The set
 * lives here so all three protocols' minters share it.
 */

import { WOC } from './config.mjs'
import { MINTER_ADDRESS, MINTER_P2PKH_HEX } from './wallet.mjs'

const recentlyUsedOutpoints = new Set()

export function opKey(txid, vout) { return `${txid}:${vout}` }

export function markUsed(outpoints) {
  for (const op of outpoints) recentlyUsedOutpoints.add(op)
}

/**
 * WoC rate-limits hard (429) under a rapid mint chain, and a bare throw there
 * aborts a run that is *mid-mint* — leaving broadcast txs with no record. Back
 * off and retry the transient statuses instead; only a genuine 4xx is fatal.
 */
export async function wocGetJson(path, { retries = 6 } = {}) {
  let delay = 2000
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${WOC}${path}`, { headers: { Accept: 'application/json' } })
    if (res.ok) return res.json()

    const transient = res.status === 429 || res.status >= 500
    if (!transient || attempt >= retries) {
      const body = await res.text().catch(() => '')
      throw new Error(`WoC GET ${path} -> ${res.status}: ${body.slice(0, 120)}`)
    }
    console.log(`[woc] ${res.status} on ${path} — backing off ${delay / 1000}s (attempt ${attempt + 1}/${retries})`)
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(delay * 2, 30_000)
  }
}

/**
 * `/unspent/all` carries `isSpentInMempoolTx` + `status`, letting us
 * distinguish in-flight (mempool-spent), unconfirmed-arriving, and
 * truly-spendable UTXOs. The legacy `/unspent` endpoint conflates
 * them and produces double-spends across rapid mints.
 */
export async function getRichUtxosAt(addressStr) {
  const res = await wocGetJson(`/address/${addressStr}/unspent/all`)
  return Array.isArray(res?.result) ? res.result : []
}

export function isTrulyAvailable(u) {
  // ALLOW_UNCONFIRMED=true lets a controlled, single-process mint chain off the
  // minter's own unconfirmed change (avoids waiting a confirmation between
  // sequential mints). The normal multi-user server leaves this unset so it
  // never picks an unconfirmed UTXO that could vanish and cause a conflict.
  const allowUnconfirmed = process.env.ALLOW_UNCONFIRMED === 'true'
  return (
    !u.isSpentInMempoolTx &&
    (allowUnconfirmed || u.status !== 'unconfirmed') &&
    !recentlyUsedOutpoints.has(opKey(u.tx_hash, u.tx_pos))
  )
}

/**
 * Returns counts + sums for: all / available / mempool-spent / unconfirmed
 * / locally-held (in our tracker but not yet surfaced by WoC). Lets the
 * UI explain *why* the minter might say "0 spendable" without lying.
 */
export async function getBalanceBreakdown(addressStr) {
  try {
    const raw = await getRichUtxosAt(addressStr)
    const buckets = {
      all:          { count: 0, sats: 0 },
      available:    { count: 0, sats: 0 },
      mempoolSpent: { count: 0, sats: 0 },
      unconfirmed:  { count: 0, sats: 0 },
      locallyHeld:  { count: 0, sats: 0 },
    }
    for (const u of raw) {
      const v = u.value || 0
      buckets.all.count += 1
      buckets.all.sats += v
      if (isTrulyAvailable(u)) {
        buckets.available.count += 1
        buckets.available.sats += v
      } else if (u.isSpentInMempoolTx) {
        buckets.mempoolSpent.count += 1
        buckets.mempoolSpent.sats += v
      } else if (u.status === 'unconfirmed') {
        buckets.unconfirmed.count += 1
        buckets.unconfirmed.sats += v
      } else if (recentlyUsedOutpoints.has(opKey(u.tx_hash, u.tx_pos))) {
        buckets.locallyHeld.count += 1
        buckets.locallyHeld.sats += v
      }
    }
    return buckets
  } catch (err) {
    return {
      all:          { count: 0, sats: 0 },
      available:    { count: 0, sats: 0 },
      mempoolSpent: { count: 0, sats: 0 },
      unconfirmed:  { count: 0, sats: 0 },
      locallyHeld:  { count: 0, sats: 0 },
      error: err.message,
    }
  }
}

/**
 * Truly-spendable minter UTXOs, shaped for direct consumption by
 * bsv-js / stas-js / dxs-bsv-token-sdk constructors.
 */
export async function getMinterUtxos() {
  const raw = await getRichUtxosAt(MINTER_ADDRESS)
  const available = raw.filter(isTrulyAvailable)

  if (available.length === 0) {
    const total = raw.length
    const mempoolSpent = raw.filter((u) => u.isSpentInMempoolTx).length
    const unconfirmed = raw.filter((u) => u.status === 'unconfirmed').length
    const locallyHeld = raw.filter((u) =>
      recentlyUsedOutpoints.has(opKey(u.tx_hash, u.tx_pos))
    ).length
    if (total === 0) {
      throw new Error(`Minter has no UTXOs at ${MINTER_ADDRESS} — fund it first.`)
    }
    throw new Error(
      `No confirmed-and-free UTXOs at ${MINTER_ADDRESS}. ` +
      `Total: ${total}, in flight in mempool: ${mempoolSpent}, unconfirmed: ${unconfirmed}, ` +
      `locally held (spent this session, awaiting WoC to catch up): ${locallyHeld}. ` +
      `Wait ~1–10 min for in-flight tx(s) to confirm, or fund the minter again, then retry.`
    )
  }

  return available.map((u) => ({
    txid: u.tx_hash,
    vout: u.tx_pos,
    scriptPubKey: MINTER_P2PKH_HEX,
    satoshis: u.value,
  }))
}

export async function broadcastTx(txHex, label) {
  const res = await fetch(`${WOC}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: txHex }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`WoC broadcast (${label}) ${res.status}: ${text.slice(0, 200)}`)
  }
  const txid = text.trim().replace(/^"|"$/g, '')
  console.log(`[broadcast] ${label} -> ${txid}`)
  return txid
}
