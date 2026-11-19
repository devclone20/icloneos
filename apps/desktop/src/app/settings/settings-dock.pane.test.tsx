// v0.0.9 r2 (F6 spec gap): Settings as a PANE beside the Message window — the shell's half (contrib/wiring.tsx).
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  $panes,
  $settingsBesideMessage,
  registerPane,
  resetPanesForTests,
  unregisterPane
} from '@/app/home/window/pane-layout'

import { $settingsOpenedInApp, closeSettingsBeside, openSettingsBeside, useSettingsPane } from './settings-dock'

afterEach(() => {
  resetPanesForTests()
  $settingsOpenedInApp.set(false)
})

describe('useSettingsPane', () => {
  it('opening beside Message shows Settings without its route; its own close ends the pane form', () => {
    const { result } = renderHook(({ route }) => useSettingsPane(route), { initialProps: { route: false } })

    expect(result.current).toBe(false)
    act(() => openSettingsBeside())
    expect(result.current).toBe(true)
    // Its close runs the shell's onClose (settings-window.tsx `leave`): opened in the app, so not a navigation home.
    expect($settingsOpenedInApp.get()).toBe(true)
    act(() => closeSettingsBeside())
    expect(result.current).toBe(false)
  })

  it('Message opening over the Settings route keeps the pane form (the route leaves, the pane stays)', () => {
    const { rerender, result } = renderHook(({ route }) => useSettingsPane(route), { initialProps: { route: true } })

    act(() => openSettingsBeside())
    rerender({ route: false })

    expect(result.current).toBe(true)
  })

  it('a door that navigates to /settings takes Settings back as its route: one Settings, the pane form ends', () => {
    const { rerender, result } = renderHook(({ route }) => useSettingsPane(route), { initialProps: { route: false } })

    act(() => openSettingsBeside())
    rerender({ route: true })

    expect(result.current).toBe(false)
    expect($settingsBesideMessage.get()).toBe(false)
  })
})

// v0.0.9 r3 (eng n3, lead): the route-door edge, pinned as the intended behaviour. A door inside Settings-as-a-pane that
// navigates to `/settings` (a cross-link, billing recovery) is a navigation, not a pane operation: the chat route
// leaves, so Message closes; Settings stays — the SAME window, never unregistered or remounted (its tab and state are
// kept) — alone. At no step are there more than two panes. "Any pane type, max two" holds: no pane is added.
describe('the route-door edge (Settings pane → a door to /settings)', () => {
  it('Message closes, Settings stays the same open pane throughout, never more than two', () => {
    const seen: string[][] = []
    const stop = $panes.subscribe(state => seen.push([...state.open]))

    registerPane('message')
    openSettingsBeside()
    registerPane('settings')
    expect($panes.get().open).toEqual(['message', 'settings'])

    // The door: useSettingsPane sees the route open and ends the pane form; the chat route unmounts Message.
    const { rerender } = renderHook(({ route }) => useSettingsPane(route), { initialProps: { route: false } })

    rerender({ route: true })
    unregisterPane('message')
    stop()

    expect($settingsBesideMessage.get()).toBe(false)
    expect($panes.get().open).toEqual(['settings'])
    // Settings never left the layout from the moment it opened: nothing of it was lost.
    const fromSettings = seen.slice(seen.findIndex(open => open.includes('settings')))

    expect(fromSettings.every(open => open.includes('settings'))).toBe(true)
    expect(seen.every(open => open.length <= 2)).toBe(true)
  })
})
