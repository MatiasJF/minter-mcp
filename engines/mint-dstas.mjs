/**
 * DSTAS minter — wraps `dxs-bsv-token-sdk`'s BuildDstasIssueTxs.
 *
 * Two-tx flow same as classic STAS: a contract tx that locks supply
 * under a P2PKH owned by the issuer (the minter itself), then an issue
 * tx that spends the contract output to produce a DSTAS-locked UTXO
 * at the recipient's address.
 *
 * Differences from `mint-stas.mjs`:
 *   - SDK signs internally; we hand it a `PrivateKey` object (no
 *     pre-signed unlocking scripts).
 *   - One funding UTXO is enough — the SDK derives the issue funding
 *     from the contract tx's change output.
 *   - tokenId is the issuer's PKH hex (TokenScheme.TokenId field),
 *     same convention the wallet's DSTAS parser uses.
 */

import { createRequire } from 'module'
import pkg from 'dxs-bsv-token-sdk'
import {
  DSTAS_TOKEN_NAME,
  DSTAS_TOKEN_SYMBOL,
  DSTAS_ISSUE_SATOSHIS,
} from './config.mjs'
import {
  minterKey as bsvJsMinterKey,
  MINTER_ADDRESS,
  MINTER_P2PKH_HEX,
  MINTER_PKH_HEX,
} from './wallet.mjs'
import { getMinterUtxos, broadcastTx, markUsed, opKey } from './woc.mjs'

const { dstas, bsv: dxsBsv } = pkg
const { BuildDstasIssueTxs } = dstas
const {
  Address,
  OutPoint,
  PrivateKey: DxsPrivateKey,
  ScriptType,
  TokenScheme,
  fromHex,
} = dxsBsv

const require = createRequire(import.meta.url)
const bsvJs = require('bsv') // for address validation only

// One-time conversion: bsv-js's PrivateKey → raw 32-byte secret → dxs PrivateKey.
const dxsMinterKey = new DxsPrivateKey(new Uint8Array(bsvJsMinterKey.toBuffer()))

// Sanity check: dxs derives its own Address from the secret. It must match
// the bsv-js-derived address that the rest of the minter uses, otherwise
// the SDK's validateFundingAgainstScheme() will reject our scheme.TokenId.
if (dxsMinterKey.Address.Value !== MINTER_ADDRESS) {
  throw new Error(
    `[mint-dstas] dxs-derived address ${dxsMinterKey.Address.Value} != bsv-js-derived ${MINTER_ADDRESS}`
  )
}

export async function mintDstasToAddress(recipientStr, opts = {}) {
  const issueSatoshis = Number.isInteger(opts.satoshis) && opts.satoshis > 0
    ? opts.satoshis
    : DSTAS_ISSUE_SATOSHIS
  const symbol = (typeof opts.symbol === 'string' && opts.symbol.trim())
    ? opts.symbol.trim()
    : DSTAS_TOKEN_SYMBOL
  const name = (typeof opts.name === 'string' && opts.name.trim())
    ? opts.name.trim()
    : DSTAS_TOKEN_NAME

  // 1. Validate the recipient address. The dxs SDK accepts an `Address`
  //    instance directly — use its own decoder for symmetry.
  let recipientAddr
  try {
    recipientAddr = Address.fromBase58(recipientStr)
  } catch (e) {
    throw new Error(`Invalid recipient address: ${e.message}`)
  }
  // Defensive: bsv-js parsing too, so we fail fast on testnet / regtest
  // addresses that base58check would otherwise let through.
  try {
    bsvJs.Address.fromString(recipientStr, 'livenet')
  } catch (e) {
    throw new Error(`Invalid recipient (bsv-js): ${e.message}`)
  }

  // 2. Pull one minter UTXO with enough room for: contract output +
  //    issue tx fee + locked sats. The SDK will derive the issue
  //    funding from the contract tx's change output internally.
  const utxos = await getMinterUtxos()
  const minFund = issueSatoshis + 1500
  const fund = utxos.find((u) => u.satoshis >= minFund) ?? utxos[0]
  if (!fund || fund.satoshis < minFund) {
    throw new Error(
      `No minter UTXO >= ${minFund} sats (largest available: ${fund?.satoshis ?? 0}).`
    )
  }
  markUsed([opKey(fund.txid, fund.vout)])

  console.log(`[mint-dstas] funding: ${fund.txid}:${fund.vout} (${fund.satoshis} sats)`)
  console.log(`[mint-dstas] -> ${recipientAddr.Value} (${issueSatoshis} sats DSTAS, symbol=${symbol})`)

  // 3. Build the dxs OutPoint for the funding UTXO and wire it as the
  //    fundingPayment for the issue flow.
  const fundingOutPoint = new OutPoint(
    fund.txid,
    fund.vout,
    fromHex(fund.scriptPubKey),
    fund.satoshis,
    dxsMinterKey.Address,
    ScriptType.p2pkh
  )
  const fundingPayment = { OutPoint: fundingOutPoint, Owner: dxsMinterKey }

  // 4. TokenScheme — the issuer's PKH IS the tokenId.
  //    satoshisPerToken=1 keeps display semantics simple (1 sat = 1 token unit).
  const scheme = new TokenScheme(name, MINTER_PKH_HEX, symbol, 1)

  // 5. SDK builds + signs both txs.
  const { contractTxHex, issueTxHex } = BuildDstasIssueTxs({
    fundingPayment,
    scheme,
    destinations: [{ Satoshis: issueSatoshis, To: recipientAddr }],
  })

  const contractTxid = await broadcastTx(contractTxHex, 'DSTAS Contract')
  const issueTxid = await broadcastTx(issueTxHex, 'DSTAS Issue')

  // Discovery is the caller's job: the MCP server calls the wallet's
  // /stas/register-by-txid with the issue txid, which registers DSTAS too (the
  // route dispatches through the wallet's protocol registry). An earlier version
  // pushed to a local "stas-relay" here; that relay no longer exists.

  return {
    contractTxid,
    issueTxid,
    recipient: recipientAddr.Value,
    symbol,
    name,
    satoshis: issueSatoshis,
    tokenId: MINTER_PKH_HEX,
  }
}

// Suppress unused-import warning — MINTER_P2PKH_HEX kept in the dependency
// surface for symmetry with mint-stas / mint-bsv21 (and easy future
// access without re-importing from wallet.mjs).
void MINTER_P2PKH_HEX
