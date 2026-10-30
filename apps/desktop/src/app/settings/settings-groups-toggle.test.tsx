import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter, useNavigate } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'

import { OverlayNav } from '../overlays/overlay-split-layout'

import { useSettingsGroups } from './group-disclosure'
import {
  buildSettingsNavRows,
  type SettingsGroupId,
  settingsGroupOf,
  type SettingsPaneContext,
  type SettingsPaneId
} from './panes'
import { settingsArrivalOptions } from './settings-arrival'
import { focusCurrentRailRowAfterPalette } from './settings-window'

// The owner's rule (2026-10-28): a Settings group opens and closes on every
// click of its heading, as many times as the person wants, in any order —
// including the group that holds the pane on screen. Arriving at a pane opens
// its group; nothing else ever re-opens or holds a group open.

const GROUPS: SettingsGroupId[] = ['profile', 'agent', 'economy', 'machine']

function paneContext(activeView: SettingsPaneId, onNavigateView: (pane: SettingsPaneId) => void): SettingsPaneContext {
  return {
    activeView,
    importInputRef: { current: null },
    keysView: 'tools',
    navigate: vi.fn(),
    onClose: vi.fn(),
    onKeysViewChange: vi.fn(),
    onNavigateView,
    onProviderViewChange: vi.fn(),
    providerView: 'accounts',
    t: en
  }
}

// Every rail row, read off the real row builder (the pane registry is private to panes.tsx).
const ALL_PANES = buildSettingsNavRows(paneContext('profiles', vi.fn()), { expanded: new Set(), toggle: vi.fn() })
  .filter(row => !('kind' in row))
  .map(row => row.id as SettingsPaneId)

const PANES_OF = new Map<SettingsGroupId, SettingsPaneId[]>(
  GROUPS.map(group => [group, ALL_PANES.filter(pane => settingsGroupOf(pane) === group)])
)

/** The rail as SettingsView wires it: the real `useSettingsGroups` inside a
 *  router, the real row builder, the real OverlayNav. A row click navigates to
 *  another pane, the way `setActiveView` does; a sub-tab click (Providers'
 *  Accounts / API keys) only rewrites the query of the pane on screen, the way
 *  `openProviderView` does — a new location, the same pane. `start` is a cold
 *  open ('') or a deep link. */
function Rail({ start }: { start: SettingsPaneId | '' }) {
  const navigate = useNavigate()
  const [active, setActive] = useState<SettingsPaneId | ''>(start)
  const disclosure = useSettingsGroups(active, start !== '')

  const ctx = paneContext((active || 'profiles') as SettingsPaneId, pane => {
    setActive(pane)
    navigate({ search: `?tab=${encodeURIComponent(pane)}` }, { replace: true })
  })

  return (
    <>
      <OverlayNav groups={buildSettingsNavRows(ctx, disclosure, active === '')} />
      {ALL_PANES.map(pane => (
        // A command-palette hit for `pane`, navigating exactly as the palette's `go` does.
        <button
          data-hit={pane}
          key={`hit-${pane}`}
          onClick={() => {
            const path = `/settings?tab=${encodeURIComponent(pane)}&setting=row`

            setActive(pane)
            navigate(path, settingsArrivalOptions(path))
          }}
          type="button"
        >
          {pane}
        </button>
      ))}
      {(['accounts', 'keys'] as const).map(view => (
        <button
          data-subtab={view}
          key={view}
          onClick={() => navigate({ search: `?tab=${encodeURIComponent(active)}&pview=${view}` }, { replace: true })}
          type="button"
        >
          {view}
        </button>
      ))}
    </>
  )
}

/** What the person should see: their own clicks, plus arrival opening a group. */
class Model {
  readonly open = new Set<SettingsGroupId>()

  constructor(start: SettingsPaneId | '') {
    const group = start ? settingsGroupOf(start) : undefined

    if (group) {
      this.open.add(group)
    }
  }

  toggle(group: SettingsGroupId) {
    if (!this.open.delete(group)) {
      this.open.add(group)
    }
  }

  navigate(pane: SettingsPaneId) {
    this.open.add(settingsGroupOf(pane)!)
  }

  /** A palette hit is an arrival, even at the pane on screen (lead ruling 2026-10-28). */
  searchHit(pane: SettingsPaneId) {
    this.navigate(pane)
  }

  /** A sub-tab of the pane on screen is not an arrival: no group changes. */
  subTab() {}
}

function mount(start: SettingsPaneId | '') {
  const { container } = render(
    <MemoryRouter initialEntries={[start ? `/settings?tab=${encodeURIComponent(start)}` : '/settings']}>
      <Rail start={start} />
    </MemoryRouter>
  )

  const model = new Model(start)
  const log: string[] = []

  const heading = (group: SettingsGroupId) =>
    container.querySelector<HTMLButtonElement>(`[data-nav-heading="group:${group}"]`)!

  const expectInSync = () => {
    for (const group of GROUPS) {
      const open = model.open.has(group)
      const where = `${group} after [${log.join(', ')}]`

      expect(heading(group).getAttribute('aria-expanded'), where).toBe(String(open))
      expect(container.querySelector(`[data-nav-rows="group:${group}"]`)!.hasAttribute('inert'), where).toBe(!open)
    }
  }

  return {
    expectInSync,
    hasPane: () => container.querySelector('[aria-current="page"]') !== null,
    heading,
    navigate(pane: SettingsPaneId) {
      log.push(`go ${pane}`)
      model.navigate(pane)
      act(() => {
        fireEvent.click(container.querySelector<HTMLButtonElement>(`[data-tour="nav-${pane}"]`)!)
      })
      expectInSync()
    },
    model,
    searchHit(pane: SettingsPaneId) {
      log.push(`hit ${pane}`)
      model.searchHit(pane)
      act(() => {
        fireEvent.click(container.querySelector<HTMLButtonElement>(`[data-hit="${pane}"]`)!)
      })
      expectInSync()
    },
    subTab(view: 'accounts' | 'keys') {
      log.push(`sub-tab ${view}`)
      model.subTab()
      act(() => {
        fireEvent.click(container.querySelector<HTMLButtonElement>(`[data-subtab="${view}"]`)!)
      })
      expectInSync()
    },
    toggle(group: SettingsGroupId) {
      log.push(`toggle ${group}`)
      model.toggle(group)
      act(() => {
        fireEvent.click(heading(group))
      })
      expectInSync()
    }
  }
}

// mulberry32: a fixed seed replays the same walk on every run.
function rng(seed: number) {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('Settings groups open and close on every click, in any order (owner 2026-10-28)', () => {
  it('opens A, opens B, closes A, closes B — with a pane of A on screen', () => {
    const rail = mount('')

    rail.toggle('profile')
    rail.navigate('keys')
    rail.toggle('agent')
    rail.toggle('profile')
    rail.toggle('agent')
  })

  it('opens a group, picks one of its rows, then closes it — and opens and closes it again', () => {
    const rail = mount('')

    rail.toggle('profile')
    rail.navigate('privacy')
    rail.toggle('profile')
    rail.toggle('profile')
    rail.toggle('profile')
  })

  it('opens A, goes to a row of B, closes A, then closes B', () => {
    const rail = mount('')

    rail.toggle('agent')
    rail.toggle('economy')
    rail.navigate('billing')
    rail.toggle('agent')
    rail.toggle('economy')
  })

  it('opens everything and closes everything, with a pane open in one of them', () => {
    const rail = mount('config:appearance')

    for (const group of GROUPS) {
      if (!rail.model.open.has(group)) {
        rail.toggle(group)
      }
    }

    rail.navigate('engine')

    for (const group of GROUPS) {
      rail.toggle(group)
    }

    expect(rail.model.open.size).toBe(0)
  })

  it('closes the deep-linked group the person landed on', () => {
    const rail = mount('billing')

    rail.expectInSync()
    rail.toggle('economy')
    rail.toggle('economy')
  })

  it('arriving at a pane whose group the person closed opens it again — and it still closes', () => {
    const rail = mount('')

    rail.toggle('machine')
    rail.navigate('hud')
    rail.toggle('machine')
    rail.toggle('agent')
    rail.navigate('engine')
    rail.toggle('agent')
    rail.toggle('machine')
    rail.navigate('about')
    rail.toggle('machine')
  })

  it('a sub-tab of the pane on screen never reopens its group: Providers, close, Accounts, API keys', () => {
    const rail = mount('')

    rail.toggle('profile')
    rail.navigate('providers')
    rail.toggle('profile')
    rail.subTab('accounts')
    rail.subTab('keys')
    rail.subTab('accounts')
    rail.subTab('keys')
  })

  it('a deep-linked Providers group, closed, stays closed through its sub-tabs', () => {
    const rail = mount('providers')

    rail.toggle('profile')
    rail.subTab('keys')
    rail.subTab('accounts')
  })

  it('going to another pane and back to Providers opens the group again — and it still closes', () => {
    const rail = mount('providers')

    rail.toggle('profile')
    rail.subTab('keys')
    rail.toggle('machine')
    rail.navigate('about')
    rail.toggle('profile')
    rail.navigate('providers')
    rail.subTab('accounts')
    rail.toggle('profile')
    rail.subTab('keys')
  })

  it('a search hit for the pane on screen opens its closed group; its sub-tabs still never reopen it', () => {
    const rail = mount('providers')

    rail.toggle('profile')
    rail.subTab('keys')
    rail.searchHit('providers')
    rail.subTab('accounts')
    rail.toggle('profile')
    rail.subTab('keys')
    rail.searchHit('providers')
    rail.toggle('profile')
    rail.toggle('machine')
    rail.searchHit('hud')
  })

  it('after a search hit at the pane on screen, the keyboard lands on its rail row, never on <body>', async () => {
    const rail = mount('providers')

    rail.toggle('profile')
    rail.searchHit('providers')

    const doc = rail.heading('profile').ownerDocument
    const row = doc.querySelector<HTMLButtonElement>('[data-tour="nav-providers"]')!

    expect(row.closest('[inert]')).toBeNull()
    ;(doc.activeElement as HTMLElement | null)?.blur()
    const stop = focusCurrentRailRowAfterPalette()

    await act(() => new Promise(resolve => setTimeout(resolve, 200)))
    stop()
    expect(doc.activeElement).toBe(row)
  })

  it('never announces a heading disabled — not even the one holding the pane on screen', () => {
    const rail = mount('billing')

    rail.navigate('privacy')

    for (const group of GROUPS) {
      expect(rail.heading(group).hasAttribute('aria-disabled'), group).toBe(false)
    }
  })

  it.each([1, 7, 2026, 1028, 4242])('stays in sync over 50 seeded walks of random clicks (seed %i)', seed => {
    const random = rng(seed)

    for (let walk = 0; walk < 50; walk += 1) {
      const rail = mount(random() < 0.5 ? '' : ALL_PANES[Math.floor(random() * ALL_PANES.length)])

      for (let step = 0; step < 40; step += 1) {
        const open = GROUPS.filter(group => rail.model.open.has(group))

        // A row can only be clicked when its group is open (closed rows are inert).
        const roll = random()

        // A sub-tab only exists while a pane is on screen (not on the landing); a
        // palette hit can land anywhere, the pane on screen included.
        if (roll < 0.15 && rail.hasPane()) {
          rail.subTab(random() < 0.5 ? 'accounts' : 'keys')
        } else if (roll < 0.22) {
          rail.searchHit(ALL_PANES[Math.floor(random() * ALL_PANES.length)])
        } else if (open.length > 0 && roll < 0.5) {
          const panes = PANES_OF.get(open[Math.floor(random() * open.length)])!

          rail.navigate(panes[Math.floor(random() * panes.length)])
        } else {
          rail.toggle(GROUPS[Math.floor(random() * GROUPS.length)])
        }
      }

      cleanup()
    }
  })
})

describe('the palette marks its Settings rows as arrivals (lead ruling 2026-10-28)', () => {
  it('puts the arrival marker on a Settings route, and on nothing else', () => {
    expect(settingsArrivalOptions('/settings?tab=providers&pview=keys')?.state).toEqual({ settingsArrival: true })
    expect(settingsArrivalOptions('/settings')?.state).toEqual({ settingsArrival: true })
    expect(settingsArrivalOptions('/skills?tab=mcp')).toBeUndefined()
    expect(settingsArrivalOptions('/settings-old')).toBeUndefined()
  })
})
