/**
 * iT layout model — the pane tree, its ids, and the stored layout read back
 * (v1/v2 migration, pruning to the live terminal pool). It only reads: the iT
 * atoms and every write stay in it-store.ts.
 */

import { readKey } from '@/lib/storage'

import { $terminals } from './it/engine/terminals'
import { ICLONE_STORAGE } from './lib/storage-keys'

export const LAYOUT_KEY = ICLONE_STORAGE.itLayout.key
const LAYOUT_V2_KEY = ICLONE_STORAGE.itLayoutV2.key
const LAYOUT_V1_KEY = ICLONE_STORAGE.itLayoutV1.key
type ItInstanceId = `it-${number}`

/** The Message window's iT view — the one surface, never closed. */
export const IT_MESSAGE_INSTANCE: ItInstanceId = 'it-1'

/** v2 files numbered their windows 1…8; anything else in one is corrupt. */
const LEGACY_MAX_INSTANCES = 8

export interface ItInstance {
  id: ItInstanceId
  n: number
  title: string
  named: boolean
  workspaces: ItWorkspace[]
  activeId: string
  /** Mirrors `$itSurfaceOpen`. */
  open: boolean
}

export type ItSplitDir = 'h' | 'v'

export interface ItPaneSplit {
  type: 'split'
  id: string
  dir: ItSplitDir
  ratio: number
  a: ItPaneNode
  b: ItPaneNode
}

interface ItPaneLeaf {
  type: 'leaf'
  /** A terminal id from `$terminals` — the pane IS that shell. */
  terminalId: string
}

export type ItPaneNode = ItPaneLeaf | ItPaneSplit

export interface ItWorkspace {
  id: string
  title: string
  /** Set when the user renamed it; otherwise the title tracks the shell. */
  named: boolean
  layout: ItPaneNode
  focusTerminalId: string
  /** A pane blown up to fill the workspace (⌘⇧↩). */
  zoomedTerminalId: null | string
  /** One of its shells printed something while this workspace was not the one
   *  on screen. Session state — deliberately not persisted. */
  unread: boolean
}

let nextWorkspace = 1
let nextNode = 1

export function makeWorkspaceId(): string {
  return `itw:${Date.now().toString(36)}:${nextWorkspace++}`
}

export function makeNodeId(): string {
  return `itn:${Date.now().toString(36)}:${nextNode++}`
}

/** In-order terminal ids of a workspace's tree (left/top first). */
export function listPanes(node: ItPaneNode): string[] {
  return node.type === 'leaf' ? [node.terminalId] : [...listPanes(node.a), ...listPanes(node.b)]
}

export function titleForTerminal(terminalId: string): string {
  return $terminals.get().find(term => term.id === terminalId)?.title || 'iT'
}

function sanitizeNode(value: unknown): ItPaneNode | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>

  if (record.type === 'leaf') {
    return typeof record.terminalId === 'string' && record.terminalId
      ? { type: 'leaf', terminalId: record.terminalId }
      : null
  }

  if (record.type !== 'split') {
    return null
  }

  const a = sanitizeNode(record.a)
  const b = sanitizeNode(record.b)

  if (!a || !b) {
    return a ?? b
  }

  const ratio = typeof record.ratio === 'number' && Number.isFinite(record.ratio) ? record.ratio : 0.5

  return {
    type: 'split',
    id: typeof record.id === 'string' && record.id ? record.id : makeNodeId(),
    dir: record.dir === 'v' ? 'v' : 'h',
    ratio: Math.max(0.12, Math.min(0.88, ratio)),
    a,
    b
  }
}

/** Drop leaves whose shell is gone from the pool (a closed tab, a cleared
 *  pool after a gateway switch). Returns null when nothing survives. */
export function pruneToPool(node: ItPaneNode, alive: ReadonlySet<string>): ItPaneNode | null {
  if (node.type === 'leaf') {
    return alive.has(node.terminalId) ? node : null
  }

  const a = pruneToPool(node.a, alive)
  const b = pruneToPool(node.b, alive)

  if (!a || !b) {
    return a ?? b
  }

  return { ...node, a, b }
}

interface PersistedWorkspace {
  id: string
  title: string
  named: boolean
  layout: ItPaneNode
  focusTerminalId: string
}

interface PersistedInstance {
  id: ItInstanceId
  n: number
  title: string
  named: boolean
  activeId: null | string
  workspaces: PersistedWorkspace[]
}

/** The one surface: what v3 writes, and what v2/v1 files load as. */
interface PersistedLayout {
  activeId: null | string
  workspaces: PersistedWorkspace[]
}

function parseWorkspaces(value: unknown): PersistedWorkspace[] {
  const out: PersistedWorkspace[] = []

  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== 'object') {
      continue
    }

    const record = item as Record<string, unknown>
    const layout = sanitizeNode(record.layout)

    if (!layout || typeof record.id !== 'string') {
      continue
    }

    out.push({
      focusTerminalId: typeof record.focusTerminalId === 'string' ? record.focusTerminalId : listPanes(layout)[0],
      id: record.id,
      layout,
      named: record.named === true,
      title: typeof record.title === 'string' && record.title ? record.title : 'iT'
    })
  }

  return out
}

function parseInstance(value: unknown): PersistedInstance | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>
  const n = record.n

  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > LEGACY_MAX_INSTANCES) {
    return null
  }

  return {
    activeId: typeof record.activeId === 'string' ? record.activeId : null,
    id: `it-${n}`,
    n,
    named: record.named === true,
    title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : `iT ${n}`,
    workspaces: parseWorkspaces(record.workspaces)
  }
}

function parseJson(raw: null | string): null | Record<string, unknown> {
  if (!raw) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)

    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** v2 (several instances) → the one surface: it-1's workspaces first, then
 *  every other instance's in window order — nothing the owner had is lost. */
function mergeV2(instances: unknown): PersistedLayout | null {
  if (!Array.isArray(instances)) {
    return null
  }

  const seen = new Set<number>()
  const parsed: PersistedInstance[] = []

  for (const item of instances) {
    const instance = parseInstance(item)

    if (instance && !seen.has(instance.n)) {
      seen.add(instance.n)
      parsed.push(instance)
    }
  }

  parsed.sort((a, b) => a.n - b.n)

  return {
    activeId: parsed.find(item => item.n === 1)?.activeId ?? parsed[0]?.activeId ?? null,
    workspaces: parsed.flatMap(item => item.workspaces)
  }
}

/** v3 when present; else a v2 file merged into the one surface; else v1.
 *  The older keys are read, never rewritten — a rollback still finds them. A
 *  corrupt current file returns null: one shell, overwritten on the next change. */
export function loadLayout(): PersistedLayout | null {
  const raw = readKey(LAYOUT_KEY)

  if (raw) {
    const parsed = parseJson(raw)

    if (!parsed || !Array.isArray(parsed.workspaces)) {
      return null
    }

    return {
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
      workspaces: parseWorkspaces(parsed.workspaces)
    }
  }

  const v2 = readKey(LAYOUT_V2_KEY)

  if (v2) {
    return mergeV2(parseJson(v2)?.instances)
  }

  const legacy = parseJson(readKey(LAYOUT_V1_KEY))

  return legacy
    ? {
        activeId: typeof legacy.activeId === 'string' ? legacy.activeId : null,
        workspaces: parseWorkspaces(legacy.workspaces)
      }
    : null
}
