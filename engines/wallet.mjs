/**
 * Minter key material.
 *
 * A single mainnet WIF is loaded (env → file → auto-generate) and shared across
 * every mint protocol — STAS, DSTAS, and BSV-21 all draw from the same address.
 * The derived constants (P2PKH script hex, PKH hex) are computed once and
 * exported as plain strings so the mint modules don't each redo bsv-js calls at
 * import time.
 *
 * This module deliberately exports NO raw key material. The signing key is
 * exposed only as a bsv-js `PrivateKey` object for the mint modules to sign
 * with; the WIF string itself never leaves this file. Do not add a WIF export
 * "for convenience".
 *
 * Vendored from the BSV Desktop demo faucet (MIT, Matias Jackson).
 */

import fs from 'fs/promises'
import { randomBytes } from 'crypto'
import { createRequire } from 'module'
import { WALLET_FILE, MINTER_HOME } from './config.mjs'

const require = createRequire(import.meta.url)
const bsv = require('bsv')

async function loadOrGenerateMinterKey() {
  if (process.env.MINTER_WIF && process.env.MINTER_WIF.trim()) {
    return { wif: process.env.MINTER_WIF.trim(), source: 'env' }
  }
  try {
    const raw = await fs.readFile(WALLET_FILE, 'utf-8')
    const data = JSON.parse(raw)
    if (data && typeof data.wif === 'string' && data.wif) {
      return { wif: data.wif, source: 'file' }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`[minter] could not read ${WALLET_FILE}: ${e.message}`)
    }
  }

  const keyBytes = Buffer.from(randomBytes(32))
  const wif = new bsv.PrivateKey(bsv.crypto.BN.fromBuffer(keyBytes), 'livenet').toWIF()
  // 0700: the home may not exist yet on a fresh install, and it holds a key.
  await fs.mkdir(MINTER_HOME, { recursive: true, mode: 0o700 })
  await fs.writeFile(
    WALLET_FILE,
    JSON.stringify(
      {
        wif,
        createdAt: new Date().toISOString(),
        note: 'Auto-generated minter key. Anyone with this file can spend its balance. Keep the balance small.',
      },
      null, 2
    ),
    { mode: 0o600 }
  )
  return { wif, source: 'generated' }
}

const { wif: MINTER_WIF, source: KEY_SOURCE } = await loadOrGenerateMinterKey()

/** bsv-js PrivateKey instance — the mint modules sign with this. */
export const minterKey = bsv.PrivateKey.fromWIF(MINTER_WIF)
export const MINTER_ADDRESS = minterKey.toAddress('livenet').toString()
/** Locking script hex for the minter address — used as the input scriptPubKey. */
export const MINTER_P2PKH_HEX = bsv.Script.buildPublicKeyHashOut(MINTER_ADDRESS).toHex()
/** hash160(publicKey) hex — used as the STAS/DSTAS tokenId (issuer field). */
export const MINTER_PKH_HEX = bsv.crypto.Hash.sha256ripemd160(
  minterKey.publicKey.toBuffer()
).toString('hex')
export { KEY_SOURCE }

console.log(`[minter] key source: ${KEY_SOURCE}`)
console.log(`[minter] funding address: ${MINTER_ADDRESS}`)
console.log(`[minter] PKH (tokenId)  : ${MINTER_PKH_HEX}`)
if (KEY_SOURCE === 'generated') {
  // Absolute, not cwd-relative: under npx the cwd is wherever the user happened
  // to be, which makes a relative path meaningless.
  console.log(`[minter] new key persisted to ${WALLET_FILE} (mode 0600). Back it up or keep the balance small.`)
}
