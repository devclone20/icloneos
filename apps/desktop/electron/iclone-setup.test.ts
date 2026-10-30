import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CONSENT_FILE,
  type ConsentRecord,
  createConsentStore,
  registerIcloneConsent,
  resetConsentForTests,
  SETUP_SECTIONS,
  setupDecisions
} from './iclone-consent'
import { decideFunctions } from './iclone-permissions/functions'
import {
  actOnSetupSystemItem,
  createSetupAttempts,
  microphoneAccess,
  registerIcloneSetup,
  SETUP_PANES,
  setupSystemAction,
  setupSystemRows,
  type SetupSystemSeam
} from './iclone-setup'
import { BUNDLED_POLICY } from './policy-version.generated'

/** What `systemPreferences.getMediaAccessStatus` really returns on macOS, per kind (r2 M1). Screen recording is a
 *  boolean preflight in Chromium: `granted` or `denied`, NEVER `not-determined`. */
type MicStatus = 'denied' | 'granted' | 'not-determined' | 'restricted'
type ScreenStatus = 'denied' | 'granted'
const SCREEN_STATUSES: readonly string[] = ['granted', 'denied']

/** The systemPreferences / desktopCapturer / Notification / shell seam, every call recorded. */
function seam(
  over: Partial<SetupSystemSeam> & {
    media?: { microphone?: MicStatus; screen?: ScreenStatus }
    off?: string[]
    attempted?: boolean
  } = {}
) {
  // A fresh install: the mic never asked, screen recording `denied` (what macOS answers before any attempt).
  const media: { microphone: MicStatus; screen: ScreenStatus } = {
    microphone: 'not-determined',
    screen: 'denied',
    ...over.media
  }

  // r2 M1 gate row: a stub may never model a screen status macOS does not return.
  if (!SCREEN_STATUSES.includes(media.screen)) {
    throw new Error(`macOS never reports '${media.screen}' for screen recording (only granted | denied)`)
  }

  let attempted = over.attempted ?? false

  const calls = {
    askMicrophone: vi.fn(async () => {
      media.microphone = 'granted'

      return true
    }),
    attemptScreenCapture: vi.fn(async () => undefined),
    markScreenAttempted: vi.fn(() => {
      attempted = true
    }),
    showNotification: vi.fn(() => true),
    openExternal: vi.fn(async () => undefined)
  }

  const value: SetupSystemSeam = {
    platform: 'darwin',
    mediaStatus: kind => media[kind],
    screenAttempted: () => attempted,
    consentAllows: key => !(over.off ?? []).includes(key),
    ...calls,
    ...over
  }

  return { value, calls, media }
}

const statuses = (rows: { id: string; status: string; action: string }[]) =>
  Object.fromEntries(rows.map(row => [row.id, `${row.status}/${row.action}`]))

describe('V3-ON system permissions — status and the one action main picks', () => {
  it('lists the three items the app itself uses, with macOS status mapped and the action per status', () => {
    const { value } = seam({ media: { microphone: 'granted', screen: 'denied' } })

    // A fresh install: macOS says `denied` for screen, but the app never tried a capture → Not set up + Allow.
    expect(statuses(setupSystemRows(value, createSetupAttempts()))).toEqual({
      microphone: 'granted/none',
      screen: 'notSetUp/request',
      notifications: 'unknown/request'
    })
  })

  it('r2 M1: screen `denied` means "Not allowed" + the pane only after an attempt was made (persisted)', () => {
    const { value } = seam({ attempted: true })

    expect(statuses(setupSystemRows(value, createSetupAttempts())).screen).toBe('denied/openSettings')
    expect(statuses(setupSystemRows(seam({ media: { screen: 'granted' } }).value, createSetupAttempts())).screen).toBe(
      'granted/none'
    )
  })

  it('r2 M1: the stub refuses a screen status macOS never returns', () => {
    expect(() => seam({ media: { screen: 'not-determined' as ScreenStatus } })).toThrow(/never reports/)
  })

  it('off macOS there is nothing to set up (the section hides)', () => {
    expect(setupSystemRows(seam({ platform: 'linux' }).value, createSetupAttempts())).toEqual([])
  })

  it('every status has exactly one action; restricted, declined and granted offer none', () => {
    expect(setupSystemAction('microphone', 'notDetermined', false)).toBe('request')
    expect(setupSystemAction('microphone', 'notDetermined', true)).toBe('openSettings')
    expect(setupSystemAction('microphone', 'denied', false)).toBe('openSettings')
    expect(setupSystemAction('screen', 'unknown', false)).toBe('openSettings')
    expect(setupSystemAction('notifications', 'unknown', false)).toBe('request')
    expect(setupSystemAction('notifications', 'unknown', true)).toBe('openSettings')

    for (const status of ['granted', 'restricted', 'declined'] as const) {
      expect(setupSystemAction('microphone', status, false)).toBe('none')
    }
  })

  it('microphone not yet asked: asks macOS (askForMediaAccess) once, then reads granted', async () => {
    const { value, calls } = seam()
    const rows = await actOnSetupSystemItem(value, createSetupAttempts(), { item: 'microphone' })

    expect(calls.askMicrophone).toHaveBeenCalledTimes(1)
    expect(calls.openExternal).not.toHaveBeenCalled()
    expect(statuses(rows).microphone).toBe('granted/none')
  })

  it('screen recording from a REAL fresh status (denied, never attempted): one capture attempt, recorded, then the pane', async () => {
    const { value, calls } = seam()

    const first = await actOnSetupSystemItem(value, createSetupAttempts(), { item: 'screen' })

    expect(calls.markScreenAttempted).toHaveBeenCalledTimes(1)
    expect(calls.attemptScreenCapture).toHaveBeenCalledTimes(1)
    expect(calls.openExternal).not.toHaveBeenCalled()
    expect(statuses(first).screen).toBe('denied/openSettings')

    // A new main run (fresh attempts set): the persisted attempt still holds — the pane, never a second attempt.
    const rows = await actOnSetupSystemItem(value, createSetupAttempts(), { item: 'screen' })

    expect(calls.attemptScreenCapture).toHaveBeenCalledTimes(1)
    expect(calls.openExternal).toHaveBeenCalledWith(SETUP_PANES.screen)
    expect(rows.find(row => row.id === 'screen')?.restartToApply).toBe(true)
  })

  it('a capture attempt that throws still counts as made (no loop of attempts)', async () => {
    const { value, calls } = seam({
      attemptScreenCapture: vi.fn(async () => {
        throw new Error('capture')
      })
    })

    await actOnSetupSystemItem(value, createSetupAttempts(), { item: 'screen' })
    expect(calls.markScreenAttempted).toHaveBeenCalledTimes(1)
    expect(statuses(setupSystemRows(value, createSetupAttempts())).screen).toBe('denied/openSettings')
  })

  it('restricted (managed Mac) never shows the restart note or an action', () => {
    const { value } = seam({ off: [] })
    const restricted = { ...value, mediaStatus: () => 'restricted' }
    const screen = setupSystemRows(restricted, createSetupAttempts()).find(row => row.id === 'screen')

    expect(screen).toEqual({ id: 'screen', status: 'restricted', action: 'none' })
  })

  it('a denied item opens its own pane (fixed in main), never a request', async () => {
    const { value, calls } = seam({ media: { microphone: 'denied' } })

    await actOnSetupSystemItem(value, createSetupAttempts(), { item: 'microphone' })

    expect(calls.askMicrophone).not.toHaveBeenCalled()
    expect(calls.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    )
  })

  it('notifications: the first press shows one notification (what makes macOS ask), the next opens the pane', async () => {
    const { value, calls } = seam()
    const attempts = createSetupAttempts()

    await actOnSetupSystemItem(value, attempts, { item: 'notifications', title: 'T', body: 'B' })
    await actOnSetupSystemItem(value, attempts, { item: 'notifications', title: 'T', body: 'B' })

    expect(calls.showNotification).toHaveBeenCalledTimes(1)
    expect(calls.showNotification).toHaveBeenCalledWith('T', 'B')
    expect(calls.openExternal).toHaveBeenCalledWith(SETUP_PANES.notifications)
  })

  it('ON-4 no re-ask: a granted item makes no call at all', async () => {
    const { value, calls } = seam({ media: { microphone: 'granted', screen: 'granted' } })

    await actOnSetupSystemItem(value, createSetupAttempts(), { item: 'microphone' })
    await actOnSetupSystemItem(value, createSetupAttempts(), { item: 'screen' })

    expect(calls.askMicrophone).not.toHaveBeenCalled()
    expect(calls.attemptScreenCapture).not.toHaveBeenCalled()
    expect(calls.openExternal).not.toHaveBeenCalled()
  })

  it('a Privacy switch OFF is never overridden: declined, and nothing is asked or opened', async () => {
    const { value, calls } = seam({ off: ['microphone', 'screen', 'notifications'] })
    const attempts = createSetupAttempts()

    for (const item of ['microphone', 'screen', 'notifications']) {
      await actOnSetupSystemItem(value, attempts, { item, title: 'T', body: 'B' })
    }

    expect(Object.values(calls).every(call => call.mock.calls.length === 0)).toBe(true)
    expect(Object.values(statuses(setupSystemRows(value, attempts)))).toEqual([
      'declined/none',
      'declined/none',
      'declined/none'
    ])
  })

  it('the renderer cannot choose a URL or an unknown item; notification text is capped', async () => {
    const { value, calls } = seam()

    await actOnSetupSystemItem(value, createSetupAttempts(), { item: 'camera', url: 'file:///etc/passwd' })
    await actOnSetupSystemItem(value, createSetupAttempts(), { item: 'notifications', title: 'x'.repeat(500) })

    expect(calls.openExternal).not.toHaveBeenCalled()
    expect((calls.showNotification.mock.calls[0] as unknown as string[])[0]).toHaveLength(80)

    // A valid item that opens a pane opens ITS fixed pane, whatever URL the renderer sends.
    const denied = seam({ media: { microphone: 'denied' } })

    await actOnSetupSystemItem(denied.value, createSetupAttempts(), { item: 'microphone', url: 'https://evil.example' })
    expect(denied.calls.openExternal.mock.calls).toEqual([[SETUP_PANES.microphone]])
  })

  it('a failing macOS call is a status, never a throw', async () => {
    const { value } = seam({
      askMicrophone: async () => {
        throw new Error('tcc')
      }
    })

    await expect(actOnSetupSystemItem(value, createSetupAttempts(), { item: 'microphone' })).resolves.toHaveLength(3)
  })
})

const accepted = (over: Partial<ConsentRecord> = {}): ConsentRecord => ({
  schema: 1,
  policyVersion: BUNDLED_POLICY.version,
  policyEffective: BUNDLED_POLICY.effective,
  acceptedAt: '2026-10-17T00:00:00.000Z',
  permissions: { terminal: true },
  permissionsDecidedAt: '2026-10-17T00:00:00.000Z',
  skipped: false,
  aiProviderConsent: { accepted: true, at: '2026-10-17T00:00:00.000Z' },
  ...over
})

describe('V3-ON decisions live in consent.json (no second store)', () => {
  let dir: string
  let file: string
  const now = () => new Date('2026-10-22T10:00:00.000Z')

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'setup-'))
    file = path.join(dir, CONSENT_FILE)
  })

  afterEach(() => {
    resetConsentForTests()
    rmSync(dir, { force: true, recursive: true })
  })

  const onDisk = () => JSON.parse(readFileSync(file, 'utf8')) as ConsentRecord

  it('Done / Skip are stored per section in the same record; nothing else moves', () => {
    writeFileSync(file, JSON.stringify(accepted()))
    const store = createConsentStore(file, now)
    const result = store.setSetup({ sections: { packages: 'done', system: 'skipped', agent: 'done' } })

    expect(result.ok).toBe(true)
    expect(onDisk()).toEqual({
      ...accepted(),
      setup: {
        packages: { state: 'done', at: '2026-10-22T10:00:00.000Z' },
        system: { state: 'skipped', at: '2026-10-22T10:00:00.000Z' },
        agent: { state: 'done', at: '2026-10-22T10:00:00.000Z' }
      }
    })
  })

  it('a partial write keeps the other decisions; junk is refused', () => {
    writeFileSync(
      file,
      JSON.stringify(accepted({ setup: { agent: { state: 'skipped', at: '2026-10-20T00:00:00Z' } } }))
    )
    const store = createConsentStore(file, now)

    expect(store.setSetup({ sections: { system: 'done' } }).ok).toBe(true)
    expect(setupDecisions(onDisk())).toEqual({
      agent: { state: 'skipped', at: '2026-10-20T00:00:00Z' },
      system: { state: 'done', at: '2026-10-22T10:00:00.000Z' }
    })
    expect(store.setSetup({ sections: { system: 'yes', bogus: 'done' } }).ok).toBe(false)
    expect(store.setSetup(null).ok).toBe(false)
    expect(store.setSetup({ sections: ['done'] }).ok).toBe(false)
  })

  it('r2 M2: an unwritable consent.json answers ok:false (never throws), and the record stays as it was', () => {
    writeFileSync(file, JSON.stringify(accepted()))
    const store = createConsentStore(file, now)

    store.read()
    chmodSync(dir, 0o500)

    try {
      const result = store.setSetup({ sections: { agent: 'done' } })

      expect(result.ok).toBe(false)
    } finally {
      chmodSync(dir, 0o700)
    }

    expect(setupDecisions(onDisk())).toEqual({})
  })

  it('cannot be recorded before the policy is accepted', () => {
    expect(createConsentStore(file, now).setSetup({ sections: { agent: 'done' } }).ok).toBe(false)
  })

  it('upgrade from 0.0.2: a record without `setup` stays valid and reads as nothing decided', () => {
    writeFileSync(file, JSON.stringify(accepted()))
    const store = createConsentStore(file, now)

    expect(store.state()).toBe('ok')
    expect(setupDecisions(store.read())).toEqual({})
  })

  it('a malformed `setup` never invalidates the record (no policy re-ask): only that entry is undecided', () => {
    writeFileSync(
      file,
      JSON.stringify(
        accepted({ setup: { packages: { state: 'done', at: 'yesterday' }, system: 'x', agent: null } as never })
      )
    )
    const store = createConsentStore(file, now)

    expect(store.state()).toBe('ok')
    expect(setupDecisions(store.read())).toEqual({})
  })

  it('re-accepting a newer policy keeps the Set up decisions (and a never-decided record gets no key)', () => {
    writeFileSync(file, JSON.stringify(accepted({ setup: { agent: { state: 'done', at: '2026-10-20T00:00:00Z' } } })))
    createConsentStore(file, now).accept({ version: BUNDLED_POLICY.version })
    expect(setupDecisions(onDisk())).toEqual({ agent: { state: 'done', at: '2026-10-20T00:00:00Z' } })

    writeFileSync(file, JSON.stringify(accepted()))
    createConsentStore(file, now).accept({ version: BUNDLED_POLICY.version })
    expect(Object.hasOwn(onDisk(), 'setup')).toBe(false)
  })

  it('saving the Privacy switches or Allow always keeps the Set up decisions', () => {
    writeFileSync(file, JSON.stringify(accepted({ setup: { system: { state: 'done', at: '2026-10-20T00:00:00Z' } } })))
    const store = createConsentStore(file, now)

    store.setPermissions({ permissions: { terminal: false } })
    store.allowAlways('clipboard')
    expect(setupDecisions(onDisk())).toEqual({ system: { state: 'done', at: '2026-10-20T00:00:00Z' } })
  })

  it('r2 M1: the screen capture attempt is recorded once in consent.json and survives relaunch and re-accept', () => {
    writeFileSync(file, JSON.stringify(accepted()))
    const store = createConsentStore(file, now)

    expect(store.screenCaptureAttempted()).toBe(false)
    expect(store.markScreenCaptureAttempt().ok).toBe(true)
    expect(onDisk().screenCaptureAttemptedAt).toBe('2026-10-22T10:00:00.000Z')
    expect(createConsentStore(file, now).screenCaptureAttempted()).toBe(true)

    // A second mark keeps the first time; a policy re-accept keeps it.
    createConsentStore(file, () => new Date('2026-10-23T00:00:00.000Z')).markScreenCaptureAttempt()
    createConsentStore(file, now).accept({ version: BUNDLED_POLICY.version })
    expect(onDisk().screenCaptureAttemptedAt).toBe('2026-10-22T10:00:00.000Z')
  })

  it('every section name is known to both halves', () => {
    expect(SETUP_SECTIONS).toEqual(['packages', 'system', 'agent'])
  })
})

describe('V3-ON IPC is fail-closed behind the consent sender guard', () => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown

  function harness(trusted: boolean) {
    const handlers = new Map<string, Handler>()
    const ipcMain = { handle: (channel: string, listener: Handler) => void handlers.set(channel, listener) }
    const { value, calls } = seam()

    registerIcloneSetup({ ipcMain, isTrustedSender: () => trusted, system: value })

    return { handlers, calls }
  }

  it('a trusted sender reads and acts; an untrusted one gets null and nothing happens', async () => {
    const ok = harness(true)

    expect(await ok.handlers.get('iclone:setup:system')?.({})).toHaveLength(3)
    await ok.handlers.get('iclone:setup:system-act')?.({}, { item: 'microphone' })
    expect(ok.calls.askMicrophone).toHaveBeenCalledTimes(1)

    const no = harness(false)

    expect(await no.handlers.get('iclone:setup:system')?.({})).toBeNull()
    expect(await no.handlers.get('iclone:setup:system-act')?.({}, { item: 'microphone' })).toBeNull()
    expect(no.calls.askMicrophone).not.toHaveBeenCalled()
  })

  it('iclone:consent:setup is registered with the consent channels (same guard)', () => {
    const handlers = new Map<string, Handler>()

    registerIcloneConsent({
      ipcMain: { handle: (channel: string, listener: Handler) => void handlers.set(channel, listener) },
      isTrustedSender: () => false,
      keychainEncrypted: () => false,
      legalDir: '/nonexistent',
      openExternal: () => undefined,
      quit: () => undefined,
      userDataDir: mkdtempSync(path.join(tmpdir(), 'setup-ipc-'))
    })

    expect(handlers.get('iclone:consent:setup')?.({}, { sections: { agent: 'done' } })).toBeNull()
  })
})

describe('ON-4 — after Set up nothing asks again; after Skip everything asks exactly as before', () => {
  const mic = (status: string, consentOn = true) => {
    const ask = vi.fn(async () => true)

    return { ask, run: () => microphoneAccess({ consentOn, mac: true, status: () => status, ask }) }
  }

  it('microphone granted in Set up: voice input gets it without calling macOS at all', async () => {
    const { ask, run } = mic('granted')

    expect(await run()).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('microphone skipped (not decided): voice input asks macOS on use, as today', async () => {
    const { ask, run } = mic('not-determined')

    expect(await run()).toBe(true)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('microphone denied stays macOS’s answer (asked through the same call, which macOS answers without a dialog)', async () => {
    const { ask, run } = mic('denied')

    await run()
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('the Privacy switch OFF still declines before macOS', async () => {
    const { ask, run } = mic('granted', false)

    expect(await run()).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('an agent level chosen in Set up settles the door: Manual refuses and Ignore allows without an ask', () => {
    const call = { mode: 'manual' as const, cls: 'M' as const, fns: ['email' as const], classGranted: false }

    expect(decideFunctions({ ...call, levels: { email: 'manual' } }).outcome).toBe('refuse')
    expect(decideFunctions({ ...call, levels: { email: 'ignore' } }).outcome).toBe('allow')
  })

  it('agent levels skipped (shipped Follow mode over Manual): the agent asks on use, as today', () => {
    const decision = decideFunctions({
      mode: 'manual',
      cls: 'M',
      fns: ['email'],
      levels: { email: 'mode' },
      classGranted: false
    })

    expect(decision.outcome).toBe('ask')
  })
})

describe('r2 minor 4 — main validates Set up decisions with the shared function', () => {
  it('iclone-consent re-exports the shared validator (one function, not a copy)', async () => {
    const shared = await import('../src/iclone-shared/setup-decisions')

    expect(setupDecisions).toBe(shared.setupDecisions)
  })
})
