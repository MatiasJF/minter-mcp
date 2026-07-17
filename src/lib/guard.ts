/**
 * Safety rails shared by every tool.
 *
 * Three unrelated hazards live here because all three must be armed before any
 * mint engine is imported:
 *
 *  1. stdout is the MCP JSON-RPC channel. The engines log freely on import and
 *     on every broadcast, and a single stray line corrupts the protocol stream —
 *     the server appears to hang rather than fail loudly.
 *  2. The minter holds a real key, read from disk or generated. `engines/wallet.mjs`
 *     deliberately exports no WIF, but redaction here is the backstop so a key can
 *     never ride out inside an error, a log line, or a nested object.
 *  3. Every mint is an irreversible mainnet broadcast.
 */

/**
 * Point console.* at stderr so the mint engines cannot corrupt the JSON-RPC
 * stream on stdout.
 *
 * MUST be called before importing any engine: `engines/wallet.mjs` logs from
 * top-level await, so the damage would be done at import time, not call time.
 * The libs use console.* exclusively (verified — no direct process.stdout.write),
 * so redirecting these four leaves real stdout to the MCP transport alone.
 */
export function routeLogsToStderr(): void {
  const toStderr =
    (level: string) =>
    (...args: unknown[]): void => {
      const line = args
        .map((a) => (typeof a === 'string' ? a : safeInspect(a)))
        .join(' ')
      process.stderr.write(`[${level}] ${redactText(line)}\n`)
    }

  console.log = toStderr('log')
  console.info = toStderr('info')
  console.warn = toStderr('warn')
  console.debug = toStderr('debug')
  // console.error already goes to stderr, but it must still be redacted.
  const realError = console.error.bind(console)
  console.error = (...args: unknown[]): void => {
    realError(
      ...args.map((a) =>
        typeof a === 'string' ? redactText(a) : redact(a)
      )
    )
  }
}

function safeInspect(value: unknown): string {
  try {
    return JSON.stringify(redact(value))
  } catch {
    return String(value)
  }
}

/** Field names whose values must never leave this process. */
const SECRET_KEY_RE = /wif|mnemonic|seed|passphrase|secret|private.?key|privkey/i

/**
 * Mainnet WIF shape: base58, leading 5 (uncompressed) or K/L (compressed).
 * Testnet WIFs lead with 9 or c. Matched on word boundaries so ordinary prose
 * survives.
 */
const WIF_RE = /\b[5KL9c][1-9A-HJ-NP-Za-km-z]{50,51}\b/g

const REDACTED = '[REDACTED]'

/** Scrub anything WIF-shaped out of a free-text string. */
export function redactText(text: string): string {
  return text.replace(WIF_RE, REDACTED)
}

/**
 * Deep-copy `value`, dropping secret-named fields and WIF-shaped strings.
 *
 * Belt and braces: we redact by field *name* (catches `MINTER_WIF_RAW`-style
 * fields even if the encoding changes) and by *value shape* (catches a WIF that
 * arrives under an innocent name). Everything returned to an MCP client passes
 * through here.
 */
export function redact<T>(value: T): T {
  return redactInner(value, new WeakSet()) as T
}

function redactInner(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value !== 'object') return value

  // A cycle would otherwise recurse forever; the engines' bsv-js objects are graphs.
  if (seen.has(value as object)) return '[Circular]'
  seen.add(value as object)

  if (Array.isArray(value)) return value.map((v) => redactInner(v, seen))

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redactInner(v, seen)
  }
  return out
}

/** Thrown when a caller asks for something we refuse to do. */
export class MinterError extends Error {}

/**
 * Every broadcast is real money on mainnet, so the caller must opt in per call.
 * Tools default `dryRun` to true; this turns "did they mean it?" into one
 * explicit check rather than a convention each flow re-implements.
 */
export function assertLive(dryRun: boolean, action: string): void {
  if (dryRun) {
    throw new MinterError(
      `Refusing to ${action}: dryRun is true. Pass dryRun:false to broadcast for real.`
    )
  }
}
