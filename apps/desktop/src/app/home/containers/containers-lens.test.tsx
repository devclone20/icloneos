import { readFileSync } from 'node:fs'
import path from 'node:path'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { confinement as en } from '@/i18n/en/confinement'
import type { ConfinementStateView, StopRunResultView } from '@/iclone-shared/confinement'
import { $confinement } from '@/store/confinement'

import { ContainersWindow } from './containers-app'
import { READ_STALE_AFTER_MS } from './containers-data'
import { $containersOpen } from './containers-dock'
import { FIXTURE_RUNS as R, fixtureState as view } from './containers-fixtures'

vi.mock('../window', async importOriginal => ({
  ...(await importOriginal<object>()),
  IcWindow: ({ children, head }: { children: React.ReactNode; head: React.ReactNode }) => (
    <div data-ic-window="containers">
      <header>{head}</header>
      {children}
    </div>
  )
}))

let push: () => void = () => undefined

const bridge = {
  state: vi.fn(async (): Promise<ConfinementStateView> => view()),
  kill: vi.fn(),
  explain: vi.fn(async () => []),
  ackHardlink: vi.fn(),
  stopRun: vi.fn(async (run: string): Promise<StopRunResultView> => ({ ok: true, run, killed: [1] })),
  onChanged: vi.fn((callback: () => void) => {
    push = callback

    return () => undefined
  })
}

beforeEach(() => {
  Object.assign(window, { hermesDesktop: { ...(window.hermesDesktop ?? {}), icloneConfinement: bridge } })
  $confinement.set({ status: 'loading', state: null, error: null })
  $containersOpen.set(true)
  bridge.state.mockImplementation(async () => view())
  bridge.stopRun.mockImplementation(async run => ({ ok: true, run, killed: [1] }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const holder = (id: string) => window.document.querySelector<HTMLElement>(`[data-run="${id}"]`)!
const row = (id: string) => holder(id).querySelector<HTMLElement>('.e-row')!

const visibleText = () => {
  const pane = window.document.querySelector('[data-ic-window]')!.cloneNode(true) as HTMLElement

  pane.querySelector('.icont__sr')?.remove()

  return pane.textContent ?? ''
}

const openPane = async () => {
  render(<ContainersWindow blocked={false} />)
  await screen.findByText('Confined')
}

const nextRead = () =>
  act(async () => {
    push()
    await new Promise(resolve => setTimeout(resolve, 20))
  })

const endRunning = () =>
  bridge.state.mockImplementation(async () =>
    view({
      runs: view().runs.map(run =>
        run.id === R.running.id
          ? { ...run, phase: 'exited' as const, exitCode: 0, endedAt: run.startedAt, live: 0 }
          : run
      )
    })
  )

const clickStop = (id: string) => fireEvent.click(within(holder(id)).getByRole('button', { name: 'Stop' }))

describe('a Stop always ends in a result the user can see', () => {
  it('survivors: the row says it, without opening the inspector', async () => {
    bridge.stopRun.mockImplementationOnce(async run => ({
      ok: false,
      run,
      reason: 'survivors',
      survivors: [1, 2],
      error: 'x'
    }))
    await openPane()
    clickStop(R.running.id)
    await within(holder(R.running.id)).findByText('2 processes still running. Try Stop again.')
    expect(window.document.querySelector('.icont__inspector')).toBeNull()
  })

  it('unverified: the row says it', async () => {
    bridge.stopRun.mockImplementationOnce(async run => ({
      ok: false,
      run,
      reason: 'unverified',
      survivors: [],
      error: 'x'
    }))
    await openPane()
    clickStop(R.running.id)
    await within(holder(R.running.id)).findByText(/could not ask macOS/)
  })

  it('a call that rejects does not stick on Stopping and says the run may still be running', async () => {
    bridge.stopRun.mockImplementationOnce(async () => {
      throw new Error('main threw')
    })
    await openPane()
    clickStop(R.running.id)
    await within(holder(R.running.id)).findByText(/did not answer. It may still be running/)

    const button = within(holder(R.running.id)).getByRole<HTMLButtonElement>('button', { name: 'Stop' })

    expect(button.getAttribute('aria-disabled')).not.toBe('true')
    expect(button.disabled).toBe(false)
  })

  it('a failure stops being said once the run has ended, and a retry clears it first', async () => {
    bridge.stopRun.mockImplementationOnce(async run => ({
      ok: false,
      run,
      reason: 'survivors',
      survivors: [1],
      error: 'x'
    }))
    await openPane()
    clickStop(R.running.id)
    await within(holder(R.running.id)).findByText('1 process still running. Try Stop again.')
    endRunning()
    await nextRead()
    expect(visibleText()).not.toMatch(/still running\. Try Stop again/)
  })

  it('the inspector and the row read the same result once, not twice', async () => {
    bridge.stopRun.mockImplementationOnce(async run => ({
      ok: false,
      run,
      reason: 'survivors',
      survivors: [1],
      error: 'x'
    }))
    await openPane()
    fireEvent.click(row(R.running.id))

    const inspector = window.document.querySelector<HTMLElement>('.icont__inspector')!

    fireEvent.click(within(inspector).getByRole('button', { name: 'Stop' }))
    await within(inspector).findByText('1 process still running. Try Stop again.')
    expect(screen.getAllByText('1 process still running. Try Stop again.')).toHaveLength(1)
  })
})

describe('a state that may be stale is said', () => {
  it('a read that starts failing: a note, the verdict is not verified, and it recovers by itself', async () => {
    await openPane()
    bridge.state.mockImplementation(async () => {
      throw new Error("Error invoking remote method 'iclone:confinement:state': boom")
    })
    await nextRead()
    expect(visibleText()).toMatch(/Could not read the current state/)
    expect(visibleText()).toMatch(/may be out of date/)
    expect(screen.queryByText('Confined')).toBeNull()
    expect(screen.getByText('Not verified')).toBeTruthy()
    expect(visibleText()).not.toMatch(/iclone:confinement|boom/)

    bridge.state.mockImplementation(async () => view())
    await nextRead()
    expect(screen.getByText('Confined')).toBeTruthy()
    expect(visibleText()).not.toMatch(/may be out of date/)
  })

  it('an answer of the wrong shape is treated the same', async () => {
    await openPane()
    bridge.state.mockImplementation(async () => ({ schema: 'old' }) as unknown as ConfinementStateView)
    await nextRead()
    expect(screen.getByText('Not verified')).toBeTruthy()
  })
})

describe('Refusals shows everything the head counts', () => {
  const openRefusals = async () => {
    await openPane()
    fireEvent.click(screen.getByRole('button', { name: /^Refusals/ }))
  }

  it('a command refused before start is listed, with its reason and its Details', async () => {
    bridge.state.mockImplementation(async () => view({ refusals: [], runs: [R.refused] }))
    render(<ContainersWindow blocked={false} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Refusals/ }))
    expect(window.document.querySelector('.icont__lead [data-blocked]')).not.toBeNull()
    await waitFor(() => expect(window.document.querySelector('[data-before-start]')).not.toBeNull())
    expect(visibleText()).not.toMatch(/Nothing refused yet/)

    const group = within(window.document.querySelector<HTMLElement>('[data-before-start]')!)

    expect(group.getByText(/was not started|refused before it started|so it was not/)).toBeTruthy()
    fireEvent.click(group.getByRole('button', { name: 'Details' }))
    expect(window.document.querySelector(`[data-inspector="${R.refused.id}"]`)).not.toBeNull()
  })

  it('All counts both kinds, and Before start narrows to them', async () => {
    const refusals = view().refusals

    bridge.state.mockImplementation(async () => view({ runs: [R.refused, R.running] }))
    await openRefusals()
    fireEvent.click(await screen.findByRole('tab', { name: new RegExp(`^All.*${refusals.length + 1}`) }))
    fireEvent.click(screen.getByRole('tab', { name: /^Before start/ }))
    expect(window.document.querySelectorAll('[data-before-start]')).toHaveLength(1)
    expect(window.document.querySelector('.icont__refusal-group:not([data-before-start])')).toBeNull()
  })

  it('a refusal whose run left the list never heads its group with the raw token', async () => {
    const orphan = view().refusals.find(refusal => refusal.run)!

    bridge.state.mockImplementation(async () => view({ runs: [], refusals: [{ ...orphan, run: 'run-a1c4' }] }))
    await openRefusals()
    await screen.findByRole('heading', { level: 3, name: 'A command no longer listed' })
    expect(visibleText()).not.toMatch(/run-a1c4/)
  })
})

describe('focus survives a run ending', () => {
  it('a focused row that moves to Recent keeps focus, and Up/Down still work', async () => {
    await openPane()
    row(R.running.id).focus()
    expect(window.document.activeElement).toBe(row(R.running.id))
    endRunning()
    await nextRead()
    expect(window.document.activeElement).toBe(row(R.running.id))
  })

  it('the Stop on a row hands focus to its row when the run ends', async () => {
    await openPane()
    within(holder(R.running.id)).getByRole('button', { name: 'Stop' }).focus()
    endRunning()
    await nextRead()
    expect(window.document.activeElement).toBe(row(R.running.id))
  })

  it('the inspector Stop hands focus to the inspector head, so Escape still closes it', async () => {
    await openPane()
    fireEvent.click(row(R.running.id))

    const inspector = window.document.querySelector<HTMLElement>('.icont__inspector')!

    within(inspector).getByRole('button', { name: 'Stop' }).focus()
    endRunning()
    await nextRead()

    const active = window.document.activeElement as HTMLElement

    expect(active.classList.contains('icont__inspector-head')).toBe(true)
    fireEvent.keyDown(active, { key: 'Escape' })
    expect(window.document.querySelector('.icont__inspector')).toBeNull()
    expect(window.document.activeElement).toBe(row(R.running.id))
  })

  it('clicking away is respected: the next read does not pull focus back', async () => {
    await openPane()
    row(R.running.id).focus()
    fireEvent.pointerDown(window.document.body)
    ;(window.document.activeElement as HTMLElement).blur()
    endRunning()
    await nextRead()
    expect(window.document.activeElement).toBe(window.document.body)
  })
})

describe('what a row and the Agents view say in words', () => {
  it('a background run says so in its row, in text', async () => {
    await openPane()
    expect(row(R.background.id).textContent).toMatch(/Background/)
    expect(row(R.running.id).textContent).not.toMatch(/Background/)
  })

  it('Agents prints words for the action and the tool', async () => {
    await openPane()
    fireEvent.click(screen.getByRole('button', { name: /^Agents/ }))

    const agents = window.document.querySelector('.icont__agents')!.textContent!

    expect(agents).toMatch(/Used/)
    expect(agents).toMatch(/Terminal/)
    expect(agents).not.toMatch(/\buse\b|\bterminal\b/)
  })

  it('a program named like an Object key prints as itself', async () => {
    const base = view()

    bridge.state.mockImplementation(async () =>
      view({
        agents: [
          {
            ...base.agents[0],
            actions: [{ ts: base.at, kind: 'refuse', tool: 'constructor', target: '/x', outcome: null }]
          }
        ]
      })
    )
    await openPane()
    fireEvent.click(screen.getByRole('button', { name: /^Agents/ }))
    expect(window.document.querySelector('.icont__agents')!.textContent).toMatch(/Refused.*constructor/)
  })

  it('an agent without an iNFT is named as what it is, not by its session id', async () => {
    const base = view()

    bridge.state.mockImplementation(async () => view({ agents: [{ ...base.agents[0], inft: null }] }))
    await openPane()
    expect(row(R.running.id).textContent).toMatch(/Agent session/)
    expect(row(R.running.id).textContent).not.toContain(R.running.sessionId as string)
    fireEvent.click(screen.getByRole('button', { name: /^Agents/ }))
    expect(screen.getByRole('heading', { level: 3, name: 'Agent session' })).toBeTruthy()
  })

  it('a cut list says it stops short', async () => {
    bridge.state.mockImplementation(async () => view({ runsCut: 12 }))
    await openPane()
    expect(window.document.querySelector('[data-runs-cut]')!.textContent).toMatch(/newest \d+ commands. 12 older/)
  })
})

describe('what the last read cannot vouch for reads as such', () => {
  const failReads = () =>
    bridge.state.mockImplementation(async () => {
      throw new Error('no answer')
    })

  it('a stale pane has no live marks: no breathing dot, no green dot or rail count, no running claim', async () => {
    await openPane()
    expect(holder(R.running.id).querySelector('[data-live="true"]')).not.toBeNull()
    expect(holder(R.running.id).querySelector('.icont__dot')?.getAttribute('data-tone')).toBe('up')

    failReads()
    await nextRead()

    expect(window.document.querySelector('[data-live="true"]')).toBeNull()
    expect(holder(R.running.id).querySelector('.icont__dot')?.getAttribute('data-tone')).toBe('muted')
    expect(screen.getByRole('button', { name: /^Activity/ }).querySelector('.e-rail__count--up')).toBeNull()
    expect(window.document.querySelector('[data-tally="running"]')?.textContent).toMatch(/at the last read/)
    // F45: stale is said in the lead and in the slot under it, and the window's top stays the title alone.
    expect(window.document.querySelector('.icont__lead [data-verdict="stale"]')).not.toBeNull()
    expect(window.document.querySelector('[data-standing] .e-note')).not.toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: 'Containers' }).parentElement?.textContent).toBe('Containers')
    expect(screen.getByText(/^Running at the last read/)).toBeTruthy()

    fireEvent.click(holder(R.running.id).querySelector<HTMLElement>('.e-row')!)

    const opened = window.document.querySelector<HTMLElement>(`[data-inspector="${R.running.id}"]`)!

    expect(within(opened).getByText('Running, at the last read')).toBeTruthy()
    expect(opened.querySelector('.icont__status')?.getAttribute('data-tone')).toBe('muted')
    expect(opened.querySelector('[data-kind="live"]')?.getAttribute('data-tone')).toBe('muted')

    bridge.state.mockImplementation(async () => view())
    await nextRead()
    expect(holder(R.running.id).querySelector('[data-live="true"]')).not.toBeNull()
  })

  describe('a read that never comes back', () => {
    const PAST_THE_LIMIT_MS = 9_000
    const clockOnly = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const }

    const flush = async () => {
      await Promise.resolve()
      await Promise.resolve()
    }

    afterEach(() => void vi.useRealTimers())

    it('turns the pane stale without any rejection, and the next answer clears it', async () => {
      await openPane()
      vi.useFakeTimers({ toFake: [...clockOnly.toFake] })
      // One more answer, so the pane's clock for the age of its read runs on the faked timers.
      await act(async () => {
        push()
        await flush()
      })
      bridge.state.mockImplementation(() => new Promise(() => undefined))
      await act(async () => {
        push()
        vi.advanceTimersByTime(PAST_THE_LIMIT_MS)
        await flush()
      })

      expect(screen.getByText('Not verified')).toBeTruthy()
      expect(visibleText()).toMatch(/may be out of date/)
      expect(window.document.querySelector('[data-live="true"]')).toBeNull()

      bridge.state.mockImplementation(async () => view())
      await act(async () => {
        push()
        await flush()
      })
      expect(screen.getByText('Confined')).toBeTruthy()
      expect(window.document.querySelector('[data-live="true"]')).not.toBeNull()
    })

    it('a first read that hangs ends in the no-read state, not in skeletons for ever', async () => {
      vi.useFakeTimers({ toFake: [...clockOnly.toFake] })
      $confinement.set({ status: 'loading', state: null, error: null })
      bridge.state.mockImplementation(() => new Promise(() => undefined))
      render(<ContainersWindow blocked={false} />)
      await act(async () => void vi.advanceTimersByTime(PAST_THE_LIMIT_MS))

      expect(screen.getByText('Could not read what is confined')).toBeTruthy()
    })

    it('waits longer than the 5 s main itself allows a slow read', () => {
      expect(READ_STALE_AFTER_MS).toBeGreaterThan(5_000)
    })
  })

  it('says nothing about a log the detail never reaches (only console errors reach it, this is a warning)', () => {
    expect(en.ledger.noRead.hint).not.toMatch(/log/i)
  })
})

describe('the Activity list shows only what it can act on', () => {
  const toolbar = () => window.document.querySelector('.icont__activity .e-toolbar')

  it('no runs at all: no filters and no search over an empty list', async () => {
    bridge.state.mockImplementation(async () => view({ runs: [] }))
    render(<ContainersWindow blocked={false} />)
    await screen.findByText('No confined command yet')
    expect(toolbar()).toBeNull()
  })

  it('only folded housekeeping: no filters for nothing, and the disclosure still brings those runs back', async () => {
    const quiet = { ...R.exited, origin: 'runtime' as const }

    bridge.state.mockImplementation(async () => view({ runs: [quiet] }))
    render(<ContainersWindow blocked={false} />)
    const disclosure = await screen.findByRole('button', { name: /Runtime housekeeping · 1/ })

    expect(toolbar()).toBeNull()
    fireEvent.click(disclosure)
    expect(window.document.querySelector(`[data-run="${quiet.id}"]`)).not.toBeNull()
  })

  it('a search with no match keeps the toolbar, so it can be cleared', async () => {
    await openPane()
    fireEvent.change(screen.getByPlaceholderText('Search commands'), { target: { value: 'zzz-no-such-command' } })
    expect(toolbar()).not.toBeNull()
  })

  it('background is one state word and an amber dot; the class pill is never a status colour', async () => {
    await openPane()

    const row = holder(R.background.id)

    expect(row.querySelector('.icont__command-line .e-pill--warn')).toBeNull()
    expect(row.querySelector('[data-phase="background"]')?.getAttribute('data-tone')).toBe('warn')
    expect(within(row).getByRole('img', { name: 'Background' })).toBeTruthy()
    expect(holder(R.running.id).querySelector('.e-pill--tone')).not.toBeNull()
  })

  it('Running and Recent fill the same eight cells, and every recent row shows it opens', async () => {
    await openPane()

    const cells = (id: string) => holder(id).querySelectorAll('.e-row > .e-cell')

    expect(cells(R.running.id)).toHaveLength(8)
    expect(cells(R.exited.id)).toHaveLength(8)
    expect(holder(R.exited.id).querySelector('.icont__open')).not.toBeNull()
  })

  it('the rail, the Refusals view and the head count the same attempts', async () => {
    bridge.state.mockImplementation(async () => view({ runs: [R.refused, R.running] }))
    await openPane()

    const said = view().refusals.length + 1

    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^Refusals.*${said}`) }))
    expect(await screen.findByRole('tab', { name: new RegExp(`^All.*${said}`) })).toBeTruthy()
  })

  it('L4-02: when today’s record has closed parts, Refusals says how many are there, with the exact day count', async () => {
    bridge.state.mockImplementation(async () => ({
      ...view(),
      refusalDay: { day: '2026-11-10', rows: 412_345, olderRows: 400_000, parts: 3 }
    }))
    await openPane()
    fireEvent.click(await screen.findByRole('button', { name: /^Refusals/ }))

    const note = await screen.findByText(/412,345 refused today/)

    expect(note.textContent).toBe(
      '412,345 refused today. The newest are listed here; the 400,000 oldest are kept in earlier parts of today’s record.'
    )
  })

  it('L4-02: no closed part, no note', async () => {
    bridge.state.mockImplementation(async () => ({
      ...view(),
      refusalDay: { day: '2026-11-10', rows: 12, olderRows: 0, parts: 0 }
    }))
    await openPane()
    fireEvent.click(await screen.findByRole('button', { name: /^Refusals/ }))
    await screen.findByRole('tab', { name: /^All/ })
    expect(window.document.querySelector('[data-refusals-older-parts]')).toBeNull()
  })

  it('every width tier of the row grid has as many tracks as it leaves cells', () => {
    const css = readFileSync(path.join(import.meta.dirname, 'containers.css'), 'utf8')
    const tiers = [...css.matchAll(/@container icont-list[^{]*\{([\s\S]*?)\n\}/g)].map(match => match[1])
    let cells = 8

    expect(tiers.length).toBeGreaterThanOrEqual(4)

    for (const tier of tiers) {
      const tracks = /grid-template-columns:([^;]+);/
        .exec(tier)?.[1]
        .trim()
        .replace(/minmax\(0, 1fr\)/, '1fr')

      cells -= [...tier.matchAll(/\.icont__run \.e-row > \.e-cell:nth-child\(\d\)/g)].length
      expect(tracks?.split(/\s+/)).toHaveLength(cells)
    }
  })

  it('Stop has no status colour at rest, only on the pointer or the focus', () => {
    const css = readFileSync(path.join(import.meta.dirname, 'containers.css'), 'utf8')

    expect(css).toMatch(/\.icont__danger \.e-btn:is\(:hover, :focus-visible\) \{[^}]*var\(--e-down\)/)
    expect(css).not.toMatch(/\.icont__danger \.e-btn \{/)
  })
})
