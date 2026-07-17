/**
 * Orchestration: fund → mint → register.
 *
 * All minting is delegated to the bundled engines in ../engines — vendored from
 * the BSV Desktop demo faucet, battle-tested, and deliberately not reimplemented
 * here. This module only sequences them against the wallet's apps API and
 * enforces the safety rails.
 *
 * Engine modules are imported LAZILY, inside calls. engines/wallet.mjs resolves
 * its key from top-level await and will *generate and persist a new key* as a
 * side effect of being imported, so importing at module scope would mean merely
 * listing tools creates key material.
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MinterError, assertLive } from './guard.js'
import * as wallet from './wallet-api.js'

export type Protocol = 'stas' | 'dstas' | 'bsv-21'

/** The bundled engines, resolved from dist/lib/ → <package root>/engines. */
const ENGINES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../engines'
)

/**
 * Per-mint funding floors. Classic STAS consumes utxos[0]+utxos[1] by position
 * without checking value, so it needs a *pair* — hence roughly double.
 */
const MIN_SATS: Record<Protocol, number> = {
  stas: 1800 * 2,
  dstas: 2600,
  'bsv-21': 600,
}

let enginesPromise: Promise<Engines> | null = null

interface Engines {
  MINTER_ADDRESS: string
  MINTER_P2PKH_HEX: string
  MINTER_PKH_HEX: string
  KEY_SOURCE: string
  getBalanceBreakdown: (addr: string) => Promise<Record<string, { count: number; sats: number }>>
  getMinterUtxos: () => Promise<Array<{ txid: string; vout: number; satoshis: number }>>
  mintStasToAddress: (addr: string, opts: Record<string, unknown>) => Promise<any>
  mintDstasToAddress: (addr: string, opts: Record<string, unknown>) => Promise<any>
  mintBsv21ToAddress: (addr: string, opts: Record<string, unknown>) => Promise<any>
  activateBsv21: (token: { tokenId: string; symbol?: string }, opts?: Record<string, unknown>) => Promise<any>
}

async function load(mod: string): Promise<any> {
  return import(pathToFileURL(path.join(ENGINES_DIR, mod)).href)
}

/**
 * Import the mint engines once.
 *
 * ALLOW_UNCONFIRMED is set before the first import because the engines read it
 * at call time: it lets a mint spend the funding tx's change without waiting for
 * a confirmation, which is the entire point of a fast minter.
 */
async function engines(): Promise<Engines> {
  if (!enginesPromise) {
    enginesPromise = (async () => {
      process.env.ALLOW_UNCONFIRMED = process.env.ALLOW_UNCONFIRMED ?? 'true'
      try {
        const [w, woc, stas, dstas, b21, act] = await Promise.all([
          load('wallet.mjs'),
          load('woc.mjs'),
          load('mint-stas.mjs'),
          load('mint-dstas.mjs'),
          load('mint-bsv21.mjs'),
          load('activate-bsv21.mjs'),
        ])
        return {
          MINTER_ADDRESS: w.MINTER_ADDRESS,
          MINTER_P2PKH_HEX: w.MINTER_P2PKH_HEX,
          MINTER_PKH_HEX: w.MINTER_PKH_HEX,
          KEY_SOURCE: w.KEY_SOURCE,
          getBalanceBreakdown: woc.getBalanceBreakdown,
          getMinterUtxos: woc.getMinterUtxos,
          mintStasToAddress: stas.mintStasToAddress,
          mintDstasToAddress: dstas.mintDstasToAddress,
          mintBsv21ToAddress: b21.mintBsv21ToAddress,
          activateBsv21: act.activateBsv21,
        }
      } catch (e) {
        enginesPromise = null // let a later call retry rather than cache the failure
        throw new MinterError(
          `Could not load the mint engines from ${ENGINES_DIR}: ${(e as Error).message}. ` +
            `If running from a clone, make sure \`npm install\` has been run.`
        )
      }
    })()
  }
  return enginesPromise
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Wallet reachability + identity, degraded rather than thrown so status still reports. */
async function walletInfo(): Promise<Record<string, unknown>> {
  try {
    const authenticated = await wallet.isAuthenticated()
    if (!authenticated) {
      return { reachable: true, authenticated: false, hint: 'Sign in to BSV Desktop.' }
    }
    // The identity key is informational — a wallet that cannot report it can
    // still receive mints — but report *why* rather than dropping it silently.
    const [network, identity] = await Promise.all([
      wallet.getNetwork(),
      wallet
        .getIdentityKey()
        .then((identityKey) => ({ identityKey }))
        .catch((e: Error) => ({ identityKeyError: e.message })),
    ])
    return { reachable: true, authenticated, network, ...identity, url: wallet.WALLET_URL }
  } catch (e) {
    return { reachable: false, error: (e as Error).message, url: wallet.WALLET_URL }
  }
}

/** Read-only. The first call a user should make. */
export async function status(): Promise<Record<string, unknown>> {
  const f = await engines()
  const [balance, w] = await Promise.all([
    f.getBalanceBreakdown(f.MINTER_ADDRESS),
    walletInfo(),
  ])

  const available = (balance.available?.sats as number) ?? 0
  const canMint = (Object.keys(MIN_SATS) as Protocol[]).filter((p) => available >= MIN_SATS[p])
  const ready = w.authenticated === true && canMint.length > 0

  return {
    minter: {
      fundingAddress: f.MINTER_ADDRESS,
      tokenIdPkh: f.MINTER_PKH_HEX,
      // Where the key came from — never the key itself.
      keySource: f.KEY_SOURCE,
      balance,
    },
    wallet: w,
    ready,
    canMint,
    minimums: MIN_SATS,
    ...(ready
      ? {}
      : {
          nextStep:
            w.authenticated !== true
              ? 'Start BSV Desktop and sign in (mainnet).'
              : `Minter has ${available} spendable sats. Run minter_fund to top it up from your wallet.`,
        }),
  }
}

/**
 * Fund the minter from the user's own wallet via /createAction.
 *
 * Splits into `splitInto` outputs (default 2) because classic STAS needs a UTXO
 * pair; a single fat output would force mint-stas to broadcast its own pre-split
 * first and then wait for WOC to surface it.
 *
 * Under our non-admin origin this raises the wallet's spending-authorization
 * modal — the human approves in-app. That prompt is the security boundary; it is
 * deliberate that this cannot be bypassed from here.
 */
export async function fund(args: {
  satoshis: number
  splitInto?: number
  dryRun: boolean
}): Promise<Record<string, unknown>> {
  const { satoshis, splitInto = 2, dryRun } = args
  if (!Number.isInteger(satoshis) || satoshis <= 0) {
    throw new MinterError('satoshis must be a positive integer')
  }
  if (!Number.isInteger(splitInto) || splitInto < 1 || splitInto > 25) {
    throw new MinterError('splitInto must be an integer between 1 and 25')
  }
  const each = Math.floor(satoshis / splitInto)
  if (each < 600) {
    throw new MinterError(
      `Each of the ${splitInto} outputs would be ${each} sats — too small to be useful. ` +
        `Raise satoshis or lower splitInto.`
    )
  }

  const f = await engines()
  const plan = {
    from: 'your BSV Desktop wallet',
    to: f.MINTER_ADDRESS,
    outputs: Array.from({ length: splitInto }, () => each),
    totalSatoshis: each * splitInto,
    note: 'Approve the spending-authorization prompt in the wallet when it appears.',
  }
  if (dryRun) return { dryRun: true, wouldFund: plan }

  const w = await walletInfo()
  if (w.authenticated !== true) {
    throw new MinterError(`Wallet not ready: ${w.hint ?? w.error ?? 'not authenticated'}`)
  }

  const before = await f.getBalanceBreakdown(f.MINTER_ADDRESS)
  const floor = (before.available?.sats as number) ?? 0

  const res = await wallet.createAction({
    description: 'Fund the STAS token minter',
    outputs: plan.outputs.map((sats, i) => ({
      lockingScript: f.MINTER_P2PKH_HEX,
      satoshis: sats,
      outputDescription: `minter funding ${i + 1}/${splitInto}`,
    })),
    options: { randomizeOutputs: false },
  })
  if (!res?.txid) {
    throw new MinterError(
      `createAction returned no txid — the spend was likely declined in the wallet.`
    )
  }

  const available = await waitForFunds(floor)
  return {
    dryRun: false,
    txid: res.txid,
    funded: plan,
    ...(available === null
      ? {
          spendable: false,
          note:
            'Broadcast succeeded, but WOC has not surfaced the outputs yet. ' +
            'The funds are safe — wait a minute and check minter_status before minting.',
        }
      : { spendable: true, availableSats: available }),
  }
}

/**
 * Wait for WOC to surface spendable value beyond `floor`.
 *
 * Funding is useless until the indexer shows it, and WOC lags a broadcast by
 * seconds-to-minutes. Returning early would hand the caller a txid that the very
 * next mint cannot spend. Resolves to the new available total, or null on
 * timeout — the money is not lost, WOC is just behind, so this is reported
 * rather than thrown.
 */
async function waitForFunds(floor: number, timeoutMs = 120_000): Promise<number | null> {
  const f = await engines()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const b = await f.getBalanceBreakdown(f.MINTER_ADDRESS)
    const available = (b.available?.sats as number) ?? 0
    if (available > floor) return available
    if (Date.now() > deadline) return null
    await sleep(5000)
  }
}

/**
 * The main event: mint a token straight into the wallet.
 *
 * Delivery is one seam (`deliver`), so a future MessageBox/peer mode can replace
 * the colocated fast-path without touching the mint step.
 */
export async function mint(args: {
  protocol: Protocol
  symbol?: string
  name?: string
  amount?: number
  dryRun: boolean
}): Promise<Record<string, unknown>> {
  const { protocol, dryRun } = args
  const symbol = args.symbol ?? defaultSymbol(protocol)
  const name = args.name ?? `Example ${protocol.toUpperCase()}`
  const amount = args.amount ?? (protocol === 'bsv-21' ? 10_000 : 1000)
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new MinterError('amount must be a positive integer')
  }

  const f = await engines()
  const balance = await f.getBalanceBreakdown(f.MINTER_ADDRESS)
  const available = (balance.available?.sats as number) ?? 0
  const need = MIN_SATS[protocol]

  if (dryRun) {
    // Deliberately does NOT call /*/receive-address: that route mints a fresh
    // receive context in the wallet, which is a real state change. A dry run
    // must not mutate anything.
    return {
      dryRun: true,
      wouldMint: { protocol, symbol, name, amount },
      funding: { available, needed: need, sufficient: available >= need },
      recipient: 'a fresh receive address from your wallet (not requested during a dry run)',
      ...(available >= need
        ? {}
        : { blocker: `Minter needs ${need} spendable sats, has ${available}. Run minter_fund.` }),
    }
  }
  assertLive(dryRun, `mint a ${protocol} token`)

  const w = await walletInfo()
  if (w.authenticated !== true) {
    throw new MinterError(`Wallet not ready: ${w.hint ?? w.error ?? 'not authenticated'}`)
  }
  if (available < need) {
    throw new MinterError(
      `Minter needs ${need} spendable sats, has ${available}. Run minter_fund first.`
    )
  }

  // STAS and DSTAS share the STAS BRC-42 receive namespace; BSV-21 has its own
  // and is NOT interchangeable (a BSV-21 at a STAS address is orphaned).
  const rx = await wallet.receiveAddress(protocol)

  const minted = await mintFor(f, protocol, rx.address, { symbol, name, amount })

  // The token lives on the issue tx for STAS/DSTAS, and on the single
  // deploy+mint tx for BSV-21. vout 0 in both cases.
  const tokenTxid: string = minted.issueTxid ?? minted.txid
  const outpoint = `${tokenTxid}.0`

  const registration = await deliver(protocol, tokenTxid)

  return {
    dryRun: false,
    protocol,
    symbol,
    amount,
    address: rx.address,
    outpoint,
    txids: minted,
    registration,
    identityKey: w.identityKey,
    ...(registration.registered
      ? { note: 'Should be visible in the wallet Assets page now — no Refresh needed.' }
      : {
          note:
            'Broadcast succeeded but the wallet did not register it immediately. ' +
            'It will still appear after a confirmation + Refresh.',
        }),
    ...(protocol === 'stas'
      ? {
          feeNote:
            'stas-js signs at 0.05 sat/b, so this mint may take a while to confirm. ' +
            'It is already visible and usable in the wallet either way — registration ' +
            'does not wait for a confirmation.',
        }
      : {}),
    ...(protocol === 'bsv-21'
      ? {
          activation:
            'Visible in the wallet already. WOC/overlay discovery additionally ' +
            'needs mint_activate_bsv21 for this token id.',
        }
      : {}),
  }
}

function defaultSymbol(protocol: Protocol): string {
  return { stas: 'EXSTAS', dstas: 'EXDSTAS', 'bsv-21': 'EXBSV21' }[protocol]
}

async function mintFor(
  f: Engines,
  protocol: Protocol,
  address: string,
  o: { symbol: string; name: string; amount: number }
): Promise<any> {
  switch (protocol) {
    case 'stas':
      return f.mintStasToAddress(address, {
        symbol: o.symbol,
        name: o.name,
        satoshis: o.amount,
      })
    case 'dstas':
      return f.mintDstasToAddress(address, {
        symbol: o.symbol,
        name: o.name,
        satoshis: o.amount,
      })
    case 'bsv-21':
      return f.mintBsv21ToAddress(address, {
        symbol: o.symbol,
        amt: String(o.amount),
        dec: 0,
      })
  }
}

/**
 * Make a just-broadcast mint visible immediately.
 *
 * This single call is what turns "wait ~1 confirmation, then hit Refresh" into
 * seconds. Non-fatal: the tokens are already on-chain and WOC discovery will
 * find them eventually, so a registration failure is reported, not thrown.
 *
 * Retried, because the first attempt races the chain. The wallet assembles a
 * chained BEEF by walking the mint's ancestry until every leaf has a merkle
 * proof; moments after broadcast that walk can transiently produce a BEEF the
 * wallet then rejects ("must be valid AtomicBEEF"). Observed live on a BSV-21
 * mint whose funding ancestry was still settling: attempt 1 failed, a later
 * attempt succeeded with no other change. Reporting failure on one attempt made
 * a working mint look broken.
 */
async function deliver(
  protocol: Protocol,
  txid: string,
  attempts = 4
): Promise<Record<string, unknown>> {
  const tried: string[] = []
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(3000 * i) // 3s, 6s, 9s — the race settles in seconds
    try {
      const r = await wallet.registerByTxid(protocol, txid)
      const count = r.registered ?? 0
      if (count > 0) {
        // Spread first: `r.registered` is a count, the caller wants a boolean.
        return { ...r, registeredCount: count, registered: true, attempts: i + 1 }
      }
      tried.push(
        `attempt ${i + 1}: ${r.error ?? r.outputs?.find((o) => o.matched)?.reason ?? 'registered 0 outputs'}`
      )
    } catch (e) {
      tried.push(`attempt ${i + 1}: ${(e as Error).message}`)
    }
  }
  return { registered: false, attempts, failures: tried }
}

/**
 * Fund a BSV-21 token id's GorillaPool fee address.
 *
 * Only needed for WOC/overlay discovery — the wallet itself already shows the
 * token via register-by-txid.
 */
export async function activate(args: {
  tokenId: string
  dryRun: boolean
}): Promise<Record<string, unknown>> {
  const { tokenId, dryRun } = args
  if (!/^[0-9a-f]{64}_\d+$/i.test(tokenId)) {
    throw new MinterError(`tokenId must look like "<64-hex-txid>_<vout>", got "${tokenId}"`)
  }
  if (dryRun) {
    return {
      dryRun: true,
      wouldActivate: tokenId,
      note: 'Would poll GorillaPool for the fee address, then pay it 2000 sats.',
    }
  }
  const f = await engines()
  const result = await f.activateBsv21({ tokenId })
  return { dryRun: false, ...result }
}
