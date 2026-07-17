import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { redact, redactText } from '../dist/lib/guard.js'

// A real mainnet-shaped WIF (compressed, leading L). Not a funded key — this is
// a throwaway string used only to prove the redactor recognises the shape.
const WIF_SHAPED = 'L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ'

test('redact strips secret-named fields', () => {
  const out = redact({
    MINTER_WIF_RAW: WIF_SHAPED,
    wif: WIF_SHAPED,
    mnemonic: 'abandon abandon abandon',
    privateKey: 'deadbeef',
    address: '1SomeAddress',
    satoshis: 42,
  })
  assert.equal(out.MINTER_WIF_RAW, '[REDACTED]')
  assert.equal(out.wif, '[REDACTED]')
  assert.equal(out.mnemonic, '[REDACTED]')
  assert.equal(out.privateKey, '[REDACTED]')
  // Non-secret fields must survive untouched.
  assert.equal(out.address, '1SomeAddress')
  assert.equal(out.satoshis, 42)
})

test('redact strips WIF-shaped values hiding under innocent names', () => {
  const out = redact({ note: `key is ${WIF_SHAPED} keep safe`, nested: { x: [WIF_SHAPED] } })
  assert.ok(!out.note.includes(WIF_SHAPED))
  assert.ok(out.note.includes('[REDACTED]'))
  assert.ok(!JSON.stringify(out.nested).includes(WIF_SHAPED))
})

test('redact survives cycles', () => {
  const a = { name: 'a' }
  a.self = a
  assert.doesNotThrow(() => redact(a))
  assert.equal(redact(a).self, '[Circular]')
})

test('redact leaves ordinary prose alone', () => {
  assert.equal(redactText('funding address 1abc, 1000 sats'), 'funding address 1abc, 1000 sats')
})

// The core hazard: the faucet libs console.log on import, and stdout is the
// JSON-RPC channel. Run in a subprocess because routeLogsToStderr patches
// console globally.
test('routeLogsToStderr keeps console.* off stdout and redacts it', () => {
  const script = `
    import { routeLogsToStderr } from './dist/lib/guard.js'
    routeLogsToStderr()
    console.log('[faucet] key source: generated')
    console.log('wif is ${WIF_SHAPED}')
    console.warn('warned')
    console.error('errored ${WIF_SHAPED}')
  `
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  assert.equal(stdout, '', 'console.* must write nothing to stdout')
})

test('routeLogsToStderr redacts secrets on their way to stderr', () => {
  const script = `
    import { routeLogsToStderr } from './dist/lib/guard.js'
    routeLogsToStderr()
    console.log('wif is ${WIF_SHAPED}')
    console.error('also ${WIF_SHAPED}')
  `
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  })
  assert.equal(res.status, 0, res.stderr)
  assert.ok(res.stderr.includes('[REDACTED]'), 'stderr should show the redaction marker')
  assert.ok(!res.stderr.includes(WIF_SHAPED), 'a WIF must never reach stderr either')
})
