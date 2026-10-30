/**
 * V3-I — the window's copy of main's WORK view, per iNFT. Main folds the view from the listener, the last job list
 * and the ledger on every read; this store holds the latest answer and re-asks when main says it changed. It never
 * counts or derives anything itself.
 *
 * The owner-decision calls (level, online, repair, approve, decline) must run synchronously inside the click handler of a
 * control carrying `data-acp-work-confirm`: the preload's gesture lock reads that click.
 */
import { atom } from 'nanostores'

import {
  type AutonomyLevel,
  SUPERVISOR_STATES,
  type WorkActionResult,
  type WorkStopReport,
  type WorkView
} from '@/iclone-shared/acp-work'

/** @public the bridge shape `window.hermesDesktop.icloneAcpWork` is typed with (src/global.d.ts). */
export interface AcpWorkBridge {
  state: (slug: string) => Promise<unknown>
  refresh: (slug: string) => Promise<unknown>
  setLevel: (slug: string, level: AutonomyLevel) => Promise<WorkActionResult>
  online: (slug: string) => Promise<WorkActionResult>
  offline: (slug: string) => Promise<WorkActionResult | WorkStopReport>
  reboot: (slug: string) => Promise<WorkActionResult>
  repair: (slug: string) => Promise<WorkActionResult>
  approve: (slug: string, jobId: string) => Promise<WorkActionResult>
  decline: (slug: string, jobId: string) => Promise<WorkActionResult>
  onChanged: (callback: (slug: unknown) => void) => () => void
}

/** What the last action said, shown above the tab until the next one. */
export type WorkNotice =
  { kind: 'error'; result: Extract<WorkActionResult, { ok: false }> } | { kind: 'stop'; report: WorkStopReport }

export const $acpWork = atom<Record<string, WorkView>>({})
export const $acpWorkNotice = atom<Record<string, WorkNotice | null>>({})

const bridge = (): AcpWorkBridge | undefined =>
  typeof window === 'undefined' ? undefined : window.hermesDesktop?.icloneAcpWork

/** A payload from main is checked for shape before it reaches the tab. */
export function isWorkView(value: unknown): value is WorkView {
  if (!value || typeof value !== 'object') {
    return false
  }

  const view = value as Record<string, unknown>

  return (
    typeof view.slug === 'string' &&
    (SUPERVISOR_STATES as readonly unknown[]).includes(view.state) &&
    Array.isArray(view.offers) &&
    Array.isArray(view.rows) &&
    Array.isArray(view.fixes) &&
    Array.isArray(view.blocking) &&
    !!view.totals &&
    typeof view.totals === 'object'
  )
}

/** False in the web build: Work needs main to hold the listener. */
export const workAvailable = (): boolean => bridge() !== undefined

const put = (view: unknown) => {
  if (isWorkView(view)) {
    $acpWork.set({ ...$acpWork.get(), [view.slug]: view })
  }
}

const notice = (slug: string, next: WorkNotice | null) => $acpWorkNotice.set({ ...$acpWorkNotice.get(), [slug]: next })

export async function loadWork(slug: string, read: 'refresh' | 'state' = 'state'): Promise<void> {
  const api = bridge()

  if (api) {
    put(await (read === 'refresh' ? api.refresh(slug) : api.state(slug)).catch(() => null))
  }
}

const watchers = new Map<string, number>()
let detach: (() => void) | null = null

/** Keeps the slug's view current while a tab shows it: one bridge listener per window, ref-counted per slug. */
export function watchWork(slug: string): () => void {
  watchers.set(slug, (watchers.get(slug) ?? 0) + 1)

  if (!detach) {
    detach =
      bridge()?.onChanged(changed => {
        if (typeof changed === 'string' && watchers.has(changed)) {
          void loadWork(changed)
        }
      }) ?? null
  }

  void loadWork(slug)

  return () => {
    const left = (watchers.get(slug) ?? 1) - 1

    if (left > 0) {
      watchers.set(slug, left)
    } else {
      watchers.delete(slug)
    }

    if (watchers.size === 0 && detach) {
      detach()
      detach = null
    }
  }
}

const isStop = (value: unknown): value is WorkStopReport =>
  !!value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).open)

/**
 * One owner action. `call` runs synchronously (the gesture lock reads the click that is still on the stack); the
 * answer becomes the notice, and the view is read again.
 */
export function runWorkAction(
  slug: string,
  call: (api: AcpWorkBridge) => Promise<WorkActionResult | WorkStopReport>
): Promise<void> {
  const api = bridge()

  if (!api) {
    return Promise.resolve()
  }

  return call(api)
    .then(result => {
      if (isStop(result)) {
        notice(slug, { kind: 'stop', report: result })
      } else {
        notice(slug, result.ok ? null : { kind: 'error', result })
      }
    })
    .catch(() => notice(slug, { kind: 'error', result: { ok: false, error: 'busy' } }))
    .then(() => loadWork(slug))
}
