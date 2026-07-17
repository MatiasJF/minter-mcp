/**
 * BSV-21 minter — single-tx deploy+mint that locks one inscription
 * output to the recipient's address.
 *
 * On-chain output layout (canonical ord envelope):
 *
 *   OP_FALSE OP_IF
 *     push "ord"
 *     OP_1                         ← content-type tag (canonical minimal push)
 *     push "application/bsv-20"
 *     OP_0                         ← separator
 *     push <BSV-20 JSON bytes>     ← {"p":"bsv-20","op":"deploy+mint",
 *                                       "amt":"<int>","dec":<n>,"sym":"<s>"}
 *   OP_ENDIF
 *   OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG
 *
 * The deploy outpoint *is* the token id — wallets index it as
 * `<txid>_<vout>` and use it as the canonical token identifier.
 *
 * Each call mints a fresh token (new id every time). Matches the
 * "fresh-per-call" pattern of the classic STAS minter — simplest demo
 * shape; no treasury / pre-deployed token to manage.
 *
 * Why OP_1 (0x51) for the content-type tag instead of `01 01`: the
 * 1sat-stack `go-templates/bsv21` decoder requires canonical minimal-push
 * encoding (`OP_1` for value 0x01). Verified empirically 2026-05-28 by
 * comparing this output against indexed tokens like `$NINJAPUNKGIRLS` —
 * they all use OP_1, and our previous `01 01` form caused both JungleBus
 * auto-pickup and direct `/1sat/bsv21/overlay/submit` to skip our outputs.
 */

import { createRequire } from 'module'
import { BSV21_SYMBOL, BSV21_AMT, BSV21_DEC } from './config.mjs'
import {
  minterKey,
  MINTER_ADDRESS,
  MINTER_P2PKH_HEX,
} from './wallet.mjs'
import { getMinterUtxos, broadcastTx, markUsed, opKey } from './woc.mjs'

const require = createRequire(import.meta.url)
const bsv = require('bsv')

const BSV20_CONTENT_TYPE = 'application/bsv-20'

// --- inline pushdata + envelope builders (no SDK dep) -----------------

function utf8ToHex(s) {
  const bytes = new TextEncoder().encode(s)
  let h = ''
  for (const b of bytes) h += b.toString(16).padStart(2, '0')
  return h
}

function encodePushHex(bytesHex) {
  const len = bytesHex.length / 2
  if (len === 0) return '00'
  if (len <= 0x4b) return len.toString(16).padStart(2, '0') + bytesHex
  if (len <= 0xff) return '4c' + len.toString(16).padStart(2, '0') + bytesHex
  if (len <= 0xffff) {
    const lo = len & 0xff
    const hi = (len >> 8) & 0xff
    return '4d' + lo.toString(16).padStart(2, '0') + hi.toString(16).padStart(2, '0') + bytesHex
  }
  const b0 = len & 0xff
  const b1 = (len >> 8) & 0xff
  const b2 = (len >> 16) & 0xff
  const b3 = (len >> 24) & 0xff
  return (
    '4e' +
    b0.toString(16).padStart(2, '0') +
    b1.toString(16).padStart(2, '0') +
    b2.toString(16).padStart(2, '0') +
    b3.toString(16).padStart(2, '0') +
    bytesHex
  )
}

function buildBsv21DeployMintScript({ payload, ownerHash160 }) {
  if (!/^[0-9a-fA-F]{40}$/.test(ownerHash160)) {
    throw new Error(`buildBsv21DeployMintScript: ownerHash160 must be 40 hex chars`)
  }
  // Fixed key order — reproducible bytes; decoders don't depend on order.
  // EVERY value MUST be a JSON string. 1sat-stack's go-templates/bsv21
  // Decode does `json.Unmarshal(content, &map[string]string{})`, which
  // returns an error for any non-string value (including JS numbers).
  // A numeric `dec` silently sinks the entire output at the topic-manager
  // admission step. Verified by tracing the open-source decoder source
  // (github.com/bitcoin-sv/go-templates/template/bsv21).
  const obj = {
    p: 'bsv-20',
    op: 'deploy+mint',
    amt: payload.amt,                // already string from validation
    dec: String(payload.dec),        // coerce number → string per spec
  }
  if (payload.sym !== undefined) obj.sym = payload.sym
  if (payload.icon !== undefined) obj.icon = payload.icon
  const jsonHex = utf8ToHex(JSON.stringify(obj))

  const envelope =
    '00' + '63' +                              // OP_FALSE OP_IF
    encodePushHex(utf8ToHex('ord')) +          // "ord"
    '51' +                                     // OP_1 — content-type tag (canonical)
    encodePushHex(utf8ToHex(BSV20_CONTENT_TYPE)) +
    '00' +                                     // OP_0 separator
    encodePushHex(jsonHex) +
    '68'                                       // OP_ENDIF

  const p2pkh =
    '76' + 'a9' + '14' + ownerHash160.toLowerCase() + '88' + 'ac'

  return envelope + p2pkh
}

// --- mint flow -----------------------------------------------------------

export async function mintBsv21ToAddress(recipientStr, opts = {}) {
  const symbol = (typeof opts.symbol === 'string' && opts.symbol.trim())
    ? opts.symbol.trim()
    : BSV21_SYMBOL
  const rawAmt = (typeof opts.amt === 'string' && opts.amt.trim())
    ? opts.amt.trim()
    : (typeof opts.amt === 'number' && Number.isFinite(opts.amt))
      ? String(Math.floor(opts.amt))
      : BSV21_AMT
  // BSV-21 `amt` is a stringified non-negative bigint per spec — reject
  // anything that isn't, otherwise the wallet's renderer chokes on the
  // basket tag (BigInt("lorem ipsum") throws) and the overlay rejects
  // the inscription as malformed.
  if (!/^\d+$/.test(rawAmt)) {
    throw new Error(`Invalid BSV-21 amt "${rawAmt}" — must be a non-negative integer string`)
  }
  if (rawAmt === '0') {
    throw new Error('Invalid BSV-21 amt — must be > 0')
  }
  const amt = rawAmt
  const dec = Number.isInteger(opts.dec) && opts.dec >= 0 && opts.dec <= 18
    ? opts.dec
    : BSV21_DEC
  const icon = typeof opts.icon === 'string' && opts.icon.trim() ? opts.icon.trim() : undefined

  // 1. Validate recipient + extract hash160.
  let recipientAddr
  let recipientHash160Hex
  try {
    recipientAddr = bsv.Address.fromString(recipientStr, 'livenet')
    recipientHash160Hex = recipientAddr.hashBuffer.toString('hex')
  } catch (e) {
    throw new Error(`Invalid recipient address: ${e.message}`)
  }

  // 2. Pull one minter UTXO with enough room for: 1-sat output + fee +
  //    change. ~200 sats is a generous demo fee floor for a sub-kB tx.
  const utxos = await getMinterUtxos()
  const minFund = 1 + 250 + 50 // inscription + fee headroom + dust margin
  const fund = utxos.find((u) => u.satoshis >= minFund) ?? utxos[0]
  if (!fund || fund.satoshis < minFund) {
    throw new Error(
      `No minter UTXO >= ${minFund} sats (largest available: ${fund?.satoshis ?? 0}).`
    )
  }
  markUsed([opKey(fund.txid, fund.vout)])

  console.log(`[mint-bsv-21] funding: ${fund.txid}:${fund.vout} (${fund.satoshis} sats)`)
  console.log(`[mint-bsv-21] -> ${recipientAddr.toString()} (1 sat, sym=${symbol}, amt=${amt}, dec=${dec})`)

  // 3. Build the inscription locking script.
  const inscriptionScriptHex = buildBsv21DeployMintScript({
    payload: { amt, dec, sym: symbol, icon },
    ownerHash160: recipientHash160Hex,
  })

  // 4. Assemble the spending tx via bsv-js. Output 0 is the inscription
  //    (1 sat to recipient); output 1 is the BSV change back to the
  //    minter. bsv-js's `.change(addr).sign(privKey)` computes the
  //    change automatically; the explicit fee headroom in `minFund`
  //    guarantees we don't underpay.
  const tx = new bsv.Transaction()
    .from({
      txId: fund.txid,
      outputIndex: fund.vout,
      script: fund.scriptPubKey,
      satoshis: fund.satoshis,
    })
    .addOutput(new bsv.Transaction.Output({
      script: bsv.Script.fromHex(inscriptionScriptHex),
      satoshis: 1,
    }))
    .change(MINTER_ADDRESS)
    .sign(minterKey)

  const txHex = tx.toString()
  const txid = await broadcastTx(txHex, 'BSV-21 deploy+mint')

  // Overlay coupling: NOT done from the minter directly.
  //
  // The original code POSTed to `https://api.1sat.app/1sat/tx` expecting
  // that to feed the BSV-21 topic-manager. Verified empirically 2026-05-28
  // that endpoint is a broadcast pass-through (returns
  // `txStatus: ACCEPTED_BY_NETWORK` and relays to miners), NOT a
  // topic-manager ingest. The canonical ingest is
  // `POST /1sat/bsv21/overlay/submit` with `X-Topics: tm_bsv21` and BEEF
  // body — but constructing a valid BEEF (with parent funding tx + its
  // merkle proof) from bsv-js is non-trivial and would require pulling in
  // @bsv/sdk just for this step.
  //
  // Instead we rely on two existing paths:
  //   1. JungleBus auto-pickup. 1sat-stack subscribes to all chain
  //      activity via JungleBus and auto-routes BSV-21 transactions to
  //      the topic-manager. Now that the inscription is canonical
  //      (OP_1 content-type tag), our deploy+mint outputs satisfy the
  //      `go-templates/bsv21` decoder and get admitted.
  //   2. Dex-shell's `/bsv-21/register-by-txid` fast-path. After the
  //      minter returns the txid, the dex-shell pushes it to the wallet's
  //      localhost HTTP route, which fetches + parses + internalizes
  //      the output for immediate UI feedback. No overlay needed.
  //
  // The wallet's `BSV21TransferService` DOES still submit to
  // `/1sat/bsv21/overlay/submit` after a SEND — it has AtomicBEEF from
  // `signAction` so the BEEF construction is free. The minter doesn't,
  // so we defer to JungleBus.

  return {
    txid,
    tokenId: `${txid}_0`,
    recipient: recipientAddr.toString(),
    symbol,
    amt,
    dec,
    icon: icon ?? null,
  }
}

// Keep MINTER_P2PKH_HEX in the dependency surface for parity with
// mint-stas / mint-dstas (server.mjs imports symmetry).
void MINTER_P2PKH_HEX
