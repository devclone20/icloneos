/**
 * Behavioural spec for the switch guard.
 *
 * Note on coverage: the bug this hook was rewritten for — StrictMode's
 * mount → unmount → re-mount of the first commit reading as a profile SWITCH,
 * which wiped Settings' freshly seeded config draft and froze every config
 * pane on its skeleton — cannot be reproduced here: React does not double
 * invoke effects under this jsdom/act harness (verified). These tests pin the
 * observable contract (silent on mount, exactly once per real change, never on
 * a same-value set); the double-mount itself is proven in the live app.
 */
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode, StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { $activeGatewayProfile } from '@/store/profile'

import { useOnProfileSwitch } from './use-on-profile-switch'

const strict = ({ children }: { children?: ReactNode }) => createElement(StrictMode, null, children)

describe('useOnProfileSwitch', () => {
  beforeEach(() => {
    $activeGatewayProfile.set('default')
  })

  it('is silent on mount', () => {
    const onSwitch = vi.fn()

    renderHook(() => useOnProfileSwitch(onSwitch), { wrapper: strict })

    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('fires once — and only once — per real profile switch', () => {
    const onSwitch = vi.fn()

    renderHook(() => useOnProfileSwitch(onSwitch), { wrapper: strict })

    act(() => $activeGatewayProfile.set('work'))
    expect(onSwitch).toHaveBeenCalledTimes(1)

    // Re-setting the same profile is not a switch.
    act(() => $activeGatewayProfile.set('work'))
    expect(onSwitch).toHaveBeenCalledTimes(1)

    act(() => $activeGatewayProfile.set('default'))
    expect(onSwitch).toHaveBeenCalledTimes(2)
  })

  it('is silent on mount even when the profile is already off the default', () => {
    $activeGatewayProfile.set('work')

    const onSwitch = vi.fn()

    renderHook(() => useOnProfileSwitch(onSwitch), { wrapper: strict })

    expect(onSwitch).not.toHaveBeenCalled()
  })
})
