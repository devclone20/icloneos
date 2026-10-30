import { readFileSync } from 'node:fs'

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $desktopBoot } from '@/store/boot'
import { $gatewaySwitching } from '@/store/gateway-switch'
import { $desktopOnboarding } from '@/store/onboarding'
import { setGatewayState } from '@/store/session'

import { BootFailureOverlay } from './boot-failure-overlay'
import {
  BOOT_WORD,
  BOOT_WORD_LEGIBLE_PREFIX,
  COLD_BOOT_DONE_KEY,
  GatewayConnectingOverlay
} from './gateway-connecting-overlay'

// Repro for the "remote gateway → stuck on CONNECTING, no way to settings"
// report. The connecting overlay (full-screen, pointer-events on) used
// to be shown whenever `gatewayState !== 'open' && !boot.error`. The ONLY escape
// hatch — BootFailureOverlay, which has "Use local gateway" / "Sign in" /
// "Retry" — only renders when `boot.error` is set.
//
// useGatewayBoot only calls failDesktopBoot() (which sets boot.error) when the
// INITIAL boot() throws. After the first successful connect (bootCompleted),
// any later socket drop goes through scheduleReconnect(), which loops FOREVER
// against the dead remote. So gatewayState sits at 'closed'/'error' with
// boot.error null. The fix keeps the initial-boot overlay out of post-boot
// reconnects, leaving chat/settings usable while the reconnect loop runs.

function resetStores() {
  window.sessionStorage.removeItem(COLD_BOOT_DONE_KEY)
  setGatewayState('idle')
  $gatewaySwitching.set(false)
  $desktopBoot.set({
    error: null,
    fakeMode: false,
    message: 'ready',
    phase: 'renderer.ready',
    progress: 100,
    running: false,
    timestamp: Date.now(),
    visible: false
  })
  $desktopOnboarding.set({
    configured: true,
    flow: { status: 'idle' },
    mode: 'oauth',
    providers: null,
    reason: null,
    requested: false,
    firstRunSkipped: false,
    manual: false,
    localEndpoint: false
  })
}

beforeEach(resetStores)
afterEach(cleanup)

// The connecting overlay renders the boot word's legible first word + a
// scrambled tail inside one span; match that node specifically so the recovery
// overlay's "Lost connection…" copy doesn't read as a false positive. Built
// from BOOT_WORD so a word change can't leave these negatives passing vacuously
// (the positive twin is in 'the boot screen' below).
const BOOT_WORD_NODE = new RegExp(
  `^${BOOT_WORD.slice(0, BOOT_WORD_LEGIBLE_PREFIX)}[ /\\\\|\\-_=+<>~:*&A-Za-z]{${BOOT_WORD.length - BOOT_WORD_LEGIBLE_PREFIX}}$`
)

// The word as drawn: the span's own text nodes only — DecodeText also nests the
// cursor's <style> and dither square inside it, which are not the word.
function bootWordText(): string | null {
  const node = window.document.querySelector('[data-boot-word]')

  return node
    ? Array.from(node.childNodes)
        .filter(child => child.nodeType === Node.TEXT_NODE)
        .map(child => child.textContent)
        .join('')
    : null
}

const isConnectingShown = () => BOOT_WORD_NODE.test(bootWordText() ?? '')

const isRecoveryShown = () =>
  Boolean(screen.queryByText(/use local gateway/i) || screen.queryByText(/retry/i) || screen.queryByText(/sign in/i))

describe('connecting overlay vs recovery surface', () => {
  it('hard initial-boot failure surfaces the recovery overlay (the working path)', async () => {
    // failDesktopBoot() ran: error set, gateway never opened.
    $desktopBoot.set({
      ...$desktopBoot.get(),
      error: 'Hermes backend did not become ready',
      running: false,
      visible: true
    })
    setGatewayState('error')

    await act(async () => {
      render(
        <>
          <GatewayConnectingOverlay />
          <BootFailureOverlay />
        </>
      )
    })

    expect(isRecoveryShown()).toBe(true)
    // Connecting overlay bows out when boot.error is set.
    expect(isConnectingShown()).toBe(false)
  })

  it('post-boot socket drops do not re-cover the app with the initial CONNECTING overlay', async () => {
    // 1. Initial boot succeeded: gateway opened, boot completed (no error).
    setGatewayState('open')

    let rerender!: (ui: React.ReactElement) => void
    await act(async () => {
      const result = render(
        <>
          <GatewayConnectingOverlay />
          <BootFailureOverlay />
        </>
      )

      rerender = result.rerender
    })

    expect(isConnectingShown()).toBe(false)

    // 2. The remote VPS socket drops (sleep/wake, remote restart, network).
    //    bootCompleted is true, so useGatewayBoot routes this through
    //    scheduleReconnect() — boot.error stays NULL.
    await act(async () => {
      setGatewayState('closed')
      rerender!(
        <>
          <GatewayConnectingOverlay />
          <BootFailureOverlay />
        </>
      )
    })

    // The initial-boot connecting overlay stays out of the way, so settings and
    // the composer remain reachable during the reconnect loop.
    expect(isConnectingShown()).toBe(false)
    expect(isRecoveryShown()).toBe(false)

    // 3. Reconnect loops against the dead remote: gatewayState bounces closed
    //    → error → closed. Until the escalation path sets boot.error, the app
    //    remains usable instead of modal-blocked.
    await act(async () => {
      setGatewayState('error')
      rerender!(
        <>
          <GatewayConnectingOverlay />
          <BootFailureOverlay />
        </>
      )
    })
    expect($desktopBoot.get().error).toBeNull()
    expect(isConnectingShown()).toBe(false)
    expect(isRecoveryShown()).toBe(false)
  })

  it('soft gateway switch keeps the shell — no fullscreen CONNECTING', async () => {
    setGatewayState('open')

    const { rerender } = render(
      <>
        <GatewayConnectingOverlay />
        <BootFailureOverlay />
      </>
    )

    await act(async () => {
      $gatewaySwitching.set(true)
      $desktopBoot.set({
        ...$desktopBoot.get(),
        running: true,
        visible: true,
        progress: 4,
        error: null
      })
      setGatewayState('closed')
      rerender(
        <>
          <GatewayConnectingOverlay />
          <BootFailureOverlay />
        </>
      )
    })

    expect(isConnectingShown()).toBe(false)
    expect(isRecoveryShown()).toBe(false)
  })

  it('FIX: confirmed reauth boot.error still surfaces the recovery overlay (not CONNECTING)', async () => {
    // Transport blips no longer set boot.error (toast + background retry).
    // Confirmed OAuth reauth still does — and that recovery surface must win
    // over any residual connecting state so Sign-in / Gateway settings stay reachable.
    setGatewayState('error')
    $desktopBoot.set({
      ...$desktopBoot.get(),
      error: 'Your remote gateway session has expired. Sign in again.',
      running: false,
      visible: true
    })

    await act(async () => {
      render(
        <>
          <GatewayConnectingOverlay />
          <BootFailureOverlay />
        </>
      )
    })

    // Escape hatch is reachable; the connecting overlay bows out.
    expect(isRecoveryShown()).toBe(true)
    expect(screen.getByRole('button', { name: /gateway settings/i })).toBeTruthy()
    expect(isConnectingShown()).toBe(false)
  })
})

describe('connecting overlay across a renderer reload', () => {
  const isMaskRaised = () => window.window.document.querySelector('[data-glass-opaque]') !== null

  function bootStarting() {
    $desktopBoot.set({ ...$desktopBoot.get(), progress: 2, running: true, visible: true })
    setGatewayState('connecting')
  }

  it('masks the very first boot until the gateway opens', async () => {
    bootStarting()

    await act(async () => {
      render(<GatewayConnectingOverlay />)
    })

    expect(isMaskRaised()).toBe(true)
  })

  it('does not raise the mask again on a reload after a completed boot', async () => {
    setGatewayState('open')

    await act(async () => {
      render(<GatewayConnectingOverlay />)
    })
    cleanup()

    // The reload: a fresh mount, boot progress back at the start, socket down.
    bootStarting()

    await act(async () => {
      render(<GatewayConnectingOverlay />)
    })

    expect(isMaskRaised()).toBe(false)
  })
})

describe('the boot screen', () => {
  // Read from disk: the ui project stubs CSS imports to ''.
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  const rule = (css: string, selector: string) =>
    new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1]?.trim() ?? null

  function bootStarting() {
    $desktopBoot.set({ ...$desktopBoot.get(), progress: 2, running: true, visible: true })
    setGatewayState('connecting')
  }

  function reducedMotion(reduce: boolean) {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: reduce && query.includes('prefers-reduced-motion'),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
          onchange: null
        }) as MediaQueryList
    )
  }

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('says GODS & ROBOTS — the first word legible, the rest decoding, spaces and length kept', async () => {
    reducedMotion(false)
    vi.useFakeTimers()
    bootStarting()

    await act(async () => {
      render(<GatewayConnectingOverlay />)
    })

    expect(BOOT_WORD).toBe('GODS & ROBOTS')
    expect(bootWordText()).toBe(BOOT_WORD)

    // Mid-decode: a few 45 ms ticks in, the tail is glyph noise but GODS and
    // both spaces hold their places, so the word never changes width or wraps.
    const frames = new Set<string>()

    for (let tick = 0; tick < 6; tick += 1) {
      await act(async () => {
        vi.advanceTimersByTime(45)
      })
      const frame = bootWordText() ?? ''

      frames.add(frame)
      expect(frame).toHaveLength(BOOT_WORD.length)
      expect(frame.slice(0, BOOT_WORD_LEGIBLE_PREFIX)).toBe('GODS')
      expect(frame[4]).toBe(' ')
      expect(frame[6]).toBe(' ')
    }

    expect([...frames].some(frame => frame !== BOOT_WORD)).toBe(true)
    expect(isConnectingShown()).toBe(true)

    // It resolves: the 9-glyph tail at half a glyph per tick lands on the word
    // by tick 18 and holds it for 16 more.
    let resolved = false

    for (let tick = 6; tick < 26; tick += 1) {
      await act(async () => {
        vi.advanceTimersByTime(45)
      })
      resolved ||= bootWordText() === BOOT_WORD
    }

    expect(resolved).toBe(true)
  })

  it('tells assistive tech the state (Connecting), not the decode noise', async () => {
    reducedMotion(false)
    bootStarting()

    await act(async () => {
      render(<GatewayConnectingOverlay />)
    })

    const status = screen.getByRole('status')

    expect(status.getAttribute('aria-busy')).toBe('true')
    expect(status.textContent).toContain('Connecting')
    expect(window.document.querySelector('[data-boot-word]')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('under reduced motion shows the resolved word and never scrambles it', async () => {
    reducedMotion(true)
    vi.useFakeTimers()
    bootStarting()

    await act(async () => {
      render(<GatewayConnectingOverlay />)
    })

    for (let tick = 0; tick < 20; tick += 1) {
      await act(async () => {
        vi.advanceTimersByTime(45)
      })
      expect(bootWordText()).toBe(BOOT_WORD)
    }
  })

  it('draws the word as written (the constant decides its case)', async () => {
    reducedMotion(false)
    bootStarting()

    await act(async () => {
      render(<GatewayConnectingOverlay />)
    })

    const classes = window.document.querySelector('[data-boot-word]')?.className.split(/\s+/) ?? []

    expect(classes).toContain('normal-case')
    expect(classes).not.toContain('uppercase')
    expect(classes).toContain('whitespace-pre')
  })

  it('stands on pure black: the void stage, never the bloom backdrop', async () => {
    reducedMotion(false)
    bootStarting()

    await act(async () => {
      render(<GatewayConnectingOverlay />)
    })

    const stage = window.document.querySelector('[data-boot-void]')
    const classes = stage?.className.split(/\s+/) ?? []

    expect(classes).toContain('ic-sys-void')
    expect(classes).not.toContain('ic-sys-backdrop')

    const systemCss = read('./ic/ic-system.css')
    const tokensCss = read('../app/home/ic-tokens.css')

    // The void is the black token and nothing else: no gradient, glow, vignette.
    expect(rule(systemCss, '.ic-sys-void')).toBe('background: var(--ic-black);')
    expect(/--ic-black:\s*(#[0-9a-f]{6})\s*;/i.exec(tokensCss)?.[1]?.toLowerCase()).toBe('#000000')
    // The failure and crash screens keep their own stage, unchanged.
    expect(rule(systemCss, '.ic-sys-backdrop')).toContain('radial-gradient(')
  })
})
