/**
 * Typed client for BSV Desktop's apps API on :3321.
 *
 * Every route is dispatched on `req.path` alone (the wallet's switch in
 * src/onWalletReady.ts) — the HTTP method is never checked — but we still send
 * the conventional verb so the traffic reads correctly in a proxy log.
 *
 * The wallet rejects any request without a parseable `Origin`/`originator`
 * header (400 "Origin header is required"), so `post` always sends one. The
 * origin also decides *who the wallet thinks is asking*: we deliberately use a
 * plain non-admin origin, which is what makes /createAction raise the
 * spending-authorization modal instead of silently spending. Do not set this to
 * the admin originator.
 */

import { MinterError } from './guard.js'

export const WALLET_URL = process.env.WALLET_URL || 'http://127.0.0.1:3321'
export const WALLET_ORIGIN = process.env.WALLET_ORIGIN || 'http://localhost:8080'

export interface ReceiveAddress {
  address: string
  keyIndex?: number
  ownerFieldHash160?: string
  brc42KeyId?: string
}

export interface RegisterResult {
  txid: string
  registered: number
  outputs?: Array<{ vout: number; matched: boolean; protocol?: string }>
  error?: string
}

export interface CreateActionResult {
  txid?: string
  tx?: number[]
  noSendChange?: string[]
  [k: string]: unknown
}

async function call<T>(path: string, body: unknown = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${WALLET_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: WALLET_ORIGIN },
      body: JSON.stringify(body),
    })
  } catch (e) {
    throw new MinterError(
      `Cannot reach BSV Desktop at ${WALLET_URL} (${(e as Error).message}). ` +
        `Start the wallet and sign in, or set WALLET_URL.`
    )
  }
  const text = await res.text()
  if (!res.ok) {
    throw new MinterError(`${path} -> ${res.status}: ${text.slice(0, 200)}`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    // A couple of BRC-100 routes return bare scalars (e.g. /isAuthenticated).
    return text as unknown as T
  }
}

/** True only if the wallet is up AND a user is signed in. */
export async function isAuthenticated(): Promise<boolean> {
  const r = await call<{ authenticated?: boolean } | boolean>('/isAuthenticated')
  return typeof r === 'boolean' ? r : r?.authenticated === true
}

export async function getNetwork(): Promise<string> {
  const r = await call<{ network?: string }>('/getNetwork')
  return r?.network ?? 'unknown'
}

/**
 * The wallet's own identity key — the tokens' ultimate destination.
 *
 * Prefers `/getPublicKey`, which is standard BRC-100 and present on every build.
 * `/peerToken/identity` is fork-specific and 404s on older/stock wallets, so it
 * is only a fallback. Going through the standard route keeps this minter usable
 * against any BRC-100 wallet.
 */
export async function getIdentityKey(): Promise<string> {
  try {
    const r = await call<{ publicKey?: string }>('/getPublicKey', { identityKey: true })
    if (r?.publicKey) return r.publicKey
  } catch {
    // fall through to the fork-specific route
  }
  const r = await call<{ identityKey?: string }>('/peerToken/identity')
  if (!r?.identityKey) throw new MinterError('Wallet returned no identity key')
  return r.identityKey
}

/**
 * Mint a fresh receive context and return its address.
 *
 * STAS and DSTAS share one BRC-42 namespace, so DSTAS deliberately asks for a
 * /stas/receive-address. BSV-21 has its own namespace and is NOT interchangeable
 * — a BSV-21 sent to a STAS address is silently orphaned.
 */
export async function receiveAddress(
  protocol: 'stas' | 'dstas' | 'bsv-21'
): Promise<ReceiveAddress> {
  const path = protocol === 'bsv-21' ? '/bsv-21/receive-address' : '/stas/receive-address'
  const r = await call<ReceiveAddress>(path)
  if (!r?.address) throw new MinterError(`${path} returned no address`)
  return r
}

/**
 * Tell the wallet about a just-broadcast mint so it appears immediately.
 *
 * This is the whole latency win: without it the token only surfaces after ~1
 * confirmation plus a manual Refresh (a WOC discovery scan). The STAS route
 * dispatches through the protocol registry, so it registers DSTAS mints too.
 */
export async function registerByTxid(
  protocol: 'stas' | 'dstas' | 'bsv-21',
  txid: string
): Promise<RegisterResult> {
  const path = protocol === 'bsv-21' ? '/bsv-21/register-by-txid' : '/stas/register-by-txid'
  return call<RegisterResult>(path, { txid })
}

/**
 * Ask the wallet to build, sign and broadcast a transaction.
 *
 * Body is CreateActionArgs directly (not wrapped) — see onWalletReady.ts:341.
 * Under our non-admin origin this raises the spending-authorization modal, so
 * this call blocks until the human approves. The wallet's HTTP bridge times out
 * at 30s, which is the practical limit on how long they have to click.
 */
export async function createAction(args: {
  description: string
  outputs: Array<{
    lockingScript: string
    satoshis: number
    outputDescription: string
  }>
  options?: Record<string, unknown>
}): Promise<CreateActionResult> {
  return call<CreateActionResult>('/createAction', args)
}
