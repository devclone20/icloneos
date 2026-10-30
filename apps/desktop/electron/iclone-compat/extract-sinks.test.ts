// V3-0 (UT1 F1/N2): the extractor's method recall grows from the gateway seeds. A function found by its shape alone
// (`method`, `params`) — and every wrapper of it — may only yield runtime-shaped names, so another protocol's JSON-RPC
// client never puts `eth_call` into the lock; extract-allow.json `sinks` excludes such a client by name even for a
// dotted name, and an exclusion that matches nothing fails the run. Runs the real extract.mjs on a small fixture app.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { RUNTIME_PIN } from '../runtime-pin.generated'

import { RUNTIME_LOCK } from './lock.generated'

vi.mock('electron', () => ({
  app: { getAppPath: () => '', getPath: () => '', once: () => undefined },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  ipcMain: { handle: () => undefined },
  Notification: { isSupported: () => false }
}))

const DESKTOP = path.resolve(__dirname, '..', '..')
const EXTRACT = path.resolve(DESKTOP, '..', '..', 'iclone', 'contract', 'extract.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-extract-'))
const app = path.join(tmp, 'app')

const FILES: Record<string, string> = {
  'package.json': '{ "name": "fixture", "private": true }\n',
  'tsconfig.json': JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true },
    include: ['src']
  }),
  'tsconfig.electron.json': JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true },
    include: ['electron']
  }),
  // The seed: the type behind `$gateway.get()`.
  'src/store/gateway.ts': `export interface Gateway {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
}
export const $gateway = { get(): Gateway { return null as unknown as Gateway } }
`,
  // Seeded: a direct call, and an RPC-shaped wrapper of the seed called with the one bare runtime name (ping).
  'src/app/use.ts': `import { $gateway } from '../store/gateway'
export async function viaWrapper() {
  await call('ping', {})
  await call('config.get', {})
}
export async function call(method: string, params: Record<string, unknown>) {
  return $gateway.get().request(method, params)
}
export async function direct() {
  await $gateway.get().request('session.list', {})
}
`,
  // Order: a wrapper whose helper is declared LATER in the file (critic r1 C1) — provenance is judged after the
  // fixpoint, so outer stays seeded; a bare served name and a bare name the spec does not know both reach the lock.
  'src/app/late.ts': `import { $gateway } from '../store/gateway'
export async function outer(method: string, params: Record<string, unknown>) {
  return late(method, params)
}
export async function useOuter() {
  await outer('ping', {})
  await outer('bare_late_name', {})
}
async function late(method: string, params: Record<string, unknown>) {
  return $gateway.get().request(method, params)
}
`,
  // Another protocol: a raw (method, params) JSON-RPC client over fetch and two wrappers, like the ownership proof.
  'electron/chain.ts': `async function raw(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return res.json()
}
async function all(method: string, params: unknown[]) {
  return [await raw('https://rpc.example', method, params)]
}
export async function first(method: string, params: unknown[]) {
  return raw('https://rpc.example', method, params)
}
export async function read() {
  await all('eth_call', [])
  await first('eth_getLogs', [])
  await all('net.version', [])
}
`,
  // K94: another protocol's discriminated union (AP2 mandate constraints) switched on .type: an event POSITION by
  // shape, never a gateway event. And one real provider event heard on the gateway, which nothing may excuse.
  'electron/constraints.ts': `type Constraint = { type: 'payment.budget'; amount: string } | { type: 'payment.reference'; value: string }
export function check(c: Constraint): string {
  switch (c.type) {
    case 'payment.budget':
      return c.amount
    case 'payment.reference':
      return c.value
  }
}
export const isBudget = (c: { type: string }) => c.type === 'payment.budget'
export function listen(gateway: { on(name: string, fn: () => void): void }) {
  gateway.on('message.delta', () => undefined)
}
`
}

function extract(name: string, allow: unknown) {
  const out = path.join(tmp, name)
  const allowFile = path.join(tmp, `${name}.allow.json`)
  fs.writeFileSync(allowFile, JSON.stringify(allow))

  const r = spawnSync(
    process.execPath,
    [EXTRACT, '--app', app, '--out', out, '--cache', path.join(tmp, `${name}.cache`), '--allow', allowFile],
    { encoding: 'utf8' }
  )

  const lock =
    r.status === 0 || fs.existsSync(path.join(out, 'runtime.lock.json'))
      ? (JSON.parse(fs.readFileSync(path.join(out, 'runtime.lock.json'), 'utf8')) as {
          methods: Record<string, unknown>
          events: Record<string, unknown>
        })
      : null

  return {
    status: r.status,
    stderr: r.stderr,
    methods: Object.keys(lock?.methods ?? {}).sort(),
    events: Object.keys(lock?.events ?? {}).sort()
  }
}

const CHAIN = (fn: string) => ({ file: 'electron/chain.ts', fn, reason: 'fixture chain client' })

beforeAll(() => {
  for (const [rel, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true })
    fs.writeFileSync(path.join(app, rel), text)
  }

  // typescript and prettier come from the app's own node_modules, as for the real app.
  const modules = [path.join(DESKTOP, 'node_modules'), path.resolve(DESKTOP, '..', '..', 'node_modules')].find(d =>
    fs.existsSync(path.join(d, 'typescript', 'package.json'))
  )

  fs.symlinkSync(modules!, path.join(app, 'node_modules'), 'dir')
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('contract extractor: sink provenance (V3-0)', () => {
  it('a shape-only JSON-RPC client never puts its bare names in the lock; seeded calls keep theirs (ping)', () => {
    const r = extract('provenance', {})
    expect(r.status).toBe(0)
    expect(r.methods.filter(m => m.startsWith('eth_'))).toEqual([])
    // No over-correction: the bare runtime name through a seeded wrapper stays.
    expect(r.methods).toEqual(expect.arrayContaining(['bare_late_name', 'config.get', 'ping', 'session.list']))
    // Provenance alone still lets a runtime-SHAPED name from the chain client through: that is what `sinks` is for.
    expect(r.methods).toContain('net.version')
  }, 60_000)

  it('extract-allow.json sinks exclude the chain client entirely, dotted names included', () => {
    const r = extract('excluded', { sinks: [CHAIN('raw'), CHAIN('all'), CHAIN('first')] })
    expect(r.status).toBe(0)
    expect(r.methods).toEqual(['bare_late_name', 'config.get', 'ping', 'session.list'])
  }, 60_000)

  it('an exclusion that matches no function fails the run', () => {
    const r = extract('stale', { sinks: [CHAIN('raw'), CHAIN('all'), CHAIN('first'), CHAIN('gone')] })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('electron/chain.ts#gone')
  }, 60_000)
})

const EVENT = (name: string, file = 'electron/constraints.ts') => ({
  file,
  name,
  reason: 'fixture AP2 constraint type'
})

describe('contract extractor: events allowlist (V3-J merge, K94)', () => {
  it('K94: a discriminant switch on another protocol’s union is read as events without an entry (the false positive, reproduced)', () => {
    const r = extract('k94-raw', {})

    expect(r.status).toBe(0)
    expect(r.events).toEqual(expect.arrayContaining(['message.delta', 'payment.budget', 'payment.reference']))
  }, 60_000)

  it('K94: extract-allow.json events excuse those positions in that file only; the provider event stays', () => {
    const r = extract('k94-allowed', { events: [EVENT('payment.budget'), EVENT('payment.reference')] })

    expect(r.status).toBe(0)
    expect(r.events.filter(name => name.startsWith('payment.'))).toEqual([])
    expect(r.events).toContain('message.delta')
  }, 60_000)

  it('K94: an events entry that matches nothing, names another file, or names a provider event fails the run', () => {
    for (const [name, entry, needle] of [
      ['k94-stale', EVENT('payment.gone'), 'events electron/constraints.ts#payment.gone'],
      ['k94-elsewhere', EVENT('payment.budget', 'electron/chain.ts'), 'events electron/chain.ts#payment.budget'],
      ['k94-provider', EVENT('message.delta'), 'events electron/constraints.ts#message.delta (a provider event)']
    ] as const) {
      const r = extract(name, { events: [EVENT('payment.budget'), EVENT('payment.reference'), entry] })

      expect(r.status, name).toBe(1)
      expect(r.stderr, name).toContain(needle)
    }
  }, 120_000)
})

describe('the shipped lock (V3-0)', () => {
  it('K94: the shipped lock holds no AP2 mandate constraint type as a gateway event', () => {
    expect(Object.keys(RUNTIME_LOCK.events).filter(name => name.startsWith('payment.'))).toEqual([])
  })

  it('holds no Ethereum JSON-RPC method', () => {
    expect(Object.keys(RUNTIME_LOCK.methods).filter(m => /^eth_|^net_|^web3_/.test(m))).toEqual([])
  })

  it('one truth: the pin ships exactly the verdict the extractor computed for it', () => {
    expect(RUNTIME_LOCK.verifiedAgainst.rev).toBe(RUNTIME_PIN.sha)
    expect(RUNTIME_PIN.verified).toBe(RUNTIME_LOCK.verifiedAgainst.result)
  })
})

describe('the boot verdict on the pinned runtime (V3-0)', () => {
  it('pin → pin on the OpenRPC tier the app reads at boot: no M-GONE, no RED card', async () => {
    const { verify } = await import('./verify')

    const full = JSON.parse(
      fs.readFileSync(path.resolve(DESKTOP, '..', '..', 'iclone', 'contract', 'runtime.spec.json'), 'utf8')
    ) as Record<string, unknown>

    // The keys the app's own boot builder emits (specFromOpenrpc), taken from it, not restated here.
    const { specFromOpenrpc } = await import('../iclone-compat')
    const keys = Object.keys(specFromOpenrpc('{"methods":[{"name":"ping"}]}', RUNTIME_PIN.sha, null, null) ?? {})
    expect(keys).toContain('methods')
    expect(keys).not.toContain('rest')
    const boot = Object.fromEntries(keys.map(k => [k, full[k]]))
    expect(boot.rev).toBe(RUNTIME_PIN.sha)
    const v = verify(RUNTIME_LOCK as never, [boot as never])
    expect(v.findings.filter(f => f.rule === 'M-GONE')).toEqual([])
    expect(v.cards.filter(c => c.level === 'RED')).toEqual([])
    expect(v.level).not.toBe('RED')
  })
})
