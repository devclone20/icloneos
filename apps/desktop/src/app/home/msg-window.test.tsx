import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $msgSidebarOpen, setMsgSidebarOpen, toggleMsgSidebar } from '@/app/chat/sidebar/msg-sidebar-state'
import { setDockWindowSize } from '@/store/dock-window-size'
import type * as Windows from '@/store/windows'

import { $itClosePrompt } from './it-keys'
import { $itWorkspaces, setMsgView } from './it-store'
import { MessageWindow } from './msg-window'

vi.mock('./it-terminal', () => ({
  ItTerminal: () => {
    throw new Error('iT render failure (test)')
  }
}))

// The wired chat surface, marked: these tests are about WHO mounts it and for
// how long, not about the chat engine behind it.
vi.mock('@/app/contrib/context', () => ({
  WiredPane: ({ part }: { part: string }) => <div data-test-wired={part} />
}))

vi.mock('@/store/windows', async importOriginal => ({
  ...(await importOriginal<typeof Windows>()),
  isPeerInstanceWindow: () => false
}))

// jsdom has no ResizeObserver; the window chassis only needs it to exist.
vi.stubGlobal(
  'ResizeObserver',
  class {
    disconnect() {}
    observe() {}
    unobserve() {}
  }
)

describe('MessageWindow iT boundary', () => {
  afterEach(() => {
    cleanup()
    setMsgView('chat')
  })

  it('a throw inside iT shows the iT crash card and keeps the window and its view switch', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    setMsgView('it')
    render(
      <MemoryRouter>
        <MessageWindow onClose={() => undefined} />
      </MemoryRouter>
    )

    const card = screen.getByRole('alert', { name: 'iT terminal' })

    expect(card.textContent).toContain('iT failed — the rest of the app is fine')
    expect(card.getAttribute('data-scope')).toBe('message')
    expect(screen.getAllByRole('button', { name: 'message' })).not.toHaveLength(0)

    // Back to chat and the window still works.
    fireEvent.click(screen.getAllByRole('button', { name: 'message' })[0])
    expect(screen.getAllByRole('button', { name: 'iT' })[0].getAttribute('aria-pressed')).toBe('false')
    quiet.mockRestore()
  })
})

describe('MessageWindow session sidebar', () => {
  // These cases start from the window on its frame: the Settings choice "normal size" (the default is pinned in
  // window/expanded.test.tsx and below).
  beforeEach(() => setDockWindowSize('normal'))

  afterEach(() => {
    setDockWindowSize('maximized')
    cleanup()
    setMsgView('chat')
    $itClosePrompt.set(null)
  })

  const bodyLeft = () => window.document.querySelector<HTMLElement>('[data-ic-window-body="message"]')?.style.left ?? ''

  const bodyTop = () => window.document.querySelector<HTMLElement>('[data-ic-window-body="message"]')?.style.top ?? ''

  it('replaces the top bar: no header tabs, the econ title pill heads the window', () => {
    render(
      <MemoryRouter>
        <MessageWindow onClose={() => undefined} />
      </MemoryRouter>
    )

    expect(window.document.querySelector('.iwin-tabs, .imsg-rail, .imsg-chip')).toBeNull()
    // Contract §14: the SAME markup as the econ windows' head (econ/window.tsx).
    const pill = window.document.querySelector('header.ic-win__head.iecon__head.imsg-head > h2')

    expect(pill?.textContent).toBe('iclone os')
    expect(pill?.closest('header')?.classList.contains('ic-tone--message')).toBe(true)
    expect(bodyTop()).toContain('+ var(--ic-win-head-h)')
  })

  // OWNER DECISION 2026-10-19 (RESUME/contracts/M1_message_head_band.md): the band is in BOTH views —
  // "the iT does not have that top, but it needs to have it there". This test asserted the opposite until
  // then (`.imsg-head` null on iT), because a fixed band over a terminal that starts at the window's top
  // edge covers the shell's first lines. That reason still holds: what makes the band safe on iT is that
  // the body — and with it the terminal (it-terminal.css reads the measured --iwin-top) — starts at the
  // band's bottom edge in both views.
  it('heads BOTH views with the same pill, and the body starts under the band in both', () => {
    setMsgView('it')
    render(
      <MemoryRouter>
        <MessageWindow onClose={() => undefined} />
      </MemoryRouter>
    )

    const pill = () => window.document.querySelector('header.ic-win__head.iecon__head.imsg-head > h2')

    expect(pill()?.textContent).toBe('iclone os')
    expect(window.document.querySelector('.imsg-head')?.getAttribute('data-view')).toBe('it')
    expect(bodyTop()).toContain('+ var(--ic-win-head-h)')
    // ONE head element across the switch, so the band cannot flash or jump (owner: "smooth transiction").
    expect(window.document.querySelectorAll('.imsg-head')).toHaveLength(1)

    act(() => setMsgView('chat'))

    expect(pill()?.textContent).toBe('iclone os')
    expect(window.document.querySelector('.imsg-head')?.getAttribute('data-view')).toBe('chat')
    expect(bodyTop()).toContain('+ var(--ic-win-head-h)')
    expect(window.document.querySelectorAll('.imsg-head')).toHaveLength(1)
  })

  it('opens maximized with the default choice (Settings › Machine › Appearance)', () => {
    setDockWindowSize('maximized')
    render(
      <MemoryRouter>
        <MessageWindow onClose={() => undefined} />
      </MemoryRouter>
    )

    expect(window.document.querySelector('header.imsg-head')?.hasAttribute('data-expanded')).toBe(true)
    expect(screen.getByRole('button', { name: 'Retract message window' })).toBeTruthy()
  })

  it('expanded, the head and the sidebar are marked so both clear the macOS window buttons', () => {
    render(
      <MemoryRouter>
        <MessageWindow onClose={() => undefined} />
      </MemoryRouter>
    )

    const head = () => window.document.querySelector('header.imsg-head')
    const nav = () => screen.getByRole('navigation', { name: 'Conversations' })

    expect(head()?.hasAttribute('data-expanded')).toBe(false)
    expect(nav().hasAttribute('data-expanded')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Expand message window' }))
    expect(head()?.hasAttribute('data-expanded')).toBe(true)
    expect(nav().hasAttribute('data-expanded')).toBe(true)

    // The band is in iT too (owner 2026-10-19), so BOTH keep the mark there: the head clears the macOS
    // window buttons and the sidebar, which starts under the band, needs no pad of its own any more.
    act(() => setMsgView('it'))
    expect(head()?.hasAttribute('data-expanded')).toBe(true)
    expect(nav().hasAttribute('data-expanded')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Retract message window' }))
    expect(nav().hasAttribute('data-expanded')).toBe(false)
  })

  it('opens collapsed and moves the body clip once per toggle: at the start of expand, at the end of collapse', () => {
    render(
      <MemoryRouter>
        <MessageWindow onClose={() => undefined} />
      </MemoryRouter>
    )

    expect(screen.getByRole('button', { name: 'Show conversations' }).getAttribute('aria-expanded')).toBe('false')
    expect(bodyLeft()).toContain('var(--ic-msg-rail-w)')

    fireEvent.click(screen.getByRole('button', { name: 'Show conversations' }))
    expect(bodyLeft()).toContain('var(--ic-msg-sidebar-w)')

    fireEvent.click(screen.getByRole('button', { name: 'Hide conversations' }))
    // Still wide while the panel slides out over the plate…
    expect(bodyLeft()).toContain('var(--ic-msg-sidebar-w)')

    // …and narrow once its fade has finished.
    const panel = window.document.querySelector('.imsg-side__panel') as HTMLElement

    fireEvent.transitionEnd(panel, { propertyName: 'transform' })
    expect(bodyLeft()).toContain('var(--ic-msg-sidebar-w)')
    fireEvent.transitionEnd(panel, { propertyName: 'opacity' })
    expect(bodyLeft()).toContain('var(--ic-msg-rail-w)')
  })

  it('⌘B (U2-p2-01): the shared store toggles the sidebar, the window toggle writes the same store, and closing the window clears it', () => {
    const onClose = vi.fn()
    render(
      <StrictMode>
        <MemoryRouter>
          <MessageWindow onClose={onClose} />
        </MemoryRouter>
      </StrictMode>
    )

    const nav = () => screen.getByRole('navigation', { name: 'Conversations' })

    expect(nav().hasAttribute('data-open')).toBe(false)
    act(() => toggleMsgSidebar())
    expect(nav().hasAttribute('data-open')).toBe(true)
    expect(bodyLeft()).toContain('var(--ic-msg-sidebar-w)')
    // The window's own control is the same door.
    fireEvent.click(screen.getByRole('button', { name: 'Hide conversations' }))
    expect($msgSidebarOpen.get()).toBe(false)
    expect(nav().hasAttribute('data-open')).toBe(false)

    act(() => setMsgSidebarOpen(true))
    fireEvent.click(screen.getByRole('button', { name: 'Close message' }))
    // Every open starts collapsed (owner rule): the explicit close clears the store.
    expect(onClose).toHaveBeenCalledTimes(1)
    expect($msgSidebarOpen.get()).toBe(false)
  })

  it('⌘B from outside the chat pre-opens the sidebar: a window mounting with the store set opens with it on stage', () => {
    setMsgSidebarOpen(true)

    // <StrictMode>, like main.tsx: its mount→cleanup→mount cycle must not wipe
    // the pre-set — an unmount-time store clear did (UF2B2-r2-C1).
    const { unmount } = render(
      <StrictMode>
        <MemoryRouter>
          <MessageWindow onClose={() => undefined} />
        </MemoryRouter>
      </StrictMode>
    )

    expect(screen.getByRole('navigation', { name: 'Conversations' }).hasAttribute('data-open')).toBe(true)
    expect(bodyLeft()).toContain('var(--ic-msg-sidebar-w)')
    // Unmounting without a close writes nothing to the store.
    unmount()
    expect($msgSidebarOpen.get()).toBe(true)
    setMsgSidebarOpen(false)
  })

  it('a busy-close prompt opens the sidebar once; the toggle still collapses it while the prompt waits', () => {
    render(
      <MemoryRouter>
        <MessageWindow onClose={() => undefined} />
      </MemoryRouter>
    )
    act(() => setMsgView('it'))

    const [workspace] = $itWorkspaces.get()

    const expanded = () => screen.getByRole('navigation', { name: 'Conversations' }).hasAttribute('data-open')

    act(() => $itClosePrompt.set({ busy: 1, terminalId: null, workspaceId: workspace.id }))
    expect(expanded()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Hide conversations' }))
    expect(expanded()).toBe(false)
    // The same prompt, re-rendered: the owner's collapse stands.
    act(() => $itClosePrompt.set({ busy: 2, terminalId: null, workspaceId: workspace.id }))
    expect(expanded()).toBe(false)
  })
})

// jsdom computes no stylesheet: the head geometry every window shares is pinned in the CSS source.
describe('one head for every window', () => {
  const css = (file: string) => readFileSync(resolve(process.cwd(), 'src/app/home', file), 'utf8')

  const block = (file: string, selector: string) => {
    const text = css(file)
    const at = text.indexOf(`${selector} {`)

    expect(at, `${selector} in ${file}`).toBeGreaterThanOrEqual(0)

    return text.slice(at, text.indexOf('}', at))
  }

  it('every econ head is at least the shared height and the Message head is exactly it', () => {
    expect(css('ic-tokens.css')).toMatch(/:root \{[^}]*--ic-win-head-h: max\(60px, calc\(/)
    expect(block('window/ic-window.css', '.ic-win__head')).toMatch(
      /box-sizing: border-box;[\s\S]*min-height: var\(--ic-win-head-h\);/
    )
    expect(block('msg-sidebar.css', '.ic-win__head.imsg-head')).toContain('height: var(--ic-win-head-h);')
  })

  it('the shared height is derived from the text scale, so it still clears the tallest head content at large text', () => {
    // The head's own padding and hairline are px (14 + 14 + 1); its tallest content is the identity chip: 1px border
    // and 4px padding around one line of --ic-type-md at the econ line-height (econ.css `.iecon` 1.45). Text size
    // multiplies every absolute font-size by --ic-text-scale (vite/postcss-text-scale.ts), so the floor has to as
    // well — a second fixed number per text size would drift (critic r6 D3-r7-T1).
    const decl =
      /--ic-win-head-h: max\(60px, calc\(39px \+ var\(--ic-type-md\) \* 1\.45 \* var\(--ic-text-scale, 1\)\)\);/

    const tokens = css('ic-tokens.css')

    expect(tokens).toMatch(decl)
    expect(tokens).not.toMatch(/--ic-win-head-h: \d/)
    expect(tokens).not.toMatch(/data-text-size[^{]*\{[^}]*--ic-win-head-h/)

    // The 39 and the 1.45 above are READ FROM these two files. Pin them here, or a change over there leaves the
    // token silently wrong until a lab probe happens to run (critic r7 D3-r8-T2).
    const headBlock = block('window/ic-window.css', '.ic-win__head')

    expect(headBlock, '39px = 14 + 14 padding + the 1px hairline').toContain('padding-block: 14px;')
    // Logical: the end padding clears the control column, which hugs the inline-end corner (left under RTL); the
    // distance is one token (64px), the same one a page head inside the body reads (ic-page.css, H-1).
    expect(headBlock).toContain('padding-inline: 26px var(--ic-win-controls-clear);')
    expect(tokens).toMatch(/--ic-win-controls-clear: 64px;/)
    expect(headBlock, '39px includes this hairline').toMatch(/border-bottom: 1px/)
    expect(block('econ/econ.css', '.iecon'), 'the 1.45 multiplier is econ\u2019s line-height').toMatch(
      /line-height: 1\.45;/
    )

    // 0.75rem = 12px: 39 + 1.45 * 12 * scale -> 56.4 (small 47.7) under the 60px floor, 73.8 at large.
    const head = (scale: number) => Math.max(60, 39 + 1.45 * 12 * scale)

    expect(head(1)).toBe(60)
    expect(head(0.5)).toBe(60)
    expect(head(2)).toBeCloseTo(73.8, 1)
  })

  it('expanded, the econ and Message heads read one inset, declared on the head (the controls offset is set below :root)', () => {
    expect(block('ic-tokens.css', '.ic-win__head')).toContain(
      '--ic-win-head-inset-expanded: max(26px, calc(var(--titlebar-controls-left, 78px) + 12px));'
    )
    expect(block('window/ic-window.css', '.ic-win[data-expanded] > .ic-win__head')).toContain(
      'padding-left: var(--ic-win-head-inset-expanded);'
    )
    expect(block('msg-sidebar.css', '.ic-win__head.imsg-head[data-expanded]')).toContain(
      'padding-left: var(--ic-win-head-inset-expanded);'
    )
  })
})

describe('the Message window owns the chat surface', () => {
  afterEach(() => {
    cleanup()
    setMsgView('chat')
  })

  const surfaces = () => window.document.body.querySelectorAll('[data-test-wired="chatRoutes"]')

  it('mounts the chat surface exactly once, at the page root, for exactly as long as the window lives', () => {
    const view = render(
      <MemoryRouter>
        <MessageWindow onClose={() => undefined} />
      </MemoryRouter>
    )

    // ONE mount: a second one would be a second composer and a second submit
    // path on the same session (contract E3 §5).
    expect(surfaces()).toHaveLength(1)
    // Portalled to <body>, not nested in the window box: home.css positions it
    // `fixed` from the page root, and nesting it inside the home layer would
    // re-stack the whole window (no layout-tree change, no CSS move).
    expect(surfaces()[0].parentElement).toBe(window.document.body)
    expect(
      window.document.querySelector('[data-ic-window-body="message"]')?.querySelector('[data-test-wired]')
    ).toBeNull()

    // The window is the owner: its life is the surface's life.
    view.unmount()
    expect(surfaces()).toHaveLength(0)
  })

  it('marks <html> for the clip and keeps the view in step, then cleans both up', () => {
    const root = window.document.documentElement

    const view = render(
      <MemoryRouter>
        <MessageWindow onClose={() => undefined} />
      </MemoryRouter>
    )

    expect(root.dataset.icloneWindow).toBe('1')
    expect(root.dataset.icloneView).toBe('chat')

    act(() => setMsgView('it'))
    expect(root.dataset.icloneView).toBe('it')

    // Still ONE surface: the chat only hides on iT (drafts, composer bus, mic).
    expect(surfaces()).toHaveLength(1)

    view.unmount()
    expect(root.dataset.icloneWindow).toBeUndefined()
    expect(root.dataset.icloneView).toBeUndefined()
  })

  it('sets that mark BEFORE paint — a passive effect would flash one unclipped full-window chat frame', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/home/msg-window.tsx'), 'utf8')

    expect(source).toMatch(/useLayoutEffect\(\(\) => \{\s*const root = document\.documentElement/)
    expect(source).not.toMatch(/useEffect\(\(\) => \{\s*const root = document\.documentElement/)
  })
})
