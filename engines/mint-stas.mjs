/**
 * Classic STAS minter — extracted from the original server.mjs.
 *
 * Behavior unchanged from the pre-refactor version: stas-js's
 * `contract` + `issue` produce a UTXO locked under the classic
 * STAS template, with WhatsOnChain's `stas_*` indexer pattern-
 * matching the schema fields. See the original module docs in
 * server.mjs for the schema-vs-indexer compatibility notes.
 */

import { createRequire } from 'module'
import {
  TOKEN_NAME,
  TOKEN_SYMBOL,
  ISSUE_SATOSHIS,
} from './config.mjs'
import {
  minterKey,
  MINTER_ADDRESS,
  MINTER_P2PKH_HEX,
  MINTER_PKH_HEX,
} from './wallet.mjs'
import {
  getMinterUtxos,
  broadcastTx,
  markUsed,
  opKey,
} from './woc.mjs'

const require = createRequire(import.meta.url)
const bsv = require('bsv')
const { contract, issue } = require('stas-js')

function buildSchema(opts = {}) {
  const name = opts.name || TOKEN_NAME
  const symbol = opts.symbol || TOKEN_SYMBOL
  const totalSupply = opts.satoshis || ISSUE_SATOSHIS
  return {
    name,
    tokenId: MINTER_PKH_HEX,
    protocolId: 'STAS',
    symbol,
    description: opts.description ||
      `Demo token minted by the STAS minter at ${MINTER_ADDRESS}.`,
    image: 'https://www.taal.com/wp-content/themes/taal_v2/img/favicon/favicon-96x96.png',
    totalSupply,
    decimals: 0,
    satsPerToken: 1,
    properties: {
      legal: { terms: 'Demo token; no warranty or implied value.', licenceId: 'demo' },
      issuer: {
        organisation: 'STAS Minter Demo',
        legalForm: 'demo',
        governingLaw: '-',
        mailingAddress: '-',
        issuerCountry: '-',
        email: '-',
      },
      meta: {
        schemaId: 'token1',
        website: 'https://github.com/MatiasJF/stas',
        legal: { terms: 'demo' },
        media: { type: 'image/png' },
      },
    },
  }
}

export async function mintStasToAddress(recipientStr, opts = {}) {
  const issueSatoshis = Number.isInteger(opts.satoshis) && opts.satoshis > 0
    ? opts.satoshis : ISSUE_SATOSHIS
  const minFund = issueSatoshis + 1500
  const symbol = (typeof opts.symbol === 'string' && opts.symbol.trim())
    ? opts.symbol.trim() : TOKEN_SYMBOL
  const name = (typeof opts.name === 'string' && opts.name.trim())
    ? opts.name.trim() : TOKEN_NAME
  const data = (typeof opts.data === 'string' && opts.data.trim())
    ? opts.data.trim() : 'demo'
  const description = (typeof opts.description === 'string' && opts.description.trim())
    ? opts.description.trim() : undefined

  let recipientAddr
  try {
    recipientAddr = bsv.Address.fromString(recipientStr, 'livenet')
  } catch (e) {
    throw new Error(`Invalid recipient address: ${e.message}`)
  }

  // Classic STAS needs two inputs (contract + funding) — split a single
  // big UTXO into two if that's all the minter has.
  let utxos = await getMinterUtxos()
  if (utxos.length < 2) {
    console.log('[mint] only one UTXO at minter; splitting it into two for contract+payment')
    const big = utxos[0]
    if (big.satoshis < minFund) {
      throw new Error(
        `Single UTXO at ${MINTER_ADDRESS} is only ${big.satoshis} sats; need >= ${minFund} to mint`
      )
    }
    const splitTx = new bsv.Transaction()
      .from({
        txId: big.txid,
        outputIndex: big.vout,
        script: big.scriptPubKey,
        satoshis: big.satoshis,
      })
      .to(MINTER_ADDRESS, Math.floor(big.satoshis / 2))
      .to(MINTER_ADDRESS, big.satoshis - Math.floor(big.satoshis / 2) - 250)
      .sign(minterKey)
    const splitTxid = await broadcastTx(splitTx.toString(), 'pre-split (single -> two outputs)')
    markUsed([opKey(big.txid, big.vout)])
    utxos = [
      { txid: splitTxid, vout: 0, scriptPubKey: MINTER_P2PKH_HEX, satoshis: Math.floor(big.satoshis / 2) },
      { txid: splitTxid, vout: 1, scriptPubKey: MINTER_P2PKH_HEX, satoshis: big.satoshis - Math.floor(big.satoshis / 2) - 250 },
    ]
  }

  const contractUtxos = [utxos[0]]
  const fundingUtxos = [utxos[1]]
  markUsed([
    opKey(contractUtxos[0].txid, contractUtxos[0].vout),
    opKey(fundingUtxos[0].txid, fundingUtxos[0].vout),
  ])
  const schema = buildSchema({ symbol, name, satoshis: issueSatoshis, description })

  console.log(`[mint] contract input: ${contractUtxos[0].txid}:${contractUtxos[0].vout} (${contractUtxos[0].satoshis} sats)`)
  console.log(`[mint] funding input : ${fundingUtxos[0].txid}:${fundingUtxos[0].vout} (${fundingUtxos[0].satoshis} sats)`)
  console.log(`[mint] -> ${recipientAddr.toString()} (${issueSatoshis} sats classic STAS, symbol=${symbol})`)

  const contractHex = await contract(
    minterKey,
    contractUtxos,
    fundingUtxos,
    minterKey,
    schema,
    issueSatoshis
  )
  const contractTxid = await broadcastTx(contractHex, 'Contract')

  const contractTx = new bsv.Transaction(contractHex)
  const contractUtxoForIssue = {
    txid: contractTxid,
    vout: 0,
    scriptPubKey: contractTx.outputs[0].script.toHex(),
    satoshis: contractTx.outputs[0].satoshis,
  }
  const paymentUtxoForIssue = {
    txid: contractTxid,
    vout: 1,
    scriptPubKey: contractTx.outputs[1].script.toHex(),
    satoshis: contractTx.outputs[1].satoshis,
  }

  const issueHex = await issue(
    minterKey,
    [{ addr: recipientAddr.toString(), satoshis: issueSatoshis, data }],
    contractUtxoForIssue,
    paymentUtxoForIssue,
    minterKey,
    true,
    symbol
  )
  const issueTxid = await broadcastTx(issueHex, 'Issue')

  return {
    contractTxid,
    issueTxid,
    recipient: recipientAddr.toString(),
    symbol,
    name,
    satoshis: issueSatoshis,
  }
}
