# minter-mcp

**Get BSV test tokens into your wallet in seconds, by asking.**

An MCP server whose only job is to mint tokens into a running
[BSV Desktop](https://github.com/bitcoin-sv/bsv-desktop) wallet. Ask Claude for
"a STAS token" and it funds a throwaway minter from your own wallet, mints, and
registers the result — the token shows up in **Assets within seconds**.

Supports **classic STAS**, **DSTAS**, and **BSV-21**.

Built for the boring-but-real problem: you're testing a token flow and you need a
token *right now*, and hand-rolling a mint means a contract tx, an issue tx, a
funding split, an indexer wait, and — for BSV-21 — a GorillaPool activation dance.

## How it works

```
minter_status   → is the wallet up? is the minter funded?
minter_fund     → your wallet pays the minter   (you approve the prompt in-app)
mint_token      → mint → register → visible in Assets in seconds
```

The **minter** is a separate throwaway key that does the issuing; your wallet
funds it and receives the tokens. Tokens are minted straight to a wallet-owned
receive address, then `register-by-txid` tells the wallet about the mint
immediately.

That last call is the whole trick. Without it you wait for a confirmation and a
WhatsOnChain scan; with it the wallet knows straight away.

**No MessageBox, no peer-to-peer, no overlay round-trip** — it talks to the
wallet's local HTTP API on `127.0.0.1:3321` and nothing else.

## Install

Requires **BSV Desktop running and signed in on mainnet**.

Add to your MCP config (`~/.claude.json`, or a project `.mcp.json`):

```json
{
  "mcpServers": {
    "minter": {
      "command": "npx",
      "args": ["-y", "minter-mcp@latest"]
    }
  }
}
```

Or from a clone:

```bash
git clone https://github.com/MatiasJF/minter-mcp.git
cd minter-mcp && npm install && npm run build
```
```json
{ "mcpServers": { "minter": {
  "command": "node",
  "args": ["/absolute/path/to/minter-mcp/dist/index.js"]
}}}
```

## Use

```
minter_status
minter_fund { satoshis: 50000, dryRun: false }     → approve the prompt in the wallet
mint_token  { protocol: "stas",   dryRun: false }
mint_token  { protocol: "dstas",  dryRun: false }
mint_token  { protocol: "bsv-21", dryRun: false }
```

| Tool | Spends? | What it does |
|---|---|---|
| `minter_status` | no | Funding address, spendable balance, wallet reachable/signed-in/network. Call this first. |
| `minter_fund` | **yours** | Moves satoshis from your wallet to the minter. Raises the wallet's spending prompt. |
| `mint_token` | minter's | Mints one token and registers it into the wallet. |
| `mint_activate_bsv21` | minter's | Funds a BSV-21 token id's GorillaPool fee address so WOC/overlays surface it. |

~50,000 sats covers several mints. A mint costs roughly 250–500 sats.

## Safety

**This spends real money on mainnet. Read this bit.**

- **Every spending tool defaults to `dryRun: true`** and needs an explicit
  `dryRun: false` to broadcast. A dry run does full preflight — balance, wallet
  state, funding sufficiency — and mutates nothing.
- **Spending *your* wallet always goes through the wallet's own
  spending-authorization prompt.** This server calls `/createAction` under a
  plain non-admin origin precisely so that prompt appears. It cannot be bypassed
  from here, by design.
- **No tool ever returns key material.** `minter_status` reports where the key
  came from (`env` / `file` / `generated`), never the key. Everything returned is
  passed through a redactor that strips secret-named fields and WIF-shaped
  strings, and the key module exports no WIF at all.
- **The minter's key is generated locally on first use** at
  `~/.stas-minter/wallet.json` (mode `0600`). **No key ships with this package** —
  everyone gets their own.

**The minter key is throwaway. Anyone with that file can spend its balance. Keep
the balance small.** It is stored outside the package directory on purpose: under
`npx` the package lives in a temp cache that gets wiped, which would orphan the
balance on every run.

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `WALLET_URL` | `http://127.0.0.1:3321` | BSV Desktop apps API |
| `WALLET_ORIGIN` | `http://localhost:8080` | Origin sent to the wallet. Must be non-admin so the spending prompt appears. |
| `MINTER_HOME` | `~/.stas-minter` | Where the minter's key lives |
| `MINTER_WIF` | — | Use an existing minter key instead of the generated file |
| `WOC_BASE` | mainnet WOC | WhatsOnChain base URL |
| `ALLOW_UNCONFIRMED` | `true` | Let a mint spend the funding tx's change without waiting a confirmation |

## Notes and rough edges

- **STAS**: `stas-js` signs at 0.05 sat/b, so a STAS mint can take a while to
  confirm. It is visible and usable in the wallet regardless — registration
  doesn't wait for a confirmation.
- **STAS needs a UTXO pair** (it consumes `utxos[0]` and `utxos[1]` by position),
  which is why `minter_fund` splits into 2 outputs by default.
- **DSTAS** shares the STAS receive-address namespace. **BSV-21 has its own** —
  they are not interchangeable, and a BSV-21 sent to a STAS address is silently
  orphaned. The server handles this for you.
- **BSV-21 activation** (`mint_activate_bsv21`) is only needed for *external*
  discovery (WOC, overlays). The wallet shows the token immediately without it.
- **WhatsOnChain lags a broadcast** by seconds to minutes. `minter_fund` waits
  for the funding to become spendable before returning.

## Development

```bash
npm run build
npm test
```

The suite includes a **stdout purity** check. stdout is the MCP JSON-RPC channel,
but the mint engines log freely — including at import time. `guard.ts` routes
`console.*` to stderr before any engine loads. Break that and the server looks
like it hangs rather than failing, so the test guards it. Another test asserts
that listing tools never imports the engines, since importing them generates a
key.

The mint engines in `engines/` are vendored from the BSV Desktop demo faucet and
deliberately not reimplemented — they encode a lot of hard-won detail (ord
envelope tags, STAS UTXO positioning, WOC indexing-lag defences).

## License

MIT © Matias Jackson
