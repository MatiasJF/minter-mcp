/**
 * Shared configuration for the minter.
 *
 * Vendored from the BSV Desktop demo minter (MIT, Matias Jackson) so this
 * package stands alone. Reads env once and exposes the constants the mint
 * modules need, keeping all env touchpoints in one place.
 */

import path from 'path'
import os from 'os'

/**
 * Where the minter's key lives.
 *
 * Deliberately NOT inside the package directory. This server is designed to run
 * via `npx`, where the package lives in a temp cache that is wiped between runs
 * — a key stored there would be regenerated on every invocation, orphaning
 * whatever satoshis the previous key still held. A stable per-user home is the
 * only safe choice.
 */
export const MINTER_HOME =
  process.env.MINTER_HOME || path.join(os.homedir(), '.stas-minter')
export const WALLET_FILE = path.join(MINTER_HOME, 'wallet.json')

// --- classic STAS / DSTAS defaults (same on-chain shape) ---
export const TOKEN_NAME = process.env.TOKEN_NAME || 'MinterTok'
export const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL || 'MTK'
export const ISSUE_SATOSHIS = parseInt(process.env.ISSUE_SATOSHIS || '100', 10)
export const MIN_FUND = ISSUE_SATOSHIS + 1500

// --- DSTAS-specific defaults ---
export const DSTAS_TOKEN_NAME = process.env.DSTAS_TOKEN_NAME || 'MinterDstas'
export const DSTAS_TOKEN_SYMBOL = process.env.DSTAS_TOKEN_SYMBOL || 'DTK'
export const DSTAS_ISSUE_SATOSHIS = parseInt(
  process.env.DSTAS_ISSUE_SATOSHIS || String(ISSUE_SATOSHIS), 10
)

// --- BSV-21 defaults ---
export const BSV21_SYMBOL = process.env.BSV21_SYMBOL || 'MB21'
export const BSV21_AMT = process.env.BSV21_AMT || '1000'
export const BSV21_DEC = parseInt(process.env.BSV21_DEC || '0', 10)

// --- broadcast / indexer base ---
export const WOC = (process.env.WOC_BASE || 'https://api.whatsonchain.com/v1/bsv/main').replace(/\/$/, '')
