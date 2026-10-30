import { atom } from 'nanostores'

import {
  CONSENT_PERMISSION_KEYS,
  type ConsentResult,
  type ConsentSnapshot,
  type ConsentSwitchKey,
  type IcloneConsentBridge
} from './types'

interface ConsentStoreState {
  // `unavailable` = no desktop bridge (web build, dev mock): nothing to show, nothing to gate.
  status: 'loading' | 'ready' | 'unavailable'
  snapshot: ConsentSnapshot | null
}

export const $consent = atom<ConsentStoreState>({ status: 'loading', snapshot: null })

export function consentBridge(): IcloneConsentBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.hermesDesktop?.icloneConsent
}

let inflight: Promise<void> | null = null

export function loadConsent(force = false): Promise<void> {
  if (inflight && !force) {
    return inflight
  }

  const bridge = consentBridge()

  if (!bridge) {
    $consent.set({ status: 'unavailable', snapshot: null })

    return Promise.resolve()
  }

  inflight = bridge.get().then(
    snapshot => $consent.set({ status: 'ready', snapshot }),
    () => $consent.set({ status: 'unavailable', snapshot: null })
  )

  return inflight
}

/** Folds a main-process answer into the store; returns the error text (or null). */
export function applyConsentResult(
  result: ConsentResult | undefined,
  settled?: ConsentSnapshot['state']
): string | null {
  if (!result || !result.ok) {
    return result && !result.ok ? result.error : 'No answer from the app.'
  }

  const current = $consent.get().snapshot

  if (current) {
    $consent.set({ status: 'ready', snapshot: { ...current, record: result.record, state: settled ?? current.state } })
  }

  return null
}

/** Every shown row as an explicit true/false: a switch displayed OFF is saved as OFF, never left undecided. */
export function displayedPermissions(isOn: (key: ConsentSwitchKey) => boolean): Record<ConsentSwitchKey, boolean> {
  return Object.fromEntries(CONSENT_PERMISSION_KEYS.map(key => [key, isOn(key)])) as Record<ConsentSwitchKey, boolean>
}

/** Test seam. */
export function resetConsentStore(): void {
  inflight = null
  $consent.set({ status: 'loading', snapshot: null })
}
