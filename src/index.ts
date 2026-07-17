#!/usr/bin/env node
/**
 * stas-minter-mcp — an MCP server whose only job is to mint tokens into a
 * running BSV Desktop wallet.
 *
 * Flow: minter_status → minter_fund (your wallet pays the minter, you approve
 * the prompt) → mint_token (mints and registers, so it shows in Assets in
 * seconds).
 *
 * Safety model:
 *  - Mainnet is the default. Every broadcasting tool defaults dryRun:true and
 *    requires an explicit dryRun:false.
 *  - Spending the *user's* wallet always goes through the wallet's own
 *    spending-authorization prompt; this server cannot bypass it.
 *  - No tool returns key material. Everything is passed through redact().
 */

// MUST run before any mint engine loads: the engines log on import (from
// top-level await), and stdout is the JSON-RPC channel.
import { routeLogsToStderr } from './lib/guard.js'
routeLogsToStderr()

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { redact, MinterError } from './lib/guard.js'
import * as flows from './lib/flows.js'

const server = new McpServer({ name: 'stas-minter', version: '0.1.0' })

/**
 * One result shape for every tool: JSON text, always redacted, errors reported
 * as content rather than thrown so the model can read and act on them.
 */
async function run(fn: () => Promise<unknown>) {
  try {
    const result = await fn()
    return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result), null, 2) }] }
  } catch (e) {
    const message = e instanceof MinterError ? e.message : `Unexpected error: ${(e as Error).message}`
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify(redact({ error: message }), null, 2) }],
    }
  }
}

const dryRunField = z
  .boolean()
  .default(true)
  .describe(
    'Preview only. Defaults to true. Pass false to actually broadcast — this spends real mainnet satoshis.'
  )

server.tool(
  'minter_status',
  "Check whether the minter can mint: its funding address and spendable balance, and whether BSV Desktop is running, signed in, and on which network. Read-only, spends nothing. Call this first.",
  {},
  async () => run(() => flows.status())
)

server.tool(
  'minter_fund',
  "Top up the minter from the user's own BSV Desktop wallet. The wallet will show a spending-authorization prompt that the user must approve by hand. Waits for the funding to become spendable.",
  {
    satoshis: z
      .number()
      .int()
      .positive()
      .describe('Total satoshis to move from your wallet to the minter. ~50000 covers several mints.'),
    splitInto: z
      .number()
      .int()
      .min(1)
      .max(25)
      .default(2)
      .describe(
        'Number of funding outputs. Default 2 because classic STAS consumes a UTXO pair; 1 forces an extra pre-split tx.'
      ),
    dryRun: dryRunField,
  },
  async ({ satoshis, splitInto, dryRun }) => run(() => flows.fund({ satoshis, splitInto, dryRun }))
)

server.tool(
  'mint_token',
  'Mint one token into the wallet and register it so it appears in Assets within seconds (no Refresh needed). Requires the minter to be funded — check minter_status first.',
  {
    protocol: z
      .enum(['stas', 'dstas', 'bsv-21'])
      .describe('Which token standard to mint.'),
    symbol: z.string().optional().describe('Ticker, e.g. "EXSTAS". Defaults per protocol.'),
    name: z.string().optional().describe('Human-readable token name. Ignored for bsv-21.'),
    amount: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Token supply. For stas/dstas this is also the satoshi value (1 sat = 1 unit); default 1000. For bsv-21 the supply is free of the satoshi value; default 10000.'
      ),
    dryRun: dryRunField,
  },
  async ({ protocol, symbol, name, amount, dryRun }) =>
    run(() => flows.mint({ protocol, symbol, name, amount, dryRun }))
)

server.tool(
  'mint_activate_bsv21',
  "Activate a BSV-21 token id with GorillaPool so WOC and overlay indexers surface it. Only needed for external discovery — the wallet already shows the token without this. Polls for the fee address, then pays it 2000 sats.",
  {
    tokenId: z.string().describe('BSV-21 token id, formatted "<64-hex-txid>_<vout>".'),
    dryRun: dryRunField,
  },
  async ({ tokenId, dryRun }) => run(() => flows.activate({ tokenId, dryRun }))
)

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport())
  console.error('[stas-minter] ready on stdio')
}

main().catch((e) => {
  console.error('[stas-minter] fatal:', e)
  process.exit(1)
})
