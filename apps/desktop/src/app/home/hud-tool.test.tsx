import { renderHook } from '@testing-library/react'
import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TitlebarTool } from '@/app/shell/titlebar-controls'
import { registry } from '@/contrib/registry'
import type * as I18nModule from '@/i18n'
import { formatCombo } from '@/lib/keybinds/combo'
import { resetBinding, setBinding } from '@/store/keybinds'

// The HUD store owns a live Electron window; here its flag is a plain atom and
// its shell probe / toggle are spies, so what is under test is only what the
// frame tool publishes and what its click calls.
const hud = vi.hoisted(() => ({ canUse: true, haptic: vi.fn(), toggle: vi.fn() }))

vi.mock('@/store/hud', () => ({
  $hudActive: atom(false),
  canUseHud: () => hud.canUse,
  toggleHud: (sessionId?: null | string) => hud.toggle(sessionId)
}))
vi.mock('@/app/hud/handoff', () => ({ hudTargetSessionId: () => 'tile-session-7' }))
const lang = vi.hoisted(() => ({ hudLabel: 'HUD mode' }))

vi.mock('@/i18n', async importOriginal => {
  const actual = await importOriginal<typeof I18nModule>()

  return { ...actual, useI18n: () => ({ ...actual.useI18n(), t: { titlebar: { enterHud: lang.hudLabel } } }) }
})
vi.mock('@/lib/haptics', () => ({ triggerHaptic: (intent?: string) => hud.haptic(intent) }))

const { $hudActive } = await import('@/store/hud')
const { HUD_TOOL_ID, registerIcloneHudTool, useIcloneHudTool } = await import('./hud-tool')

const published = () => {
  const entries = registry.getArea('titleBar.tools.right').filter(c => c.id === HUD_TOOL_ID)

  expect(entries).toHaveLength(1)
  expect(entries[0].source ?? 'core').toBe('core')

  return entries[0].data as TitlebarTool
}

describe('registerIcloneHudTool', () => {
  beforeEach(() => {
    hud.canUse = true
    hud.haptic.mockClear()
    hud.toggle.mockClear()
    $hudActive.set(false)
  })

  it('publishes one core HUD tool on the frame band, labelled from the catalog', () => {
    registerIcloneHudTool()
    registerIcloneHudTool()

    const tool = published()

    expect(tool.id).toBe('iclone-hud')
    expect(tool.label).toBe('HUD mode')
    expect(tool.title).toBe(`HUD mode (${formatCombo('mod+shift+h')})`)
    expect(tool.hidden).toBe(false)
    expect(tool.active).toBe(false)
    expect(tool.icon).toBeTruthy()
  })

  it('mirrors the HUD store: pressed while the HUD window is up, released when it goes', () => {
    registerIcloneHudTool()

    $hudActive.set(true)
    expect(published().active).toBe(true)

    $hudActive.set(false)
    expect(published().active).toBe(false)
  })

  it('hides itself when the shell exposes no HUD', () => {
    registerIcloneHudTool()
    hud.canUse = false

    $hudActive.set(true)

    expect(published().hidden).toBe(true)
  })

  it('toggles the HUD on the chat the user is looking at', () => {
    registerIcloneHudTool()

    published().onSelect?.()

    expect(hud.toggle).toHaveBeenCalledTimes(1)
    expect(hud.toggle).toHaveBeenCalledWith('tile-session-7')
    expect(hud.haptic).toHaveBeenCalledWith('open')
  })

  it('keeps the shortcut hint in step with a rebind, and drops it when unbound', () => {
    registerIcloneHudTool()

    setBinding('view.toggleHud', ['mod+shift+j'])
    expect(published().title).toBe(`HUD mode (${formatCombo('mod+shift+j')})`)

    setBinding('view.toggleHud', [])
    expect(published().title).toBe('HUD mode')

    resetBinding('view.toggleHud')
    expect(published().title).toBe(`HUD mode (${formatCombo('mod+shift+h')})`)
  })

  it('re-labels in the display language on a switch, keeping the hint', () => {
    const view = renderHook(() => useIcloneHudTool())

    expect(published().label).toBe('HUD mode')

    lang.hudLabel = 'Modo HUD'
    view.rerender()

    expect(published().label).toBe('Modo HUD')
    expect(published().title).toBe(`Modo HUD (${formatCombo('mod+shift+h')})`)

    lang.hudLabel = 'HUD mode'
    view.rerender()
    view.unmount()
  })
})
