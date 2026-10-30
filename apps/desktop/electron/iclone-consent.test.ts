import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { compareVersions } from '../src/iclone-shared/version'

import {
  CONSENT_CAPABILITY_KEYS,
  CONSENT_DEVICE_KEYS,
  CONSENT_FILE,
  CONSENT_PERMISSION_KEYS,
  consentAllows,
  consentEnv,
  consentEnvFor,
  type ConsentRecord,
  consentState,
  createConsentStore,
  decideWebPermission,
  gateWebSessionsByConsent,
  guardedHandler,
  installConsentPermissionHandlers,
  isConsentRecord,
  isIso,
  mediaDeclinedByConsent,
  mediaWantsAudio,
  noteConsentPermission,
  type PermissionSessionLike,
  policyBlocks,
  registerIcloneConsent,
  resetConsentForTests,
  SCREEN_DECLINED_NOTE,
  withRealKeychain,
  withScreenDeclined
} from './iclone-consent'
import { BUNDLED_POLICY } from './policy-version.generated'

const record = (over: Partial<ConsentRecord> = {}): ConsentRecord => ({
  schema: 1,
  policyVersion: BUNDLED_POLICY.version,
  policyEffective: BUNDLED_POLICY.effective,
  acceptedAt: '2026-10-17T00:00:00.000Z',
  permissions: {},
  permissionsDecidedAt: null,
  skipped: false,
  aiProviderConsent: null,
  ...over
})

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'consent-'))
  file = path.join(dir, CONSENT_FILE)
})

afterEach(() => {
  resetConsentForTests()
  rmSync(dir, { force: true, recursive: true })
})

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>()

  return {
    handle: (channel: string, fn: (event: unknown, ...args: any[]) => unknown) => handlers.set(channel, fn),
    handlers
  }
}

describe('consentState', () => {
  it('absent → required, older → update, equal or newer → ok', () => {
    expect(consentState(null, '1.0')).toBe('required')
    expect(consentState(record({ policyVersion: '0.9' }), '1.0')).toBe('update')
    expect(consentState(record({ policyVersion: '1.0' }), '1.0')).toBe('ok')
    expect(consentState(record({ policyVersion: '1.1' }), '1.0')).toBe('ok')
    expect(compareVersions('1.10', '1.9')).toBeGreaterThan(0)
  })

  it('an invalid file is treated as absent and kept as consent.json.bad', () => {
    writeFileSync(file, JSON.stringify({ schema: 1, policyVersion: 'x' }))
    const store = createConsentStore(file)

    expect(store.state()).toBe('required')
    expect(readFileSync(`${file}.bad`, 'utf8')).toContain('policyVersion')
  })
})

describe('consent store', () => {
  const now = () => new Date('2026-10-17T12:00:00.000Z')

  it('accept writes atomically with 0600 and only for the bundled version', () => {
    const store = createConsentStore(file, now)

    expect(store.accept({ version: '0.1' }).ok).toBe(false)
    expect(store.accept({ version: BUNDLED_POLICY.version, aiProvider: true }).ok).toBe(true)
    const saved = JSON.parse(readFileSync(file, 'utf8'))

    expect(saved.policyVersion).toBe(BUNDLED_POLICY.version)
    expect(saved.aiProviderConsent).toEqual({ accepted: true, at: '2026-10-17T12:00:00.000Z' })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(createConsentStore(file).state()).toBe('ok')
  })

  it('permissions cannot be saved before acceptance; Skip writes permissions {}', () => {
    const store = createConsentStore(file, now)

    expect(store.setPermissions({ permissions: { microphone: true } }).ok).toBe(false)
    store.accept({ version: BUNDLED_POLICY.version })
    store.setPermissions({ skipped: true, permissions: { microphone: true } })
    const saved = JSON.parse(readFileSync(file, 'utf8'))

    expect(saved).toMatchObject({ permissions: {}, permissionsDecidedAt: null, skipped: true })
  })

  it('Save keeps only known boolean keys; re-acceptance after a policy bump keeps the switches', () => {
    writeFileSync(file, JSON.stringify(record({ policyVersion: '0.9', permissions: { clipboard: true } })))
    const store = createConsentStore(file, now)

    expect(store.state()).toBe('update')
    store.setPermissions({ permissions: { microphone: false, bogus: true, screen: 'yes' } })
    store.accept({ version: BUNDLED_POLICY.version })
    const saved = JSON.parse(readFileSync(file, 'utf8'))

    expect(saved.permissions).toEqual({ microphone: false })
    expect(saved.policyVersion).toBe(BUNDLED_POLICY.version)
    expect(saved.permissionsDecidedAt).toBe('2026-10-17T12:00:00.000Z')
  })

  it('withdrawing AI-provider consent records accepted:false', () => {
    const store = createConsentStore(file, now)

    store.accept({ version: BUNDLED_POLICY.version, aiProvider: true })
    store.setAiProvider({ accepted: false })
    expect(JSON.parse(readFileSync(file, 'utf8')).aiProviderConsent.accepted).toBe(false)
    // Re-accepting the policy (e.g. after an update) re-records it: the one required box includes the AI-provider disclosure.
    store.accept({ version: BUNDLED_POLICY.version })
    expect(JSON.parse(readFileSync(file, 'utf8')).aiProviderConsent.accepted).toBe(true)
  })
})

describe('runtime gates (OFF behaviour)', () => {
  function register(over: Partial<ConsentRecord> | null) {
    if (over) {
      writeFileSync(file, JSON.stringify(record(over)))
    }

    const ipc = fakeIpc()
    const openExternal = vi.fn()
    const quit = vi.fn()

    registerIcloneConsent({
      ipcMain: ipc,
      isTrustedSender: () => true,
      keychainEncrypted: () => false,
      legalDir: dir,
      openExternal,
      quit,
      userDataDir: dir
    })

    return { ipc, openExternal, quit }
  }

  it('undecided allows (the system prompt decides); only an explicit OFF declines', () => {
    expect(consentAllows('microphone')).toBe(true)
    register({
      permissions: { microphone: false, notifications: true },
      permissionsDecidedAt: '2026-10-17T00:00:00.000Z'
    })
    expect(consentAllows('microphone')).toBe(false)
    expect(consentAllows('notifications')).toBe(true)
    expect(consentAllows('screen')).toBe(true)
  })

  it('gate: microphone OFF declines the request', () => {
    register({ permissions: { microphone: false }, permissionsDecidedAt: '2026-10-17T00:00:00.000Z' })
    expect(consentAllows('microphone')).toBe(false)
  })

  it('gate: microphone OFF refuses audio in both media session handlers (request and check)', () => {
    const decide = (permission: string, details?: unknown) =>
      mediaDeclinedByConsent(consentAllows('microphone'), permission, details)

    // Undecided: nothing is refused here; packaged-env decides as before.
    expect(decide('media', { mediaTypes: ['audio'] })).toBe(false)
    register({ permissions: { microphone: false }, permissionsDecidedAt: '2026-10-17T00:00:00.000Z' })
    expect(decide('media', { mediaTypes: ['audio'] })).toBe(true)
    expect(decide('media', { mediaTypes: [] })).toBe(true)
    expect(decide('audioCapture')).toBe(true)
    expect(decide('media', { mediaType: 'audio' })).toBe(true)
    expect(decide('media', { mediaType: 'unknown' })).toBe(true)
    expect(decide('media')).toBe(true)
    // Video-only and non-media permissions are not the microphone's business.
    expect(decide('media', { mediaTypes: ['video'] })).toBe(false)
    expect(decide('media', { mediaType: 'video' })).toBe(false)
    expect(decide('notifications')).toBe(false)
    expect(decide('clipboard-read')).toBe(false)
  })

  it('mediaWantsAudio reads request and check details', () => {
    expect(mediaWantsAudio('media', { mediaTypes: ['video', 'audio'] })).toBe(true)
    expect(mediaWantsAudio('media', null)).toBe(true)
    expect(mediaWantsAudio('videoCapture')).toBe(false)
    expect(mediaWantsAudio('geolocation', { mediaTypes: ['audio'] })).toBe(false)
  })

  it('IPC: Save records Keychain as the real encryption state, never as a wish; Skip stays {}', async () => {
    const { ipc } = register({})
    const save = ipc.handlers.get('iclone:consent:permissions')!

    const all = Object.fromEntries(CONSENT_PERMISSION_KEYS.map(key => [key, true]))

    // "Allow all": 14 explicit trues, Keychain as its real state; a retired key (`files`) is not recorded.
    const saved = (await save({}, { permissions: { ...all, files: true } })) as { ok: true; record: ConsentRecord }

    expect(saved.record.permissions).toEqual({ ...all, keychain: false })
    expect(Object.keys(saved.record.permissions)).toHaveLength(13)
    expect([...CONSENT_CAPABILITY_KEYS, ...CONSENT_DEVICE_KEYS]).toEqual([...CONSENT_PERMISSION_KEYS])
    const skipped = (await save({}, { skipped: true })) as { ok: true; record: ConsentRecord }

    expect(skipped.record.permissions).toEqual({})
    expect(withRealKeychain(null, true)).toBeNull()
    expect(withRealKeychain({ permissions: 'x' }, true)).toEqual({ permissions: 'x' })
  })

  it('gate: notifications OFF suppresses notify()', () => {
    register({ permissions: { notifications: false }, permissionsDecidedAt: '2026-10-17T00:00:00.000Z' })
    expect(consentAllows('notifications')).toBe(false)
  })

  it('gate: screen OFF withholds window titles with the reason', () => {
    register({ permissions: { screen: false }, permissionsDecidedAt: '2026-10-17T00:00:00.000Z' })
    expect(consentAllows('screen')).toBe(false)
    expect(withScreenDeclined({ window: null, platform: 'darwin' })).toEqual({
      window: null,
      platform: 'darwin',
      note: SCREEN_DECLINED_NOTE
    })
    expect(withScreenDeclined({ error: 'x' })).toEqual({ error: 'x' })
  })

  it('gate: automation, screen and clipboard reach the agent runtime as ICLONE_CONSENT_<KEY> env', () => {
    register({
      permissions: { automation: false, clipboard: true, screen: false },
      permissionsDecidedAt: '2026-10-17T00:00:00.000Z'
    })
    const env = consentEnv()

    expect(env).toMatchObject({
      ICLONE_CONSENT_AUTOMATION: '0',
      ICLONE_CONSENT_CLIPBOARD: '1',
      ICLONE_CONSENT_SCREEN: '0',
      // Undecided capabilities tell the agent to ask through the consent door.
      ICLONE_CONSENT_TERMINAL: 'ask',
      ICLONE_CONSENT_FILE_WRITING: 'ask',
      ICLONE_CONSENT_WEB_BROWSING: 'ask',
      ICLONE_CONSENT_INSTALL_SOFTWARE: 'ask',
      ICLONE_CONSENT_SCHEDULED_TASKS: 'ask',
      ICLONE_CONSENT_SEND_MESSAGES: 'ask',
      ICLONE_CONSENT_SPEND_TRADE: 'ask'
    })
    // FX-4: plus the record's path, for Hermes' microphone gate (plugins/iclone-consent).
    expect(env.ICLONE_CONSENT_RECORD).toBe(file)
    expect(Object.keys(env)).toHaveLength(14)
    expect(Object.values(consentEnvFor(null))).toEqual(Array(13).fill('ask'))
  })

  it('gate: keychain mirrors the encryption toggle (single source) once permissions were decided', () => {
    register({ permissions: { keychain: false }, permissionsDecidedAt: '2026-10-17T00:00:00.000Z' })
    noteConsentPermission('keychain', true)
    expect(JSON.parse(readFileSync(file, 'utf8')).permissions.keychain).toBe(true)
  })

  it('gate: keychain mirror does not invent a decision after Skip', () => {
    register({ skipped: true })
    noteConsentPermission('keychain', true)
    expect(JSON.parse(readFileSync(file, 'utf8')).permissions).toEqual({})
  })

  function fakeSession() {
    const handlers: { check?: Parameters<PermissionSessionLike['setPermissionCheckHandler']>[0]; request?: any } = {}

    const sess: PermissionSessionLike = {
      setPermissionCheckHandler: handler => void (handlers.check = handler),
      setPermissionRequestHandler: handler => void (handlers.request = handler)
    }

    const request = (permission: string, details: unknown = {}) => {
      let granted: boolean | undefined

      handlers.request!({}, permission, (ok: boolean) => void (granted = ok), details)

      return granted
    }

    const check = (permission: string, details: unknown = {}) =>
      handlers.check!({}, permission, 'https://page.test', details)

    return { check, handlers, request, sess }
  }

  it('web sessions: every session-created gets request AND check handlers', () => {
    const listeners: Array<(sess: PermissionSessionLike) => void> = []
    const fakeApp = { on: (event: string, fn: (sess: PermissionSessionLike) => void) => listeners.push(fn) }
    const web = fakeSession()

    gateWebSessionsByConsent(fakeApp as never)
    expect(listeners).toHaveLength(1)
    listeners[0](web.sess)
    expect(typeof web.handlers.request).toBe('function')
    expect(typeof web.handlers.check).toBe('function')
  })

  it('web sessions: Microphone and Notifications OFF decline a page; never-used permissions are always refused', () => {
    const web = fakeSession()

    installConsentPermissionHandlers(web.sess)
    // Before registration there is no record: a web page gets nothing but fullscreen.
    expect(web.request('media', { mediaTypes: ['audio'] })).toBe(false)
    expect(web.request('notifications')).toBe(false)
    expect(web.check('fullscreen')).toBe(true)

    register({
      permissions: { microphone: false, notifications: false },
      permissionsDecidedAt: '2026-10-17T00:00:00.000Z'
    })
    // The handlers read consent on every call, so a later switch applies without reinstalling them.
    expect(web.request('media', { mediaTypes: ['audio'] })).toBe(false)
    expect(web.request('media', { mediaTypes: ['audio', 'video'] })).toBe(false)
    expect(web.request('notifications')).toBe(false)
    expect(web.check('media', { mediaType: 'audio' })).toBe(false)
    expect(web.check('notifications')).toBe(false)
    expect(web.request('media', { mediaTypes: ['video'] })).toBe(false)
    // Clipboard is undecided in this record: undecided is a No for a web page.
    expect(web.request('clipboard-sanitized-write')).toBe(false)
    expect(web.check('media', { mediaType: 'video' })).toBe(false)
    expect(web.check('fullscreen')).toBe(true)
  })

  it('web sessions: undecided is a No — permissions {} (Skip for now) and no record grant nothing but fullscreen', () => {
    const asks: Array<[string, unknown]> = [
      ['clipboard-read', {}],
      ['clipboard-sanitized-write', {}],
      ['notifications', {}],
      ['display-capture', {}],
      ['media', { mediaTypes: ['audio'] }],
      ['audioCapture', {}],
      ['geolocation', {}],
      ['media', { mediaTypes: ['video'] }]
    ]

    for (const permissions of [{}, null, undefined]) {
      expect(asks.filter(([permission, details]) => decideWebPermission(permission, details, permissions))).toEqual([])
      expect(decideWebPermission('fullscreen', {}, permissions)).toBe(true)
    }

    // A record that saved only some keys: the missing ones stay No; inherited keys never count as a switch.
    const partial = Object.create({ clipboard: true }) as Record<string, boolean>

    partial.notifications = true
    expect(decideWebPermission('clipboard-read', {}, partial)).toBe(false)
    expect(decideWebPermission('notifications', {}, partial)).toBe(true)
    expect(decideWebPermission('display-capture', {}, { screen: false })).toBe(false)

    const web = fakeSession()

    installConsentPermissionHandlers(web.sess)
    register({ permissions: {}, permissionsDecidedAt: '2026-10-17T00:00:00.000Z' })

    for (const permission of ['clipboard-read', 'clipboard-sanitized-write', 'display-capture', 'notifications']) {
      expect([permission, web.request(permission), web.check(permission)]).toEqual([permission, false, false])
    }

    expect(web.request('media', { mediaTypes: ['audio'] })).toBe(false)
  })

  it('web sessions: deny by default — every switch OFF leaves a page only fullscreen', () => {
    const web = fakeSession()

    installConsentPermissionHandlers(web.sess)
    register({
      permissions: Object.fromEntries(CONSENT_PERMISSION_KEYS.map(key => [key, false])),
      permissionsDecidedAt: '2026-10-17T00:00:00.000Z'
    })

    for (const permission of ['clipboard-read', 'clipboard-sanitized-write', 'display-capture', 'notifications']) {
      expect([permission, web.request(permission), web.check(permission)]).toEqual([permission, false, false])
    }

    expect(web.request('media', { mediaTypes: ['audio'] })).toBe(false)
    expect(web.request('fullscreen')).toBe(true)
  })

  it('web sessions: camera, location and device APIs are refused even with every switch ON', () => {
    const web = fakeSession()

    installConsentPermissionHandlers(web.sess)
    register({
      permissions: Object.fromEntries(CONSENT_PERMISSION_KEYS.map(key => [key, true])),
      permissionsDecidedAt: '2026-10-17T00:00:00.000Z'
    })

    const never = [
      'geolocation',
      'midi',
      'midiSysex',
      'usb',
      'hid',
      'serial',
      'bluetooth',
      'idle-detection',
      'pointerLock'
    ]

    for (const permission of [...never, 'openExternal', 'window-management', 'unknown-future-permission']) {
      expect([permission, web.request(permission), web.check(permission)]).toEqual([permission, false, false])
    }

    expect(web.request('media', { mediaTypes: ['video'] })).toBe(false)
    expect(web.request('media', { mediaTypes: ['audio'] })).toBe(true)
    expect(web.check('clipboard-read')).toBe(true)
    expect(web.request('display-capture')).toBe(true)
    expect(decideWebPermission('media', { mediaTypes: ['audio', 'video'] }, { microphone: true })).toBe(false)
  })

  it('records: an impossible day (30 February) is not a timestamp', () => {
    expect(isIso('2026-02-30T00:00:00Z')).toBe(false)
    expect(isIso('2028-02-29T00:00:00Z')).toBe(true)
    expect(isIso('2026-04-31T10:00:00+01:00')).toBe(false)
  })

  it('door grant: Allow always turns one key ON and keeps every other choice', () => {
    const store = createConsentStore(file, () => new Date('2026-10-17T03:00:00.000Z'))

    expect(store.allowAlways('terminal').ok).toBe(false)
    store.accept({ version: BUNDLED_POLICY.version })
    store.setPermissions({ skipped: true })
    const after = store.allowAlways('terminal')

    expect(after.ok && after.record.permissions).toEqual({ terminal: true })
    expect(after.ok && after.record.skipped).toBe(false)
  })

  it('web sessions: switches ON grant the microphone and notifications to a page', () => {
    const web = fakeSession()

    installConsentPermissionHandlers(web.sess)
    register({
      permissions: { microphone: true, notifications: true },
      permissionsDecidedAt: '2026-10-17T00:00:00.000Z'
    })
    expect(web.request('media', { mediaTypes: ['audio'] })).toBe(true)
    expect(web.check('notifications')).toBe(true)
  })

  it('IPC: get reports the state, open-policy opens only the fixed URL, quit quits', async () => {
    const { ipc, openExternal, quit } = register(null)
    const got = (await ipc.handlers.get('iclone:consent:get')!({})) as { state: string; bundled: { version: string } }

    expect(got.state).toBe('required')
    expect(got.bundled.version).toBe(BUNDLED_POLICY.version)
    await ipc.handlers.get('iclone:consent:open-policy')!({}, 'https://evil.example')
    expect(openExternal).toHaveBeenCalledWith('https://cloneframe.io/privacy/')
    ipc.handlers.get('iclone:consent:quit')!({})
    expect(quit).toHaveBeenCalledTimes(1)
    expect(ipc.handlers.get('iclone:consent:policy-text')!({})).toBeNull()
  })
})

describe('hostile consent records', () => {
  const at = '2026-10-17T00:00:00.000Z'

  it('unknown permission keys (a newer build) are ignored so the record survives a downgrade', () => {
    writeFileSync(file, JSON.stringify(record({ permissions: { microphone: false, faceId: true } as never })))
    const read = createConsentStore(file).read()

    expect(read).not.toBeNull()
    expect(read?.permissions.microphone).toBe(false)
    expect(() => statSync(`${file}.bad`)).toThrow()
  })

  it('a known key with a non-boolean value, or a non-object permissions field, is rejected', () => {
    expect(isConsentRecord(record({ permissions: { microphone: 'no' } as never }))).toBe(false)
    expect(isConsentRecord(record({ permissions: [] as never }))).toBe(false)
    expect(isConsentRecord(record({ permissions: null as never }))).toBe(false)
    expect(isConsentRecord(JSON.parse(`${JSON.stringify(record()).slice(0, -1)},"x":1}`))).toBe(true)
  })

  it('__proto__ in permissions neither pollutes nor smuggles a switch', () => {
    const raw = JSON.stringify(record()).replace('"permissions":{}', '"permissions":{"__proto__":{"microphone":false}}')
    const parsed = JSON.parse(raw) as ConsentRecord

    expect(isConsentRecord(parsed)).toBe(true)
    expect(Object.hasOwn(parsed.permissions, 'microphone')).toBe(false)
    expect(({} as Record<string, unknown>).microphone).toBeUndefined()
  })

  it('timestamps must be real ISO-8601 date-times', () => {
    expect(isIso(at)).toBe(true)
    expect(isIso('2026-10-17T01:02:03+01:00')).toBe(true)
    expect(isIso('2026-10-17T01:02Z')).toBe(true)

    for (const bad of ['1', '2026', '2026-10-17', 'Tue Oct 17 2026', '2026-13-01T00:00:00Z', '2026-10-17T24:00:00Z']) {
      expect(isIso(bad), bad).toBe(false)
    }

    expect(isIso(1_760_000_000_000)).toBe(false)
    expect(isConsentRecord(record({ acceptedAt: '1' }))).toBe(false)
    expect(isConsentRecord(record({ permissionsDecidedAt: 'yesterday' }))).toBe(false)
    expect(isConsentRecord(record({ aiProviderConsent: { accepted: true, at: '2026-10-17' } }))).toBe(false)
  })
})

describe('policyBlocks', () => {
  it('returns text only, keeps pp- anchors and joins table cells', () => {
    const blocks = policyBlocks(
      '<h1 id="policyTitle">A &amp; B</h1><p class="p-meta">Effective 1 · Version 1</p><h2 id="pp-who">1. Who</h2>' +
        '<p>Hi <b>there</b><img src=x onerror=alert(1)></p><tr><td>Mic</td><td>Voice</td></tr>'
    )

    expect(blocks).toEqual([
      { kind: 'title', text: 'A & B' },
      { kind: 'meta', text: 'Effective 1 · Version 1' },
      { id: 'pp-who', kind: 'heading', text: '1. Who' },
      { kind: 'paragraph', text: 'Hi there' },
      { kind: 'row', text: 'Mic — Voice' }
    ])
  })
})

describe('guardedHandler (L9)', () => {
  it('a missing guard refuses every call; only a guard that answers exactly true lets one through', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    const ipcMain = {
      handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) =>
        handlers.set(channel, listener)
    }

    const listener = vi.fn(() => 'ran')

    guardedHandler(ipcMain, undefined).handle('a', listener)
    guardedHandler(ipcMain, (() => 'yes') as never).handle('b', listener)
    guardedHandler(ipcMain, () => true).handle('c', listener)

    expect(await handlers.get('a')?.({})).toBeNull()
    expect(await handlers.get('b')?.({})).toBeNull()
    expect(await handlers.get('c')?.({})).toBe('ran')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
