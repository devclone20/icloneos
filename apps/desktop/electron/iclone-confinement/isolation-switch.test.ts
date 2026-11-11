/**
 * F41: the switch. Off takes the user's click and main's native dialog, Cancel the default; on takes the click only.
 * The layer is the real createConfinement over a real signed settings file, so "off" here is what a spawn then reads.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { BrowserWindow, MessageBoxOptions } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SealedKeyStore } from './hardlinks'
import {
  confirmIsolationOffNatively,
  createIsolationSwitch,
  ISOLATION_OFF_AFTER,
  ISOLATION_OFF_LEAD,
  ISOLATION_OFF_STAYS,
  ISOLATION_OFF_STOPS,
  restartAgentInPlace
} from './isolation-switch'

import { type ConfinementDeps, createConfinement } from './index'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

const keyStore: SealedKeyStore = {
  seal: key => `kc:${key.toString('base64')}`,
  open: sealed => Buffer.from(sealed.slice(3), 'base64')
}

function layer(): ReturnType<typeof createConfinement> {
  return layerAt(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-switch-'))), keyStore)
}

/** One launch of the real layer over the folders in root: a second call on the same root is the relaunch. */
function layerAt(root: string, store: SealedKeyStore | null): ReturnType<typeof createConfinement> {
  dirs.push(root)
  fs.mkdirSync(path.join(root, 'home'), { recursive: true })

  return createConfinement({
    userDataDir: path.join(root, 'data'),
    home: path.join(root, 'home'),
    hermesHome: path.join(root, 'home', '.hermes'),
    hermesRoot: null,
    hermesPids: () => [],
    audit: () => [],
    ps: async () => [],
    platform: 'darwin',
    keyStore: store,
    gitIdentity: () => ({ name: '', email: '' })
  } satisfies ConfinementDeps)
}

const CLICK = { gesture: { activation: true, confirm: true } }

function world(over: { confirm?: boolean; input?: number; platform?: NodeJS.Platform } = {}) {
  const confinement = layer()
  const confirmOff = vi.fn(async () => over.confirm ?? true)
  const restartAgent = vi.fn(async () => 'done' as const)
  const record = vi.fn()
  const changed = vi.fn()

  const handler = createIsolationSwitch({
    layer: confinement,
    platform: over.platform ?? 'darwin',
    lastInputAt: () => over.input ?? Date.now(),
    confirmOff,
    restartAgent,
    record,
    changed
  })

  return { changed, confinement, confirmOff, handler, record, restartAgent }
}

describe('restarting the agent for a change of isolation (F41b)', () => {
  const run = (running: boolean, start: () => Promise<void> = async () => undefined) => {
    const order: string[] = []

    return {
      order,
      result: restartAgentInPlace({
        running: () => running,
        stop: async () => void order.push('stop'),
        start: async () => {
          order.push('start')
          await start()
        },
        restarted: () => order.push('restarted')
      })
    }
  }

  it('stops, starts, then tells the window it was a restart', async () => {
    const r = run(true)

    await expect(r.result).resolves.toBe('done')
    expect(r.order).toEqual(['stop', 'start', 'restarted'])
  })

  it('nothing running: stops the pool, starts nothing, still tells the window', async () => {
    const r = run(false)

    await expect(r.result).resolves.toBe('nothing-running')
    expect(r.order).toEqual(['stop', 'restarted'])
  })

  it('a failed start still tells the window, and the caller hears the failure', async () => {
    const r = run(true, async () => {
      throw new Error('no runtime')
    })

    await expect(r.result).rejects.toThrow('no runtime')
    expect(r.order).toEqual(['stop', 'start', 'restarted'])
  })
})

describe('the isolation switch', () => {
  it('off after the dialog: main writes it, a spawn then has no sandbox, the agent restarts, the change is logged', async () => {
    const w = world()

    expect(w.confinement.spawnEnv().ICLONE_RUNTIME_CONFINED).toBe('1')
    await expect(w.handler({}, { enabled: false, ...CLICK })).resolves.toEqual({ ok: true, on: false, restart: 'done' })

    expect(w.confirmOff).toHaveBeenCalledOnce()
    expect(w.restartAgent).toHaveBeenCalledOnce()
    expect(w.record.mock.calls[0]?.[0].reason).toContain('turned off')
    expect(w.changed).toHaveBeenCalled()
    expect(w.confinement.settings().enabled).toBe(false)
    expect(w.confinement.runtimeConfined()).toBe(false)
    // No profile, launcher, pin or hand-over: only the state itself.
    expect(w.confinement.spawnEnv()).toEqual({ ICLONE_CONFINEMENT: 'off' })
  })

  it('Cancel changes nothing and restarts nothing', async () => {
    const w = world({ confirm: false })

    await expect(w.handler({}, { enabled: false, ...CLICK })).resolves.toEqual({ ok: false, on: true, reason: 'cancelled' })
    expect(w.confinement.settings().enabled).toBe(true)
    expect(w.confinement.spawnEnv().ICLONE_CONFINEMENT).toBe('1')
    expect(w.restartAgent).not.toHaveBeenCalled()
    expect(w.record).not.toHaveBeenCalled()
  })

  it('on is one click: no dialog, and the sandbox is back for the next spawn', async () => {
    const w = world()

    await w.handler({}, { enabled: false, ...CLICK })
    w.confirmOff.mockClear()
    w.restartAgent.mockClear()

    await expect(w.handler({}, { enabled: true, ...CLICK })).resolves.toEqual({ ok: true, on: true, restart: 'done' })
    expect(w.confirmOff).not.toHaveBeenCalled()
    expect(w.restartAgent).toHaveBeenCalledOnce()
    expect(w.confinement.spawnEnv().TERMINAL_ENV).toBe('iclone_seatbelt')
  })

  it.each([
    ['no gesture field', { enabled: false }],
    ['a gesture the preload did not mark', { enabled: false, gesture: { activation: true, confirm: false } }],
    ['a script click', { enabled: false, gesture: { activation: false, confirm: true } }]
  ])('%s: refused before any dialog', async (_name, input) => {
    const w = world()

    await expect(w.handler({}, input)).resolves.toMatchObject({ ok: false, reason: 'no-gesture' })
    expect(w.confirmOff).not.toHaveBeenCalled()
    expect(w.confinement.settings().enabled).toBe(true)
  })

  it('no input reached this window just now: refused, whatever the payload says', async () => {
    const w = world({ input: Date.now() - 60_000 })

    await expect(w.handler({}, { enabled: false, ...CLICK })).resolves.toMatchObject({ ok: false, reason: 'no-gesture' })
    expect(w.confinement.settings().enabled).toBe(true)
  })

  it('anything but a boolean is invalid, another platform has no switch', async () => {
    await expect(world().handler({}, { enabled: 'false', ...CLICK })).resolves.toMatchObject({ ok: false, reason: 'invalid' })
    await expect(world({ platform: 'linux' }).handler({}, { enabled: false, ...CLICK })).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported'
    })
  })

  it('no dialog wired: it cannot go off', async () => {
    const confinement = layer()

    const handler = createIsolationSwitch({
      layer: confinement,
      platform: 'darwin',
      lastInputAt: () => Date.now(),
      record: () => undefined,
      changed: () => undefined
    })

    await expect(handler({}, { enabled: false, ...CLICK })).resolves.toMatchObject({ ok: false, reason: 'cancelled' })
    expect(confinement.settings().enabled).toBe(true)
  })

  it('a signed off saved while it was off and put back after the click on is not believed', async () => {
    const w = world()
    const file = path.join(path.dirname(w.confinement.paths.profilesDir), 'settings.json')

    expect(fs.existsSync(file)).toBe(false)
    await w.handler({}, { enabled: false, ...CLICK })
    const signedOff = fs.readFileSync(file)

    await w.handler({}, { enabled: true, ...CLICK })
    fs.writeFileSync(file, signedOff)

    expect(w.confinement.settings().enabled).toBe(true)
    expect(w.confinement.spawnEnv().ICLONE_CONFINEMENT).toBe('1')
  })

  it('with the keychain on, a relaunch still reads off: the same key opens the same signed file (F41b, stand-in key store)', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-relaunch-')))
    const first = layerAt(root, keyStore)

    expect(first.settingsPersist()).toBe(true)
    first.setEnabled(false)
    const next = layerAt(root, keyStore)

    expect(next.settingsPersist()).toBe(true)
    expect(next.settings().enabled).toBe(false)
    expect(next.spawnEnv().ICLONE_CONFINEMENT).toBe('off')
    next.setEnabled(true)
    expect(layerAt(root, keyStore).settings().enabled).toBe(true)
  })

  it('with the keychain off, a relaunch is on again, and a keychain that no longer opens the key is on again', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-relaunch-')))

    const before = layerAt(root, keyStore)

    before.setEnabled(false)
    const file = path.join(path.dirname(before.paths.profilesDir), 'settings.json')
    const signedOff = fs.readFileSync(file, 'utf8')
    const noKeychain = layerAt(root, null)

    expect(noKeychain.settingsPersist()).toBe(false)
    // The old off does not linger under a session key: the file is written again with the defaults.
    expect(fs.readFileSync(file, 'utf8')).not.toBe(signedOff)
    expect(noKeychain.settings().enabled).toBe(true)
    expect(noKeychain.spawnEnv().ICLONE_CONFINEMENT).toBe('1')

    const again = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-relaunch-')))

    layerAt(again, keyStore).setEnabled(false)

    const broken = layerAt(again, {
      seal: keyStore.seal,
      open: () => {
        throw new Error('the keychain says no')
      }
    })

    expect(broken.settings().enabled).toBe(true)
  })

  it('a restart that fails still reports the new state', async () => {
    const w = world()

    w.restartAgent.mockRejectedValueOnce(new Error('no runtime'))
    await expect(w.handler({}, { enabled: false, ...CLICK })).resolves.toEqual({
      ok: true,
      on: false,
      restart: 'failed',
      error: 'no runtime'
    })
  })
})

describe('the native dialog', () => {
  /** A dialog that records the options it was given, whichever overload main calls. */
  function dialog(response: number) {
    const calls: MessageBoxOptions[] = []

    const showMessageBox = async (first: BrowserWindow | MessageBoxOptions, second?: MessageBoxOptions) => {
      calls.push(second ?? (first as MessageBoxOptions))

      return { response, checkboxChecked: false }
    }

    return { box: { showMessageBox } satisfies Parameters<typeof confirmIsolationOffNatively>[0], calls }
  }

  it('Cancel is the default and the Escape answer, and only the second button turns it off', async () => {
    const cancel = dialog(0)

    await expect(confirmIsolationOffNatively(cancel.box, null, true)).resolves.toBe(false)
    const options = cancel.calls[0]!

    expect(options.buttons).toEqual(['Cancel', 'Turn isolation off'])
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(0)
    await expect(confirmIsolationOffNatively(dialog(1).box, null, true)).resolves.toBe(true)
  })

  it('says plainly what is lost, other processes being read included, and how far what stays goes', async () => {
    const shown = dialog(0)

    await confirmIsolationOffNatively(shown.box, null, false)
    const { detail } = shown.calls[0]!

    for (const line of [...ISOLATION_OFF_STOPS, ...ISOLATION_OFF_STAYS, ISOLATION_OFF_LEAD, ISOLATION_OFF_AFTER]) {
      expect(detail).toContain(line)
    }

    // The facts the owner is owed, pinned to the exact lines the dialog is built from.
    expect(ISOLATION_OFF_STOPS).toContain(
      'They can read what your other programs were started with and their environment, this app\u2019s runtime included. Those can hold secrets.'
    )
    expect(ISOLATION_OFF_STAYS).toContain('These are checks in the app, not the kernel: a determined program can go round them.')
    expect(ISOLATION_OFF_AFTER).toBe(
      'Turning it back on does not undo this. A program started while it was off can keep running, and what it did stays: changed files, copied secrets, things left to run later.'
    )
    expect(detail).toContain('comes back on when you quit')
  })
})
