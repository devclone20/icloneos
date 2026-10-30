// The swap overlay used to stay mounted for the whole life of the chat view,
// holding "Waking up <profile>…" (or a blank "Waking up …" before the first
// swap) in the DOM next to answers that had already arrived. These pin the
// mount window: nothing before a swap, the name while it runs, the held name
// only through the fade-out, nothing after.
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $activeInftName, $inftSwitch } from '@/app/home/inft-switch'
import { $gateway } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'

import { ChatSwapOverlay } from './chat-swap-overlay'
import { SWAP_OVERLAY_FADE_MS, swapOverlayLabel, useSwapOverlayPresence } from './swap-overlay-presence'

function Harness({ target }: { target: string | null }) {
  const swap = useSwapOverlayPresence(target)

  return <div>{swap.mounted && <ChatSwapOverlay profile={swap.profile} />}</div>
}

const FRAME_MS = 17

// The overlay root is the harness div's only child; the spinner glyph strip
// is stripped so the label reads alone.
function overlay(container: HTMLElement): Element | null {
  return container.firstElementChild?.firstElementChild ?? null
}

function waking(container: HTMLElement): null | string {
  const text = (container.textContent ?? '').replace(/[\u2800-\u28ff]/g, '')

  return /Waking up/.test(text) ? text.trim() : null
}

function overlayOpacity(container: HTMLElement): null | string {
  const node = overlay(container)

  if (!node) {
    return null
  }

  return node.className.includes('opacity-100') ? '100' : '0'
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

afterEach(() => {
  cleanup()
})

describe('useSwapOverlayPresence', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    // A real wake: the live profile is another one than the target.
    $activeGatewayProfile.set('work')
    $activeInftName.set(null)
    $inftSwitch.set({ phase: 'idle' })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    $activeGatewayProfile.set('default')
  })

  it('renders nothing while no swap has run (no blank "Waking up …")', () => {
    const { container } = render(<Harness target={null} />)

    advance(5_000)

    expect(waking(container)).toBeNull()
    expect(overlay(container)).toBeNull()
  })

  it('fades in named, holds the name through the fade-out, then leaves the DOM', () => {
    const { container, rerender } = render(<Harness target={null} />)

    rerender(<Harness target="default" />)
    // Mounted transparent first so the overlay's own fade-in still runs.
    expect(overlayOpacity(container)).toBe('0')

    advance(FRAME_MS * 2)

    expect(overlayOpacity(container)).toBe('100')
    expect(waking(container)).toBe('Waking up default…')

    rerender(<Harness target={null} />)

    expect(overlayOpacity(container)).toBe('0')
    expect(waking(container)).toBe('Waking up default…')

    advance(SWAP_OVERLAY_FADE_MS)

    expect(waking(container)).toBeNull()
    expect(overlay(container)).toBeNull()

    // Long after the answer, the status is still gone.
    advance(60_000)
    expect(waking(container)).toBeNull()
  })

  it('unmounts at once when the swap settles before it was ever named', () => {
    const { container, rerender } = render(<Harness target={null} />)

    rerender(<Harness target="default" />)
    rerender(<Harness target={null} />)

    expect(overlay(container)).toBeNull()

    advance(FRAME_MS * 4)

    expect(waking(container)).toBeNull()
  })

  it('keeps one overlay and names the new target when a swap restarts mid-fade', () => {
    const { container, rerender } = render(<Harness target="alpha" />)

    advance(FRAME_MS * 2)
    rerender(<Harness target={null} />)
    advance(SWAP_OVERLAY_FADE_MS / 2)
    rerender(<Harness target="beta" />)

    expect(container.firstElementChild?.children).toHaveLength(1)
    expect(overlayOpacity(container)).toBe('100')
    expect(waking(container)).toBe('Waking up beta…')

    advance(SWAP_OVERLAY_FADE_MS * 2)

    expect(waking(container)).toBe('Waking up beta…')
  })

  it('treats a blank target as no swap', () => {
    const { container } = render(<Harness target="   " />)

    advance(FRAME_MS * 4)

    expect(waking(container)).toBeNull()
  })
})

// Only its presence matters to the overlay.
const CONNECTED = {} as NonNullable<ReturnType<typeof $gateway.get>>

describe('the wake label after an iNFT switch — R3d r4', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    $activeInftName.set(null)
    $inftSwitch.set({ phase: 'idle' })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    $activeGatewayProfile.set('default')
    $gateway.set(null)
    $activeInftName.set(null)
    $inftSwitch.set({ phase: 'idle' })
  })

  it("names the iNFT, never the profile 'default' it rides on", () => {
    expect(swapOverlayLabel('default', '#7')).toBe('#7')
    expect(swapOverlayLabel('work', '#7')).toBe('work')
    expect(swapOverlayLabel('default', null)).toBe('default')
    expect(swapOverlayLabel('default', ' ')).toBe('default')
  })

  it('a wake of default during a switch to #7 reads "Waking up #7…"', () => {
    $activeGatewayProfile.set('work')
    $inftSwitch.set({ phase: 'applying', slug: 'slug-7', name: '#7', startedAt: 0 })
    const { container, rerender } = render(<Harness target={null} />)

    rerender(<Harness target="default" />)
    advance(FRAME_MS * 2)
    expect(waking(container)).toBe('Waking up #7…')
    expect(container.textContent).not.toContain('default')
  })

  it('a session open hydrating on the live profile (#6 -> #7 -> #6) never mounts the overlay', () => {
    $activeGatewayProfile.set('default')
    $gateway.set(CONNECTED)

    for (const name of ['#7', '#6']) {
      $activeInftName.set(name)
      const { container, rerender, unmount } = render(<Harness target={null} />)

      rerender(<Harness target="default" />)
      advance(FRAME_MS * 2)
      expect(overlay(container)).toBeNull()
      rerender(<Harness target={null} />)
      advance(SWAP_OVERLAY_FADE_MS)
      expect(container.textContent).toBe('')
      unmount()
    }
  })

  it('an overlay up for a real swap stays through the hydration that follows it', () => {
    $activeGatewayProfile.set('work')
    $activeInftName.set('#6')
    const { container, rerender } = render(<Harness target={null} />)

    rerender(<Harness target="default" />)
    advance(FRAME_MS * 2)
    act(() => $activeGatewayProfile.set('default'))
    expect(waking(container)).toBe('Waking up #6…')
  })

  it('a reconnect of the live profile ($gateway null) still reads "Waking up #6…" — R3d r5', () => {
    $activeGatewayProfile.set('default')
    $gateway.set(null)
    $activeInftName.set('#6')
    const { container, rerender } = render(<Harness target={null} />)

    rerender(<Harness target="default" />)
    advance(FRAME_MS * 2)
    expect(waking(container)).toBe('Waking up #6…')
  })
})
