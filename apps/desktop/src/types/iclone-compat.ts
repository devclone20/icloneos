// Renderer mirror of the compat engine's IPC shapes (electron/iclone-compat.ts and electron/iclone-compat/*). Main owns
// the verdict and the owner's hold; the renderer only reads, previews, and asks main to time a hold.
type IcloneCompatLevel = 'GREEN' | 'INFO' | 'AMBER' | 'UNKNOWN' | 'RED'
type IcloneCompatGateLevel = 'GREEN' | 'AMBER' | 'RED' | 'UNKNOWN'

export interface IcloneCompatCard {
  root: string
  level: IcloneCompatLevel
  items: number
  names: string[]
  rules: string[]
  upstream: string[]
  ticket: null | string
  sites: number
}

export interface IcloneCompatVerdict {
  schema: 1
  id: string
  kind: string
  level: IcloneCompatLevel
  computedAt: string
  computedMs: number
  runtime: {
    from: string
    to: string
    contractHash: string
    isDescendant: boolean | null
    specCoverage: string[]
  }
  state: Record<string, unknown>
  cards: IcloneCompatCard[]
  perSpec: { rev: string; describe: null | string; specTier: null | string; level: IcloneCompatLevel }[]
}

export interface IcloneCompatProbe {
  ok: number
  gone: number
  renamed: number
  skipped: number
  unsafe: boolean
  ms: number
  reason: null | string
}

export interface IcloneCompatStatus {
  latest: IcloneCompatVerdict | null
  pending: IcloneCompatVerdict | null
  guard: null | { status: 'cached' | 'no-openrpc' | 'stale-backend' | 'verify'; head: null | string }
  probe: IcloneCompatProbe | null
  /** The gate's last refusal of the owner (`iclone-compat/last-refusal.json`); history, shown only for its target. */
  lastRefusal?: IcloneCompatRefusal | null
  holdMs: Record<IcloneCompatGateLevel, number>
}

export interface IcloneCompatRefusal {
  at: string
  level: IcloneCompatGateLevel
  reason: string
  /** The rev the refused update would have installed (possibly abbreviated); null = unknown, matches no target. */
  target: null | string
  verdictId: string
}

interface IcloneCompatVerdictPush {
  slot: 'latest' | 'pending'
  verdict: IcloneCompatVerdict
}

type IcloneCompatFailure = { ok: false; reason: string }

export type IcloneCompatAckRequest =
  | { phase: 'begin'; verdictId: string }
  | { phase: 'mint'; verdictId: string; nonce: string; names: string[] }
  | { phase: 'cancel' }

export type IcloneCompatAckResult =
  | { ok: true; phase: 'begin'; verdictId: string; nonce: string; holdMs: number }
  | { ok: true; phase: 'mint'; verdictId: string; heldMs: number }
  | { ok: true; phase: 'cancel' }
  | IcloneCompatFailure

export interface IcloneCompatInboxRow {
  week: string
  sha: string
  at: string
  subject: string
  score: number
  terms: string[]
  disposition: 'adopt' | 'ignore' | 'watch'
  cluster: null | string
}

export interface IcloneCompatBacklog {
  inbox?: IcloneCompatInboxRow[]
  [key: string]: unknown
}

type IcloneCompatDecisionValue = 'adopt' | 'ignore' | 'watch' | `defer:${string}`

export interface IcloneCompatDecision {
  cs: string
  upstream: string[]
  decision: IcloneCompatDecisionValue
}

export type IcloneCompatDecideResult =
  { ok: true; line: IcloneCompatDecision & { v: 1; at: string; by: 'owner'; lane: 'adopt' } } | IcloneCompatFailure

type IcloneCompatSummary = { ok: true; label: string; text: string } | IcloneCompatFailure

export interface IcloneCompatBridge {
  status: () => Promise<IcloneCompatStatus>
  preview: (target?: string) => Promise<IcloneCompatVerdict>
  probe: () => Promise<IcloneCompatFailure | IcloneCompatProbe>
  ack: (request: IcloneCompatAckRequest) => Promise<IcloneCompatAckResult>
  backlog: (options?: { refresh?: boolean }) => Promise<IcloneCompatBacklog | null>
  decide: (decision: IcloneCompatDecision) => Promise<IcloneCompatDecideResult>
  summarise: (subjects: string[]) => Promise<IcloneCompatSummary>
  onVerdict: (callback: (payload: IcloneCompatVerdictPush) => void) => () => void
}
