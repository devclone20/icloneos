/**
 * V3-FX FX-4 (desktop side): the app never asks the backend to arm the wake word while the owner switched the
 * microphone off on the consent sheet / Settings › Privacy — the same switch the app's own voice input obeys. Every
 * path that sends `wake.start` (auto-arm, the composer toggle, the post-voice re-arm) checks it first. The backend
 * enforces the same switch on its own (plugins/iclone-consent); this keeps the desktop from even asking.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $wakeWord,
  armWakeWord,
  microphoneSwitchedOff,
  resetWakeWordState,
  resumeWakeAfterVoice,
  toggleWakeWord,
  type WakeRequester
} from './wake-word'

vi.mock('@/lib/wake-client-capture', () => ({
  startClientWakeCapture: vi.fn(async () => ({ stop: vi.fn() }))
}))

type DesktopWindow = { hermesDesktop?: Record<string, unknown> }

const consentWith = (microphone: boolean | undefined) => {
  const host = window as unknown as DesktopWindow

  host.hermesDesktop = {
    ...host.hermesDesktop,
    icloneConsent: {
      get: vi.fn(async () => ({
        state: 'ok',
        record: { permissions: microphone === undefined ? {} : { microphone } }
      }))
    }
  }
}

function backend(): { calls: string[]; request: WakeRequester } {
  const calls: string[] = []

  const request = (async (method: string) => {
    calls.push(method)

    if (method === 'wake.status') {
      return { available: true, enabled: true, listening: false }
    }

    if (method === 'wake.start') {
      return { started: true, capture: 'local' }
    }

    return {}
  }) as WakeRequester

  return { calls, request }
}

beforeEach(() => resetWakeWordState())

afterEach(() => {
  delete (window as unknown as DesktopWindow).hermesDesktop?.icloneConsent
  vi.useRealTimers()
})

describe('FX-4: the microphone switch OFF means no wake.start from the desktop', () => {
  it('reads the switch: only an explicit OFF counts (undecided is not off, as in the app)', async () => {
    consentWith(false)
    expect(await microphoneSwitchedOff()).toBe(true)
    consentWith(true)
    expect(await microphoneSwitchedOff()).toBe(false)
    consentWith(undefined)
    expect(await microphoneSwitchedOff()).toBe(false)
  })

  it('auto-arm: off → never wake.start', async () => {
    consentWith(false)
    const { calls, request } = backend()

    await armWakeWord(request)
    expect(calls).not.toContain('wake.start')
    expect($wakeWord.get().listening).toBe(false)
  })

  it('the composer toggle: off → never wake.start, and the tooltip says why', async () => {
    consentWith(false)
    const { calls, request } = backend()

    await toggleWakeWord(request)
    expect(calls).not.toContain('wake.start')
    expect($wakeWord.get().notice).toMatch(/microphone is switched off/i)
    expect($wakeWord.get().pending).toBe(false)
  })

  it('the post-voice re-arm: off → never wake.start', async () => {
    consentWith(false)
    const { calls, request } = backend()

    await resumeWakeAfterVoice(request)
    expect(calls).not.toContain('wake.start')
  })

  it('on: every path arms as before', async () => {
    consentWith(true)

    for (const run of [armWakeWord, toggleWakeWord, resumeWakeAfterVoice]) {
      resetWakeWordState()
      const { calls, request } = backend()

      await run(request)
      expect(calls).toContain('wake.start')
    }
  })
})

describe('FX-4: every renderer site that sends wake.start reads the switch first (structural)', () => {
  it("each non-test module with a 'wake.start' request also checks microphoneSwitchedOff / startWake", () => {
    const SRC = join(__dirname, '..')

    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory()
          ? files(join(dir, entry.name))
          : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !/\.(d|generated)\.ts$/.test(entry.name)
            ? [join(dir, entry.name)]
            : []
      )

    const senders = files(SRC).filter(file => /['"]wake\.start['"]/.test(readFileSync(file, 'utf8')))
    const unguarded = senders.filter(file => !/microphoneSwitchedOff\(|startWake\(/.test(readFileSync(file, 'utf8')))

    expect(senders.map(file => relative(SRC, file)).sort()).toEqual([
      'app/session/hooks/use-prompt-actions/slash.ts',
      'store/wake-word.ts'
    ])
    expect(unguarded).toEqual([])
  })
})
