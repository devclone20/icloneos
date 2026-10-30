import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startAcpSocketServer } from './iclone-acp-ipc'
import { createConsentStore, registerIcloneConsent, resetConsentForTests } from './iclone-consent'
import {
  cleanReason,
  CONSENT_REQUESTS_FILE,
  consentDoorCommand,
  createConsentDoor,
  type DoorRequest,
  parseDoorArgv,
  PENDING_PER_INFT_MAX,
  registerConsentDoor,
  REQUESTABLE_KEYS,
  resetConsentDoorForTests
} from './iclone-consent-door'
import { BUNDLED_POLICY } from './policy-version.generated'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-door-'))
})

afterEach(() => {
  vi.useRealTimers()
  resetConsentDoorForTests()
  resetConsentForTests()
  rmSync(dir, { recursive: true, force: true })
})

function setup(options: { accepted?: boolean; timeoutMs?: number } = {}) {
  const store = createConsentStore(path.join(dir, 'consent.json'))

  if (options.accepted !== false) {
    store.accept({ version: BUNDLED_POLICY.version })
  }

  const shown: (DoorRequest | null)[] = []

  const door = createConsentDoor({
    store,
    show: request => shown.push(request),
    userDataDir: dir,
    timeoutMs: options.timeoutMs
  })

  resetConsentDoorForTests(door)

  return { door, shown, store }
}

describe('parseDoorArgv', () => {
  it('reads request <key> --reason, status, and refuses everything else', () => {
    expect(parseDoorArgv(['request', 'terminal', '--reason', 'run the tests'])).toEqual({
      kind: 'request',
      key: 'terminal',
      reason: 'run the tests'
    })
    expect(parseDoorArgv(['request', 'spendTrade', '--reason=pay the invoice', '--json'])).toMatchObject({
      key: 'spendTrade',
      reason: 'pay the invoice'
    })
    expect(parseDoorArgv(['status'])).toEqual({ kind: 'status', key: null })
    expect(parseDoorArgv(['status', 'clipboard'])).toEqual({ kind: 'status', key: 'clipboard' })

    for (const bad of [
      [],
      ['request', 'terminal'],
      ['request', 'terminal', '--reason', '   '],
      ['request', 'keychain', '--reason', 'x'],
      ['request', 'camera', '--reason', 'x'],
      ['request', 'terminal', '--reason', 'x', '--yes'],
      ['grant', 'terminal'],
      ['request', 7, '--reason', 'x']
    ]) {
      expect(parseDoorArgv(bad).kind).toBe('error')
    }
  })

  it('shows the reason on one line, without control characters, capped', () => {
    expect(cleanReason('line one\n\u0007line\ttwo end')).toBe('line one line two end')
    expect(cleanReason('x'.repeat(1000))).toHaveLength(280)
    // 12: Local network is an informational policy row, not a switch (U1-08-p2, fixer wave UF2C).
    expect(REQUESTABLE_KEYS).toHaveLength(12)
  })
})

describe('createConsentDoor', () => {
  it('Allow always writes consent.json; Allow once is a grant for this run and this iNFT only', async () => {
    const { door, shown, store } = setup()

    const always = door.request('inft-6', 'terminal', 'run the test suite')

    expect(shown.at(-1)).toMatchObject({ key: 'terminal', reason: 'run the test suite', inft: 'inft-6' })
    expect(door.answer(shown.at(-1)!.id, 'always')).toBe(true)
    await expect(always).resolves.toEqual({ allowed: true, key: 'terminal', scope: 'always' })
    expect(store.read()?.permissions.terminal).toBe(true)
    expect(JSON.parse(readFileSync(path.join(dir, 'consent.json'), 'utf8')).permissions.terminal).toBe(true)
    // Already ON: answered without a sheet.
    await expect(door.request('inft-7', 'terminal', 'again')).resolves.toMatchObject({ allowed: true, scope: 'always' })

    const once = door.request('inft-6', 'clipboard', 'paste the address')

    door.answer(shown.at(-1)!.id, 'once')
    await expect(once).resolves.toEqual({ allowed: true, key: 'clipboard', scope: 'once' })
    expect(store.read()?.permissions.clipboard).toBeUndefined()
    await expect(door.request('inft-6', 'clipboard', 'again')).resolves.toMatchObject({ scope: 'once' })
    expect(door.status('inft-6', 'clipboard')).toEqual({ clipboard: 'once' })
    expect(door.status('inft-7', 'clipboard')).toEqual({ clipboard: 'ask' })
    expect(shown.at(-1)).toBeNull()
  })

  it('Deny answers denied and writes nothing; the recent list keeps key, reason, answer and time', async () => {
    const { door, shown, store } = setup()
    const asked = door.request('inft-6', 'spendTrade', 'buy the dataset')

    expect(door.answer('wrong-id', 'always')).toBe(false)
    expect(door.answer(shown.at(-1)!.id, 'maybe')).toBe(false)
    door.answer(shown.at(-1)!.id, 'deny')
    await expect(asked).resolves.toEqual({ allowed: false, key: 'spendTrade', scope: 'denied' })
    expect(store.read()?.permissions.spendTrade).toBeUndefined()
    expect(door.recent()[0]).toMatchObject({
      key: 'spendTrade',
      reason: 'buy the dataset',
      answer: 'denied',
      inft: 'inft-6'
    })
    expect(JSON.parse(readFileSync(path.join(dir, CONSENT_REQUESTS_FILE), 'utf8')).requests).toHaveLength(1)
  })

  it('one sheet at a time: the second request waits, then shows when the first is answered', async () => {
    const { door, shown } = setup()
    const first = door.request('inft-6', 'terminal', 'first')
    const second = door.request('inft-7', 'webBrowsing', 'second')

    expect(shown.filter(Boolean)).toHaveLength(1)
    expect(door.current()?.reason).toBe('first')
    expect(door.pendingCount()).toBe(2)
    door.answer(door.current()!.id, 'deny')
    await first
    expect(door.current()?.reason).toBe('second')
    door.answer(door.current()!.id, 'once')
    await expect(second).resolves.toMatchObject({ allowed: true, scope: 'once' })
    expect(shown.map(item => item?.reason ?? null)).toEqual(['first', 'second', null])
  })

  it('no answer within the timeout is a Deny; a queued request is timed from when it is shown', async () => {
    vi.useFakeTimers()
    const { door } = setup({ timeoutMs: 120_000 })
    const first = door.request('inft-6', 'terminal', 'first')
    const second = door.request('inft-6', 'scheduledTasks', 'second')

    vi.advanceTimersByTime(119_999)
    expect(door.current()?.reason).toBe('first')
    vi.advanceTimersByTime(1)
    await expect(first).resolves.toEqual({
      allowed: false,
      key: 'terminal',
      scope: 'denied',
      reason: 'no answer in time'
    })
    expect(door.current()?.reason).toBe('second')
    vi.advanceTimersByTime(120_000)
    await expect(second).resolves.toMatchObject({ allowed: false, scope: 'denied' })
    expect(door.recent().map(item => item.answer)).toEqual(['timeout', 'timeout'])
    expect(door.current()).toBeNull()
  })

  it('an agent that goes away withdraws its request; nothing is asked before the policy is accepted', async () => {
    const { door } = setup()
    const abort = new AbortController()
    const asked = door.request('inft-6', 'terminal', 'x', abort.signal)

    abort.abort()
    await expect(asked).resolves.toMatchObject({ allowed: false })
    expect(door.current()).toBeNull()

    rmSync(path.join(dir, 'consent.json'))
    const fresh = setup({ accepted: false })

    await expect(fresh.door.request('inft-6', 'terminal', 'x')).resolves.toMatchObject({ allowed: false })
    expect(fresh.shown).toHaveLength(0)
  })

  it('a flood of the same (iNFT, key) is one sheet, and every caller gets the same answer', async () => {
    const { door, shown } = setup({ timeoutMs: 60_000 })
    const asked = Array.from({ length: 500 }, (_, i) => door.request('inft-6', 'terminal', `step ${i}`))

    expect(door.pendingCount()).toBe(1)
    expect(shown.filter(Boolean)).toHaveLength(1)
    expect(door.current()?.reason).toBe('step 0')
    door.answer(door.current()!.id, 'once')

    const answers = await Promise.all(asked)

    expect(new Set(answers.map(answer => JSON.stringify(answer)))).toEqual(
      new Set([JSON.stringify({ allowed: true, key: 'terminal', scope: 'once' })])
    )
    expect(door.recent()).toHaveLength(1)
  })

  it('caps the distinct keys one iNFT may have waiting; the rest are refused, never queued', async () => {
    const { door } = setup({ timeoutMs: 60_000 })
    const keys = ['terminal', 'screen', 'clipboard', 'automation', 'fileWriting'] as const

    const asked = keys.map(key => door.request('inft-6', key, 'x'))

    expect(door.pendingCount()).toBe(PENDING_PER_INFT_MAX)
    await expect(asked[PENDING_PER_INFT_MAX]).resolves.toMatchObject({ allowed: false, scope: 'denied' })
    door.request('inft-7', 'terminal', 'another iNFT is not held back')
    expect(door.pendingCount()).toBe(PENDING_PER_INFT_MAX + 1)
    await expect(consentDoorCommand('inft-6', ['request', 'webBrowsing', '--reason', 'x'])).resolves.toMatchObject({
      code: 1
    })
  })

  it('after a Deny the same (iNFT, key) is denied without a sheet until the user changes that switch', async () => {
    const { door, shown } = setup({ timeoutMs: 60_000 })
    const first = door.request('inft-6', 'terminal', 'first')

    door.answer(door.current()!.id, 'deny')
    await expect(first).resolves.toEqual({ allowed: false, key: 'terminal', scope: 'denied' })

    const sheets = shown.filter(Boolean).length

    await expect(door.request('inft-6', 'terminal', 'pretty please')).resolves.toMatchObject({ allowed: false })
    expect(shown.filter(Boolean)).toHaveLength(sheets)
    // Another iNFT, or another key, still asks.
    door.request('inft-7', 'terminal', 'x')
    expect(door.pendingCount()).toBe(1)

    door.clearDenied(['screen'])
    await expect(door.request('inft-6', 'terminal', 'x')).resolves.toMatchObject({ allowed: false })
    door.clearDenied(['terminal'])
    door.request('inft-6', 'terminal', 'x')
    expect(door.pendingCount()).toBe(2)
  })

  it('Allow once gives way to a later switch change by the user, for every iNFT; status reports the stored switch', async () => {
    const { door, shown, store } = setup({ timeoutMs: 60_000 })

    const grant = (slug: string) => {
      const pending = door.request(slug, 'clipboard', 'paste the error')

      door.answer(door.current()!.id, 'once')

      return pending
    }

    await expect(grant('inft-8')).resolves.toEqual({ allowed: true, key: 'clipboard', scope: 'once' })
    await expect(grant('inft-9')).resolves.toMatchObject({ scope: 'once' })
    door.request('inft-8', 'terminal', 'build')
    door.answer(door.current()!.id, 'once')
    expect(door.status('inft-8', 'clipboard')).toEqual({ clipboard: 'once' })

    // The user says No in Privacy: the once grants for that key end; other keys keep theirs.
    store.setPermissions({ permissions: { clipboard: false } })
    door.clearDenied(['clipboard'])
    expect(door.status('inft-8', 'clipboard')).toEqual({ clipboard: 'off' })
    expect(door.status('inft-9', 'clipboard')).toEqual({ clipboard: 'off' })
    expect(door.status('inft-8', 'terminal')).toEqual({ terminal: 'once' })

    const sheets = shown.filter(Boolean).length
    const again = door.request('inft-8', 'clipboard', 'paste again')

    expect(shown.filter(Boolean)).toHaveLength(sheets + 1)
    door.answer(door.current()!.id, 'deny')
    await expect(again).resolves.toEqual({ allowed: false, key: 'clipboard', scope: 'denied' })
  })

  it('a call whose agent has already gone is never queued; one caller leaving keeps the sheet for the others', async () => {
    const { door, shown } = setup({ timeoutMs: 60_000 })
    const gone = new AbortController()

    gone.abort()
    await expect(door.request('inft-6', 'screen', 'gone', gone.signal)).resolves.toMatchObject({ allowed: false })
    expect(door.pendingCount()).toBe(0)
    expect(shown).toHaveLength(0)

    const leaving = new AbortController()
    const a = door.request('inft-6', 'terminal', 'a', leaving.signal)
    const b = door.request('inft-6', 'terminal', 'b')

    leaving.abort()
    await expect(a).resolves.toMatchObject({ allowed: false, reason: 'the request was withdrawn' })
    expect(door.pendingCount()).toBe(1)
    door.answer(door.current()!.id, 'once')
    await expect(b).resolves.toMatchObject({ allowed: true, scope: 'once' })
  })

  it('the reason drops bidi overrides, isolates, zero-width characters and the BOM', () => {
    const raw = 'Read \u202Eexe.tpircs\u202C notes\u200B\u2066x\u2069\uFEFF'
    const clean = cleanReason(raw)

    expect([...clean].filter(char => /\p{Cf}/u.test(char))).toEqual([])
    expect(clean).toBe('Read exe.tpircs notesx')
    expect(parseDoorArgv(['request', 'fileWriting', '--reason', '\u200B\u200D'])).toMatchObject({ kind: 'error' })
  })

  it('a corrupt history file is ignored, never thrown', () => {
    writeFileSync(path.join(dir, CONSENT_REQUESTS_FILE), '{"schema":1,"requests":[{"key":"rm -rf"}]}')
    expect(setup().door.recent()).toEqual([])
  })
})

describe('the consent verb on the agent socket', () => {
  const ask = (socketPath: string, request: unknown) =>
    new Promise<{ t: string; d?: string; c?: number }[]>((resolve, reject) => {
      const socket = net.createConnection(socketPath)
      let data = ''

      socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
      socket.on('data', chunk => (data += String(chunk)))
      socket.on('error', reject)
      socket.on('close', () =>
        resolve(
          data
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line))
        )
      )
    })

  it('round trip: fake agent → token + iNFT checked → sheet → answer; never forwarded to the Virtuals CLI', async () => {
    const { door, shown } = setup()
    const runs: string[][] = []
    const resolved: (string | null)[] = []

    const server = await startAcpSocketServer({
      admitStreaming: () => true,
      dir: path.join(dir, 'run'),
      resolveInft: key => (
        resolved.push(key),
        key === 'nope' ? { ok: false, error: 'unknown iNFT' } : { ok: true, slug: 'inft-6' }
      ),
      run: (_slug, argv) => (runs.push(argv), Promise.resolve({ code: 0 })),
      log: () => undefined
    })

    try {
      const token = readFileSync(path.join(dir, 'run', 'acp.token'), 'utf8').trim()
      const argv = ['consent', 'request', 'terminal', '--reason', 'run the build']

      const stale = await ask(server.socketPath, { v: 1, token: 'f'.repeat(64), inft: '6', argv })

      expect(stale.at(-1)).toEqual({ t: 'x', c: 3 })
      expect(shown).toHaveLength(0)

      const unknown = await ask(server.socketPath, { v: 1, token, inft: 'nope', argv })

      expect(unknown.at(-1)).toEqual({ t: 'x', c: 2 })

      const pending = ask(server.socketPath, { v: 1, token, inft: '6', argv })

      await vi.waitFor(() => expect(door.current()).not.toBeNull())
      expect(door.current()).toMatchObject({ key: 'terminal', reason: 'run the build', inft: 'inft-6' })
      door.answer(door.current()!.id, 'once')

      const frames = await pending

      const out = frames
        .filter(frame => frame.t === 'o')
        .map(frame => frame.d)
        .join('')

      expect(JSON.parse(out)).toEqual({ allowed: true, key: 'terminal', scope: 'once' })
      expect(frames.at(-1)).toEqual({ t: 'x', c: 0 })

      const denied = ask(server.socketPath, {
        v: 1,
        token,
        inft: '6',
        argv: ['consent', 'request', 'spendTrade', '--reason', 'pay']
      })

      await vi.waitFor(() => expect(door.current()?.key).toBe('spendTrade'))
      door.answer(door.current()!.id, 'deny')
      expect((await denied).at(-1)).toEqual({ t: 'x', c: 1 })

      const usage = await ask(server.socketPath, { v: 1, token, inft: '6', argv: ['consent', 'request', 'terminal'] })

      expect(usage.at(-1)).toEqual({ t: 'x', c: 64 })
      expect(runs).toHaveLength(0)
      expect(resolved).toContain('6')
    } finally {
      server.close()
    }
  })

  it('status answers without a sheet; IPC answers only the request on screen', async () => {
    const shown: (DoorRequest | null)[] = []
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const store = createConsentStore(path.join(dir, 'consent.json'))

    store.accept({ version: BUNDLED_POLICY.version })
    store.setPermissions({ permissions: { terminal: false, clipboard: true } })
    registerConsentDoor({
      ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
      isTrustedSender: () => true,
      store,
      broadcast: request => shown.push(request),
      userDataDir: dir
    })

    const status = await consentDoorCommand('inft-6', ['status'])

    expect(JSON.parse(status.stdout).permissions).toMatchObject({
      terminal: 'off',
      clipboard: 'on',
      webBrowsing: 'ask'
    })
    expect(shown).toHaveLength(0)

    const asked = consentDoorCommand('inft-6', ['request', 'terminal', '--reason', 'build'])

    await vi.waitFor(() => expect(shown).toHaveLength(1))
    expect(await handlers.get('iclone:consent:door-current')!({})).toMatchObject({ key: 'terminal' })
    expect(await handlers.get('iclone:consent:door-answer')!({}, { id: 'x', choice: 'always' })).toBe(false)
    expect(await handlers.get('iclone:consent:door-answer')!({}, { id: shown[0]!.id, choice: 'always' })).toBe(true)
    expect((await asked).code).toBe(0)
    expect(store.read()?.permissions.terminal).toBe(true)
    expect(await handlers.get('iclone:consent:requests')!({})).toHaveLength(1)
  })

  it('IPC refuses any sender the guard refuses; a Privacy change of the switch lifts an earlier Deny', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const ipcMain = { handle: (channel: string, listener: never) => handlers.set(channel, listener) }
    const trusted = { trusted: true }
    const guard = vi.fn((event: unknown) => event === trusted)

    const store = registerIcloneConsent({
      ipcMain,
      isTrustedSender: guard as never,
      keychainEncrypted: () => false,
      legalDir: dir,
      openExternal: () => undefined,
      quit: () => undefined,
      userDataDir: dir
    })

    store.accept({ version: BUNDLED_POLICY.version })

    const shown: (DoorRequest | null)[] = []

    const door = registerConsentDoor({
      ipcMain,
      isTrustedSender: guard as never,
      store,
      broadcast: request => shown.push(request),
      userDataDir: dir
    })

    const first = door.request('inft-6', 'terminal', 'build')
    const id = shown[0]!.id

    expect(await handlers.get('iclone:consent:door-current')!({ forged: true })).toBeNull()
    expect(await handlers.get('iclone:consent:door-answer')!({ forged: true }, { id, choice: 'always' })).toBeNull()
    expect(await handlers.get('iclone:consent:get')!({ forged: true })).toBeNull()
    expect(door.pendingCount()).toBe(1)
    expect(await handlers.get('iclone:consent:door-answer')!(trusted, { id, choice: 'deny' })).toBe(true)
    await expect(first).resolves.toMatchObject({ allowed: false })
    await expect(door.request('inft-6', 'terminal', 'again')).resolves.toMatchObject({ allowed: false })

    // Saving Privacy with terminal unchanged keeps the Deny; changing it lifts it.
    await handlers.get('iclone:consent:permissions')!(trusted, { permissions: { clipboard: true } })
    await expect(door.request('inft-6', 'terminal', 'again')).resolves.toMatchObject({ allowed: false })
    await handlers.get('iclone:consent:permissions')!(trusted, { permissions: { clipboard: true, terminal: false } })
    door.request('inft-6', 'terminal', 'after the change')
    expect(door.pendingCount()).toBe(1)
    expect(guard).toHaveBeenCalledWith({ forged: true }, 'iclone:consent:door-answer')
    door.answer(door.current()!.id, 'deny')

    // Clipboard undecided, Allow once, then Clipboard OFF through the same IPC: the grant ends, status reports the switch.
    await handlers.get('iclone:consent:permissions')!(trusted, { permissions: { terminal: false } })
    const once = door.request('inft-6', 'clipboard', 'paste')

    door.answer(door.current()!.id, 'once')
    await expect(once).resolves.toMatchObject({ allowed: true, scope: 'once' })
    await handlers.get('iclone:consent:permissions')!(trusted, { permissions: { clipboard: false, terminal: false } })
    expect(door.status('inft-6', 'clipboard')).toEqual({ clipboard: 'off' })
  })
})
