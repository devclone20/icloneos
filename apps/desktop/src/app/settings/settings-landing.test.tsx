import { fireEvent, render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ar } from '@/i18n/ar'
import { en } from '@/i18n/en'
import { ja } from '@/i18n/ja'
import { ptPt } from '@/i18n/pt-PT'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-hant'

import { useGroupDisclosure } from './group-disclosure'
import { buildSettingsNavRows, settingsGroupDoors, type SettingsGroupId, settingsGroupOf } from './panes'
import { SettingsLanding } from './settings-landing'

const ctx = {
  activeView: 'config:model' as const,
  importInputRef: { current: null },
  keysView: 'tools' as const,
  navigate: vi.fn(),
  onClose: vi.fn(),
  onKeysViewChange: vi.fn(),
  onNavigateView: vi.fn(),
  onProviderViewChange: vi.fn(),
  providerView: 'accounts' as const,
  t: en
}

describe('the Settings landing (S8.5)', () => {
  it('offers the four groups as doors, each opening its first pane', () => {
    const doors = settingsGroupDoors(en)

    expect(doors.map(door => [door.id, door.label, door.firstPane])).toEqual([
      ['profile', 'Profile', 'profiles'],
      ['agent', 'Agent', 'config:model'],
      ['economy', 'Economy', 'inft'],
      ['machine', 'Machine', 'config:appearance']
    ])

    for (const door of doors) {
      expect(settingsGroupOf(door.firstPane)).toBe(door.id)
      expect(door.sentence.length).toBeGreaterThan(10)
    }
  })

  it('renders the doors and hands the chosen pane back', () => {
    const onOpen = vi.fn()
    const { container } = render(<SettingsLanding doors={settingsGroupDoors(en)} onOpen={onOpen} />)

    expect(container.querySelectorAll('[data-settings-door]')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: /Economy/ }))
    expect(onOpen).toHaveBeenCalledWith('inft')
  })

  it('marks no rail row active while the landing shows', () => {
    const closed = { expanded: new Set<SettingsGroupId>(), toggle: vi.fn() }

    const active = (landing: boolean) =>
      buildSettingsNavRows(ctx, closed, landing).filter(row => !('kind' in row) && row.active)

    expect(active(true)).toHaveLength(0)
    expect(active(false).map(row => row.id)).toEqual(['config:model'])
  })

  it('says each group in one sentence in every locale, in that locale', () => {
    for (const locale of [ar, ja, zh, zhHant, ptPt]) {
      expect(Object.keys(locale.settings.landing)).toEqual(['profile', 'agent', 'economy', 'machine'])

      for (const id of ['profile', 'agent', 'economy', 'machine'] as const) {
        expect(locale.settings.landing[id]).not.toBe(en.settings.landing[id])
      }
    }
  })

  it('reveals the group of the pane a door opens, from the landing', () => {
    const { rerender, result } = renderHook(({ pane }) => useGroupDisclosure(pane, settingsGroupOf, false), {
      initialProps: { pane: '' }
    })

    expect([...result.current.expanded]).toEqual([])
    rerender({ pane: 'config:model' })
    expect([...result.current.expanded]).toEqual(['agent'])
  })

  it('keeps the disclosure object stable across renders that change nothing', () => {
    const { rerender, result } = renderHook(() => useGroupDisclosure('about', settingsGroupOf, true))
    const first = result.current

    rerender()
    expect(result.current).toBe(first)
  })
})
