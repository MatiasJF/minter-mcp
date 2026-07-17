/**
 * BSV-21 fee-address activation.
 *
 * A freshly minted BSV-21 stays invisible to WOC until its per-token topic
 * manager is activated by funding GorillaPool's `fundAddress`. That address only
 * exists once GorillaPool has ingested the mint, so poll for it rather than
 * assuming it is there.
 *
 * Extracted from mint-fleet.mjs so the MCP server can reuse it. Logs via
 * console.* only — never process.stdout.write — because callers may be speaking
 * JSON-RPC over stdout.
 */

import { createRequire } from 'module'
import { minterKey, MINTER_ADDRESS } from './wallet.mjs'
import { getMinterUtxos, broadcastTx, markUsed, opKey } from './woc.mjs'

const require = createRequire(import.meta.url)
const bsv = require('bsv')

export const GP = 'https://ordinals.gorillapool.io/api/bsv20/id'
export const ACTIVATION_SATS = 2000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getj = (u) =>
  fetch(u, { headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)

/**
 * Resolve a token id's GorillaPool activation state.
 * Returns `{ included }` if already active, `{ fundAddress }` once ingested,
 * or `{}` if GorillaPool has not seen the mint within the poll window.
 */
export async function pollFundAddress(
  tokenId,
  { attempts = 40, intervalMs = 15_000, label = tokenId } = {}
) {
  let gp = null
  for (let i = 0; i < attempts; i++) {
    gp = await getj(`${GP}/${tokenId}`)
    if (gp?.included) return { included: true }
    if (gp?.fundAddress) return { fundAddress: gp.fundAddress }
    console.log(
      `[activate] ${label}: waiting for GorillaPool to ingest the mint… ${(i + 1) * (intervalMs / 1000)}s`
    )
    await sleep(intervalMs)
  }
  return {}
}

/**
 * Fund a token's GorillaPool fee address so WOC will surface it.
 *
 * `token` needs `{ tokenId, symbol }`; the returned object is `token` plus an
 * `activation` discriminator. Never throws for the expected "not ready yet"
 * cases — a fleet run must not lose already-minted tokens to a pending
 * activation, so those come back as `pending-*` for the caller to retry later.
 */
export async function activateBsv21(token, opts = {}) {
  const { activationSats = ACTIVATION_SATS } = opts
  const label = token.symbol ?? token.tokenId

  const gp = await pollFundAddress(token.tokenId, { ...opts, label })
  if (gp.included) {
    console.log(`[activate] ${label}: already included ✓`)
    return { ...token, activation: 'already-included' }
  }
  if (!gp.fundAddress) {
    console.log(
      `[activate] ${label}: no fundAddress after the poll window — re-run later: node fund-bsv21-activation.mjs <fundAddress> ${activationSats}`
    )
    return { ...token, activation: 'pending-no-fundaddress' }
  }

  const utxos = await getMinterUtxos()
  const fund = utxos
    .sort((a, b) => b.satoshis - a.satoshis)
    .find((u) => u.satoshis >= activationSats + 400)
  if (!fund) {
    console.log(
      `[activate] ${label}: no minter UTXO >= ${activationSats + 400} sats — fund the minter and re-run`
    )
    return { ...token, activation: 'pending-no-utxo', fundAddress: gp.fundAddress }
  }

  const tx = new bsv.Transaction()
    .from({
      txId: fund.txid,
      outputIndex: fund.vout,
      script: fund.scriptPubKey,
      satoshis: fund.satoshis,
    })
    .to(gp.fundAddress, activationSats)
    .change(MINTER_ADDRESS)
    .sign(minterKey)
  const txid = await broadcastTx(tx.toString(), `BSV-21 activation (${label})`)
  markUsed([opKey(fund.txid, fund.vout)])
  console.log(
    `[activate] ${label}: funded ${gp.fundAddress} with ${activationSats} sats — ${txid}`
  )
  return {
    ...token,
    activation: 'funded',
    fundAddress: gp.fundAddress,
    activationTxid: txid,
  }
}
