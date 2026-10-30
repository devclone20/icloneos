import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerTerminalReader } from '../right-sidebar/terminal/buffer'
import { $terminals, createTerminal, type TerminalEntry } from '../right-sidebar/terminal/terminals'

import {
  $itClosePrompt,
  closeFocusedItPane,
  confirmItClose,
  dismissItClose,
  handleItHubKey,
  requestCloseItPane,
  requestCloseItWorkspace,
  resetItClosePressForTests
} from './it-keys'
import { listPanes } from './it-layout'
import {
  $itSurfaceOpen,
  $itWorkspaces,
  activeItWorkspace,
  addItWorkspace,
  setItInstancesForTests,
  splitItPane
} from './it-store'

const settle = () => new Promise<void>(resolve => queueMicrotask(resolve))

function key(
  init: Partial<{
    altKey: boolean
    ctrlKey: boolean
    key: string
    metaKey: boolean
    repeat: boolean
    shiftKey: boolean
  }>
) {
  return {
    altKey: false,
    ctrlKey: false,
    key: '',
    metaKey: false,
    shiftKey: false,
    ...init,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  }
}

function reset(): string {
  const id = createTerminal('/tmp')

  $terminals.set([$terminals.get().find(term => term.id === id) as TerminalEntry])
  setItInstancesForTests([
    {
      activeId: 'ws-k',
      id: 'it-1',
      n: 1,
      named: false,
      open: true,
      title: 'iT',
      workspaces: [
        {
          focusTerminalId: id,
          id: 'ws-k',
          layout: { type: 'leaf', terminalId: id },
          named: true,
          title: 'k',
          unread: false,
          zoomedTerminalId: null
        }
      ]
    }
  ])
  dismissItClose()
  resetItClosePressForTests()

  return id
}

const ws = () => activeItWorkspace()!

type Reader = Parameters<typeof registerTerminalReader>[1]

/** What a started shell shows; a pane without a reader never started. */
const screen = (id: string, text: string) => registerTerminalReader(id, (() => ({ text })) as unknown as Reader)

describe('handleItHubKey', () => {
  beforeEach(() => {
    reset()
  })

  it('hands every ⌃-only chord to the shell: ⌃C, ⌃D (EOF), ⌃W, ⌃⇧D, ⌃⇧T', () => {
    for (const init of [
      { ctrlKey: true, key: 'c' },
      { ctrlKey: true, key: 'd' },
      { ctrlKey: true, key: 'w' },
      { ctrlKey: true, key: 'D', shiftKey: true },
      { ctrlKey: true, key: 'T', shiftKey: true }
    ]) {
      const event = key(init)

      expect(handleItHubKey(event), JSON.stringify(init)).toBe(false)
      expect(event.preventDefault).not.toHaveBeenCalled()
    }

    expect(listPanes(ws().layout)).toHaveLength(1)
  })

  it('⌘D splits right, ⌘⇧D splits down, ⌃⌘= equalizes', () => {
    expect(handleItHubKey(key({ key: 'd', metaKey: true }))).toBe(true)
    expect(handleItHubKey(key({ key: 'D', metaKey: true, shiftKey: true }))).toBe(true)
    expect(listPanes(ws().layout)).toHaveLength(3)
    expect(handleItHubKey(key({ ctrlKey: true, key: '=', metaKey: true }))).toBe(true)
  })

  it('⌘⇧T opens nothing: there are no iT windows', () => {
    expect(handleItHubKey(key({ key: 'T', metaKey: true, shiftKey: true }))).toBe(false)
    expect($itWorkspaces.get()).toHaveLength(1)
  })

  it('⌘W closes the focused pane and consumes the chord', () => {
    const first = ws().focusTerminalId
    const second = splitItPane(ws().id, 'h')!

    expect(handleItHubKey(key({ key: 'w', metaKey: true }))).toBe(true)
    expect(listPanes(ws().layout)).toEqual([first])
    expect($terminals.get().some(term => term.id === second)).toBe(false)
  })

  it('⌘W never closes the last pane of the last workspace', () => {
    const only = ws().focusTerminalId

    expect(handleItHubKey(key({ key: 'w', metaKey: true }))).toBe(true)
    expect(listPanes(ws().layout)).toEqual([only])
  })

  it('leaves plain typing alone', () => {
    expect(handleItHubKey(key({ key: 'd' }))).toBe(false)
  })
})

describe('the guarded close (busy prompt)', () => {
  beforeEach(() => {
    reset()
  })

  it('a busy pane asks first; Keep keeps it, Close closes exactly it', () => {
    const busy = splitItPane(ws().id, 'h')!

    screen(busy, 'python3\n>>> while True: pass')
    expect(requestCloseItPane(ws().id, busy)).toBe('prompt')
    expect($itClosePrompt.get()).toMatchObject({ busy: 1, terminalId: busy })
    dismissItClose()
    expect(listPanes(ws().layout)).toContain(busy)
    expect(requestCloseItPane(ws().id, busy)).toBe('prompt')
    expect(confirmItClose()).toBe(true)
    expect(listPanes(ws().layout)).not.toContain(busy)
  })

  it('an idle pane closes at once; a never-started one is idle', () => {
    const idle = splitItPane(ws().id, 'h')!

    screen(idle, 'user@mac ~ % ')
    expect(requestCloseItPane(ws().id, idle)).toBe('closed')
    expect(requestCloseItPane(ws().id, splitItPane(ws().id, 'v')!)).toBe('closed')
  })

  it("a workspace's last pane closes the workspace, never the last workspace", async () => {
    const lone = ws().focusTerminalId

    expect(requestCloseItPane(ws().id, lone)).toBe('refused')
    addItWorkspace('two')
    await settle()
    expect(requestCloseItPane(ws().id, ws().focusTerminalId)).toBe('closed')
    expect($itWorkspaces.get()).toHaveLength(1)
    expect(requestCloseItWorkspace(ws().id)).toBe('refused')
  })
})

describe('closeFocusedItPane (the macOS ⌘W path)', () => {
  beforeEach(() => {
    reset()
  })

  it('claims ⌘W only while the keyboard is in the iT view on screen', () => {
    const inside = document.createElement('div')
    const outside = document.createElement('div')

    inside.setAttribute('data-it-host', 'x')
    splitItPane(ws().id, 'h')
    $itSurfaceOpen.set(false)
    expect(closeFocusedItPane(inside)).toBe(false)
    $itSurfaceOpen.set(true)
    expect(closeFocusedItPane(outside)).toBe(false)
    expect(listPanes(ws().layout)).toHaveLength(2)
    expect(closeFocusedItPane(inside)).toBe(true)
    expect(listPanes(ws().layout)).toHaveLength(1)
    // The last pane: still iT's chord (never falls through to a chat tab), nothing closes.
    expect(closeFocusedItPane(inside)).toBe(true)
    expect(listPanes(ws().layout)).toHaveLength(1)
    $itSurfaceOpen.set(false)
  })
})

describe('one ⌘W press closes exactly one pane — R3d r4', () => {
  const inside = document.createElement('div')
  const cmdW = (init: { repeat?: boolean } = {}) => handleItHubKey(key({ key: 'w', metaKey: true, ...init }))

  inside.setAttribute('data-it-host', 'x')

  beforeEach(() => {
    reset()
    vi.useFakeTimers()
    $itSurfaceOpen.set(true)
    splitItPane(ws().id, 'h')
    splitItPane(ws().id, 'v')
    splitItPane(ws().id, 'h')
    expect(listPanes(ws().layout)).toHaveLength(4)
  })

  afterEach(() => {
    $itSurfaceOpen.set(false)
    vi.useRealTimers()
  })

  it("the page keydown and main's IPC request of the same press close one pane, in either order", () => {
    expect(cmdW()).toBe(true)
    expect(closeFocusedItPane(inside)).toBe(true)
    expect(listPanes(ws().layout)).toHaveLength(3)

    vi.advanceTimersByTime(1000)
    expect(closeFocusedItPane(inside)).toBe(true)
    expect(cmdW()).toBe(true)
    expect(listPanes(ws().layout)).toHaveLength(2)
  })

  it('a held ⌘W (auto-repeat) closes one pane; a later press closes the next', () => {
    expect(cmdW()).toBe(true)
    expect(cmdW({ repeat: true })).toBe(true)
    expect(cmdW({ repeat: true })).toBe(true)
    expect(listPanes(ws().layout)).toHaveLength(3)
    vi.advanceTimersByTime(1000)
    expect(cmdW()).toBe(true)
    expect(listPanes(ws().layout)).toHaveLength(2)
  })

  it('one press delivered twice over IPC in the same frame closes one pane', () => {
    expect(closeFocusedItPane(inside)).toBe(true)
    vi.advanceTimersByTime(2)
    expect(closeFocusedItPane(inside)).toBe(true)
    expect(listPanes(ws().layout)).toHaveLength(3)
  })

  it('two fast presses on one path are two presses (hardware ⌘W⌘W)', () => {
    expect(closeFocusedItPane(inside)).toBe(true)
    vi.advanceTimersByTime(120)
    expect(closeFocusedItPane(inside)).toBe(true)
    expect(listPanes(ws().layout)).toHaveLength(2)
  })

  it('ipc + key + ipc echo of one press (10 ms apart) close one pane — R3d r5', () => {
    expect(closeFocusedItPane(inside)).toBe(true)
    vi.advanceTimersByTime(10)
    expect(cmdW()).toBe(true)
    vi.advanceTimersByTime(10)
    expect(closeFocusedItPane(inside)).toBe(true)
    expect(listPanes(ws().layout)).toHaveLength(3)
  })

  it('two IPC listeners + the page keydown of one press close one pane — R3d r5', () => {
    expect(closeFocusedItPane(inside)).toBe(true)
    expect(closeFocusedItPane(inside)).toBe(true)
    vi.advanceTimersByTime(5)
    expect(cmdW()).toBe(true)
    vi.advanceTimersByTime(5)
    expect(cmdW()).toBe(true)
    expect(listPanes(ws().layout)).toHaveLength(3)
  })

  it('a second press on a path the first already used is a new press, and its own twin is absorbed — R3d r5', () => {
    expect(closeFocusedItPane(inside)).toBe(true)
    expect(cmdW()).toBe(true)
    vi.advanceTimersByTime(250)
    expect(closeFocusedItPane(inside)).toBe(true)
    vi.advanceTimersByTime(5)
    expect(cmdW()).toBe(true)
    expect(listPanes(ws().layout)).toHaveLength(2)
  })
})
