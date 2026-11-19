// v0.0.9 W1b — the voice extra installs APP-SIDE, only on the owner's click, into the app's private dependency home.
// Throwaway HOME only (a temp folder stands in for the user's home, its ~/.hermes, and the runtime). The installer
// child is a fake that does what PM does on success (a new generation carrying `faster_whisper`), so the real logic —
// paths, env, gesture, refusals — runs without Python or network. Red on the old code: none of this existed (lazy
// installs were simply off, so voice could never be installed for the managed runtime).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createVoiceExtra,
  registerVoiceExtraIpc,
  voiceExtraCommand,
  type VoiceExtraDeps,
  voiceExtraInVenv,
  voiceExtraSupported
} from './voice-extra'

interface Lab {
  root: string
  userHermes: string
  runtime: string
  priv: { hermesHome: string; home: string }
  venv: string | null
  runs: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[]
}

let lab: Lab

function generation(name: string, withVoice: boolean): string {
  const venv = path.join(lab.priv.hermesHome, 'installs', 'k', 'environments', name, 'venv')

  fs.mkdirSync(path.join(venv, 'lib', 'python3.11', 'site-packages'), { recursive: true })

  if (withVoice) {
    fs.mkdirSync(path.join(venv, 'lib', 'python3.11', 'site-packages', 'faster_whisper'))
  }

  return venv
}

function deps(over: Partial<VoiceExtraDeps> = {}): VoiceExtraDeps {
  return {
    runtimeRoot: () => lab.runtime,
    privateDependencies: () => lab.priv,
    committedVenv: () => lab.venv,
    venvPython: venv => path.join(venv, 'bin', 'python'),
    run: async (cmd, args, opts) => {
      lab.runs.push({ cmd, args, env: opts.env })
      // What PM's explicit install does on success: commit a new generation that carries the extra.
      lab.venv = generation('g2', true)

      return { code: 0 }
    },
    baseEnv: () => ({ HOME: path.join(lab.root, 'home'), HERMES_HOME: lab.userHermes, PATH: '/usr/bin' }),
    platform: 'darwin',
    arch: 'arm64',
    log: () => undefined,
    ...over
  }
}

beforeEach(() => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w1b-voice-')))
  const runtime = path.join(root, 'ud', 'hermes-runtime', 'abc')

  lab = {
    root,
    userHermes: path.join(root, 'home', '.hermes'),
    runtime,
    priv: {
      hermesHome: path.join(runtime, '.iclone-deps', 'hermes'),
      home: path.join(runtime, '.iclone-deps', 'home')
    },
    venv: null,
    runs: []
  }
  fs.mkdirSync(lab.userHermes, { recursive: true })
  lab.venv = generation('g1', false)
})

afterEach(() => fs.rmSync(lab.root, { force: true, recursive: true }))

describe('platform gate and detection', () => {
  it('mirrors the runtime gate: not on macOS Intel, not on Windows ARM', () => {
    expect(voiceExtraSupported('darwin', 'arm64')).toBe(true)
    expect(voiceExtraSupported('linux', 'x64')).toBe(true)
    expect(voiceExtraSupported('darwin', 'x64')).toBe(false)
    expect(voiceExtraSupported('win32', 'arm64')).toBe(false)
  })

  it('reads the anchor module in the committed environment only', () => {
    expect(voiceExtraInVenv(lab.venv, 'darwin')).toBe(false)
    expect(voiceExtraInVenv(generation('g9', true), 'darwin')).toBe(true)
    expect(voiceExtraInVenv(null, 'darwin')).toBe(false)
  })
})

describe('the install command', () => {
  it('is the runtime explicit installer with the PRIVATE homes and the pin, never the user HERMES_HOME', () => {
    const { cmd, args, env } = voiceExtraCommand({
      baseEnv: { HOME: '/Users/me', HERMES_HOME: '/Users/me/.hermes', PATH: '/usr/bin', EVIL: '1' },
      priv: lab.priv,
      python: '/rt/venv/bin/python',
      sealEnv: base => ({ HOME: base.HOME, HERMES_HOME: base.HERMES_HOME, PATH: base.PATH })
    })

    expect(cmd).toBe('/rt/venv/bin/python')
    expect(args).toEqual([
      '-s',
      '-P',
      '--check-hash-based-pycs',
      'always',
      '-m',
      'hermes_cli.main',
      'pm',
      'install',
      '--extra',
      'stt-whisper'
    ])
    expect(env.HOME).toBe(lab.priv.home)
    expect(env.HERMES_HOME).toBe(lab.priv.hermesHome)
    expect(env.HERMES_DEPENDENCY_HOME).toBe(lab.priv.hermesHome)
    expect(env.PYTHONDONTWRITEBYTECODE).toBe('1')
    expect(env.EVIL).toBeUndefined()
    expect(Object.values(env)).not.toContain('/Users/me/.hermes')
  })
})

describe('createVoiceExtra', () => {
  it('absent, one install, installed (restart needed); nothing under the user ~/.hermes/installs', async () => {
    const voice = createVoiceExtra(deps())

    expect(voice.status()).toEqual({ state: 'absent' })

    const answer = await voice.install()

    expect(answer).toEqual({ ok: true, status: { state: 'installed', restartNeeded: true } })
    expect(lab.runs).toHaveLength(1)
    expect(lab.runs[0].env.HERMES_HOME).toBe(lab.priv.hermesHome)
    expect(voice.status()).toEqual({ state: 'installed', restartNeeded: true })
    expect(fs.existsSync(path.join(lab.userHermes, 'installs'))).toBe(false)
  })

  it('one install at a time: a second click while one runs is refused busy (no second child)', async () => {
    let release: () => void = () => undefined
    const voice = createVoiceExtra(
      deps({
        run: (cmd, args, opts) =>
          new Promise(resolve => {
            lab.runs.push({ cmd, args, env: opts.env })
            release = () => {
              lab.venv = generation('g2', true)
              resolve({ code: 0 })
            }
          })
      })
    )

    const first = voice.install()

    expect(voice.status()).toEqual({ state: 'installing' })
    expect(await voice.install()).toEqual({ ok: false, refused: 'busy' })
    release()
    expect(await first).toMatchObject({ ok: true })
    expect(lab.runs).toHaveLength(1)
  })

  it('already installed: nothing runs', async () => {
    lab.venv = generation('g1b', true)

    const voice = createVoiceExtra(deps())

    expect(await voice.install()).toEqual({ ok: true, status: { state: 'installed' } })
    expect(lab.runs).toHaveLength(0)
  })

  it('no app-managed runtime (dev layout) or an unsupported Mac: refused, nothing runs', async () => {
    expect(await createVoiceExtra(deps({ privateDependencies: () => null })).install()).toEqual({
      ok: false,
      refused: 'unmanaged'
    })
    expect(createVoiceExtra(deps({ privateDependencies: () => null })).status()).toEqual({ state: 'unmanaged' })
    expect(await createVoiceExtra(deps({ arch: 'x64' })).install()).toEqual({ ok: false, refused: 'unsupported' })
    expect(lab.runs).toHaveLength(0)
  })

  it('packaged: a runtime that fails its integrity check runs nothing', async () => {
    const voice = createVoiceExtra(
      deps({
        verifyRuntime: async () => {
          throw new Error('manifest mismatch')
        }
      })
    )

    expect(await voice.install()).toMatchObject({ ok: false, error: expect.stringMatching(/integrity/) })
    expect(lab.runs).toHaveLength(0)
  })

  it('a failed or timed-out install says so and stays absent', async () => {
    const failed = createVoiceExtra(deps({ run: async () => ({ code: 1 }) }))

    expect(await failed.install()).toMatchObject({ ok: false, error: expect.stringMatching(/exit 1/) })
    expect(failed.status()).toEqual({ state: 'absent' })

    const timedOut = createVoiceExtra(deps({ run: async () => ({ code: null }) }))

    expect(await timedOut.install()).toMatchObject({ ok: false, error: expect.stringMatching(/time limit/) })
  })
})

describe('registerVoiceExtraIpc — the owner’s own click', () => {
  const NOW = 1_000_000

  function wire(trusted = true, lastInputAt = NOW - 100) {
    const handlers = new Map<string, (event: unknown, input: unknown) => unknown>()
    const voice = {
      status: vi.fn(() => ({ state: 'absent' as const })),
      install: vi.fn(async () => ({ ok: true as const, status: { state: 'installed' as const } }))
    }

    registerVoiceExtraIpc({
      voice,
      handle: (channel, handler) => handlers.set(channel, handler as never),
      isTrustedSender: () => trusted,
      lastInputAt: () => lastInputAt,
      now: () => NOW
    })

    return { call: (channel: string, input?: unknown) => handlers.get(channel)!({ sender: {} }, input), voice }
  }

  it('without the gesture: refused, nothing installs', async () => {
    const { call, voice } = wire()

    expect(await call('iclone:voice-extra:install', {})).toEqual({ ok: false, refused: 'gesture' })
    expect(await call('iclone:voice-extra:install', { gesture: { activation: true, confirm: false } })).toEqual({
      ok: false,
      refused: 'gesture'
    })
    expect(await call('iclone:voice-extra:install', { gesture: { activation: false, confirm: true } })).toEqual({
      ok: false,
      refused: 'gesture'
    })
    expect(voice.install).not.toHaveBeenCalled()
  })

  it('tests-perf 11: activation + confirm but the last real input is a minute old: refused, nothing installs', async () => {
    const { call, voice } = wire(true, NOW - 60_000)

    expect(await call('iclone:voice-extra:install', { gesture: { activation: true, confirm: true } })).toEqual({
      ok: false,
      refused: 'gesture'
    })
    expect(voice.install).not.toHaveBeenCalled()
  })

  it('with activation + the lock’s confirm + recent real input: installs once', async () => {
    const { call, voice } = wire()

    expect(await call('iclone:voice-extra:install', { gesture: { activation: true, confirm: true } })).toMatchObject({
      ok: true
    })
    expect(voice.install).toHaveBeenCalledTimes(1)
  })

  it('a sender the app guard refuses gets null on both channels', async () => {
    const { call, voice } = wire(false)

    expect(await call('iclone:voice-extra:status')).toBeNull()
    expect(await call('iclone:voice-extra:install', { gesture: { activation: true, confirm: true } })).toBeNull()
    expect(voice.install).not.toHaveBeenCalled()
  })
})
