/**
 * The user-run agent update (Settings › Updates › Agent): one click asks Nous Research, through main,
 * for the newest Hermes agent; a second click on a confirm sheet updates it. Nothing in this module
 * runs on mount, at boot, on a timer, on focus or on resume — `loadLastAgentCheck` only reads back the
 * result main persisted after the user's previous click (a local file, no network).
 */
import { atom } from 'nanostores'

import { errorMessage } from '@/iclone-shared/errors'
import { isRecord } from '@/iclone-shared/guards'
import type { IcloneCompatRefusal } from '@/types/iclone-compat'
import type {
  IcloneAgentApplyError,
  IcloneAgentGestureResult,
  IcloneAgentUpdateApplyRequest,
  IcloneAgentUpdateApplyResult,
  IcloneAgentUpdateCheck,
  IcloneCompatFlag,
  IcloneUpdatePolicyInfo
} from '@/types/iclone-updates'

import { refreshCompatStatus } from './iclone-compat'
import { $updateOverlayTarget, $updatePolicy, applyUpdates, isCuratedPolicy, setUpdateOverlayOpen } from './updates'

/** `window.hermesDesktop.agentUpdate` (preload, U1a). */
interface AgentUpdateBridge {
  apply: (request: IcloneAgentUpdateApplyRequest) => Promise<IcloneAgentUpdateApplyResult>
  check: () => Promise<IcloneAgentUpdateCheck>
  /** Must be invoked synchronously inside the confirm button's event: main reads the live user activation. */
  gesture: () => Promise<IcloneAgentGestureResult>
  lastCheck: () => Promise<IcloneAgentUpdateCheck | null>
}

interface CompatFlagBridge {
  flag: () => Promise<IcloneCompatFlag | null>
  onFlag: (callback: (flag: IcloneCompatFlag) => void) => () => void
}

type AgentUpdatePhase = 'applying' | 'checked' | 'checking' | 'error' | 'idle'

/** `bridge` = this build has no agent-update bridge; `failed` = the IPC itself threw. */
type AgentUpdateFault = 'bridge' | 'failed'

interface AgentUpdateState {
  applyError: { error: AgentUpdateFault | IcloneAgentApplyError; message: string } | null
  /** The last answer main gave (fresh click or persisted); null = never checked. */
  check: IcloneAgentUpdateCheck | null
  /** A check that never reached an answer from main. */
  fault: AgentUpdateFault | null
  phase: AgentUpdatePhase
}

const INITIAL: AgentUpdateState = { applyError: null, check: null, fault: null, phase: 'idle' }

export const $agentUpdate = atom<AgentUpdateState>(INITIAL)
export const $agentCompatFlag = atom<IcloneCompatFlag | null>(null)

function patch(next: Partial<AgentUpdateState>) {
  $agentUpdate.set({ ...$agentUpdate.get(), ...next })
}

function bridgeMember<T>(path: readonly string[], methods: readonly string[]): T | null {
  if (typeof window === 'undefined' || !window.hermesDesktop) {
    return null
  }

  let candidate: unknown = window.hermesDesktop

  for (const key of path) {
    candidate = isRecord(candidate) ? candidate[key] : undefined
  }

  return isRecord(candidate) && methods.every(name => typeof candidate[name] === 'function')
    ? (candidate as unknown as T)
    : null
}

function agentUpdateBridge(): AgentUpdateBridge | null {
  return bridgeMember<AgentUpdateBridge>(['agentUpdate'], ['apply', 'check', 'gesture', 'lastCheck'])
}

function phaseOf(check: IcloneAgentUpdateCheck): AgentUpdatePhase {
  return check.error ? 'error' : 'checked'
}

let inflightCheck: Promise<IcloneAgentUpdateCheck | null> | null = null

/** One query per click; a second click while the first is in flight joins it. */
export function checkAgentUpdate(): Promise<IcloneAgentUpdateCheck | null> {
  if (inflightCheck) {
    return inflightCheck
  }

  const bridge = agentUpdateBridge()

  if (!bridge) {
    patch({ fault: 'bridge', phase: 'error' })

    return Promise.resolve(null)
  }

  patch({ fault: null, phase: 'checking' })

  inflightCheck = bridge
    .check()
    .then(check => {
      patch({ applyError: null, check, fault: null, phase: phaseOf(check) })

      return check
    })
    .catch(() => {
      patch({ fault: 'failed', phase: 'error' })

      return null
    })
    .finally(() => {
      inflightCheck = null
    })

  return inflightCheck
}

/** Shows the previous click's answer across restarts; never asks the network. */
export async function loadLastAgentCheck(): Promise<void> {
  const bridge = agentUpdateBridge()

  if (!bridge || $agentUpdate.get().phase !== 'idle') {
    return
  }

  try {
    const check = await bridge.lastCheck()

    if (check && $agentUpdate.get().phase === 'idle') {
      patch({ check, phase: phaseOf(check) })
    }
  } catch {
    // No persisted answer is the same as never checked.
  }
}

/** The sha an Update click may target: the latest of the last check, only when it is newer. */
export function agentUpdateTargetSha(state: AgentUpdateState): null | string {
  const check = state.check

  return check && check.updateAvailable && !check.error && check.latest ? check.latest.sha : null
}

/** The gate's persisted refusal speaks for `targetSha` only when it was for that very rev (possibly abbreviated). */
export function refusalFor(refusal: IcloneCompatRefusal | null | undefined, targetSha: null | string): boolean {
  const to = refusal?.target ?? ''

  return Boolean(targetSha && to.length >= 7 && targetSha.startsWith(to))
}

/**
 * The gate in main lets only a GREEN target through without the owner's review (electron/iclone-compat/gate.ts), so a
 * cached non-GREEN or missing verdict — or a refusal the gate already recorded for this target — makes the review the
 * pane's primary action instead of a click the gate is certain to hold.
 */
export function agentUpdateNeedsReview(
  state: AgentUpdateState,
  refusal: IcloneCompatRefusal | null | undefined
): boolean {
  const target = agentUpdateTargetSha(state)

  return target !== null && ((state.check?.compat?.verdict ?? 'UNKNOWN') !== 'GREEN' || refusalFor(refusal, target))
}

/**
 * Call synchronously from the confirm button's click/keydown handler — before any await — so main can
 * mint the single-use gesture token while the user activation is live. On success iclone os quits.
 */
export function applyAgentUpdate(targetSha: string): Promise<IcloneAgentUpdateApplyResult | null> {
  const bridge = agentUpdateBridge()

  if (!bridge) {
    patch({ applyError: { error: 'bridge', message: '' } })

    return Promise.resolve(null)
  }

  const minted = bridge.gesture()

  patch({ applyError: null, phase: 'applying' })

  return minted
    .then((gesture): Promise<IcloneAgentUpdateApplyResult> | IcloneAgentUpdateApplyResult =>
      gesture.ok
        ? bridge.apply({ gestureToken: gesture.gesture.token, targetSha })
        : { error: 'gesture', message: gesture.error, ok: false }
    )
    .then(result => {
      if (!result.ok) {
        const check = $agentUpdate.get().check
        patch({ applyError: { error: result.error, message: result.message }, phase: check ? phaseOf(check) : 'idle' })

        if (result.error === 'stale-check') {
          void checkAgentUpdate()
        }

        // Main recorded the gate's refusal on disk; read it back so the pane says it now and after a restart.
        if (result.error === 'compat-hold') {
          void refreshCompatStatus().catch(() => undefined)
        }
      }

      return result
    })
    .catch((error: unknown) => {
      const check = $agentUpdate.get().check
      patch({
        applyError: { error: 'failed', message: errorMessage(error, '') },
        phase: check ? phaseOf(check) : 'idle'
      })

      return null
    })
}

/**
 * The existing updater lands on the pin only through gateUpdateApply's pinned door (curated, POSIX); under developer
 * policy or on Windows it takes the raw door to the branch tip, so a "restore" there would be an update.
 */
export function restoreOffered(policy: IcloneUpdatePolicyInfo | null, isWindows: boolean): boolean {
  return isCuratedPolicy(policy) && !isWindows
}

/** The rollback to the pin this release was verified with (the old "Align runtime"). False = refused, nothing ran. */
export function restoreVerifiedAgent(isWindows: boolean): boolean {
  if (!restoreOffered($updatePolicy.get(), isWindows)) {
    return false
  }

  $updateOverlayTarget.set('client')
  setUpdateOverlayOpen(true)
  void applyUpdates()

  return true
}

/** The RED compat flag main pushes (passive: a banner, never an OS notification). Returns the unsubscribe. */
export function watchAgentCompatFlag(): () => void {
  // Preload exposes it as hermesDesktop.icloneUpdates.compat (U1a), next to the existing compat ack.
  const compat = bridgeMember<CompatFlagBridge>(['icloneUpdates', 'compat'], ['flag', 'onFlag'])

  if (!compat) {
    return () => undefined
  }

  void compat
    .flag()
    .then(flag => $agentCompatFlag.set(flag))
    .catch(() => undefined)

  return compat.onFlag(flag => $agentCompatFlag.set(flag))
}

/** Tests only. */
export function __resetAgentUpdate(): void {
  inflightCheck = null
  $agentUpdate.set(INITIAL)
  $agentCompatFlag.set(null)
}
