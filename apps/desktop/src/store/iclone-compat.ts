// Compat engine state for the App Atualisation pane and the updates overlay. Main owns the verdicts and the gate; these
// atoms only mirror `iclone:compat:status` plus the `iclone:compat:verdict` push.
import { atom, onMount } from 'nanostores'

import type {
  IcloneCompatAckResult,
  IcloneCompatBacklog,
  IcloneCompatDecideResult,
  IcloneCompatDecision,
  IcloneCompatStatus,
  IcloneCompatVerdict
} from '@/types/iclone-compat'

// The verdict at the update target (`pending.json`): the one the gate in main reads.
export const $compatVerdict = atom<IcloneCompatVerdict | null>(null)
// The verdict of the runtime that is running now (`latest.json`).
export const $compatLatest = atom<IcloneCompatVerdict | null>(null)
export const $compatStatus = atom<IcloneCompatStatus | null>(null)
export const $backlog = atom<IcloneCompatBacklog | null>(null)

const bridge = () => window.hermesDesktop?.icloneUpdates?.compat

export async function refreshCompatStatus(): Promise<IcloneCompatStatus | null> {
  const api = bridge()

  if (!api) {
    return null
  }

  const status = await api.status()
  $compatStatus.set(status)
  $compatVerdict.set(status.pending)
  $compatLatest.set(status.latest)

  return status
}

export async function loadBacklog(refresh = false): Promise<IcloneCompatBacklog | null> {
  const backlog = (await bridge()?.backlog({ refresh })) ?? null
  $backlog.set(backlog)

  return backlog
}

export async function decideAdoption(decision: IcloneCompatDecision): Promise<IcloneCompatDecideResult> {
  return (await bridge()?.decide(decision)) ?? { ok: false, reason: 'no-bridge' }
}

// The owner's hold on a non-GREEN verdict: main starts its clock on `beginOwnerHold` and measures the hold itself on
// `releaseOwnerHold`; nothing the renderer reports about time is trusted.
export async function beginOwnerHold(verdictId: string): Promise<IcloneCompatAckResult> {
  return (await bridge()?.ack({ phase: 'begin', verdictId })) ?? { ok: false, reason: 'no-bridge' }
}

export async function releaseOwnerHold(
  verdictId: string,
  nonce: string,
  names: string[]
): Promise<IcloneCompatAckResult> {
  return (await bridge()?.ack({ phase: 'mint', verdictId, nonce, names })) ?? { ok: false, reason: 'no-bridge' }
}

export async function cancelOwnerHold(): Promise<void> {
  await bridge()?.ack({ phase: 'cancel' })
}

onMount($compatVerdict, () => {
  const api = bridge()

  if (!api) {
    return
  }

  void refreshCompatStatus().catch(() => undefined)

  return api.onVerdict(({ slot, verdict }) => (slot === 'pending' ? $compatVerdict : $compatLatest).set(verdict))
})
