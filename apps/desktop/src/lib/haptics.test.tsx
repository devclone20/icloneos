import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebHaptics } from 'web-haptics'

import { HapticsProvider } from '@/components/haptics-provider'
import { $hapticsMuted } from '@/store/haptics'

import { registerHapticTrigger, triggerHaptic } from './haptics'

// web-haptics decides `isSupported` when it is first evaluated, so the engine
// must look like Chromium (navigator.vibrate present) before the imports run.
const vibrate = vi.hoisted(() => {
  const fn = vi.fn(() => true)

  Object.defineProperty(navigator, 'vibrate', { configurable: true, value: fn })

  return fn
})

function setActivation(hasBeenActive: boolean | undefined) {
  Object.defineProperty(navigator, 'userActivation', {
    configurable: true,
    value: hasBeenActive === undefined ? undefined : { hasBeenActive, isActive: false }
  })
}

const realNow = performance.now.bind(performance)
let clockOffset = 0

beforeEach(() => {
  // Each test starts in a fresh rate-limit window.
  clockOffset += 10_000
  vi.spyOn(performance, 'now').mockImplementation(() => realNow() + clockOffset)
  $hapticsMuted.set(false)
  setActivation(true)
})

afterEach(() => {
  cleanup()
  registerHapticTrigger(null)
  vibrate.mockClear()
  vi.restoreAllMocks()
})

describe('triggerHaptic', () => {
  it('fires nothing before the frame has seen a user gesture', () => {
    const trigger = vi.fn(() => Promise.resolve())

    registerHapticTrigger(trigger)
    setActivation(false)
    triggerHaptic('tap')

    expect(trigger).not.toHaveBeenCalled()
  })

  it('fires the intent pattern once the frame has been activated', () => {
    const trigger = vi.fn(() => Promise.resolve())

    registerHapticTrigger(trigger)
    triggerHaptic('tap')

    expect(trigger).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveBeenCalledWith(
      [
        { duration: 14, intensity: 0.58 },
        { delay: 30, duration: 12, intensity: 0.42 }
      ],
      undefined
    )
  })

  it('fires where the engine has no user-activation API', () => {
    const trigger = vi.fn(() => Promise.resolve())

    registerHapticTrigger(trigger)
    setActivation(undefined)
    triggerHaptic('success')

    expect(trigger).toHaveBeenCalledTimes(1)
  })

  it('stays silent while muted', () => {
    const trigger = vi.fn(() => Promise.resolve())

    registerHapticTrigger(trigger)
    $hapticsMuted.set(true)
    triggerHaptic('tap')

    expect(trigger).not.toHaveBeenCalled()
  })

  it('caps a runaway source at five haptics a second', () => {
    const trigger = vi.fn(() => Promise.resolve())

    registerHapticTrigger(trigger)

    for (let i = 0; i < 8; i += 1) {
      triggerHaptic('error')
    }

    expect(trigger).toHaveBeenCalledTimes(5)
  })
})

describe('HapticsProvider', () => {
  it('plays a haptic without ever calling navigator.vibrate', async () => {
    const { baseElement } = render(
      <HapticsProvider>
        <span />
      </HapticsProvider>
    )

    triggerHaptic('tap')
    await Promise.resolve()

    expect(WebHaptics.isSupported).toBe(false)
    expect(baseElement.querySelector('[id^="web-haptics-"]')).not.toBeNull()
    expect(vibrate).not.toHaveBeenCalled()
  })
})
