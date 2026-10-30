/**
 * iT terminal state — the multiplexer's LAYOUT, and nothing else.
 *
 * The shells themselves are Hermes Desktop's own terminal pool (`$terminals`
 * in it/engine/terminals.ts): one registry, one engine. That pool
 * already owns everything a terminal needs to survive — the PTY, persistence
 * across launches, the replayed scrollback, the last `cd`, the resolved shell
 * name, and the read-only mirrors of the agent's background processes. iT used
 * to invent its own pane ids and hand them to the engine as if they were tabs,
 * so an iT pane was a second-class shell: nothing about it was persisted, and
 * `closeAllTerminals()` (a gateway switch) emptied the pool while iT kept
 * pointing at ids that no longer existed.
 *
 * So a LEAF here is a terminal id from that pool. This module only says where
 * each one sits:
 *
 *   workspace (a row on the iT rail)
 *     └── binary tree of panes — split {dir, ratio, a, b} | leaf {terminalId}
 *
 * A split replaces the focused leaf (the old terminal keeps side `a`, a newly
 * created one takes `b` at ratio .5 and the focus); closing a pane promotes its
 * sibling and closes that terminal. Ratios clamp to .12–.88 (the HUB rule).
 *
 * Nothing in here touches the DOM: the panes are laid out as empty slots and a
 * single host (it-host.tsx) parks one never-reparented xterm over each. That
 * separation is the fix for "what was written disappears when I split" — the
 * old tree mounted the xterm INSIDE itself, so every split reparented the host
 * and React tore the terminal down and built a new one.
 *
 * ONE SURFACE. iT is the Message window's iT view and nothing else (owner
 * rule 2026-10-16: "internal windows" = the splits inside it, never iT windows
 * on the home). `$itInstances` therefore holds exactly one entry, `it-1` — its
 * rail (workspaces), its active workspace and its open flag. A layout written
 * by the abandoned multi-window build (v2, several instances) is MERGED into
 * it on load: every workspace and pane the owner had survives. A pool terminal
 * is placed in exactly ONE (workspace, leaf) — two places would mean two hosts
 * and two PTYs for one shell.
 */
import { atom, type ReadableAtom } from 'nanostores'

import { readKey, writeKey } from '@/lib/storage'
import { isPeerInstanceWindow } from '@/store/windows'

import { IT_DEFAULT_BODY_PX, ratioBounds, splitFits } from './it-host-rects'
import type { ItInstance, ItPaneNode, ItPaneSplit, ItSplitDir, ItWorkspace } from './it-layout'
import {
  IT_MESSAGE_INSTANCE,
  LAYOUT_KEY,
  listPanes,
  loadLayout,
  makeNodeId,
  makeWorkspaceId,
  pruneToPool,
  titleForTerminal
} from './it-layout'
import { onTerminalOutput } from './it/engine/buffer'
import { $terminalTakeover, setTerminalTakeover } from './it/engine/store'
import { $terminals, closeTerminal, createTerminal, type TerminalEntry } from './it/engine/terminals'
import { ICLONE_STORAGE } from './lib/storage-keys'

const VIEW_KEY = ICLONE_STORAGE.msgView.key

/** A ⌘⇧N peer window shares this origin's storage and the pool's key, but
 *  never hosts a shell: its iT store is read-only (no writes, no new shells). */
const READ_ONLY = isPeerInstanceWindow()

function replaceLeaf(node: ItPaneNode, terminalId: string, next: ItPaneNode): ItPaneNode {
  if (node.type === 'leaf') {
    return node.terminalId === terminalId ? next : node
  }

  return { ...node, a: replaceLeaf(node.a, terminalId, next), b: replaceLeaf(node.b, terminalId, next) }
}

function dropLeaf(node: ItPaneNode, terminalId: string): ItPaneNode | null {
  if (node.type === 'leaf') {
    return node.terminalId === terminalId ? null : node
  }

  const a = dropLeaf(node.a, terminalId)
  const b = dropLeaf(node.b, terminalId)

  if (a === null) {
    return b
  }

  if (b === null) {
    return a
  }

  return { ...node, a, b }
}

/** The iT body's last measured size (the host writes it; kept while hidden). */
export const $itBodySize = atom<null | { height: number; width: number }>(null)

/** False when the focused pane is too small to halve (see IT_MIN_PANE_PX). */
export function canSplitItPane(workspaceId: string, dir: ItSplitDir): boolean {
  const workspace = workspaceById(workspaceId)

  return Boolean(
    workspace && splitFits(workspace.layout, workspace.focusTerminalId, dir, $itBodySize.get() ?? IT_DEFAULT_BODY_PX)
  )
}

/** Split the workspace's focused pane; the new pane takes focus. dir 'h' =
 *  side by side (split right), 'v' = stacked (split down). Null when there is
 *  no such workspace or the halves would be unusable (canSplitItPane). */
export function splitItPane(workspaceId: string, dir: ItSplitDir, cwd?: string): null | string {
  const workspace = workspaceById(workspaceId)

  if (!workspace || !canSplitItPane(workspaceId, dir)) {
    return null
  }

  // A zoomed pane hides its siblings; splitting into a hidden layout is a
  // trap, so a split always un-zooms first (the HUB behaviour).
  const from = $terminals.get().find(term => term.id === workspace.focusTerminalId)
  const terminalId = createTerminal(cwd ?? from?.restoreCwd ?? from?.cwd ?? '')

  const split: ItPaneSplit = {
    type: 'split',
    id: makeNodeId(),
    dir,
    ratio: 0.5,
    a: { type: 'leaf', terminalId: workspace.focusTerminalId },
    b: { type: 'leaf', terminalId }
  }

  patchWorkspace(workspaceId, current => ({
    ...current,
    layout: replaceLeaf(current.layout, current.focusTerminalId, split),
    focusTerminalId: terminalId,
    zoomedTerminalId: null
  }))

  return terminalId
}

/** Close one pane — and its shell. The last pane of a workspace never closes. */
export function closeItPane(workspaceId: string, terminalId: string): boolean {
  const workspace = workspaceById(workspaceId)

  if (!workspace || listPanes(workspace.layout).length < 2) {
    return false
  }

  const layout = dropLeaf(workspace.layout, terminalId)

  if (!layout) {
    return false
  }

  patchWorkspace(workspaceId, current => ({
    ...current,
    layout,
    focusTerminalId: current.focusTerminalId === terminalId ? listPanes(layout)[0] : current.focusTerminalId,
    zoomedTerminalId: current.zoomedTerminalId === terminalId ? null : current.zoomedTerminalId
  }))

  closeTerminal(terminalId)

  return true
}

export function focusItPane(workspaceId: string, terminalId: string): boolean {
  const workspace = workspaceById(workspaceId)

  if (!workspace || !listPanes(workspace.layout).includes(terminalId)) {
    return false
  }

  if (workspace.focusTerminalId === terminalId) {
    return true
  }

  patchWorkspace(workspaceId, current => ({ ...current, focusTerminalId: terminalId }))

  return true
}

/** Move the focus one pane along the in-order walk (+1 next, -1 previous). */
export function cycleItPane(workspaceId: string, direction: -1 | 1): boolean {
  const workspace = workspaceById(workspaceId)

  if (!workspace) {
    return false
  }

  const panes = listPanes(workspace.layout)

  if (panes.length < 2) {
    return false
  }

  const at = Math.max(0, panes.indexOf(workspace.focusTerminalId))

  return focusItPane(workspaceId, panes[(at + direction + panes.length) % panes.length])
}

function findSplit(node: ItPaneNode, nodeId: string): ItPaneNode | null {
  if (node.type === 'leaf') {
    return null
  }

  return node.id === nodeId ? node : (findSplit(node.a, nodeId) ?? findSplit(node.b, nodeId))
}

/** A divider drag. With the body measured, the ratio stops where a pane on
 *  either side would drop under IT_MIN_PANE_PX; unmeasured, at .12–.88. */
export function setItPaneRatio(workspaceId: string, nodeId: string, ratio: number): void {
  const workspace = workspaceById(workspaceId)
  const split = workspace ? findSplit(workspace.layout, nodeId) : null
  const body = $itBodySize.get()

  if (!workspace || !split || !Number.isFinite(ratio)) {
    return
  }

  let clamped = Math.max(0.12, Math.min(0.88, ratio))

  if (body) {
    const bounds = ratioBounds(workspace.layout, split, body)

    if (!bounds) {
      return
    }

    clamped = Math.max(bounds.min, Math.min(bounds.max, ratio))
  }

  const walk = (node: ItPaneNode): ItPaneNode => {
    if (node.type === 'leaf') {
      return node
    }

    if (node.id === nodeId) {
      return { ...node, ratio: clamped }
    }

    return { ...node, a: walk(node.a), b: walk(node.b) }
  }

  patchWorkspace(workspaceId, current => ({ ...current, layout: walk(current.layout) }))
}

/** All ratios back to .5 (the HUB's equalize-splits). */
export function equalizeItPanes(workspaceId: string): void {
  const walk = (node: ItPaneNode): ItPaneNode =>
    node.type === 'leaf' ? node : { ...node, ratio: 0.5, a: walk(node.a), b: walk(node.b) }

  patchWorkspace(workspaceId, current => ({ ...current, layout: walk(current.layout) }))
}

/** ⌘⇧↩ — blow the focused pane up to the whole workspace, or back. */
export function toggleItZoom(workspaceId: string): boolean {
  const workspace = workspaceById(workspaceId)

  if (!workspace || listPanes(workspace.layout).length < 2) {
    return false
  }

  patchWorkspace(workspaceId, current => ({
    ...current,
    zoomedTerminalId: current.zoomedTerminalId ? null : current.focusTerminalId
  }))

  return true
}

/** Lift the focused pane out into a workspace of its own (the HUB's
 *  break-pane). The shell is carried over, never restarted. */
export function breakItPane(workspaceId: string): null | string {
  const workspace = workspaceById(workspaceId)

  if (!workspace || listPanes(workspace.layout).length < 2) {
    return null
  }

  const terminalId = workspace.focusTerminalId
  const layout = dropLeaf(workspace.layout, terminalId)

  if (!layout) {
    return null
  }

  patchWorkspace(workspaceId, current => ({
    ...current,
    layout,
    focusTerminalId: listPanes(layout)[0],
    unread: false,
    zoomedTerminalId: null
  }))

  const lifted: ItWorkspace = {
    id: makeWorkspaceId(),
    title: titleForTerminal(terminalId),
    named: false,
    layout: { type: 'leaf', terminalId },
    focusTerminalId: terminalId,
    unread: false,
    zoomedTerminalId: null
  }

  const owner = instanceOfWorkspace(workspaceId)

  if (owner) {
    patchInstance(owner.id, current => ({
      ...current,
      activeId: lifted.id,
      workspaces: [...current.workspaces, lifted]
    }))
  }

  return lifted.id
}

// ── The workspaces ─────────────────────────────────────────────────────────

function freshWorkspace(terminalId: string, title: string): ItWorkspace {
  return {
    focusTerminalId: terminalId,
    id: makeWorkspaceId(),
    layout: { type: 'leaf', terminalId },
    named: false,
    title,
    unread: false,
    zoomedTerminalId: null
  }
}

/** A new pool entry — or, in a read-only peer, a placeholder no host mounts. */
function newShell(cwd: string): string {
  return READ_ONLY ? `peer:${makeNodeId()}` : createTerminal(cwd)
}

function bootSurface(): ItInstance {
  const pool = $terminals.get()
  const alive = new Set(pool.map(term => term.id))
  const persisted = loadLayout()
  const used = new Set<string>()
  const workspaceIds = new Set<string>()
  const workspaces: ItWorkspace[] = []

  for (const saved of persisted?.workspaces ?? []) {
    // Placed exactly once: a leaf an earlier workspace already holds is dropped
    // (a merged v2 file could carry one twice), and so is a repeated id.
    const free = new Set([...alive].filter(id => !used.has(id)))
    const layout = workspaceIds.has(saved.id) ? null : pruneToPool(saved.layout, free)

    if (!layout) {
      continue
    }

    const panes = listPanes(layout)

    panes.forEach(id => used.add(id))
    workspaceIds.add(saved.id)
    workspaces.push({
      focusTerminalId: panes.includes(saved.focusTerminalId) ? saved.focusTerminalId : panes[0],
      id: saved.id,
      layout,
      named: saved.named,
      title: saved.title,
      unread: false,
      zoomedTerminalId: null
    })
  }

  // Nothing restored (first run, or the pool was cleared) — one workspace with
  // one shell. `createTerminal` only appends a POOL ENTRY; no PTY is spawned
  // until its pane is actually on screen (the host defers the session start).
  if (workspaces.length === 0) {
    const reuse = pool.find(term => term.kind === 'user')?.id

    workspaces.push(freshWorkspace(reuse ?? newShell(''), 'iT 1'))
  }

  const activeId = persisted?.activeId

  return {
    activeId: workspaces.some(w => w.id === activeId) ? activeId! : workspaces[0].id,
    id: IT_MESSAGE_INSTANCE,
    n: 1,
    named: false,
    open: false,
    title: 'iT',
    workspaces
  }
}

const boot = bootSurface()

/** Exactly one entry — the surface (see the header). */
export const $itInstances = atom<ItInstance[]>([boot])

const messageInstance = (list: readonly ItInstance[]) => list.find(item => item.id === IT_MESSAGE_INSTANCE)!

// Back-compat views of it-1 for the call sites that predate instances; written
// only by setInstances(), so they can never disagree with $itInstances.
const itWorkspacesView = atom<ItWorkspace[]>(boot.workspaces)
const itActiveIdView = atom<string>(boot.activeId)

export const $itWorkspaces: ReadableAtom<ItWorkspace[]> = itWorkspacesView
export const $itActiveId: ReadableAtom<string> = itActiveIdView

function setInstances(next: ItInstance[]): void {
  const it1 = messageInstance(next)

  $itInstances.set(next)

  if (itWorkspacesView.get() !== it1.workspaces) {
    itWorkspacesView.set(it1.workspaces)
  }

  if (itActiveIdView.get() !== it1.activeId) {
    itActiveIdView.set(it1.activeId)
  }
}

/** Replace every instance at once — test setup only (the store's own ops keep
 *  the placed-exactly-once invariant; this trusts its caller). */
export function setItInstancesForTests(next: ItInstance[]): void {
  setInstances(next)
}

function persistLayout(): void {
  if (READ_ONLY) {
    return
  }

  const surface = messageInstance($itInstances.get())

  writeKey(
    LAYOUT_KEY,
    JSON.stringify({
      activeId: surface.activeId,
      version: 3,
      workspaces: surface.workspaces.map(workspace => ({
        focusTerminalId: workspace.focusTerminalId,
        id: workspace.id,
        layout: workspace.layout,
        named: workspace.named,
        title: workspace.title
      }))
    })
  )
}

$itInstances.listen(persistLayout)

/** @public — read by the out-of-tree iT lab probes (R5). */
export function instanceOf(id: string): ItInstance | undefined {
  return $itInstances.get().find(item => item.id === id)
}

function instanceOfWorkspace(workspaceId: string): ItInstance | undefined {
  return $itInstances.get().find(item => item.workspaces.some(workspace => workspace.id === workspaceId))
}

function workspaceById(workspaceId: string): ItWorkspace | undefined {
  return instanceOfWorkspace(workspaceId)?.workspaces.find(workspace => workspace.id === workspaceId)
}

/** The instance a terminal is placed in, with its workspace. */
export function locateItTerminal(terminalId: string): { instance: ItInstance; workspace: ItWorkspace } | undefined {
  for (const instance of $itInstances.get()) {
    const workspace = instance.workspaces.find(item => listPanes(item.layout).includes(terminalId))

    if (workspace) {
      return { instance, workspace }
    }
  }

  return undefined
}

function patchInstance(id: string, update: (instance: ItInstance) => ItInstance): boolean {
  const list = $itInstances.get()

  if (!list.some(item => item.id === id)) {
    return false
  }

  setInstances(list.map(item => (item.id === id ? update(item) : item)))

  return true
}

function patchWorkspace(workspaceId: string, update: (workspace: ItWorkspace) => ItWorkspace): boolean {
  const owner = instanceOfWorkspace(workspaceId)

  if (!owner) {
    return false
  }

  return patchInstance(owner.id, instance => ({
    ...instance,
    workspaces: instance.workspaces.map(item => (item.id === workspaceId ? update(item) : item))
  }))
}

/** Every terminal id iT currently shows, across ALL workspaces. */
function placedTerminalIds(): Set<string> {
  const out = new Set<string>()

  for (const instance of $itInstances.get()) {
    for (const workspace of instance.workspaces) {
      for (const id of listPanes(workspace.layout)) {
        out.add(id)
      }
    }
  }

  return out
}

/** Terminal ids placed on the surface — what the host mounts. */
export function instanceTerminalIds(instance: ItInstance): Set<string> {
  return new Set(instance.workspaces.flatMap(workspace => listPanes(workspace.layout)))
}

/** `iT n` with the first n (from count + 1) no tab already carries — a closed
 *  middle tab must not make the next default title collide with a live one. */
function defaultWorkspaceTitle(workspaces: readonly ItWorkspace[]): string {
  const taken = new Set(workspaces.map(workspace => workspace.title.toLowerCase()))
  let n = workspaces.length + 1

  while (taken.has(`it ${n}`)) {
    n += 1
  }

  return `iT ${n}`
}

export function addItWorkspace(title?: string, cwd?: string): ItWorkspace {
  const instance = messageInstance($itInstances.get())
  const terminalId = newShell(cwd ?? '')

  const asked = title?.trim()
  const named = asked && !isRefShapedTitle(asked) ? asked : undefined

  const workspace: ItWorkspace = {
    ...freshWorkspace(terminalId, named || defaultWorkspaceTitle(instance.workspaces)),
    named: Boolean(named)
  }

  patchInstance(instance.id, current => ({
    ...current,
    activeId: workspace.id,
    workspaces: [...current.workspaces, workspace]
  }))

  return workspace
}

/** The last workspace never closes — the surface always has a live shell. */
export function closeItWorkspace(id: string): boolean {
  const owner = instanceOfWorkspace(id)
  const going = owner?.workspaces.find(workspace => workspace.id === id)
  const remaining = owner?.workspaces.filter(workspace => workspace.id !== id) ?? []

  if (!owner || !going || remaining.length === 0) {
    return false
  }

  patchInstance(owner.id, current => ({
    ...current,
    activeId: current.activeId === id ? remaining[remaining.length - 1].id : current.activeId,
    workspaces: remaining
  }))

  for (const terminalId of listPanes(going.layout)) {
    closeTerminal(terminalId)
  }

  return true
}

export function renameItWorkspace(id: string, title: string): boolean {
  const trimmed = title.trim()

  if (!trimmed || isRefShapedTitle(trimmed)) {
    return false
  }

  return patchWorkspace(id, workspace => ({ ...workspace, named: true, title: trimmed }))
}

export function setItActive(id: string): boolean {
  const owner = instanceOfWorkspace(id)

  if (!owner) {
    return false
  }

  if (owner.activeId !== id) {
    patchInstance(owner.id, current => ({ ...current, activeId: id }))
  }

  return true
}

/** Resolve a CLI workspace reference: its 1-based index, or its EXACT title
 *  (case-insensitive) when exactly one workspace carries it. Never a
 *  substring — `it close build` must not hit "build-old". */
export function findItWorkspace(ref: string): ItWorkspace | undefined {
  const workspaces = messageInstance($itInstances.get()).workspaces
  const trimmed = ref.trim()

  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed)

    return index >= 1 && index <= workspaces.length ? workspaces[index - 1] : undefined
  }

  const needle = trimmed.toLowerCase()
  const titled = workspaces.filter(workspace => workspace.title.toLowerCase() === needle)

  return needle && titled.length === 1 ? titled[0] : undefined
}

/** How many workspaces answer to `ref` as a title — >1 = ambiguous. */
export function itWorkspacesTitled(ref: string): number {
  const needle = ref.trim().toLowerCase()

  return needle
    ? messageInstance($itInstances.get()).workspaces.filter(workspace => workspace.title.toLowerCase() === needle)
        .length
    : 0
}

export function activeItWorkspace(): ItWorkspace | undefined {
  const instance = messageInstance($itInstances.get())

  return instance.workspaces.find(workspace => workspace.id === instance.activeId)
}

/** A title that reads as a ref (`3`, `it-3`): numbered refs win over titles,
 *  so a workspace titled "3" could never be addressed by its title. */
export function isRefShapedTitle(title: string): boolean {
  return /^(?:it-)?\d+$/i.test(title.trim())
}

/** True while the surface is on screen (the Message window's iT view). */
function isItInstanceOnScreen(instance: ItInstance): boolean {
  return instance.open && $itSurfaceOpen.get()
}

// ── Keeping the layout and the pool honest ─────────────────────────────────
//
// The pool is the authority on which shells exist; the layout is the authority
// on where they sit. Anything the pool gains that iT has not placed gets a home
// (this is how the agent's background processes surface inside iT), and any
// leaf whose shell the pool has dropped disappears.
function reconcileWorkspaces(
  workspaces: ItWorkspace[],
  pool: readonly TerminalEntry[],
  alive: ReadonlySet<string>
): ItWorkspace[] {
  let changed = false

  // Gone from the pool → gone from the layout.
  const pruned = workspaces
    .map(workspace => {
      const layout = pruneToPool(workspace.layout, alive)

      if (layout === workspace.layout) {
        return workspace
      }

      changed = true

      if (!layout) {
        return null
      }

      const panes = listPanes(layout)

      return {
        ...workspace,
        focusTerminalId: panes.includes(workspace.focusTerminalId) ? workspace.focusTerminalId : panes[0],
        layout,
        zoomedTerminalId:
          workspace.zoomedTerminalId && panes.includes(workspace.zoomedTerminalId) ? workspace.zoomedTerminalId : null
      }
    })
    .filter((workspace): workspace is ItWorkspace => workspace !== null)

  // An unnamed workspace wears its shell's name, exactly like a pool tab.
  const titled = pruned.map(workspace => {
    if (workspace.named) {
      return workspace
    }

    const title = pool.find(term => term.id === workspace.focusTerminalId)?.title

    if (!title || title === workspace.title) {
      return workspace
    }

    changed = true

    return { ...workspace, title }
  })

  return changed ? titled : workspaces
}

function reconcile(pool: readonly TerminalEntry[]): void {
  const alive = new Set(pool.map(term => term.id))
  const placed = placedTerminalIds()
  let changed = false

  let instances = $itInstances.get().map(instance => {
    const workspaces = reconcileWorkspaces(instance.workspaces, pool, alive)

    if (workspaces === instance.workspaces) {
      return instance
    }

    changed = true

    return { ...instance, workspaces }
  })

  // New in the pool and nowhere on screen → its own workspace. A row on the
  // rail costs nothing and can never disturb an existing layout, which an
  // auto-split would.
  for (const term of pool.filter(item => !placed.has(item.id))) {
    const home = IT_MESSAGE_INSTANCE

    changed = true
    instances = instances.map(instance =>
      instance.id === home
        ? {
            ...instance,
            workspaces: [
              ...instance.workspaces,
              {
                ...freshWorkspace(
                  term.id,
                  term.title || (term.kind === 'agent' ? 'agent' : defaultWorkspaceTitle(instance.workspaces))
                ),
                named: term.kind === 'agent'
              }
            ]
          }
        : instance
    )
  }

  // Never an empty instance: one fresh shell.
  instances = instances.map(instance => {
    let next = instance

    if (next.workspaces.length === 0) {
      changed = true
      next = { ...next, workspaces: [freshWorkspace(newShell(''), 'iT 1')] }
    }

    if (!next.workspaces.some(workspace => workspace.id === next.activeId)) {
      changed = true
      next = { ...next, activeId: next.workspaces[next.workspaces.length - 1].id }
    }

    return next
  })

  if (changed) {
    setInstances(instances)
  }
}

// DEFERRED, and that is the whole point. A split calls createTerminal() and
// THEN patches the layout, both synchronously: a listener that ran inline saw
// the pool grow while the new shell was still unplaced and dutifully gave it a
// workspace of its own — so every split also spawned a rail row, and the
// terminal ended up in two places at once with two slots fighting over it.
// A microtask lands after the whole mutation, when the layout is true.
let reconcileQueued = false

function queueReconcile(): void {
  if (reconcileQueued) {
    return
  }

  reconcileQueued = true
  queueMicrotask(() => {
    reconcileQueued = false
    reconcile($terminals.get())
  })
}

$terminals.listen(queueReconcile)

// ── Message window view (chat | it) — shared with the header tabs ──────────

type MsgView = 'chat' | 'it'

function initialView(): MsgView {
  return readKey(VIEW_KEY) === 'it' ? 'it' : 'chat'
}

export const $msgView = atom<MsgView>(initialView())

/** True while the iT surface is actually on screen (the Message window is open
 *  AND showing the iT view). The host reads this to decide which shells paint;
 *  ItTerminal owns it, so it can never disagree with what is mounted. */
export const $itSurfaceOpen = atom(false)

export function isItSurfaceOpen(): boolean {
  return $itSurfaceOpen.get()
}

/** Every door that used to open the retired bottom deck — ⌃`, the statusbar
 *  pill, the ⌘K row, `it open` — lands here: the Message window on its iT
 *  view. `$terminalTakeover` stays the app-wide "a terminal is showing" flag
 *  that other surfaces (the agent's openAgentTerminal) already raise. */
export function openItSurface(): void {
  window.location.hash = '#/'
  setMsgView('it')
  setTerminalTakeover(true)
}

export function toggleItSurface(): void {
  if ($itSurfaceOpen.get()) {
    setMsgView('chat')
    setTerminalTakeover(false)

    return
  }

  openItSurface()
}

// The agent raising a background process (openAgentTerminal) sets takeover —
// bring iT up so its new workspace is actually on screen.
$terminalTakeover.listen(on => {
  if (on && !$itSurfaceOpen.get()) {
    openItSurface()
  }
})

export function setMsgView(view: MsgView) {
  $msgView.set(view)

  writeKey(VIEW_KEY, view)
}

// ── Unread ────────────────────────────────────────────────────────────────
// The HUB rule: output that lands in a workspace you are not looking at marks
// it. Clearing is the act of looking — becoming the active workspace of an
// instance that is on screen.
function clearUnreadHere(): void {
  for (const instance of $itInstances.get()) {
    if (!isItInstanceOnScreen(instance)) {
      continue
    }

    const id = instance.activeId

    if (instance.workspaces.find(workspace => workspace.id === id)?.unread) {
      patchWorkspace(id, workspace => ({ ...workspace, unread: false }))
    }
  }
}

onTerminalOutput(terminalId => {
  const owner = locateItTerminal(terminalId)

  if (!owner || owner.workspace.unread) {
    return
  }

  if (isItInstanceOnScreen(owner.instance) && owner.workspace.id === owner.instance.activeId) {
    return
  }

  patchWorkspace(owner.workspace.id, workspace => ({ ...workspace, unread: true }))
})

$itInstances.subscribe(clearUnreadHere)
$itSurfaceOpen.subscribe(open => {
  const it1 = messageInstance($itInstances.get())

  if (it1.open !== open) {
    patchInstance(IT_MESSAGE_INSTANCE, current => ({ ...current, open }))
  }

  clearUnreadHere()
})
