import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { JsonRpcGatewayError } from '@hermes/shared'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { bandContextDoorSurfaces } from '@/app/chat/composer/context-chip'
import { PRIMARY_SESSION_VIEW } from '@/app/chat/session-view'
import { CONTEXT_PANEL_COPY } from '@/app/context-panel/context-panel.copy'
import { formatTokens } from '@/app/context-panel/context-rows'
import {
  $stopAttempts,
  type BgTask,
  registerTaskSource,
  resetBackgroundTasksForTests,
  type TaskSource
} from '@/store/background-tasks'
import {
  $backgroundStatusBySession,
  $backgroundStopWatch,
  reconcileBackgroundProcesses,
  refreshBackgroundProcesses,
  resetBackgroundPollingGuard,
  resetSessionBackground,
  stopBackgroundProcess
} from '@/store/composer-status'
import { $gateway } from '@/store/gateway'
import { $activeSessionId, setCurrentUsage } from '@/store/session'
import { stubResizeObserver } from '@/test/jsdom'
import type { UsageStats } from '@/types/hermes'

import { MsgHead } from './msg-head'

// Measured, not estimated: `context_source: 'provider_usage'` is what keeps the '~' off the numbers.
const USAGE: UsageStats = {
  calls: 3,
  context_max: 200_000,
  context_percent: 25,
  context_source: 'provider_usage',
  context_used: 50_000,
  input: 900,
  output: 300,
  total: 1200
}

// The card's own edges, once a runtime id is set: the compression config and the spend analytics go
// through the desktop bridge, which jsdom has not got (its gateway RPC already guards itself).
const { getHermesConfigRecord, getUsageAnalytics } = vi.hoisted(() => ({
  getHermesConfigRecord: vi.fn(),
  getUsageAnalytics: vi.fn()
}))

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getHermesConfigRecord: (...args: unknown[]) => getHermesConfigRecord(...args),
  getUsageAnalytics: (...args: unknown[]) => getUsageAnalytics(...args)
}))

const head = () => window.document.querySelector('header.ic-win__head.iecon__head.imsg-head')

beforeEach(() => {
  getHermesConfigRecord.mockResolvedValue({ compression: { threshold: 0.5 } })
  getUsageAnalytics.mockResolvedValue({ by_model: [], by_task: [], daily: [], period_days: 1 })
})

afterEach(() => {
  // `cleanup()` unmounts the band, and its own effect cleanup lowers the door:
  // nothing here resets that by hand, so a leaked claim fails the next case.
  cleanup()
  $activeSessionId.set(null)
  setCurrentUsage({ calls: 0, input: 0, output: 0, total: 0 })
})

/**
 * OWNER DECISION 2026-10-19 (RESUME/contracts/M1_message_head_band.md): the band is in BOTH Message
 * views — "the iT does not have that top, but it needs to have it there". It was chat-only before, so
 * that no pill sat over the shell's first lines; the terminal now starts at the band's bottom edge
 * instead (it-terminal.css, pinned in it-terminal-css.test.ts).
 */
describe('the Message head band — one band, both views', () => {
  it('is the same element, the same classes and the same title in chat and in iT', () => {
    const view = render(<MsgHead expanded={false} view="chat" />)

    expect(head()?.querySelector('h2')?.textContent).toBe('iclone os')

    const classes = head()?.className

    view.rerender(<MsgHead expanded={false} view="it" />)

    expect(head()?.className).toBe(classes)
    expect(head()?.querySelector('h2')?.textContent).toBe('iclone os')
    expect(head()?.getAttribute('data-view')).toBe('it')
    expect(window.document.querySelectorAll('.imsg-head')).toHaveLength(1)
  })

  it('expanded, the band is marked in both views so it clears the macOS window buttons', () => {
    const view = render(<MsgHead expanded view="chat" />)

    expect(head()?.hasAttribute('data-expanded')).toBe(true)

    view.rerender(<MsgHead expanded view="it" />)
    expect(head()?.hasAttribute('data-expanded')).toBe(true)
  })

  it('carries the context door at the END of the head, in chat only', () => {
    const view = render(<MsgHead expanded={false} view="chat" />)
    const button = screen.getByTestId('msg-context-button')

    // Last child of the head: the title pill leads, the door closes the row (CSS parks it with
    // `margin-left: auto` inside the content box the head's 64px right padding keeps clear of the
    // window control column).
    expect(head()?.lastElementChild?.contains(button)).toBe(true)
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('type')).toBe('button')
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')

    // iT has no chat session to report; the owner asked for the BAND there, so future buttons have a home.
    view.rerender(<MsgHead expanded={false} view="it" />)
    expect(screen.queryByTestId('msg-context-button')).toBeNull()
  })
})

/**
 * Owner, same instruction: "in that top corner you will put the context usage button, so when we click
 * on it it will show all the information as I ask". "All the information" is the card we already have
 * (app/context-panel) — this is our own control and our own panel over it, never the composer's chip
 * moved (that one is Radix + `--ui-*`, which this window's theme does not take).
 */
describe('the context-usage door', () => {
  const openDoor = async () => {
    render(<MsgHead expanded={false} view="chat" />)

    const button = screen.getByTestId('msg-context-button')

    fireEvent.click(button)
    await act(async () => {})

    return button
  }

  it('reads the live usage and opens the card on the SAME numbers', async () => {
    $activeSessionId.set('m1-rt')
    setCurrentUsage(USAGE)

    const used = formatTokens(50_000)
    const max = formatTokens(200_000)
    const button = await openDoor()

    expect(screen.getByTestId('msg-context-percent').textContent).toBe('25%')
    expect(button.getAttribute('aria-label')).toBe(CONTEXT_PANEL_COPY.chipLabel(25, used, max))
    expect(button.getAttribute('aria-expanded')).toBe('true')

    const panel = screen.getByTestId('msg-context-panel')

    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.contains(screen.getByTestId('context-card'))).toBe(true)
    expect(screen.getByTestId('context-percent').textContent).toBe('25%')
    expect(screen.getByTestId('context-used').textContent).toContain(`${used} / ${max}`)
  })

  it('stands on the band with no session too — the owner asked for the button, not for a conditional one', async () => {
    const button = await openDoor()

    expect(screen.getByTestId('msg-context-percent').textContent).toBe('—')
    expect(button.getAttribute('aria-label')).toBe('Context usage')
    expect(screen.getByTestId('msg-context-panel')).not.toBeNull()
  })

  it('hands the focus to the panel it opens, so a reader lands on the card', async () => {
    await openDoor()

    const panel = screen.getByTestId('msg-context-panel')

    expect(panel.getAttribute('tabindex')).toBe('-1')
    expect(window.document.activeElement).toBe(panel)
  })

  it('closes on Escape and hands the focus back to the button', async () => {
    const button = await openDoor()

    fireEvent.keyDown(window.document, { key: 'Escape' })
    expect(screen.queryByTestId('msg-context-panel')).toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(window.document.activeElement).toBe(button)
  })

  /**
   * LEAD DECISION 2026-10-19 17:10 (gates/L/fronts.json): one door per surface. The composer's chip
   * opens the same card ~300px away on the same surface, so the door raises a flag while it is mounted
   * and the chip stands down (context-chip.tsx). It must also LOWER it: in the iT view there is no door
   * (and in another window no band at all), where the chip has to stay the only way in.
   */
  it('claims the door for its own surface while it is mounted, and only for that one', () => {
    const claimed = () => bandContextDoorSurfaces().has(PRIMARY_SESSION_VIEW)

    expect(claimed()).toBe(false)

    const view = render(<MsgHead expanded={false} view="chat" />)

    expect(claimed()).toBe(true)
    // M1-r2-01: the claim names ONE surface — a session tile's own view is a
    // different key, so its chip never sees this door.
    expect(bandContextDoorSurfaces().size).toBe(1)

    // iT drops the door (it has no chat session to report), so the chip is needed again.
    view.rerender(<MsgHead expanded={false} view="it" />)
    expect(claimed()).toBe(false)

    view.rerender(<MsgHead expanded={false} view="chat" />)
    expect(claimed()).toBe(true)

    view.unmount()
    expect(claimed()).toBe(false)
    expect(bandContextDoorSurfaces().size).toBe(0)
  })

  /**
   * The ring is the door's OWN (msg-head.css), not the card's `.ic-ctx-ring-*`: context-panel.css
   * strokes that one from the old Hermes theme variables on block K's negative list, and front G3 owns
   * that file — so the band draws the same arc on the head's own tokens instead.
   */
  it("draws its own ring, on the head's own tokens", async () => {
    $activeSessionId.set('m1-rt')
    setCurrentUsage(USAGE)
    await openDoor()

    const button = screen.getByTestId('msg-context-button')
    const circles = button.querySelectorAll('svg.imsg-head__ctx-ring circle')

    expect(circles).toHaveLength(2)
    expect(circles[0]?.getAttribute('class')).toBe('imsg-head__ctx-ring-track')
    expect(circles[1]?.getAttribute('class')).toBe('imsg-head__ctx-ring-fill')
    // 25 % of the circumference drawn, measured from the dash offset the component sets.
    const circumference = 2 * Math.PI * 5.5

    expect(Number(circles[1]?.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference * 0.75, 6)
    // The card's own ring class never appears on the band — that is the one we must not inherit.
    expect(button.querySelector('.ic-ctx-ring, .ic-ctx-ring-track, .ic-ctx-ring-fill')).toBeNull()
  })

  it('closes on a pointerdown outside and stays open for one inside', async () => {
    const button = await openDoor()

    fireEvent.pointerDown(screen.getByTestId('msg-context-panel'))
    expect(screen.queryByTestId('msg-context-panel')).not.toBeNull()

    fireEvent.pointerDown(window.document.body)
    expect(screen.queryByTestId('msg-context-panel')).toBeNull()

    // A second click re-opens: the button is a toggle, not a one-shot.
    fireEvent.click(button)
    expect(screen.queryByTestId('msg-context-panel')).not.toBeNull()
    fireEvent.click(button)
    expect(screen.queryByTestId('msg-context-panel')).toBeNull()
  })
})

// jsdom computes no stylesheet: the band's own theme is pinned in the source it ships.
describe('the band keeps the window theme (block K negative list)', () => {
  const read = (name: string) => readFileSync(resolve(process.cwd(), 'src/app/home', name), 'utf8')

  /**
   * M1-r2-02 (r2 critic): the first four patterns never see a Tailwind alias
   * utility. `styles.css`'s `@theme inline` block maps `--color-<name>` onto
   * `var(--dt-<name>)`, so `bg-card` / `text-muted-foreground` IS an old-theme
   * colour while containing none of `--ui-`, `--dt-`, `components/ui`, a hex or
   * an `rgb()`. The alias names are READ from styles.css, never re-typed, so a
   * new alias there widens this scan by itself.
   */
  const colourAliases = () => {
    const theme = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8').match(
      /@theme inline \{[\s\S]*?\n\}/
    )?.[0]

    // Longest first: `text-muted-foreground` must report in full, not as the
    // `muted` prefix that `\b` also accepts before the hyphen.
    return [...(theme ?? '').matchAll(/--color-([\w-]+):\s*var\(--dt-/g)]
      .map(m => m[1]!)
      .sort((a, b) => b.length - a.length)
  }

  const UTILITY_PREFIX =
    'bg|text|border|ring|fill|stroke|from|via|to|outline|divide|shadow|accent|caret|decoration|placeholder'

  it('no --ui-/--dt-/--theme- token, no components/ui import and no raw colour in the band files', () => {
    const files = ['msg-head.tsx', 'msg-head.css', 'msg-window.tsx']
    const aliases = colourAliases()
    // The list is the instrument: an empty one would make the alias scan pass over nothing.
    // This used to be a hard floor of 20, and front E3h's verified removal of eight
    // `@theme inline` declarations on 2026-10-20 made that floor stale (18) while the scan
    // itself was still sound — a fixed number invalidated by a legitimate change, which is
    // the defect class this plan spent 19 Oct removing from its own gates. So the guard is
    // now a CROSS-CHECK of two independent readings of the same block instead of a magic
    // number: the regex list against a line-based count. A parser that silently stopped
    // matching would diverge from the line count; an empty block still fails on > 0.

    const aliasLines = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
      .match(/@theme inline \{[\s\S]*?\n\}/)?.[0]
      ?.split('\n')
      .filter(line => line.includes('--color-') && line.includes('var(--dt-')).length

    expect(aliases.length, 'colour aliases read from styles.css').toBeGreaterThan(0)
    expect(aliases.length, 'the regex list and a line count of the same block must agree').toBe(aliasLines)

    const aliasUtility = new RegExp(
      `\\b(?:${UTILITY_PREFIX})-(?:${aliases.map(a => a.replace(/-/g, '\\-')).join('|')})(?:\\/\\d+)?\\b`,
      'g'
    )

    let lines = 0

    for (const file of files) {
      const text = read(file)

      lines += text.split('\n').length
      expect(text.match(/--(?:ui|dt|theme)-[\w-]+/g) ?? [], file).toEqual([])
      expect(text.match(/@\/components\/ui/g) ?? [], file).toEqual([])
      expect(text.match(/#[\da-fA-F]{3,8}\b/g) ?? [], file).toEqual([])
      expect(text.match(/\b(?:rgba?|hsla?)\(/g) ?? [], file).toEqual([])
      expect(text.match(aliasUtility) ?? [], `${file} Tailwind colour aliases`).toEqual([])
    }

    // A check that reports 0 says how much it read, and fails when it read nothing (plan L rule).
    expect(lines, 'lines examined').toBeGreaterThan(200)
  })

  it("the ring strokes from the head's own ink tokens", () => {
    const css = read('msg-head.css')

    expect(css).toMatch(/\.imsg-head__ctx-ring-track \{\s*stroke: var\(--ic-econ-ink-14\);/)
    expect(css).toMatch(/\.imsg-head__ctx-ring-fill \{\s*stroke: var\(--ic-econ-ink-72\);/)
    expect(css.match(/stroke: var\(--ic-[\w-]+\);/g) ?? []).toHaveLength(3)
  })

  /**
   * The panel hangs 10px under the BAND, and retracted the band itself starts at the window frame's
   * inset (`--iwin-outer-top`): a max-height measured from the viewport's top overflowed the screen by
   * exactly that inset plus the gap, which an empty card was too short to show.
   */
  it("the panel's max-height is measured from the band's own position", () => {
    expect(read('msg-head.css')).toContain(
      'max-height: calc(100vh - var(--iwin-outer-top, var(--ic-frame-top)) - var(--ic-win-head-h) - 26px);'
    )
  })

  it('the door and its panel take their own clicks back from the pointer-less band', () => {
    const css = read('msg-head.css')

    expect(css.match(/pointer-events: auto;/g) ?? []).toHaveLength(2)
    expect(css).toContain('margin-left: auto;')
    expect(css).toMatch(/z-index: var\(--ic-z-local-peak\);/)
  })
})

describe('Message head centring at every text size (U4-p2-13)', () => {
  it('the fixed-height band carries no block padding and the context value has a 1-line box, so flex centres both', () => {
    const band = readFileSync(resolve(__dirname, 'msg-sidebar.css'), 'utf8')
    const head = readFileSync(resolve(__dirname, 'msg-head.css'), 'utf8')

    expect(band).toMatch(/\.ic-win__head\.imsg-head\s*\{[^}]*height: var\(--ic-win-head-h\);[^}]*padding-block: 0;/)
    expect(head).toMatch(/\.imsg-head__ctx-button\s*\{[^}]*align-items: center;/)
    expect(head).toMatch(/\.imsg-head__ctx-value\s*\{[^}]*line-height: 1;/)
  })
})

/**
 * V3-A (RESUME/contracts/V3A_background_tasks.md): the owner's "botão ao lado do botão do contexto … aonde ele mostra
 * atividades em segundo plano". A second door on the same band, left of the ring, in BOTH views (O1).
 */
describe('the Background tasks door (V3-A)', () => {
  const tasksButton = () => screen.getByTestId('msg-tasks-button')

  const fake = (tasks: BgTask[], stop = vi.fn(() => Promise.resolve({ effect: 'killed' as const, ok: true }))) => {
    const listeners = new Set<() => void>()
    let current = tasks

    const src: TaskSource = {
      id: 'fake',
      snapshot: () => current,
      stop,
      subscribe: cb => {
        listeners.add(cb)

        return () => listeners.delete(cb)
      }
    }

    act(() => void registerTaskSource(src))

    return {
      set: (next: BgTask[]) => {
        current = next
        act(() => listeners.forEach(cb => cb()))
      },
      stop
    }
  }

  const bg = (native: string, patch: Partial<BgTask> = {}): BgTask => ({
    id: `fake:${native}`,
    kind: 'shell',
    lastLine: `out ${native}`,
    lastLineAt: null,
    seen: true,
    source: 'fake',
    startedAt: null,
    state: 'running',
    stop: 'none',
    title: `job ${native}`,
    ...patch
  })

  beforeEach(() => {
    window.localStorage.clear()
    resetBackgroundTasksForTests()
  })

  afterEach(() => {
    $backgroundStatusBySession.set({})
    resetBackgroundTasksForTests()
  })

  it('stands left of the ring in one right-hand group, in chat AND in iT (O1); the ring stays chat-only', () => {
    const view = render(<MsgHead expanded={false} view="chat" />)
    const group = head()?.lastElementChild

    expect(group?.className).toBe('imsg-head__tools')
    expect(group?.children[0]?.contains(tasksButton())).toBe(true)
    expect(group?.children[1]?.contains(screen.getByTestId('msg-context-button'))).toBe(true)
    expect(tasksButton().getAttribute('aria-haspopup')).toBe('dialog')

    view.rerender(<MsgHead expanded={false} view="it" />)
    expect(head()?.lastElementChild?.contains(tasksButton())).toBe(true)
    expect(screen.queryByTestId('msg-context-button')).toBeNull()
  })

  it("wears the context door's own pill and hangs its panel in the context card's chassis", () => {
    render(<MsgHead expanded={false} view="chat" />)

    expect(tasksButton().className).toBe(screen.getByTestId('msg-context-button').className)
    fireEvent.click(tasksButton())
    expect(screen.getByTestId('msg-tasks-panel').className).toBe('imsg-head__ctx-panel')
  })

  it('the badge is running + waiting from the live set, the aria-label carries it, and a death gets its own mark', () => {
    render(<MsgHead expanded={false} view="it" />)

    expect(screen.queryByTestId('msg-tasks-count')).toBeNull()

    const source = fake([bg('1'), bg('2', { state: 'waiting' }), bg('3', { state: 'done' })])

    expect(screen.getByTestId('msg-tasks-count').textContent).toBe('2')
    expect(tasksButton().getAttribute('aria-label')).toContain('2')
    expect(screen.queryByTestId('msg-tasks-died-mark')).toBeNull()

    // Job 1 is killed outside the app: the next snapshot no longer has it running.
    source.set([bg('1', { exit: { signal: 'SIGKILL' }, state: 'failed' }), bg('2', { state: 'waiting' })])

    expect(screen.getByTestId('msg-tasks-count').textContent).toBe('1')
    expect(screen.getByTestId('msg-tasks-died-mark')).toBeTruthy()

    // The panel names it, and opening its row clears the mark (the row stays until dismissed).
    fireEvent.click(tasksButton())
    expect(screen.getByTestId('bg-tasks-died-banner')).toBeTruthy()

    const died = screen.getAllByTestId('bg-task-row').find(row => row.getAttribute('data-state') === 'died')!

    expect(died.textContent).toContain('job 1')
    expect(died.textContent).toContain('SIGKILL')
    fireEvent.click(died.querySelector('.icui-row__open')!)
    expect(screen.queryByTestId('msg-tasks-died-mark')).toBeNull()
  })

  it('a shell job polled in a session that is NOT on screen dies in the panel with the panel closed (G3, unit)', () => {
    render(<MsgHead expanded={false} view="chat" />)

    act(() =>
      $backgroundStatusBySession.set({
        'off-screen': [{ id: 'p1', state: 'running', title: 'sleep 600', type: 'background' }]
      })
    )
    expect(screen.getByTestId('msg-tasks-count').textContent).toBe('1')

    act(() =>
      $backgroundStatusBySession.set({
        'off-screen': [{ exitCode: -9, id: 'p1', state: 'failed', title: 'sleep 600', type: 'background' }]
      })
    )

    expect(screen.queryByTestId('msg-tasks-count')).toBeNull()
    expect(screen.getByTestId('msg-tasks-died-mark')).toBeTruthy()
  })

  it('G7: Enter opens, focus lands in the panel, Escape closes and hands it back; one door at a time', async () => {
    render(<MsgHead expanded={false} view="chat" />)

    tasksButton().focus()
    fireEvent.click(tasksButton())
    expect(window.document.activeElement).toBe(screen.getByTestId('msg-tasks-panel'))

    // Opening the other door closes this one — by keyboard as well, where no pointerdown fires.
    act(() => screen.getByTestId('msg-context-button').click())
    expect(screen.queryByTestId('msg-tasks-panel')).toBeNull()
    expect(screen.getByTestId('msg-context-panel')).toBeTruthy()
    expect(window.document.querySelectorAll('[role="dialog"]')).toHaveLength(1)

    act(() => tasksButton().click())
    expect(screen.queryByTestId('msg-context-panel')).toBeNull()

    fireEvent.keyDown(window.document, { key: 'Escape' })
    expect(screen.queryByTestId('msg-tasks-panel')).toBeNull()
    expect(window.document.activeElement).toBe(tasksButton())
  })

  it('states: empty when nothing runs, a failing source named while others render', () => {
    render(<MsgHead expanded={false} view="chat" />)
    fireEvent.click(tasksButton())

    // The runtime registered the built-in sources on mount: nothing runs, so the panel is empty, not loading.
    expect(screen.getByTestId('msg-tasks-panel').querySelector('[data-ic-state="empty"]')).toBeTruthy()

    const broken: TaskSource = {
      id: 'agent',
      snapshot: () => {
        throw new Error('stream lost')
      },
      stop: () => Promise.resolve({ effect: 'unsupported', ok: false }),
      subscribe: () => () => undefined
    }

    act(() => void registerTaskSource(broken))
    fake([bg('1')])

    expect(screen.getByTestId('bg-tasks-source-error').textContent).toContain('stream lost')
    expect(screen.getAllByTestId('bg-task-row')).toHaveLength(1)
  })

  it('G6: 200 tasks mount at most 50 rows; "Show 50 more" adds the next 50', () => {
    render(<MsgHead expanded={false} view="chat" />)
    fake(Array.from({ length: 200 }, (_, i) => bg(String(i))))
    fireEvent.click(tasksButton())

    expect(screen.getAllByTestId('bg-task-row')).toHaveLength(50)
    fireEvent.click(screen.getByTestId('bg-tasks-more'))
    expect(screen.getAllByTestId('bg-task-row')).toHaveLength(100)
  })

  it('G4: Stop only where stopping is real; elsewhere one line says why, and 0 Stop buttons', async () => {
    render(<MsgHead expanded={false} view="chat" />)

    const source = fake([
      bg('real', { stop: 'real' }),
      bg('agent', { kind: 'agent', stop: 'none' }),
      bg('cron', { kind: 'cron', stop: 'none' })
    ])

    fireEvent.click(tasksButton())

    expect(screen.getAllByTestId('bg-task-stop')).toHaveLength(1)
    expect(screen.getAllByTestId('bg-task-cannot-stop')).toHaveLength(2)

    await act(async () => {
      fireEvent.click(screen.getByTestId('bg-task-stop').querySelector('button')!)
    })

    expect(source.stop).toHaveBeenCalledWith('real')
    // Acknowledged, not yet confirmed: the row is still running and says it is stopping.
    expect(screen.getByTestId('bg-task-stop').querySelector('button')?.disabled).toBe(true)
  })

  it('the elapsed time is "—" when the start is unknown, never a guess (R1)', () => {
    render(<MsgHead expanded={false} view="chat" />)
    fake([bg('1', { startedAt: null })])
    fireEvent.click(tasksButton())

    expect(screen.getByTestId('bg-task-row').textContent).toContain('—')
  })

  it('the permission log tab is read-only and says so when this build has no bridge', () => {
    render(<MsgHead expanded={false} view="chat" />)
    fireEvent.click(tasksButton())
    fireEvent.click(screen.getByRole('button', { name: 'Permission log' }))

    expect(screen.getByTestId('msg-tasks-panel').textContent).toContain('not available')
    expect(screen.getByTestId('msg-tasks-panel').querySelectorAll('input, textarea')).toHaveLength(0)
  })
})

/**
 * V3-A r1b: a running shell job can leave the composer store without dying — the stack's X killed it, a rewind
 * dropped it, or its session was lost (4001). Each reads as what happened; only an unexplained end reads "Died".
 * These drive the REAL composer-status functions through the real processes source and row copy.
 */
describe('Background tasks: a job that ends without dying is named, never "Died"', () => {
  const tasksButton = () => screen.getByTestId('msg-tasks-button')
  const request = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>()

  const startJob = (sid: string) => {
    render(<MsgHead expanded={false} view="chat" />)
    act(() =>
      $backgroundStatusBySession.set({
        [sid]: [{ id: 'p1', state: 'running', title: 'sleep 600', type: 'background' }]
      })
    )
    expect(screen.getByTestId('msg-tasks-count').textContent).toBe('1')
  }

  const endedRow = () => {
    fireEvent.click(tasksButton())

    const [row, ...rest] = screen.getAllByTestId('bg-task-row')

    expect(rest).toHaveLength(0)

    return row!
  }

  beforeEach(() => {
    window.localStorage.clear()
    resetBackgroundTasksForTests()
    resetBackgroundPollingGuard()
    request.mockReset().mockResolvedValue({})
    $gateway.set({ request } as never)
  })

  afterEach(() => {
    $backgroundStatusBySession.set({})
    $backgroundStopWatch.set({})
    $gateway.set(null)
    resetBackgroundPollingGuard()
    resetBackgroundTasksForTests()
  })

  /** The gateway's `process.list` answer for p1, per the scenario. */
  const listing = (proc: Record<string, unknown> | null) =>
    request.mockImplementation(method =>
      Promise.resolve(method === 'process.list' ? { processes: proc ? [{ session_id: 'p1', ...proc }] : [] } : {})
    )

  const RUNNING = { command: 'sleep 600', status: 'running' }

  it('the composer stack\'s X on a running job ⇒ "Stopping…" until the registry confirms, then "Stopped by you"', async () => {
    startJob('rt-x')
    listing(RUNNING)

    await act(() => stopBackgroundProcess('rt-x', 'p1'))

    expect(request).toHaveBeenCalledWith('process.kill', { process_id: 'p1', session_id: 'rt-x' })
    // Intent is not effect: until a reading says the process is gone, it is still running.
    expect(screen.getByTestId('msg-tasks-count').textContent).toBe('1')
    fireEvent.click(tasksButton())
    expect(screen.getByTestId('bg-task-row').dataset.state).toBe('running')
    expect(screen.getByTestId('bg-task-stop').textContent).toBe('Stopping…')
    expect(screen.getByTestId('bg-task-stop').querySelector('button')?.disabled).toBe(true)

    listing(null)
    await act(() => refreshBackgroundProcesses('rt-x'))

    expect(screen.queryByTestId('msg-tasks-died-mark')).toBeNull()

    const row = screen.getByTestId('bg-task-row')

    expect(row).toMatchObject({ dataset: { endedBy: 'owner', state: 'stopped' } })
    expect(row.textContent).toContain('Stopped by you')
    expect(row.textContent).not.toContain('Died')
  })

  it('a rewind ⇒ "Stopping…", then "Removed by rewind" once the registry confirms, no death mark', async () => {
    startJob('rt-rw')
    listing(RUNNING)

    act(() => resetSessionBackground('rt-rw'))

    fireEvent.click(tasksButton())
    expect(screen.getByTestId('bg-task-stop').textContent).toBe('Stopping…')

    listing({ ...RUNNING, exit_code: -15, status: 'exited' })
    await act(() => refreshBackgroundProcesses('rt-rw'))

    expect(screen.queryByTestId('msg-tasks-died-mark')).toBeNull()

    const row = screen.getByTestId('bg-task-row')

    expect(row).toMatchObject({ dataset: { endedBy: 'rewind', state: 'stopped' } })
    expect(row.textContent).toContain('Removed by rewind')
  })

  describe('a stop that did not take never reads "Stopped"', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('the X on a gateway that ACKs without killing ⇒ "Did not stop" with Retry; its later end is still the owner\'s', async () => {
      startJob('rt-ack')
      listing(RUNNING)

      await act(() => stopBackgroundProcess('rt-ack', 'p1'))
      fireEvent.click(tasksButton())
      expect(screen.getByTestId('bg-task-stop').textContent).toBe('Stopping…')

      // The stop's own re-read, STOP_VERIFY_MS later, still finds it running.
      await act(() => vi.advanceTimersByTimeAsync(3_000))

      expect(screen.getByTestId('bg-task-row').dataset.state).toBe('running')
      expect(screen.getByTestId('bg-task-did-not-stop').textContent).toContain('Did not stop')
      expect(screen.getByTestId('bg-task-retry').textContent).toBe('Retry')
      expect(screen.getByTestId('msg-tasks-count').textContent).toBe('1')

      listing({ ...RUNNING, exit_code: 1, status: 'exited' })
      await act(() => refreshBackgroundProcesses('rt-ack'))

      const row = screen.getByTestId('bg-task-row')

      expect(row).toMatchObject({ dataset: { endedBy: 'owner', state: 'stopped' } })
      expect(screen.queryByTestId('msg-tasks-died-mark')).toBeNull()
    })

    it('a rewind whose kill is refused ⇒ "Did not stop" at once, still running', async () => {
      startJob('rt-rwf')
      request.mockImplementation(method =>
        method === 'process.kill'
          ? Promise.reject(new Error('no such process'))
          : Promise.resolve({ processes: [{ session_id: 'p1', ...RUNNING }] })
      )

      await act(async () => resetSessionBackground('rt-rwf'))
      fireEvent.click(tasksButton())

      expect(screen.getByTestId('bg-task-row').dataset.state).toBe('running')
      expect(screen.getByTestId('bg-task-did-not-stop')).toBeTruthy()
      expect(screen.queryByText('Removed by rewind')).toBeNull()
    })

    it('MAJOR-2: the panel Stop on an ACK-without-kill gateway ⇒ "Did not stop"; its later end is still the owner\'s', async () => {
      startJob('rt-panel')
      listing(RUNNING)
      fireEvent.click(tasksButton())

      await act(async () => fireEvent.click(screen.getByTestId('bg-task-stop').querySelector('button')!))
      expect(request).toHaveBeenCalledWith('process.kill', { process_id: 'p1', session_id: 'rt-panel' })
      await act(() => vi.advanceTimersByTimeAsync(3_000))

      expect(screen.getByTestId('bg-task-did-not-stop').textContent).toContain('Did not stop')

      listing({ ...RUNNING, exit_code: 1, status: 'exited' })
      await act(() => refreshBackgroundProcesses('rt-panel'))

      const row = screen.getByTestId('bg-task-row')

      expect(row).toMatchObject({ dataset: { endedBy: 'owner', state: 'stopped' } })
      expect(screen.queryByTestId('msg-tasks-died-mark')).toBeNull()
    })

    it('Retry after "Did not stop" sends the kill again, and a confirmed exit then reads "Stopped by you"', async () => {
      startJob('rt-retry')
      listing(RUNNING)

      await act(() => stopBackgroundProcess('rt-retry', 'p1'))
      await act(() => vi.advanceTimersByTimeAsync(3_000))
      fireEvent.click(tasksButton())
      request.mockClear()

      await act(async () => fireEvent.click(screen.getByTestId('bg-task-retry').querySelector('button')!))

      expect(request).toHaveBeenCalledWith('process.kill', { process_id: 'p1', session_id: 'rt-retry' })
      expect(screen.getByTestId('bg-task-stop').textContent).toBe('Stopping…')

      listing({ ...RUNNING, exit_code: -15, status: 'exited' })
      await act(() => refreshBackgroundProcesses('rt-retry'))

      const row = screen.getByTestId('bg-task-row')

      expect(row).toMatchObject({ dataset: { endedBy: 'owner', state: 'stopped' } })
      expect(screen.queryByTestId('msg-tasks-died-mark')).toBeNull()
    })
  })

  it('MAJOR-1: 4001 → the gateway reconnects → the job is live again: running, counted, and Stop is offered', async () => {
    startJob('rt-back')
    request.mockRejectedValue(new JsonRpcGatewayError('session not found', { code: 4001 }))

    await act(() => refreshBackgroundProcesses('rt-back'))
    expect(screen.queryByTestId('msg-tasks-count')).toBeNull()

    listing(RUNNING)
    act(() => resetBackgroundPollingGuard())
    await act(() => refreshBackgroundProcesses('rt-back'))

    expect(screen.getByTestId('msg-tasks-count').textContent).toBe('1')
    fireEvent.click(tasksButton())

    const row = screen.getByTestId('bg-task-row')

    expect(row.dataset.state).toBe('running')
    expect(row.dataset.endedBy).toBeUndefined()
    expect(row.textContent).not.toContain('Session ended')
    expect(screen.getByTestId('bg-task-stop').textContent).toBe('Stop')
  })

  it('a session lost to 4001 "session not found" ⇒ "Session ended", not running forever and not died', async () => {
    startJob('rt-gone')
    request.mockRejectedValue(new JsonRpcGatewayError('session not found', { code: 4001 }))

    await act(() => refreshBackgroundProcesses('rt-gone'))

    // The composer store still holds the row as running; the panel no longer counts it.
    expect($backgroundStatusBySession.get()['rt-gone']?.[0]?.state).toBe('running')
    expect(screen.queryByTestId('msg-tasks-count')).toBeNull()
    expect(screen.queryByTestId('msg-tasks-died-mark')).toBeNull()

    const row = endedRow()

    expect(row).toMatchObject({ dataset: { endedBy: 'session', state: 'stopped' } })
    expect(row.textContent).toContain('Session ended')
  })

  /**
   * minor-9 (critic r3, R2): a read sent before a rebind answers "session not found" for the runtime the rebind
   * replaced, and lands before any post-rebind reading. The rebound session is healthy and the job still runs: the
   * stale 4001 must not end it as "Session ended" nor call a stop that did not take "Stopped by you".
   */
  it('minor-9: a stale pre-rebind 4001 landing first never ends a live job, and polling goes on', async () => {
    vi.useFakeTimers()

    try {
      startJob('r2')
      fireEvent.click(tasksButton())

      let sent = 0

      request.mockImplementation(method => {
        if (method !== 'process.list') {
          return Promise.resolve({})
        }

        sent += 1

        return sent === 1
          ? new Promise((_resolve, reject) =>
              setTimeout(() => reject(new JsonRpcGatewayError('session not found', { code: 4001 })), 1_000)
            )
          : new Promise(resolve => setTimeout(() => resolve({ processes: [{ session_id: 'p1', ...RUNNING }] }), 2_000))
      })

      // The kill's own read leaves at 0 s for the old runtime; a fresh runtime binds at 0.5 s.
      await act(async () => fireEvent.click(screen.getByTestId('bg-task-stop').querySelector('button')!))
      await act(() => vi.advanceTimersByTimeAsync(500))
      act(() => resetBackgroundPollingGuard('r2'))
      await act(() => vi.advanceTimersByTimeAsync(100))
      act(() => void refreshBackgroundProcesses('r2'))

      for (let t = 600; t < 15_000; t += 100) {
        await act(() => vi.advanceTimersByTimeAsync(100))

        const row = screen.getByTestId('bg-task-row')

        expect(row.dataset.state, `t=${t + 100} ms`).toBe('running')
        expect(row.textContent).not.toContain('Stopped by you')
        expect(row.textContent).not.toContain('Session ended')
      }

      expect(screen.getByTestId('bg-task-did-not-stop').textContent).toContain('Did not stop')
      expect(request.mock.calls.filter(([method]) => method === 'process.list').length).toBeGreaterThan(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('CONTROL: a running job that vanishes from the registry for no known reason still reads "Died", unseen', () => {
    startJob('rt-die')

    act(() => reconcileBackgroundProcesses('rt-die', []))

    expect(screen.getByTestId('msg-tasks-died-mark')).toBeTruthy()

    const row = endedRow()

    expect(row.dataset).toMatchObject({ state: 'died' })
    expect(row.dataset.endedBy).toBeUndefined()
    expect(row.textContent).toContain('Died')
  })

  /**
   * MAJOR-3 (critic r2, Q5–Q7): on a slow or out-of-order gateway, a reading that was SENT before the kill took effect
   * can land after the 3 s window. It proves nothing about the kill, so it must never turn a stop that worked into
   * "Did not stop", and then into an unseen "Died". The gateway here answers each `process.list` with the registry as
   * it was when the request was sent, after a per-request delay.
   */
  describe('MAJOR-3: a slow or out-of-order gateway never makes a stop that worked read "Did not stop" or "Died"', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    const RUNNING = { command: 'sleep 600', status: 'running' }
    const SIGTERMED = { ...RUNNING, exit_code: -15, status: 'exited' }

    let registry: Record<string, unknown> | null = RUNNING

    /** `latency(n)` is the delay of the n-th `process.list` (0-based); every other method answers at once. */
    const laggingGateway = (latency: (n: number) => number) => {
      let sent = 0

      registry = RUNNING
      request.mockImplementation(method => {
        if (method !== 'process.list') {
          return Promise.resolve({})
        }

        const reply = { processes: registry ? [{ session_id: 'p1', ...registry }] : [] }

        return new Promise(resolve => setTimeout(() => resolve(reply), latency((sent += 1) - 1)))
      })
    }

    const openPanel = (sid: string) => {
      startJob(sid)
      fireEvent.click(tasksButton())
    }

    const pressPanelStop = () =>
      act(async () => fireEvent.click(screen.getByTestId('bg-task-stop').querySelector('button')!))

    const expectNoLie = (at: string) => {
      expect(screen.queryByTestId('bg-task-did-not-stop'), `"Did not stop" at ${at}`).toBeNull()
      expect(screen.queryByTestId('msg-tasks-died-mark'), `death mark at ${at}`).toBeNull()
      expect(
        screen.queryAllByTestId('bg-task-row').map(row => row.dataset.state),
        `a died row at ${at}`
      ).not.toContain('died')
    }

    /** Advances in 100 ms steps, checking the panel never lies at any of them. */
    const walk = async (ms: number, from: number) => {
      for (let t = 100; t <= ms; t += 100) {
        await act(() => vi.advanceTimersByTimeAsync(100))
        expectNoLie(`t=${from + t} ms`)
      }
    }

    const expectStoppedByYou = () => {
      const [row, ...rest] = screen.getAllByTestId('bg-task-row')

      expect(rest).toHaveLength(0)
      expect(row).toMatchObject({ dataset: { endedBy: 'owner', state: 'stopped' } })
      expect(row!.textContent).toContain('Stopped by you')
      expect(screen.queryByTestId('msg-tasks-died-mark')).toBeNull()
    }

    it('Q5 · the composer X, replies 2 s late: a read sent at 1.5 s that lands at 3.5 s is not a verdict', async () => {
      openPanel('m3-x')
      laggingGateway(() => 2_000)

      await act(() => stopBackgroundProcess('m3-x', 'p1'))
      await walk(1_500, 0)
      act(() => void refreshBackgroundProcesses('m3-x'))
      await walk(100, 1_500)
      registry = SIGTERMED
      await walk(8_400, 1_600)

      expectStoppedByYou()

      registry = null
      act(() => void refreshBackgroundProcesses('m3-x'))
      await walk(2_500, 10_000)
      expectStoppedByYou()
    })

    it.each([1_000, 2_000, 3_000])(
      'Q6 · the panel Stop, replies %i ms late, SIGTERM lands at 0.1 s ⇒ "Stopped by you", never "Did not stop"',
      async latency => {
        openPanel(`m3-panel-${latency}`)
        laggingGateway(() => latency)

        await pressPanelStop()
        expect(screen.getByTestId('bg-task-stop').textContent).toBe('Stopping…')
        await walk(100, 0)
        registry = SIGTERMED
        await walk(9_900, 100)

        expectStoppedByYou()
        expect($stopAttempts.get()).toEqual({})
      }
    )

    it('Q7 · the panel Stop, out-of-order replies (the first read lands last) ⇒ a stale "running" never revives it', async () => {
      openPanel('m3-order')
      laggingGateway(n => (n === 0 ? 2_500 : 100))

      await pressPanelStop()
      registry = SIGTERMED
      await walk(2_200, 0)
      expectStoppedByYou()
      // The read sent at 0 s lands now, older than the confirmed exit: dropped, not a resurrection.
      await walk(5_000, 2_200)

      expectStoppedByYou()
      expect(screen.queryByTestId('bg-task-stop')).toBeNull()
    })

    it('CONTROL · a stop that really did not take, on the same slow gateway, still reads "Did not stop"', async () => {
      openPanel('m3-ctl')
      laggingGateway(() => 2_000)

      await pressPanelStop()
      // The verdict needs a reading sent 3 s after the kill; it lands 2 s later.
      await act(() => vi.advanceTimersByTimeAsync(5_100))

      expect(screen.getByTestId('bg-task-row').dataset.state).toBe('running')
      expect(screen.getByTestId('bg-task-did-not-stop').textContent).toContain('Did not stop')
      expect(screen.getByTestId('bg-task-retry').textContent).toBe('Retry')
    })

    it('CONTROL · the composer X on a kill that did not take, slow gateway, still reads "Did not stop"', async () => {
      openPanel('m3-xctl')
      laggingGateway(() => 2_000)

      await act(() => stopBackgroundProcess('m3-xctl', 'p1'))
      await act(() => vi.advanceTimersByTimeAsync(5_100))

      expect(screen.getByTestId('bg-task-row').dataset.state).toBe('running')
      expect(screen.getByTestId('bg-task-did-not-stop').textContent).toContain('Did not stop')
    })

    /**
     * MAJOR-4 (critic r3, S / S-X): a job that honours the stop but takes longer than the 3 s window to exit (a dev
     * server, docker, any graceful shutdown) reads "Did not stop" — true at that moment — and then, when it exits,
     * "Stopped by you": the owner's ask ended it. Never "Died", never the death mark, at any 100 ms step.
     */
    const pressX = (sid: string) => act(() => stopBackgroundProcess(sid, 'p1'))

    const expectNoDeath = (at: string) => {
      expect(screen.queryByTestId('msg-tasks-died-mark'), `death mark at ${at}`).toBeNull()
      expect(
        screen.queryAllByTestId('bg-task-row').map(row => row.dataset.state),
        `a died row at ${at}`
      ).not.toContain('died')
    }

    for (const path of ['panel', 'X'] as const) {
      it.each([4_000, 10_000, 30_000])(
        `MAJOR-4 · ${path}: the job exits on the SIGTERM %i ms after Stop ⇒ "Did not stop", then "Stopped by you", never "Died"`,
        async exitAt => {
          const sid = `m4-${path}-${exitAt}`

          openPanel(sid)
          laggingGateway(() => 300)
          await (path === 'panel' ? pressPanelStop() : pressX(sid))

          for (let t = 100; t <= exitAt + 3_000; t += 100) {
            if (t === exitAt) {
              registry = SIGTERMED
            }

            // A reader after the exit: the stack's own poll, or anyone's.
            if (t === exitAt + 500) {
              act(() => void refreshBackgroundProcesses(sid))
            }

            await act(() => vi.advanceTimersByTimeAsync(100))
            expectNoDeath(`t=${t} ms`)

            if (t === exitAt - 100) {
              // The verdict was true at the time: the job had outlived the window.
              expect(screen.getByTestId('bg-task-did-not-stop').textContent).toContain('Did not stop')
            }
          }

          expectStoppedByYou()

          // And it stays so: the ledger keeps the owner's reason after the registry forgets the job.
          registry = null
          act(() => void refreshBackgroundProcesses(sid))
          await walk(1_000, exitAt + 3_000)
          expectStoppedByYou()
        }
      )
    }

    it('MAJOR-4 CONTROL · a job that never stops stays "Did not stop" with Retry, and is never called stopped', async () => {
      openPanel('m4-ctl')
      laggingGateway(() => 300)

      await pressPanelStop()

      for (let t = 0; t < 30_000; t += 5_000) {
        act(() => void refreshBackgroundProcesses('m4-ctl'))
        await act(() => vi.advanceTimersByTimeAsync(5_000))
      }

      expect(screen.getByTestId('bg-task-row').dataset.state).toBe('running')
      expect(screen.getByTestId('bg-task-did-not-stop').textContent).toContain('Did not stop')
      expect(screen.getByTestId('bg-task-retry').textContent).toBe('Retry')
      expect(screen.queryByText('Stopped by you')).toBeNull()
    })

    /**
     * minor-8 (critic r3, U / U-null): with no reading of the gateway, "Stopping…" does not run forever. 15 s after the
     * stop it reads a neutral "Can't confirm" (with Retry), never "Did not stop", never "Died"; the reading that comes
     * later still decides.
     */
    const expectCannotConfirm = () => {
      const note = screen.getByTestId('bg-task-cannot-confirm')

      expect(note.textContent).toContain("Can't confirm")
      expect(note.querySelector('[data-tone="danger"]')).toBeNull()
      expect(screen.queryByTestId('bg-task-stop')).toBeNull()
      expect(screen.queryByTestId('bg-task-did-not-stop')).toBeNull()
      expect(screen.getByTestId('bg-task-row').dataset.state).toBe('running')
    }

    /** Every `process.list` sent before `until` ms hangs and times out at 30 s, the client's own deadline. */
    const unreadableGateway = (until: number) => {
      const t0 = Date.now()

      registry = RUNNING
      request.mockImplementation(method => {
        if (method !== 'process.list') {
          return Promise.resolve({})
        }

        const reply = { processes: registry ? [{ session_id: 'p1', ...registry }] : [] }

        return Date.now() - t0 < until
          ? new Promise((_resolve, reject) => setTimeout(() => reject(new Error('request timed out')), 30_000))
          : new Promise(resolve => setTimeout(() => resolve(reply), 200))
      })
    }

    for (const path of ['panel', 'X'] as const) {
      for (const worked of [true, false]) {
        it(`minor-8 · ${path}: gateway unreadable 30 s ⇒ "Stopping…", "Can't confirm" at 15 s, then the reading decides (kill ${worked ? 'worked' : 'failed'})`, async () => {
          const sid = `m8-${path}-${worked}`

          openPanel(sid)
          unreadableGateway(30_000)
          await (path === 'panel' ? pressPanelStop() : pressX(sid))

          if (worked) {
            registry = SIGTERMED
          }

          await walk(14_800, 0)
          expect(screen.getByTestId('bg-task-stop').textContent).toBe('Stopping…')
          await walk(200, 14_800)
          expectCannotConfirm()

          // The gateway answers again: the first reading sent after it decides.
          await walk(16_000, 15_000)
          act(() => void refreshBackgroundProcesses(sid))

          for (let t = 31_100; t <= 35_000; t += 100) {
            await act(() => vi.advanceTimersByTimeAsync(100))
            expectNoDeath(`t=${t} ms`)
          }

          if (worked) {
            expectStoppedByYou()
          } else {
            expect(screen.getByTestId('bg-task-did-not-stop').textContent).toContain('Did not stop')
            expect(screen.queryByTestId('bg-task-cannot-confirm')).toBeNull()
          }
        })
      }

      it(`minor-8 · ${path}: the gateway disconnects after the kill ⇒ "Can't confirm" at 15 s; reconnected, the reading decides`, async () => {
        const sid = `m8-off-${path}`
        const gateway = $gateway.get()

        openPanel(sid)
        laggingGateway(() => 100)
        await (path === 'panel' ? pressPanelStop() : pressX(sid))
        act(() => $gateway.set(null))
        registry = SIGTERMED

        await walk(15_000, 0)
        expectCannotConfirm()

        act(() => $gateway.set(gateway))
        act(() => void refreshBackgroundProcesses(sid))
        await walk(4_000, 15_000)

        expectStoppedByYou()
      })
    }
  })

  describe('elapsed "—"', () => {
    beforeEach(stubResizeObserver)
    afterEach(() => vi.unstubAllGlobals())

    it('the same tip opens from the keyboard: Tab onto the row and it reads "Start time unknown"', async () => {
      startJob('rt-kbd')
      fireEvent.click(tasksButton())

      const open = screen.getByTestId('bg-task-row').querySelector<HTMLElement>('.icui-row__open')!
      const matches = HTMLElement.prototype.matches

      // jsdom has no focus-visible heuristics; the trigger asks for it, as Chromium answers after a Tab.
      const focusVisible = vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (
        this: HTMLElement,
        selector: string
      ) {
        return selector === ':focus-visible' ? this === open : matches.call(this, selector)
      })

      try {
        fireEvent.keyDown(window.document.body, { key: 'Tab' })
        act(() => open.focus())

        await waitFor(() =>
          expect(window.document.querySelector('[data-slot=tooltip-content]')?.textContent).toContain(
            'Start time unknown'
          )
        )
        expect(focusVisible).toHaveBeenCalledWith(':focus-visible')
      } finally {
        focusVisible.mockRestore()
      }
    })

    it('a row with no start time says why on hover; a row with one carries no tip', async () => {
      startJob('rt-tip')
      fireEvent.click(tasksButton())

      const open = screen.getByTestId('bg-task-row').querySelector<HTMLElement>('.icui-row__open')!

      expect(open.textContent).toContain('—')
      expect(open.dataset.slot).toBe('tooltip-trigger')
      fireEvent.pointerMove(open, { pointerType: 'mouse' })

      await waitFor(() =>
        expect(window.document.querySelector('[data-slot=tooltip-content]')?.textContent).toContain(
          'Start time unknown'
        )
      )

      let known = () => {}

      act(() => {
        known = registerTaskSource({
          id: 'timed',
          snapshot: () => [
            {
              id: 'timed:1',
              kind: 'agent',
              lastLine: null,
              lastLineAt: null,
              seen: true,
              source: 'timed',
              startedAt: Date.now() - 5_000,
              state: 'running',
              stop: 'none',
              title: 'timed agent'
            }
          ],
          stop: () => Promise.resolve({ effect: 'unsupported', ok: false }),
          subscribe: () => () => undefined
        })
      })

      const timed = screen
        .getAllByTestId('bg-task-row')
        .find(row => row.textContent?.includes('timed agent'))!
        .querySelector<HTMLElement>('.icui-row__open')!

      expect(timed.dataset.slot).toBeUndefined()
      act(known)
    })
  })
})
