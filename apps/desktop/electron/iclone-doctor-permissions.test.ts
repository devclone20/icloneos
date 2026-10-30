/**
 * V3-FX FX-3: the permissions doctor acts on the item it flagged, and checks the identity that actually holds the
 * trust. Live finding (V3-ON): `permissions.open_privacy` always opened Privacy_Microphone, even when Screen was the
 * item flagged; `permissions.accessibility` checked the app's own trust, while computer use takes its Accessibility
 * trust on CuaDriver (com.trycua.driver — tools/computer_use/permissions.py), so the doctor reported the wrong thing
 * and its reset touched the wrong identity.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CHECKS, cuaDriverBinary, type DoctorEnv, type DoctorExec } from './iclone-doctor-checks'
import { FIXES } from './iclone-doctor-fixes'

const PRIVACY = 'x-apple.systempreferences:com.apple.preference.security?Privacy'

let root = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx3-'))
  // Hermetic: a cua-driver on this machine's PATH must not stand in for the test's own (m5 looks PATH up).
  vi.stubEnv('PATH', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

interface Call {
  file: string
  args: readonly string[]
  env?: NodeJS.ProcessEnv
}

function envWith(
  extra: Partial<DoctorEnv> = {},
  answer: (file: string, args: readonly string[]) => string = () => ''
): DoctorEnv & {
  calls: Call[]
} {
  const calls: Call[] = []

  const exec: DoctorExec = async (file, args, options) => {
    calls.push({ file, args, env: options.env })

    return { code: 0, stdout: answer(file, args), stderr: '', timedOut: false }
  }

  return {
    platform: 'darwin',
    home: path.join(root, 'home'),
    userData: path.join(root, 'userData'),
    hermesHome: path.join(root, 'hermes'),
    venvDir: path.join(root, 'venv'),
    icloneHome: path.join(root, 'iclone'),
    appBundle: null,
    packaged: false,
    mainPid: process.pid,
    bundleId: 'io.cloneframe.icloneos',
    crashDumpsDir: null,
    live: false,
    signal: new AbortController().signal,
    exec,
    now: () => 0,
    calls,
    ...extra
  }
}

const media = (denied: Partial<Record<'camera' | 'microphone' | 'screen', string>>) => ({
  mediaStatus: (kind: 'camera' | 'microphone' | 'screen') => denied[kind] ?? 'granted'
})

/** A CuaDriver binary where the official installer puts it (~/.local/bin/cua-driver). */
function installDriver(env: DoctorEnv): string {
  const file = path.join(env.home, '.local', 'bin', 'cua-driver')

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 })

  return file
}

describe('FX-3 permissions.open_privacy opens the pane of the flagged item', () => {
  it('Screen flagged → Screen Recording pane (not Microphone)', async () => {
    const steps = await FIXES.openPrivacy!(envWith({ electron: media({ screen: 'denied' }) }))

    expect(steps).toEqual([{ kind: 'open', url: `${PRIVACY}_ScreenCapture` }])
  })

  it('Microphone flagged → Microphone pane', async () => {
    const steps = await FIXES.openPrivacy!(envWith({ electron: media({ microphone: 'restricted' }) }))

    expect(steps).toEqual([{ kind: 'open', url: `${PRIVACY}_Microphone` }])
  })

  it('both flagged → the Microphone pane opens and the plan names Screen Recording too', async () => {
    const steps = await FIXES.openPrivacy!(envWith({ electron: media({ microphone: 'denied', screen: 'denied' }) }))

    expect(steps[0]).toEqual({ kind: 'open', url: `${PRIVACY}_Microphone` })
    expect(steps.slice(1)).toEqual([
      expect.objectContaining({ kind: 'advice', text: expect.stringContaining('Screen') })
    ])
  })

  it('nothing flagged → nothing to open', async () => {
    expect(await FIXES.openPrivacy!(envWith({ electron: media({}) }))).toEqual([])
  })
})

describe("FX-3 permissions.accessibility checks CuaDriver's trust, the identity computer use runs under", () => {
  it("the app's own trust no longer decides: CuaDriver granted → pass even when the app is untrusted", async () => {
    const env = envWith({}, () => JSON.stringify({ accessibility: true, screen_recording: true }))
    const driver = installDriver(env)

    expect(await CHECKS.accessibility!(env)).toMatchObject({ ok: true })
    expect(env.calls).toEqual([{ file: driver, args: ['permissions', 'status', '--json'], env: expect.any(Object) }])
  })

  it('CuaDriver not granted → the check fails and names CuaDriver', async () => {
    const env = envWith({}, () => JSON.stringify({ accessibility: false }))

    installDriver(env)

    const outcome = await CHECKS.accessibility!(env)

    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toMatch(/CuaDriver/)
  })

  it('no CuaDriver installed → skipped (computer use is not set up), never a fail', async () => {
    const env = envWith()

    expect(await CHECKS.accessibility!(env)).toMatchObject({ ok: 'skip' })
    expect(env.calls).toEqual([])
  })

  it('an unreadable answer → skipped, not a pass', async () => {
    const env = envWith({}, () => 'not json')

    installDriver(env)
    expect(await CHECKS.accessibility!(env)).toMatchObject({ ok: 'skip' })
  })

  it('the probe never hands the driver our environment (no provider keys to a third-party binary)', async () => {
    process.env.FX3_CANARY_KEY = 'sk-canary'

    try {
      const env = envWith({}, () => JSON.stringify({ accessibility: true }))

      installDriver(env)
      await CHECKS.accessibility!(env)
      expect(env.calls[0]?.env).toBeDefined()
      expect(JSON.stringify(env.calls[0]?.env)).not.toContain('sk-canary')
    } finally {
      delete process.env.FX3_CANARY_KEY
    }
  })
})

describe('FX-3 permissions.reset_accessibility resets the identity that holds the trust', () => {
  it("tccutil resets CuaDriver's Accessibility entry (com.trycua.driver) as well as the running app's (K144)", async () => {
    const steps = await FIXES.resetAccessibility!(envWith())

    expect(steps.map(step => (step.kind === 'exec' ? step.args : step))).toEqual([
      ['reset', 'Accessibility', 'io.cloneframe.icloneos'],
      ['reset', 'Accessibility', 'com.trycua.driver'],
      { kind: 'open', url: `${PRIVACY}_Accessibility` }
    ])
  })
})

describe('V3-FX m5: the driver is found where Hermes finds it', () => {
  it('a bare-name override and the default name are looked up on PATH; an absolute override is used as is', () => {
    const env = envWith()
    const bin = path.join(root, 'bin')

    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'cua-driver'), '#!/bin/sh\n', { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'my-driver'), '#!/bin/sh\n', { mode: 0o755 })

    expect(cuaDriverBinary(env, bin)).toBe(path.join(bin, 'cua-driver'))
    expect(cuaDriverBinary({ ...env, cuaDriverCmd: 'my-driver' }, bin)).toBe(path.join(bin, 'my-driver'))
    expect(cuaDriverBinary({ ...env, cuaDriverCmd: 'missing' }, bin)).toBeNull()
    expect(cuaDriverBinary({ ...env, cuaDriverCmd: path.join(bin, 'my-driver') }, '')).toBe(path.join(bin, 'my-driver'))
    expect(cuaDriverBinary(env, '')).toBeNull()
  })
})
