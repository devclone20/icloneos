import { atom } from 'nanostores'

import {
  CONFINEMENT_STATE_SCHEMA,
  type ConfinementStateView,
  type HardlinkAckResultView,
  type KillResultView
} from '@/iclone-shared/confinement'

/**
 * V3-G — the window's copy of main's confinement state for the Dock pane. Main folds it from live `ps` on every
 * read; this store only holds the last answer and asks again (every second while the pane is open, and whenever main
 * announces a refusal). It never counts anything itself.
 */
export interface IcloneConfinementBridge {
  state: () => Promise<ConfinementStateView | null>
  kill: (pid: number) => Promise<KillResultView | null>
  explain: (pid: number) => Promise<string[] | null>
  ackHardlink: (input: { root: string; dir: string; digest: string }) => Promise<HardlinkAckResultView | null>
  onChanged: (callback: () => void) => () => void
}

interface ConfinementStore {
  status: 'error' | 'loading' | 'ready' | 'unavailable'
  state: ConfinementStateView | null
  error: string | null
}

export const $confinement = atom<ConfinementStore>({ status: 'loading', state: null, error: null })

const POLL_MS = 1_000

function bridge(): IcloneConfinementBridge | undefined {
  return window.hermesDesktop?.icloneConfinement
}

const isState = (value: unknown): value is ConfinementStateView =>
  typeof value === 'object' && value !== null && (value as { schema?: unknown }).schema === CONFINEMENT_STATE_SCHEMA

async function loadConfinement(): Promise<void> {
  const door = bridge()

  if (!door) {
    $confinement.set({ status: 'unavailable', state: null, error: null })

    return
  }

  try {
    const state = await door.state()

    $confinement.set(
      isState(state)
        ? { status: 'ready', state, error: null }
        : { status: 'error', state: $confinement.get().state, error: 'unexpected state' }
    )
  } catch (error) {
    $confinement.set({
      status: 'error',
      state: $confinement.get().state,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/** V3-FX M2: one read of main's live state, for a surface that only states it (the Permissions pane's note). */
export function readConfinementOnce(): Promise<void> {
  return loadConfinement()
}

/** While the pane is open: read now, every second, and on every refusal main announces. */
export function watchConfinement(): () => void {
  const off = bridge()?.onChanged(() => void loadConfinement())
  const timer = window.setInterval(() => void loadConfinement(), POLL_MS)

  void loadConfinement()

  return () => {
    off?.()
    window.clearInterval(timer)
  }
}

export async function killConfined(pid: number): Promise<KillResultView> {
  const result: KillResultView = (await bridge()?.kill(pid)) ?? {
    ok: false,
    pid,
    reason: 'not-confined',
    survivors: [],
    error: 'unavailable'
  }

  void loadConfinement()

  return result
}

export async function explainConfined(pid: number): Promise<string[]> {
  return (await bridge()?.explain(pid)) ?? []
}

/**
 * Call SYNCHRONOUSLY from the click handler of a control inside `data-confinement-confirm`: the preload attaches the
 * proof of that click, and main refuses the acknowledgement without it. One gesture allows the files under `dir`
 * exactly as the pane showed them (`digest`).
 */
export async function acknowledgeHardlink(root: string, dir: string, digest: string): Promise<HardlinkAckResultView> {
  const result = (await bridge()?.ackHardlink({ root, dir, digest })) ?? { ok: false, reason: 'invalid' }

  void loadConfinement()

  return result
}
