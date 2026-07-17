import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Drive the real server over stdio and collect every stdout line.
 *
 * This is the regression that matters most: stdout is the JSON-RPC channel, so a
 * single stray log line from a faucet lib breaks the protocol in a way that
 * looks like a hang rather than an error.
 */
function talk(messages, { timeoutMs = 15_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/index.js'], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ stdout, stderr, timedOut: true })
    }, timeoutMs)

    // Give the server a moment to connect its transport before writing.
    setTimeout(() => {
      for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n')
    }, 500)

    // Close once responses have had time to land.
    setTimeout(() => {
      child.stdin.end()
      child.kill('SIGTERM')
    }, timeoutMs - 2000)

    child.on('close', () => {
      clearTimeout(timer)
      resolve({ stdout, stderr, timedOut: false })
    })
  })
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
  },
}
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' }

test('stdout carries only clean JSON-RPC, and tools/list exposes the four tools', async () => {
  const { stdout, stderr } = await talk([
    INIT,
    INITIALIZED,
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ])

  const lines = stdout.split('\n').filter((l) => l.trim())
  assert.ok(lines.length > 0, `server produced no stdout. stderr:\n${stderr}`)

  const parsed = []
  for (const line of lines) {
    let msg
    assert.doesNotThrow(
      () => (msg = JSON.parse(line)),
      `stdout line is not JSON — the protocol stream is corrupted:\n${line}`
    )
    assert.equal(msg.jsonrpc, '2.0', `non-JSON-RPC object on stdout: ${line}`)
    parsed.push(msg)
  }

  const list = parsed.find((m) => m.id === 2)
  assert.ok(list, `no tools/list response. stdout:\n${stdout}\nstderr:\n${stderr}`)
  const names = list.result.tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['mint_activate_bsv21', 'mint_token', 'minter_fund', 'minter_status'])
})

test('every spending tool defaults dryRun to true', async () => {
  const { stdout } = await talk([INIT, INITIALIZED, { jsonrpc: '2.0', id: 2, method: 'tools/list' }])
  const list = stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .find((m) => m.id === 2)

  for (const name of ['minter_fund', 'mint_token', 'mint_activate_bsv21']) {
    const tool = list.result.tools.find((t) => t.name === name)
    assert.ok(tool, `${name} missing`)
    const dryRun = tool.inputSchema.properties.dryRun
    assert.equal(dryRun.default, true, `${name} must default dryRun to true`)
  }
})

/**
 * Listing tools must not import the mint engines: engines/wallet.mjs generates
 * and persists a key as an import side effect, so a mere tools/list would create
 * key material for someone who only wanted to see what this server offers.
 *
 * engines/wallet.mjs logs "[minter] key source: ..." from top-level await, so
 * the absence of that line on stderr is direct proof it was never imported.
 * MINTER_HOME is redirected at a throwaway path as a second guard: if the engines
 * did load, any key would land there and not touch the real one.
 */
test('tools/list does not load the engines (no key material created)', async () => {
  const tmpHome = await mkdtemp(path.join(tmpdir(), 'minter-test-'))
  try {
    const { stdout, stderr } = await talk(
      [INIT, INITIALIZED, { jsonrpc: '2.0', id: 2, method: 'tools/list' }],
      { env: { MINTER_HOME: tmpHome } }
    )
    const list = stdout
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .find((m) => m.id === 2)
    assert.ok(list, 'tools/list should succeed')
    assert.equal(list.result.tools.length, 4)

    assert.ok(
      !/\[minter\] key source/.test(stderr),
      'the engines must not be imported during tools/list'
    )
    assert.deepEqual(
      await readdir(tmpHome),
      [],
      'tools/list must not create any key material'
    )
  } finally {
    await rm(tmpHome, { recursive: true, force: true })
  }
})
