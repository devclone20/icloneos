import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ar } from '@/i18n/ar'
import { en } from '@/i18n/en'
import { ja } from '@/i18n/ja'
import { ptPt } from '@/i18n/pt-PT'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-hant'

import { useGroupDisclosure } from './group-disclosure'
import {
  buildSettingsNavRows,
  SETTINGS_VIEW_ALIASES,
  SETTINGS_VIEWS,
  type SettingsGroupId,
  settingsGroupOf,
  type SettingsPaneContext,
  type SettingsPaneId
} from './panes'

// The owner's four groups (2026-10-20), and every pane placed as inventory §3
// places it. The gate's probe derives the same list from the inventory itself.
const PLACED: Record<SettingsGroupId, string[]> = {
  profile: ['profiles', 'messaging', 'providers', 'keys', 'privacy'],
  agent: [
    'config:model',
    'engine',
    'config:memory',
    'config:voice',
    'skills',
    'config:chat',
    'permissions',
    'config:safety',
    'config:workspace',
    'config:browser',
    'sessions-bots',
    'sessions',
    'command-center',
    'config:advanced'
  ],
  economy: ['inft', 'inft-book', 'economyos', 'payments', 'billing'],
  machine: [
    'config:appearance',
    'hud',
    'notifications',
    'keybinds',
    'it-terminal',
    'gateway',
    'plugins',
    'updates',
    // V3-ON: the first-launch Set up choices, any time
    'setup',
    'diagnostics',
    'about'
  ]
}

function paneContext(activeView: SettingsPaneId): SettingsPaneContext {
  return {
    activeView,
    importInputRef: { current: null },
    keysView: 'tools',
    navigate: vi.fn(),
    onClose: vi.fn(),
    onKeysViewChange: vi.fn(),
    onNavigateView: vi.fn(),
    onProviderViewChange: vi.fn(),
    providerView: 'accounts',
    t: en
  }
}

const closed = { expanded: new Set<SettingsGroupId>(), toggle: vi.fn() }

describe('the four Settings groups', () => {
  it('lists Profile, Agent, Economy, Machine — with all 35 panes where §3 puts them (V3-J adds Payments, V3-ON Set up)', () => {
    const rows = buildSettingsNavRows(paneContext('about'), closed)
    const placed: Record<string, string[]> = {}
    let group = ''

    for (const row of rows) {
      if ('kind' in row) {
        group = row.id.replace('group:', '')
        placed[group] = []
      } else {
        placed[group].push(row.id)
      }
    }

    expect(placed).toEqual(PLACED)
    expect(Object.values(placed).flat()).toHaveLength(35)
    expect(rows.filter(row => 'kind' in row).map(row => row.label)).toEqual(['Profile', 'Agent', 'Economy', 'Machine'])
  })

  it('makes every heading a disclosure that reads and flips the shared state', () => {
    const toggle = vi.fn()
    const rows = buildSettingsNavRows(paneContext('about'), { expanded: new Set(['economy']), toggle })
    const headings = rows.filter(row => 'kind' in row)

    expect(headings.map(row => row.disclosure?.expanded)).toEqual([false, false, true, false])
    headings[0].disclosure?.onToggle()
    expect(toggle).toHaveBeenCalledWith('profile')
  })

  it('resolves the legacy aliases: `connections` to Gateways, `app-atualisation` to Updates (U4-p2b-09)', () => {
    expect(settingsGroupOf('connections')).toBe('machine')
    expect(settingsGroupOf('app-atualisation')).toBe('machine')
    expect(settingsGroupOf('not-a-pane')).toBeUndefined()
    expect(SETTINGS_VIEW_ALIASES).toEqual({ 'app-atualisation': 'updates', connections: 'gateway' })
    // Aliases are routable (`?tab=` accepts them) but never a nav row.
    expect(SETTINGS_VIEWS).toEqual(expect.arrayContaining(['updates', 'app-atualisation', 'connections']))
    expect(buildSettingsNavRows(paneContext('updates'), closed).map(row => row.id)).not.toContain('app-atualisation')
  })

  it('never pins a heading: no disclosure carries a refuse-to-close flag (owner 2026-10-28, replaces U3-01-p2b)', () => {
    const rows = buildSettingsNavRows(paneContext('about'), { expanded: new Set(['machine']), toggle: vi.fn() })

    for (const row of rows.filter(row => 'kind' in row)) {
      expect(Object.keys(row.disclosure ?? {}).sort()).toEqual(['expanded', 'onToggle'])
    }
  })

  it('names the four groups in every locale, in that locale', () => {
    for (const locale of [ar, ja, zh, zhHant, ptPt]) {
      const groups = locale.settings.groups

      expect(Object.keys(groups)).toEqual(['profile', 'agent', 'economy', 'machine'])

      for (const id of Object.keys(groups)) {
        expect(groups[id]).not.toBe(en.settings.groups[id])
      }
    }
  })
})

describe('useGroupDisclosure', () => {
  const groupOf = (pane: string) => settingsGroupOf(pane)

  it('opens cold with every group collapsed', () => {
    const { result } = renderHook(() => useGroupDisclosure('config:model', groupOf, false))

    expect([...result.current.expanded]).toEqual([])
  })

  it('reveals the destination group when Settings opens on a pane', () => {
    const { result } = renderHook(() => useGroupDisclosure('billing', groupOf, true))

    expect([...result.current.expanded]).toEqual(['economy'])
  })

  it('reveals the group of every pane the person moves to, and lets them close the others', () => {
    const { rerender, result } = renderHook(({ pane }) => useGroupDisclosure(pane, groupOf, false), {
      initialProps: { pane: 'config:model' }
    })

    rerender({ pane: 'privacy' })
    expect([...result.current.expanded]).toEqual(['profile'])

    // The active pane's group closes on the person's click too (owner 2026-10-28).
    act(() => result.current.toggle('profile'))
    expect([...result.current.expanded]).toEqual([])

    // Moving to another pane of the closed group opens it again.
    rerender({ pane: 'keys' })
    expect([...result.current.expanded]).toEqual(['profile'])

    act(() => result.current.toggle('agent'))
    act(() => result.current.toggle('agent'))
    expect([...result.current.expanded]).toEqual(['profile'])

    act(() => result.current.toggle('machine'))
    expect(new Set(result.current.expanded)).toEqual(new Set(['profile', 'machine']))
  })
})

describe('the active pane group opens on arrival and closes on the person’s click (owner 2026-10-28)', () => {
  it('collapses the active group on a click, and every other group still toggles', () => {
    const { result } = renderHook(() => useGroupDisclosure('messaging', settingsGroupOf, true))

    expect([...result.current.expanded]).toEqual(['profile'])

    act(() => result.current.toggle('profile'))
    expect(result.current.expanded.has('profile')).toBe(false)

    act(() => result.current.toggle('profile'))
    expect(result.current.expanded.has('profile')).toBe(true)

    act(() => result.current.toggle('machine'))
    expect(result.current.expanded.has('machine')).toBe(true)

    act(() => result.current.toggle('machine'))
    expect(result.current.expanded.has('machine')).toBe(false)
  })

  it('a re-render on the same pane never reopens a group the person closed', () => {
    const { rerender, result } = renderHook(({ pane }) => useGroupDisclosure(pane, settingsGroupOf, true), {
      initialProps: { pane: 'messaging' }
    })

    act(() => result.current.toggle('profile'))
    rerender({ pane: 'messaging' })
    rerender({ pane: 'messaging' })
    expect(result.current.expanded.has('profile')).toBe(false)
  })

  it('opens the group only on arrival at a different pane, never on the pane already on screen (owner 2026-10-28)', () => {
    const { rerender, result } = renderHook(({ pane }) => useGroupDisclosure(pane, settingsGroupOf, false), {
      initialProps: { pane: 'config:appearance' }
    })

    // Settings opened without revealing; the same pane again is not an arrival.
    rerender({ pane: 'config:appearance' })
    expect(result.current.expanded.size).toBe(0)

    rerender({ pane: 'about' })
    expect(result.current.expanded.has('machine')).toBe(true)
  })
})
