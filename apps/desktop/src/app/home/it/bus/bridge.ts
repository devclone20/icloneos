/**
 * The renderer's view of the pane bus (electron/iclone-pane-bus/ipc.ts). Main
 * is the authority; every value crossing the bridge is re-checked here, so a
 * shape drift degrades to "no data" instead of a crash.
 */

type PaneState = 'dead' | 'exited' | 'idle' | 'needs-input' | 'running'

export type RendererSignalSource = 'bell' | 'osc777' | 'osc9'

export interface PaneSignal {
  text: string
  at: number
  source: string
}

export interface PaneSummary {
  paneId: string
  name: string
  group: null | string
  role: null | string
  spawnId: null | string
  state: PaneState
  pid: null | number
  unread: number
  signal: null | PaneSignal
  result: null | string
  exit: null | { code: null | number; signal: null | number | string }
}

export interface PaneFacts {
  paneId: string
  branch: null | string
  ports: number[]
}

export interface SpawnPane {
  name: string
  role?: string
  cwd: string
  cmd?: string
  env?: Record<string, string>
  group?: string
}

type SpawnPlanResult =
  { ok: false; errors: string[] } | { ok: true; plan: { layout: 'tabs' | 'tiled'; panes: SpawnPane[] } }

interface TmuxSessionRow {
  name: string
  createdAt: number
  attached: number
}

interface TmuxListing {
  ok: boolean
  sessions: TmuxSessionRow[]
  panes: Record<string, { scope: string; session: string; createdAt: number }>
}

interface PaneBusBridge {
  snapshot: () => Promise<unknown>
  signal: (paneId: string, text: string, source: RendererSignalSource) => Promise<unknown>
  clear: (paneId: string) => Promise<unknown>
  plan: (file: string) => Promise<unknown>
  probe: (panes: { paneId: string; cwd: null | string }[]) => Promise<unknown>
  tmuxList: () => Promise<unknown>
  tmuxEnd: (session: string) => Promise<unknown>
  onChange: (callback: (pane: unknown) => void) => () => void
}

const PANE_STATES: readonly PaneState[] = ['dead', 'exited', 'idle', 'needs-input', 'running']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringOrNull = (value: unknown): null | string => (typeof value === 'string' ? value : null)

function hasBridgeShape(value: unknown): value is PaneBusBridge {
  return (
    isRecord(value) &&
    ['snapshot', 'signal', 'clear', 'plan', 'probe', 'tmuxList', 'tmuxEnd', 'onChange'].every(
      key => typeof value[key] === 'function'
    )
  )
}

export function paneBus(): null | PaneBusBridge {
  if (typeof window === 'undefined') {
    return null
  }

  const desktop: unknown = window.hermesDesktop
  const candidate = isRecord(desktop) ? desktop.paneBus : undefined

  return hasBridgeShape(candidate) ? candidate : null
}

function parseSignal(value: unknown): null | PaneSignal {
  if (!isRecord(value) || typeof value.text !== 'string' || typeof value.at !== 'number') {
    return null
  }

  return { text: value.text, at: value.at, source: String(value.source ?? '') }
}

function parseExit(value: unknown): PaneSummary['exit'] {
  if (!isRecord(value)) {
    return null
  }

  const signal = typeof value.signal === 'number' || typeof value.signal === 'string' ? value.signal : null

  return { code: typeof value.code === 'number' ? value.code : null, signal }
}

export function parsePaneSummary(value: unknown): null | PaneSummary {
  if (!isRecord(value) || typeof value.paneId !== 'string' || typeof value.name !== 'string') {
    return null
  }

  const state = PANE_STATES.find(candidate => candidate === value.state)

  if (!state) {
    return null
  }

  return {
    paneId: value.paneId,
    name: value.name,
    group: stringOrNull(value.group),
    role: stringOrNull(value.role),
    spawnId: stringOrNull(value.spawnId),
    state,
    pid: typeof value.pid === 'number' ? value.pid : null,
    unread: typeof value.unread === 'number' ? value.unread : 0,
    signal: parseSignal(value.signal),
    result: stringOrNull(value.result),
    exit: parseExit(value.exit)
  }
}

export function parsePaneFacts(value: unknown): PaneFacts[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter(isRecord).map(item => ({
    paneId: String(item.paneId ?? ''),
    branch: stringOrNull(item.branch),
    ports: Array.isArray(item.ports) ? item.ports.filter((port): port is number => Number.isInteger(port)) : []
  }))
}

function parseSpawnPane(value: unknown): null | SpawnPane {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.cwd !== 'string') {
    return null
  }

  const env = isRecord(value.env)
    ? Object.fromEntries(
        Object.entries(value.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      )
    : undefined

  return {
    name: value.name,
    cwd: value.cwd,
    ...(typeof value.role === 'string' ? { role: value.role } : {}),
    ...(typeof value.cmd === 'string' ? { cmd: value.cmd } : {}),
    ...(typeof value.group === 'string' ? { group: value.group } : {}),
    ...(env ? { env } : {})
  }
}

export function parseSpawnPlan(value: unknown): SpawnPlanResult {
  if (!isRecord(value)) {
    return { ok: false, errors: ['the app gave no answer'] }
  }

  if (value.ok !== true) {
    const errors = Array.isArray(value.errors) ? value.errors.map(String) : ['the spec was refused']

    return { ok: false, errors }
  }

  const plan = isRecord(value.plan) ? value.plan : {}
  const panes = (Array.isArray(plan.panes) ? plan.panes : []).map(parseSpawnPane)

  if (!panes.length || panes.some(pane => pane === null)) {
    return { ok: false, errors: ['the plan was malformed'] }
  }

  return {
    ok: true,
    plan: { layout: plan.layout === 'tabs' ? 'tabs' : 'tiled', panes: panes.filter(pane => pane !== null) }
  }
}

export function parseTmuxListing(value: unknown): TmuxListing {
  if (!isRecord(value) || value.ok !== true) {
    return { ok: false, sessions: [], panes: {} }
  }

  const sessions = (Array.isArray(value.sessions) ? value.sessions : []).filter(isRecord).map(row => ({
    name: String(row.name ?? ''),
    createdAt: Number(row.createdAt ?? 0),
    attached: Number(row.attached ?? 0)
  }))

  const panes: TmuxListing['panes'] = {}

  for (const [paneId, entry] of Object.entries(isRecord(value.panes) ? value.panes : {})) {
    if (isRecord(entry) && typeof entry.session === 'string') {
      panes[paneId] = {
        scope: String(entry.scope ?? ''),
        session: entry.session,
        createdAt: Number(entry.createdAt ?? 0)
      }
    }
  }

  return { ok: true, sessions, panes }
}
