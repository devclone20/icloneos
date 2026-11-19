/**
 * The notification centre and the toasts.
 *
 * r4b/r4c (critic-r4 06a): while the centre is open a new notification is an entry only, and opening the centre takes
 * the toasts on screen away (their entries are already there).
 *
 * r4d (eng r4-M1, r4-m1): taking them away is a PARK, never a dismissal. The cases below run the three real callers
 * the critic named, and every one is red on 52cae17554, where opening the centre ran each toast's `onDismiss`:
 *   - the cron model confirm (cron-model-impact.ts) stays pending and resolves true from its entry's action;
 *   - the app-update toast (app-update.ts) is never snoozed by an open;
 *   - a sticky warning (`survivesClear`, `durationMs` 0) is back on screen once the centre closes;
 * and a confirm raised while the centre is open resolves false when its entry is cleared (it awaited forever).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { APP_UPDATE_SNOOZE_KEY, APP_UPDATE_TOAST_ID, syncAppUpdateToast } from '@/store/app-update'
import { invalidateCronModelImpactScope, setMainModelAssignment } from '@/store/cron-model-impact'
import type { ModelAssignmentResponse } from '@/types/hermes'

import {
  $notificationHistory,
  $notifications,
  clearNotificationHistory,
  clearNotifications,
  closeNotificationCentre,
  dismissNotification,
  notify,
  openNotificationCentre,
  parkedNotificationIds,
  removeNotificationRecord,
  runNotificationAction,
  TOAST_STACK_CAP
} from './notifications'

const setModelAssignment = vi.fn()

vi.mock('@/hermes', () => ({
  setModelAssignment: (...args: unknown[]) => setModelAssignment(...args),
  getApiRequestProfile: () => 'default'
}))

const CONFIRM: ModelAssignmentResponse = {
  ok: false,
  scope: 'main',
  provider: 'openrouter',
  model: 'openai/gpt-5.5-pro',
  confirm_required: true,
  confirm_message: 'Confirm this expensive model.'
}

const SAVED: ModelAssignmentResponse = { ok: true, scope: 'main', provider: 'openrouter', model: 'openai/gpt-5.5-pro' }

const confirmId = () =>
  $notificationHistory.get().find(entry => entry.id.startsWith('model-warning-confirm-'))?.id ?? null

/** Settles within a few ticks, or reports that it did not (a confirm that never resolves would hang the case). */
async function outcome(promise: Promise<unknown>): Promise<'pending' | 'rejected' | 'resolved'> {
  let state: 'pending' | 'rejected' | 'resolved' = 'pending'

  promise.then(
    () => (state = 'resolved'),
    () => (state = 'rejected')
  )

  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }

  return state
}

beforeEach(() => {
  setModelAssignment.mockReset()
  closeNotificationCentre()
  // survivesClear toasts outlive clearNotifications (by design): a case starts with none left from the one before,
  // whose timers belonged to another clock.
  for (const toast of [...$notifications.get()]) {
    dismissNotification(toast.id)
  }

  clearNotifications()
  clearNotificationHistory()
  invalidateCronModelImpactScope({ clearNotification: false })
  window.localStorage.clear()
})

afterEach(() => {
  closeNotificationCentre()
  clearNotifications()
  clearNotificationHistory()
  vi.useRealTimers()
})

describe('opening the centre parks the toasts, it never dismisses them (r4-M1)', () => {
  it('a pending cron model confirm stays pending, and its entry action resolves it true', async () => {
    setModelAssignment.mockResolvedValueOnce(CONFIRM).mockResolvedValueOnce(SAVED)

    const pending = setMainModelAssignment({ provider: 'openrouter', model: 'openai/gpt-5.5-pro' })

    await vi.waitFor(() => expect(confirmId()).not.toBeNull())
    openNotificationCentre()

    expect($notifications.get()).toEqual([])
    expect(await outcome(pending)).toBe('pending')

    runNotificationAction(confirmId()!)

    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(setModelAssignment).toHaveBeenLastCalledWith(expect.objectContaining({ confirm_expensive_model: true }))
    expect(parkedNotificationIds()).not.toContain(confirmId())
  })

  it('opening the centre never snoozes the update prompt', () => {
    syncAppUpdateToast({
      checkedAt: null,
      current: '0.0.8',
      error: null,
      next: '0.0.9',
      phase: 'available',
      progress: null,
      releaseUrl: null
    })
    expect($notifications.get().map(toast => toast.id)).toContain(APP_UPDATE_TOAST_ID)

    openNotificationCentre()

    expect(window.localStorage.getItem(APP_UPDATE_SNOOZE_KEY)).toBeNull()

    // And it is a sticky toast (durationMs 0): it is back on screen after the close.
    closeNotificationCentre()
    expect($notifications.get().map(toast => toast.id)).toContain(APP_UPDATE_TOAST_ID)
    expect(window.localStorage.getItem(APP_UPDATE_SNOOZE_KEY)).toBeNull()
  })

  it('a sticky survivesClear warning is back on screen after the centre closes; a timed one is not', () => {
    const kept = vi.fn()
    const timed = vi.fn()

    notify({ durationMs: 0, id: 'send-kept', kind: 'warning', message: 'Send kept.', onDismiss: kept, survivesClear: true })
    notify({ id: 'saved', kind: 'success', message: 'Saved.', onDismiss: timed })
    openNotificationCentre()
    closeNotificationCentre()

    expect($notifications.get().map(toast => toast.id)).toEqual(['send-kept'])
    expect(kept).not.toHaveBeenCalled()
    expect(timed).not.toHaveBeenCalled()
  })
})

describe('a toast raised while the centre is open keeps its onDismiss (r4-m1)', () => {
  it('a confirm raised with the centre open resolves false when its entry is cleared', async () => {
    setModelAssignment.mockResolvedValueOnce(CONFIRM)
    openNotificationCentre()

    const pending = setMainModelAssignment({ provider: 'openrouter', model: 'openai/gpt-5.5-pro' })

    await vi.waitFor(() => expect(confirmId()).not.toBeNull())
    expect($notifications.get()).toEqual([])

    clearNotificationHistory()

    await expect(pending).rejects.toThrow('Model change cancelled')
  })

  it('removing one entry ends its parked toast; an entry whose action was used owes no dismissal', () => {
    const removed = vi.fn()
    const used = vi.fn()
    const act = vi.fn()

    openNotificationCentre()
    notify({ id: 'a', kind: 'info', message: 'A', onDismiss: removed })
    notify({ action: { label: 'Open', onClick: act }, id: 'b', kind: 'info', message: 'B', onDismiss: used })

    runNotificationAction('b')
    removeNotificationRecord('a')
    removeNotificationRecord('b')

    expect(removed).toHaveBeenCalledTimes(1)
    expect(act).toHaveBeenCalledTimes(1)
    expect(used).not.toHaveBeenCalled()
  })

  it('the caller dismissing a parked toast is a real dismissal, once', () => {
    const onDismiss = vi.fn()

    openNotificationCentre()
    notify({ id: 'job', kind: 'info', message: 'Working', onDismiss })
    dismissNotification('job')
    dismissNotification('job')
    clearNotificationHistory()

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})

describe('no toast over an open centre (r4b/r4c)', () => {
  it('a new notification while the centre is open is an entry, not a toast', () => {
    openNotificationCentre()
    notify({ kind: 'error', id: 'agent-stopped', title: 'The agent stopped', message: 'It quit.' })

    expect($notifications.get()).toEqual([])
    expect($notificationHistory.get().map(entry => entry.title)).toContain('The agent stopped')
  })

  it('opening the centre takes the toasts on screen away; their entries stay', () => {
    notify({ kind: 'error', id: 'agent-stopped', title: 'The agent stopped', message: 'It quit.' })
    notify({ kind: 'info', title: 'Replaced Email', message: 'Wallet opened in its place.' })
    openNotificationCentre()

    expect($notifications.get()).toEqual([])
    expect($notificationHistory.get().map(entry => entry.title)).toEqual(
      expect.arrayContaining(['The agent stopped', 'Replaced Email'])
    )
  })

  it('an update of a parked toast while the centre is open updates the entry, not a toast', () => {
    notify({ kind: 'info', id: 'job', title: 'Working', message: 'Step 1' })
    openNotificationCentre()
    notify({ kind: 'info', id: 'job', title: 'Working', message: 'Step 2' })

    expect($notifications.get()).toEqual([])
    expect($notificationHistory.get().find(entry => entry.id === 'job')?.message).toBe('Step 2')
  })

  it('with the centre closed, toasts show as before', () => {
    openNotificationCentre()
    closeNotificationCentre()
    notify({ kind: 'error', title: 'The agent stopped', message: 'It quit.' })

    expect($notifications.get()).toHaveLength(1)
  })
})

/**
 * F4 → 9 (eng r4 "Path upward"): a property over random sequences. Whatever the order of notify / open / close /
 * dismiss / clear / remove / timers, every onDismiss runs AT MOST ONCE, and only on a real end — the toast was dismissed,
 * evicted by the stack cap, cleared by a reconnect, timed out on screen, or its parked entry left the centre unused.
 * Opening or closing the centre alone never runs one. Seeded, so a failure replays.
 */
describe('property: onDismiss runs at most once, and only on a real end', () => {
  type Op =
    | { kind: 'clear' }
    | { kind: 'clearHistory' }
    | { kind: 'close' }
    | { kind: 'dismiss'; id: string }
    | { kind: 'notify'; id: string; sticky: boolean; survives: boolean }
    | { kind: 'open' }
    | { kind: 'remove'; id: string }
    | { kind: 'tick' }

  function rng(seed: number) {
    let state = seed >>> 0

    return () => {
      state = (state * 1664525 + 1013904223) >>> 0

      return state / 2 ** 32
    }
  }

  const IDS = ['a', 'b', 'c', 'd', 'e']
  const endsBySeed = new Map<number, number>()

  function sequence(seed: number): Op[] {
    const random = rng(seed)
    const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]!

    return Array.from({ length: 40 }, (): Op => {
      const roll = random()
      const id = pick(IDS)

      if (roll < 0.35) {
        return { kind: 'notify', id, sticky: random() < 0.4, survives: random() < 0.3 }
      }

      if (roll < 0.47) {
        return { kind: 'open' }
      }

      if (roll < 0.59) {
        return { kind: 'close' }
      }

      if (roll < 0.69) {
        return { kind: 'dismiss', id }
      }

      if (roll < 0.76) {
        return { kind: 'remove', id }
      }

      if (roll < 0.81) {
        return { kind: 'clear' }
      }

      if (roll < 0.85) {
        return { kind: 'clearHistory' }
      }

      return { kind: 'tick' }
    })
  }

  it.each(Array.from({ length: 60 }, (_, i) => 1000 + i))('seed %i', seed => {
    vi.useFakeTimers()

    // Each notify is a distinct toast instance with its own callback (a same-id notify replaces, with no callback).
    const calls = new Map<string, number>()
    let serial = 0
    let realEnds = 0

    for (const op of sequence(seed)) {
      const before = [...calls.values()].reduce((n, c) => n + c, 0)

      switch (op.kind) {
        case 'notify': {
          const key = `${op.id}#${serial++}`

          calls.set(key, 0)
          notify({
            durationMs: op.sticky ? 0 : undefined,
            id: op.id,
            kind: 'info',
            message: key,
            onDismiss: () => calls.set(key, (calls.get(key) ?? 0) + 1),
            survivesClear: op.survives
          })

          break
        }

        case 'open':
          openNotificationCentre()

          break

        case 'close':
          closeNotificationCentre()

          break

        case 'dismiss':
          dismissNotification(op.id)

          break

        case 'remove':
          removeNotificationRecord(op.id)

          break

        case 'clear':
          clearNotifications()

          break

        case 'clearHistory':
          clearNotificationHistory()

          break

        case 'tick':
          vi.advanceTimersByTime(60_000)

          break
      }

      const after = [...calls.values()].reduce((n, c) => n + c, 0)

      // Opening or closing the centre is never a dismissal — except that closing may restore sticky toasts past the
      // stack cap, and the cap's eviction IS one (X2). Anything else that ran a callback is a real end.
      if (op.kind === 'open') {
        expect(after, `seed ${seed}: open ran an onDismiss`).toBe(before)
      }

      if (op.kind === 'close') {
        expect(after - before, `seed ${seed}: close ran more than the cap evicts`).toBeLessThanOrEqual(TOAST_STACK_CAP)
      }

      realEnds += after - before

      // r5 (eng r5-m1): a tick runs every timer out, so whatever is still on screen is sticky (durationMs 0) — never a
      // timed toast that came back from the park without its timer.
      if (op.kind === 'tick') {
        expect(
          $notifications.get().filter(toast => toast.durationMs !== 0).map(toast => toast.id),
          `seed ${seed}: a timed toast outlived its timer`
        ).toEqual([])
      }
    }

    for (const [key, count] of calls) {
      expect(count, `seed ${seed}: ${key} ran onDismiss ${count} times`).toBeLessThanOrEqual(1)
    }

    // Every callback that ran was counted against an end the sequence did (the property is not vacuous: across the
    // seeds some toasts do end — checked once below).
    endsBySeed.set(seed, realEnds)
  })

  it('the seeds exercise real ends (dismissals, clears, evictions, timers)', () => {
    expect([...endsBySeed.values()].reduce((n, c) => n + c, 0)).toBeGreaterThan(20)
  })
})

// r5 (eng r5-m1, r5-m2). Red on b290e6d7f3.
describe('r5: restored toasts keep their timers; a merged notice shares its entry id', () => {
  it('a timed survivesClear toast (a native info) is not brought back without a timer after the centre closes', () => {
    vi.useFakeTimers()
    notify({ id: 'native-info', kind: 'info', message: 'Saved to Downloads.', survivesClear: true })
    expect($notifications.get().map(toast => toast.id)).toEqual(['native-info'])

    openNotificationCentre()
    closeNotificationCentre()
    vi.advanceTimersByTime(60_000)

    expect($notifications.get()).toEqual([])
    // Its entry stays in the centre.
    expect($notificationHistory.get().map(entry => entry.id)).toContain('native-info')
  })

  it('a sticky (durationMs 0) survivesClear warning still comes back', () => {
    notify({ durationMs: 0, id: 'kept', kind: 'warning', message: 'Send kept.', survivesClear: true })
    openNotificationCentre()
    closeNotificationCentre()

    expect($notifications.get().map(toast => toast.id)).toEqual(['kept'])
  })

  it('the second identical plain notice toasts under the merged entry id; nothing is left parked', () => {
    const first = notify({ kind: 'info', title: 'Replaced Settings', message: 'Open it again from the Dock.' })
    const second = notify({ kind: 'info', title: 'Replaced Settings', message: 'Open it again from the Dock.' })

    expect(second).toBe(first)
    expect($notificationHistory.get().map(entry => entry.id)).toEqual([first])
    expect($notifications.get().map(toast => toast.id)).toEqual([first])

    openNotificationCentre()
    closeNotificationCentre()
    clearNotificationHistory()
    expect(parkedNotificationIds()).toEqual([])
  })

  it('a toast whose entry was removed before the centre opened is not stranded in the park', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()

    notify({ id: 'orphan', kind: 'info', message: 'Working', onDismiss })
    removeNotificationRecord('orphan')
    openNotificationCentre()
    closeNotificationCentre()

    expect(parkedNotificationIds()).toEqual([])
    expect($notifications.get().map(toast => toast.id)).toEqual(['orphan'])
    vi.advanceTimersByTime(60_000)
    expect($notifications.get()).toEqual([])
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('a notice with its own id is never merged under another one', () => {
    notify({ kind: 'info', title: 'Copied', message: 'Address copied.' })
    notify({ id: 'mine', kind: 'info', title: 'Copied', message: 'Address copied.' })

    expect($notificationHistory.get().map(entry => entry.id)).toContain('mine')
  })
})

