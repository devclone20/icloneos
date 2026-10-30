/**
 * The iT layout algebra. These are the operations the owner reported broken —
 * "when I split, what was written disappears" and "only one of the panes
 * works" — so the invariants they pin are:
 *
 *   - a split KEEPS the existing pane's shell and adds one beside it;
 *   - every pane of a workspace is addressable at the same time;
 *   - closing a pane closes its shell and nothing else;
 *   - a shell that leaves the pool leaves the layout with it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { IT_MIN_PANE_PX } from './it-host-rects'
import { type ItPaneNode, listPanes } from './it-layout'
import {
  $itActiveId,
  $itBodySize,
  $itInstances,
  $itWorkspaces,
  $msgView,
  activeItWorkspace,
  addItWorkspace,
  breakItPane,
  canSplitItPane,
  closeItPane,
  closeItWorkspace,
  cycleItPane,
  equalizeItPanes,
  findItWorkspace,
  focusItPane,
  isRefShapedTitle,
  renameItWorkspace,
  setItInstancesForTests,
  setItPaneRatio,
  setMsgView,
  splitItPane,
  toggleItZoom
} from './it-store'
import { $terminals, closeTerminal, createTerminal, type TerminalEntry } from './it/engine/terminals'

/** The reconcile pass is deferred to a microtask on purpose (a split must be
 *  able to create a shell and place it in the same tick). */
const settle = () => new Promise<void>(resolve => queueMicrotask(resolve))

function reset(): void {
  const id = createTerminal('/tmp')

  $terminals.set([$terminals.get().find(term => term.id === id) as TerminalEntry])
  setItInstancesForTests([
    {
      activeId: 'ws-test',
      id: 'it-1',
      n: 1,
      named: false,
      open: false,
      title: 'iT',
      workspaces: [
        {
          focusTerminalId: id,
          id: 'ws-test',
          layout: { type: 'leaf', terminalId: id },
          named: true,
          title: 'test',
          unread: false,
          zoomedTerminalId: null
        }
      ]
    }
  ])
}

const ws = () => activeItWorkspace()!

function ratios(node: ItPaneNode): number[] {
  return node.type === 'leaf' ? [] : [node.ratio, ...ratios(node.a), ...ratios(node.b)]
}

describe('iT layout', () => {
  beforeEach(() => {
    reset()
    // Unmeasured body: the divider clamps at .12–.88.
    $itBodySize.set(null)
  })

  it('a split keeps the existing shell and adds one beside it', async () => {
    const before = ws().focusTerminalId

    const created = splitItPane('ws-test', 'h')
    await settle()

    const panes = listPanes(ws().layout)

    expect(created).toBeTruthy()
    // The whole point: the pane that was there is STILL there, same shell id.
    expect(panes).toEqual([before, created])
    expect(ws().focusTerminalId).toBe(created)
    // And it is a real pool terminal, not an invented pane id.
    expect($terminals.get().map(term => term.id)).toContain(created)
  })

  it('holds every pane addressable at once, however deep the tree', async () => {
    splitItPane('ws-test', 'h')
    await settle()
    splitItPane('ws-test', 'v')
    await settle()
    focusItPane('ws-test', listPanes(ws().layout)[0])
    splitItPane('ws-test', 'v')
    await settle()

    const panes = listPanes(ws().layout)

    expect(panes).toHaveLength(4)
    expect(new Set(panes).size).toBe(4)
    expect($itWorkspaces.get()).toHaveLength(1)
  })

  it('closing a pane promotes its sibling and closes only that shell', async () => {
    const first = ws().focusTerminalId
    const second = splitItPane('ws-test', 'h')!
    await settle()

    expect(closeItPane('ws-test', second)).toBe(true)
    await settle()

    expect(listPanes(ws().layout)).toEqual([first])
    expect(ws().focusTerminalId).toBe(first)
    expect($terminals.get().map(term => term.id)).not.toContain(second)
    expect($terminals.get().map(term => term.id)).toContain(first)
  })

  it('never closes the last pane', () => {
    expect(closeItPane('ws-test', ws().focusTerminalId)).toBe(false)
    expect(listPanes(ws().layout)).toHaveLength(1)
  })

  it('walks the focus around the panes', async () => {
    const first = ws().focusTerminalId
    const second = splitItPane('ws-test', 'h')!
    await settle()

    expect(ws().focusTerminalId).toBe(second)
    cycleItPane('ws-test', 1)
    expect(ws().focusTerminalId).toBe(first)
    cycleItPane('ws-test', 1)
    expect(ws().focusTerminalId).toBe(second)
    cycleItPane('ws-test', -1)
    expect(ws().focusTerminalId).toBe(first)
  })

  it('clamps a divider drag and equalizes back to the middle', async () => {
    splitItPane('ws-test', 'h')
    await settle()

    const node = ws().layout as Extract<ItPaneNode, { type: 'split' }>

    setItPaneRatio('ws-test', node.id, 0.99)
    expect(ratios(ws().layout)[0]).toBeCloseTo(0.88)

    setItPaneRatio('ws-test', node.id, -1)
    expect(ratios(ws().layout)[0]).toBeCloseTo(0.12)

    equalizeItPanes('ws-test')
    expect(ratios(ws().layout)).toEqual([0.5])
  })

  it('zooms one pane and comes back', async () => {
    splitItPane('ws-test', 'h')
    await settle()

    const focused = ws().focusTerminalId

    expect(toggleItZoom('ws-test')).toBe(true)
    expect(ws().zoomedTerminalId).toBe(focused)
    expect(toggleItZoom('ws-test')).toBe(true)
    expect(ws().zoomedTerminalId).toBeNull()
  })

  it('a split drops the zoom instead of splitting into a hidden layout', async () => {
    splitItPane('ws-test', 'h')
    await settle()
    toggleItZoom('ws-test')
    expect(ws().zoomedTerminalId).toBeTruthy()

    splitItPane('ws-test', 'v')
    await settle()

    expect(ws().zoomedTerminalId).toBeNull()
    expect(listPanes(ws().layout)).toHaveLength(3)
  })

  it('breaks a pane out carrying its shell, not a fresh one', async () => {
    const lifted = splitItPane('ws-test', 'h')!
    await settle()

    const before = $terminals.get().length

    expect(breakItPane('ws-test')).toBeTruthy()
    await settle()

    const carried = $itWorkspaces.get().find(workspace => workspace.id !== 'ws-test')!

    expect(listPanes(carried.layout)).toEqual([lifted])
    expect($terminals.get()).toHaveLength(before)
    expect(listPanes($itWorkspaces.get()[0].layout)).not.toContain(lifted)
  })

  it('drops a leaf when its shell leaves the pool', async () => {
    const second = splitItPane('ws-test', 'h')!
    await settle()

    closeTerminal(second)
    await settle()

    expect(listPanes(ws().layout)).not.toContain(second)
    expect(listPanes(ws().layout)).toHaveLength(1)
  })

  it('gives a shell that appears from nowhere a home of its own', async () => {
    const stray = createTerminal('/tmp/stray')
    await settle()

    const owner = $itWorkspaces.get().find(workspace => listPanes(workspace.layout).includes(stray))

    expect(owner).toBeTruthy()
    expect(owner!.id).not.toBe('ws-test')
    // …and it did NOT disturb the workspace that was already laid out.
    expect(listPanes($itWorkspaces.get()[0].layout)).toHaveLength(1)
  })

  it('never closes the last workspace', () => {
    expect(closeItWorkspace('ws-test')).toBe(false)

    const extra = addItWorkspace('second')

    expect(closeItWorkspace('ws-test')).toBe(true)
    expect($itWorkspaces.get().map(workspace => workspace.id)).toEqual([extra.id])
  })
})

// The key strings are user data on disk (home/lib/storage-keys.ts): pinned
// literally here so a registry edit cannot silently orphan a stored layout.
describe('iT persistence', () => {
  beforeEach(reset)

  it('stores the Message/iT view and boots back into it', async () => {
    setMsgView('it')
    expect($msgView.get()).toBe('it')
    expect(window.localStorage.getItem('iclone.msg.view')).toBe('it')

    vi.resetModules()
    const fresh = await import('./it-store')

    expect(fresh.$msgView.get()).toBe('it')

    fresh.setMsgView('chat')
    expect(window.localStorage.getItem('iclone.msg.view')).toBe('chat')
  })

  it('stores the whole layout under its key on every change', async () => {
    const second = splitItPane('ws-test', 'v')

    await settle()
    expect(second).not.toBeNull()

    const stored = JSON.parse(window.localStorage.getItem('iclone.it.layout.v3') ?? 'null') as {
      activeId: string
      workspaces: { id: string; layout: ItPaneNode }[]
    }

    expect(stored.activeId).toBe($itActiveId.get())
    expect(stored.workspaces.map(workspace => workspace.id)).toEqual($itWorkspaces.get().map(workspace => workspace.id))
    expect(stored.workspaces[0].layout).toEqual(activeItWorkspace()?.layout)
    expect(listPanes(stored.workspaces[0].layout)).toContain(second)
  })
})

describe('the one iT surface', () => {
  beforeEach(() => {
    reset()
  })

  it('holds exactly one instance, it-1, whatever is done to it', async () => {
    addItWorkspace('two')
    splitItPane(ws().id, 'h')
    await settle()
    expect($itInstances.get().map(item => item.id)).toEqual(['it-1'])
    expect($itWorkspaces.get()).toBe($itInstances.get()[0].workspaces)
    expect($itActiveId.get()).toBe(ws().id)
  })

  it('resolves a workspace by index or EXACT title, never a substring or an ambiguous title', () => {
    addItWorkspace('build')
    addItWorkspace('build-old')
    expect(findItWorkspace('2')?.title).toBe('build')
    expect(findItWorkspace('BUILD')?.title).toBe('build')
    expect(findItWorkspace('bui')).toBeUndefined()
    expect(findItWorkspace('old')).toBeUndefined()
    expect(findItWorkspace('9')).toBeUndefined()
    addItWorkspace('build')
    expect(findItWorkspace('build')).toBeUndefined()
  })

  it('never stores a ref-shaped title: a numbered ref would win over it', () => {
    expect(isRefShapedTitle('3')).toBe(true)
    expect(isRefShapedTitle('it-3')).toBe(true)
    expect(isRefShapedTitle('build 3')).toBe(false)
    expect(addItWorkspace('2').named).toBe(false)
    expect(renameItWorkspace(ws().id, '7')).toBe(false)
    expect(renameItWorkspace(ws().id, 'logs')).toBe(true)
    expect(ws().title).toBe('logs')
  })

  it('places every pool terminal exactly once after any sequence', async () => {
    const first = ws().id

    splitItPane(first, 'h')
    addItWorkspace('b')
    splitItPane(ws().id, 'v')
    createTerminal('/tmp')
    await settle()

    const placed = $itWorkspaces.get().flatMap(item => listPanes(item.layout))

    expect(new Set(placed).size).toBe(placed.length)
    expect(new Set(placed)).toEqual(new Set($terminals.get().map(term => term.id)))
  })
})

describe('iT layout boot (v3, v2 merged, v1)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  const leaf = (id: string, ws: string, title: string) => ({
    focusTerminalId: id,
    id: ws,
    layout: { type: 'leaf', terminalId: id },
    named: true,
    title
  })

  it('boots a v1 layout, writes v3 and leaves v1 untouched', async () => {
    const pool = await import('./it/engine/terminals')
    const id = pool.createTerminal('/tmp')
    const v1 = JSON.stringify({ activeId: 'w1', workspaces: [leaf(id, 'w1', 'old')] })

    window.localStorage.setItem('iclone.it.layout.v1', v1)
    vi.resetModules()

    const store = await import('./it-store')

    expect(store.$itInstances.get().map(item => item.id)).toEqual(['it-1'])
    expect(store.$itWorkspaces.get()[0].title).toBe('old')
    store.addItWorkspace('new')
    expect(window.localStorage.getItem('iclone.it.layout.v1')).toBe(v1)
    expect(JSON.parse(window.localStorage.getItem('iclone.it.layout.v3')!).workspaces).toHaveLength(2)
  })

  it('merges a multi-window v2 file into the one surface without losing a workspace or a pane', async () => {
    const pool = await import('./it/engine/terminals')
    const [a, b, c] = [pool.createTerminal('/a'), pool.createTerminal('/b'), pool.createTerminal('/c')]

    const split = {
      a: { terminalId: b, type: 'leaf' },
      b: { terminalId: c, type: 'leaf' },
      dir: 'h',
      id: 's1',
      ratio: 0.4,
      type: 'split'
    }

    const v2 = JSON.stringify({
      focused: 'it-3',
      instances: [
        {
          activeId: 'w3',
          n: 3,
          open: true,
          raisedSeq: 2,
          title: 'iT 3',
          workspaces: [{ ...leaf(b, 'w3', 'build'), layout: split }]
        },
        { activeId: 'w1', n: 1, open: false, raisedSeq: 0, title: 'iT 1', workspaces: [leaf(a, 'w1', 'main')] },
        // A pane two windows claimed is placed once; a repeated id once.
        { activeId: 'w1', n: 2, open: true, raisedSeq: 1, title: 'iT 2', workspaces: [leaf(a, 'w1', 'dup')] }
      ],
      version: 2
    })

    window.localStorage.setItem('iclone.it.layout.v2', v2)
    vi.resetModules()

    const store = await import('./it-store')
    const workspaces = store.$itWorkspaces.get()

    expect(store.$itInstances.get()).toHaveLength(1)
    expect(workspaces.map(item => item.title)).toEqual(['main', 'build'])
    expect(listPanes(workspaces[1].layout)).toEqual([b, c])
    expect(store.$itActiveId.get()).toBe('w1')
    store.setItActive('w3')
    expect(window.localStorage.getItem('iclone.it.layout.v2')).toBe(v2)

    const v3 = JSON.parse(window.localStorage.getItem('iclone.it.layout.v3')!)

    expect(v3).toMatchObject({ activeId: 'w3', version: 3 })
    expect(v3.instances).toBeUndefined()
  })

  it('boots one workspace with one shell from a corrupt v3', async () => {
    window.localStorage.setItem('iclone.it.layout.v3', '{not json')

    const store = await import('./it-store')

    expect(store.$itInstances.get()).toHaveLength(1)
    expect(store.$itWorkspaces.get()).toHaveLength(1)
  })
})

describe('R5 r6 — splits never make an unusable pane; default titles stay unique', () => {
  beforeEach(() => {
    reset()
    $itBodySize.set(null)
  })

  it('refuses a split whose halves would fall under ~20 cols × 4 rows, and creates no shell', () => {
    $itBodySize.set({ height: 400, width: 580 })
    expect(splitItPane(ws().id, 'h')).not.toBeNull()
    expect(splitItPane(ws().id, 'h')).toBeNull()
    expect(canSplitItPane(ws().id, 'h')).toBe(false)
    expect(listPanes(ws().layout)).toHaveLength(2)
    expect($terminals.get()).toHaveLength(2)
    // The other direction still has room.
    expect(splitItPane(ws().id, 'v')).not.toBeNull()
  })

  it('ten splits of the focused pane stop at the size floor instead of painting slivers', () => {
    $itBodySize.set({ height: 700, width: 1200 })

    for (let i = 0; i < 10; i += 1) {
      splitItPane(ws().id, i % 2 ? 'v' : 'h')
    }

    const count = listPanes(ws().layout).length

    expect(count).toBeGreaterThan(3)
    expect(count).toBeLessThan(11)
  })

  it('uses a conservative body before iT has ever been measured', () => {
    expect(canSplitItPane(ws().id, 'h')).toBe(true)
    expect(canSplitItPane('nope', 'h')).toBe(false)
  })

  it('add three, close the second, add one: no two tabs share a default title', () => {
    addItWorkspace()
    const second = addItWorkspace()

    addItWorkspace()
    closeItWorkspace(second.id)
    addItWorkspace()

    const titles = $itWorkspaces.get().map(item => item.title)

    expect(new Set(titles).size).toBe(titles.length)
    expect(titles.filter(title => findItWorkspace(title)?.title === title)).toEqual(titles)
  })
})

describe('R5 r7 — a divider drag keeps every pane above the floor', () => {
  beforeEach(() => {
    reset()
    $itBodySize.set(null)
  })

  const root = () => ws().layout as Extract<ItPaneNode, { type: 'split' }>

  it('stops a 2-pane stack in a 640x360 body at 64 px, both ways', async () => {
    splitItPane('ws-test', 'v')
    await settle()
    $itBodySize.set({ height: 360, width: 640 })

    setItPaneRatio('ws-test', root().id, 0)
    expect(360 * root().ratio - 0.5).toBeGreaterThanOrEqual(IT_MIN_PANE_PX.height - 1e-9)
    expect(360 * root().ratio).toBeLessThan(IT_MIN_PANE_PX.height + 2)

    setItPaneRatio('ws-test', root().id, 1)
    const second = 360 - (360 * root().ratio - 0.5) - 1

    expect(second).toBeGreaterThanOrEqual(IT_MIN_PANE_PX.height - 1e-9)
  })

  it('lets a wide body go past .12 when the panes still fit', async () => {
    splitItPane('ws-test', 'h')
    await settle()
    $itBodySize.set({ height: 800, width: 2400 })

    setItPaneRatio('ws-test', root().id, 0.07)
    expect(root().ratio).toBeCloseTo(0.07)
  })

  it('counts the nested panes on the far side of the divider', async () => {
    splitItPane('ws-test', 'h')
    await settle()
    splitItPane('ws-test', 'h')
    await settle()
    $itBodySize.set({ height: 400, width: 800 })

    // Root splits [first | (second | third)]: the right side needs two widths.
    setItPaneRatio('ws-test', root().id, 1)

    const right = 800 - (800 * root().ratio - 0.5) - 1

    expect(right * 0.5 - 0.5).toBeGreaterThanOrEqual(IT_MIN_PANE_PX.width - 1e-9)
  })

  it('leaves the divider where it is when no ratio fits, and ignores NaN', async () => {
    splitItPane('ws-test', 'v')
    await settle()
    $itBodySize.set({ height: 100, width: 640 })

    setItPaneRatio('ws-test', root().id, 0.2)
    expect(root().ratio).toBe(0.5)
    $itBodySize.set({ height: 360, width: 640 })
    setItPaneRatio('ws-test', root().id, Number.NaN)
    expect(root().ratio).toBe(0.5)
  })

  it('falls back to .12–.88 until the body is measured', async () => {
    splitItPane('ws-test', 'h')
    await settle()
    setItPaneRatio('ws-test', root().id, 0)
    expect(root().ratio).toBeCloseTo(0.12)
  })
})
