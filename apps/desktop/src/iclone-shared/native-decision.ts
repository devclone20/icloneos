/**
 * v0.0.9 F4b — the wire contract for the main process's decisions and notices shown by the renderer (spec F4 type 4:
 * "`dialog.showMessageBox` stays only where no renderer exists"). Shared by electron/main/renderer-dialogs.ts, the
 * preload bridge and src/components/native-decision-host.tsx; no Electron or DOM import, so both sides and their tests
 * read the same shapes.
 *
 * Not on this wire, on purpose: the Ignore-permissions and function-raise confirms (iclone-permissions/ignore-dialog.ts)
 * and the isolation-off confirm (iclone-confinement/isolation-switch.ts). Those are F-17 consents that weaken a security
 * boundary; they stay native because no renderer may click, focus-steal or answer them.
 */

/** main → renderer: a decision is waiting (payload `NativeDecisionAsk`). */
export const NATIVE_DECISION_ASK = 'iclone:native-decision:ask'
/** renderer → main (invoke): "I am showing it" — true only while main still waits for this renderer. */
export const NATIVE_DECISION_SHOWN = 'iclone:native-decision:shown'
/** renderer → main (invoke): the button the person chose (`NativeDecisionAnswer`). */
export const NATIVE_DECISION_ANSWER = 'iclone:native-decision:answer'
/** main → renderer: notices are queued; the renderer drains them (no payload, so nothing rides an unchecked push). */
export const NATIVE_NOTICE_READY = 'iclone:native-notice:ready'
/** renderer → main (invoke): take every queued notice (`NativeNotice[]`). */
export const NATIVE_NOTICE_DRAIN = 'iclone:native-notice:drain'

export type NativeDecisionTone = 'danger' | 'default' | 'warning'

export interface NativeDecisionAsk {
  id: string
  title: string
  /** The whole explanation; the dialog wraps and scrolls it, never cuts it. */
  detail: string
  /** Left to right as the person reads them; `cancelId` is the safe one (Esc, Cancel). */
  buttons: string[]
  cancelId: number
  defaultId: number
  tone: NativeDecisionTone
}

export interface NativeDecisionAnswer {
  id: string
  response: number
  /** navigator.userActivation.isActive at the click (preload fills it, the page cannot). */
  activation: boolean
}

export type NativeNoticeKind = 'error' | 'info' | 'success' | 'warning'

export interface NativeNotice {
  id: string
  kind: NativeNoticeKind
  title: string
  message: string
  /** Raw text kept whole in the notification centre (copyable): an error, a log path. */
  detail?: string
  nextStep?: string
  /** Record in the centre only, no toast (the OS already showed it as a native notification). */
  historyOnly?: boolean
  at: number
}

const MAX_TEXT = 8_000
const MAX_BUTTONS = 4

const isText = (value: unknown, max = MAX_TEXT): value is string => typeof value === 'string' && value.length <= max

/** The renderer accepts only a well-formed ask: a malformed push is dropped, never half-shown. */
export function parseNativeDecisionAsk(value: unknown): NativeDecisionAsk | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const v = value as Record<string, unknown>
  const buttons = v.buttons

  if (
    !isText(v.id, 128) ||
    !isText(v.title, 500) ||
    !isText(v.detail) ||
    !Array.isArray(buttons) ||
    buttons.length < 1 ||
    buttons.length > MAX_BUTTONS ||
    !buttons.every(b => isText(b, 80) && b.length > 0)
  ) {
    return null
  }

  const index = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < buttons.length

  if (!index(v.cancelId) || !index(v.defaultId)) {
    return null
  }

  const tone: NativeDecisionTone = v.tone === 'danger' || v.tone === 'warning' ? v.tone : 'default'

  return {
    buttons: buttons as string[],
    cancelId: v.cancelId as number,
    defaultId: v.defaultId as number,
    detail: v.detail,
    id: v.id,
    title: v.title,
    tone
  }
}

/** Main accepts an answer only in this exact shape; anything else is refused (the decision keeps waiting). */
export function parseNativeDecisionAnswer(value: unknown): NativeDecisionAnswer | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const v = value as Record<string, unknown>

  if (!isText(v.id, 128) || typeof v.response !== 'number' || !Number.isInteger(v.response)) {
    return null
  }

  return { activation: v.activation === true, id: v.id, response: v.response }
}

export function parseNativeNotices(value: unknown): NativeNotice[] {
  if (!Array.isArray(value)) {
    return []
  }

  const kinds = new Set<NativeNoticeKind>(['error', 'info', 'success', 'warning'])

  return value.flatMap(item => {
    if (!item || typeof item !== 'object') {
      return []
    }

    const v = item as Record<string, unknown>

    if (
      !isText(v.id, 128) ||
      !kinds.has(v.kind as NativeNoticeKind) ||
      !isText(v.title, 500) ||
      !isText(v.message) ||
      (v.detail !== undefined && !isText(v.detail)) ||
      (v.nextStep !== undefined && !isText(v.nextStep, 1_000)) ||
      typeof v.at !== 'number'
    ) {
      return []
    }

    return [
      {
        at: v.at,
        detail: v.detail as string | undefined,
        historyOnly: v.historyOnly === true,
        id: v.id,
        kind: v.kind as NativeNoticeKind,
        message: v.message,
        nextStep: v.nextStep as string | undefined,
        title: v.title
      }
    ]
  })
}
