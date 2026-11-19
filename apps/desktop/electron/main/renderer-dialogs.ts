/**
 * v0.0.9 F4b — the main process asks the renderer instead of opening a native message box whenever a window can
 * answer (spec F4 type 4: "`dialog.showMessageBox` stays only where no renderer exists"), and hands main-only notices
 * (a failed detached update, a step left to do) to the notification centre instead of `showErrorBox`.
 *
 * The decision path, and why each step is there:
 *   1. No live window → the native box, exactly as before.
 *   2. Main pushes `NATIVE_DECISION_ASK` to that window. The renderer shows nothing until main confirms with
 *      `NATIVE_DECISION_SHOWN` → true, so a late renderer can never paint a decision main already settled.
 *   3. No "shown" within `ackMs` (renderer still booting, crashed, no host mounted) → the native box. A decision is
 *      therefore never lost and never doubled.
 *   4. The answer must come from that same window's main frame (and the app sender guard), name a pending id, be an
 *      integer button index, and — for anything but the safe `cancelId` — carry the V3-F owner-click proof of THIS
 *      dialog's own button (v0.0.9 Q, lead decision 2): the preload's single-use trusted click/Enter on a control marked
 *      `data-native-decision-confirm` (only the host's non-cancel buttons carry it), user activation, and real input the
 *      browser process delivered to this window within 1.5 s AND after main accepted "shown" — so the keypress that
 *      raised the ask (Cmd+Q) can never answer it, and activation alone answers nothing. Esc/close/Cancel stay free and
 *      answer the safe button, so a person can always back out.
 *   5. The window closes or its renderer goes away while asking → the safe `cancelId`.
 *
 * Kept native on purpose (not routed here): the F-17 consents (Ignore permissions, raising a function's level, turning
 * isolation off) — no renderer may answer those — and the boot-time move-to-Applications prompt (no window yet).
 *
 * Pure: Electron arrives through `deps`, so the whole contract unit-tests without Electron.
 */
import type { BrowserWindow, IpcMainInvokeEvent, MessageBoxOptions, WebContents } from 'electron'

import {
  NATIVE_DECISION_ANSWER,
  NATIVE_DECISION_ASK,
  NATIVE_DECISION_SHOWN,
  NATIVE_NOTICE_DRAIN,
  NATIVE_NOTICE_READY,
  type NativeDecisionAsk,
  type NativeDecisionTone,
  type NativeNotice,
  parseNativeDecisionAnswer
} from '../../src/iclone-shared/native-decision'
import { gestureOf, permissionGestureOk } from '../iclone-permissions/gesture'

/** How long a window has to say "shown" before the native box takes over. */
export const DECISION_ACK_MS = 1_500
/** A notice with a native fallback that no window drained by then is shown natively (the boot never got a renderer). */
export const NOTICE_DEADLINE_MS = 20_000

export interface DecisionOptions {
  title: string
  detail: string
  buttons: string[]
  cancelId: number
  defaultId: number
  tone?: NativeDecisionTone
  /** The MessageBox `type` for the native fallback. */
  nativeType?: MessageBoxOptions['type']
}

export interface NoticeOptions {
  kind: NativeNotice['kind']
  title: string
  message: string
  detail?: string
  nextStep?: string
  historyOnly?: boolean
  /** What to show natively if no window drains the notice in time. Omit for centre-only notices. */
  nativeFallback?: { kind: 'error-box' } | { kind: 'message-box'; type: MessageBoxOptions['type'] }
}

type Timer = ReturnType<typeof setTimeout>

export interface RendererDialogsDeps {
  ipcMain: { handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void }
  /** The window that answers (the main window); null when none exists. */
  window: () => BrowserWindow | null
  isTrustedSender: (event: IpcMainInvokeEvent, channel: string) => boolean
  lastTrustedInputAt: (contents: WebContents) => number
  showNativeBox: (window: BrowserWindow | null, options: MessageBoxOptions) => Promise<{ response: number }>
  showErrorBox: (title: string, content: string) => void
  log: (line: string) => void
  now?: () => number
  newId?: () => string
  setTimer?: (fn: () => void, ms: number) => Timer
  clearTimer?: (timer: Timer) => void
  /** The V3-F verdict on a non-cancel answer's `gesture` payload (default: `permissionGestureOk`, 1.5 s). */
  gestureOk?: (facts: { payload: unknown; lastInputAt: number; now: number }) => boolean
  ackMs?: number
  noticeDeadlineMs?: number
}

export interface RendererDialogs {
  ask: (options: DecisionOptions) => Promise<{ response: number }>
  notice: (options: NoticeOptions) => void
}

interface Pending {
  ask: NativeDecisionAsk
  contents: WebContents
  shown: boolean
  /** When main accepted "shown": the answer's real input must come after it. */
  shownAt: number
  ackTimer: Timer | null
  settle: (response: number) => void
}

const liveWindow = (win: BrowserWindow | null): win is BrowserWindow =>
  Boolean(win && !win.isDestroyed() && !win.webContents.isDestroyed())

const nativeOptions = (options: DecisionOptions): MessageBoxOptions => ({
  buttons: options.buttons,
  cancelId: options.cancelId,
  defaultId: options.defaultId,
  detail: options.detail,
  message: options.title,
  noLink: true,
  type: options.nativeType ?? (options.tone === 'danger' || options.tone === 'warning' ? 'warning' : 'question')
})

export function createRendererDialogs(deps: RendererDialogsDeps): RendererDialogs {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((timer: Timer) => clearTimeout(timer))
  const ackMs = deps.ackMs ?? DECISION_ACK_MS
  const gestureOk = deps.gestureOk ?? permissionGestureOk
  const noticeDeadlineMs = deps.noticeDeadlineMs ?? NOTICE_DEADLINE_MS
  let counter = 0
  const newId = deps.newId ?? (() => `nd-${now().toString(36)}-${(counter += 1)}`)

  const pending = new Map<string, Pending>()
  const notices: { notice: NativeNotice; deadline: Timer | null }[] = []

  const fromAnsweringWindow = (event: IpcMainInvokeEvent, channel: string, entry: Pending | undefined) =>
    Boolean(entry) &&
    deps.isTrustedSender(event, channel) &&
    event.sender === entry!.contents &&
    event.senderFrame === entry!.contents.mainFrame

  deps.ipcMain.handle(NATIVE_DECISION_SHOWN, (event, id) => {
    const entry = typeof id === 'string' ? pending.get(id) : undefined

    if (!entry || !fromAnsweringWindow(event, NATIVE_DECISION_SHOWN, entry)) {
      return false
    }

    entry.shown = true
    entry.shownAt = now()

    if (entry.ackTimer) {
      clearTimer(entry.ackTimer)
      entry.ackTimer = null
    }

    return true
  })

  deps.ipcMain.handle(NATIVE_DECISION_ANSWER, (event, raw) => {
    const answer = parseNativeDecisionAnswer(raw)
    const entry = answer ? pending.get(answer.id) : undefined

    if (!answer || !entry || !entry.shown || !fromAnsweringWindow(event, NATIVE_DECISION_ANSWER, entry)) {
      return false
    }

    if (answer.response < 0 || answer.response >= entry.ask.buttons.length) {
      return false
    }

    if (answer.response !== entry.ask.cancelId) {
      const lastInputAt = deps.lastTrustedInputAt(entry.contents)
      const afterShown = lastInputAt > entry.shownAt

      if (!afterShown || gestureOk({ payload: gestureOf(raw), lastInputAt, now: now() }) !== true) {
        deps.log(`[decision] refused a non-cancel answer to "${entry.ask.title}" without a click on its own button`)

        return false
      }
    }

    entry.settle(answer.response)

    return true
  })

  deps.ipcMain.handle(NATIVE_NOTICE_DRAIN, event => {
    const win = deps.window()

    // Only the main window's own renderer takes the queue (a pet overlay or a 3D window must not swallow it).
    if (!liveWindow(win) || event.sender !== win.webContents || !deps.isTrustedSender(event, NATIVE_NOTICE_DRAIN)) {
      return []
    }

    const taken = notices.splice(0, notices.length)

    for (const entry of taken) {
      if (entry.deadline) {
        clearTimer(entry.deadline)
      }
    }

    return taken.map(entry => entry.notice)
  })

  const ask = (options: DecisionOptions): Promise<{ response: number }> => {
    const win = deps.window()

    // A hidden window (HUD mode, closed to the Dock) would ask where nobody looks: the native box asks instead.
    if (!liveWindow(win) || !win.isVisible()) {
      return deps.showNativeBox(null, nativeOptions(options))
    }

    const id = newId()
    const contents = win.webContents

    // Asked from another of the app's windows (a session window in front): bring the answering window forward.
    if (!win.isFocused()) {
      win.focus()
    }

    const payload: NativeDecisionAsk = {
      buttons: options.buttons,
      cancelId: options.cancelId,
      defaultId: options.defaultId,
      detail: options.detail,
      id,
      title: options.title,
      tone: options.tone ?? 'default'
    }

    return new Promise(resolve => {
      let done = false

      const cleanup = () => {
        const entry = pending.get(id)

        if (entry?.ackTimer) {
          clearTimer(entry.ackTimer)
        }

        pending.delete(id)
        win.removeListener('closed', onGone)
        contents.removeListener('render-process-gone', onGone)
      }

      const settle = (response: number) => {
        if (done) {
          return
        }

        done = true
        cleanup()
        resolve({ response })
      }

      function onGone() {
        settle(options.cancelId)
      }

      const fallBackToNative = () => {
        if (done) {
          return
        }

        done = true
        cleanup()
        deps.log(`[decision] no window answered in ${ackMs} ms; asking natively: "${options.title}"`)
        deps.showNativeBox(liveWindow(win) ? win : null, nativeOptions(options)).then(resolve, () =>
          resolve({ response: options.cancelId })
        )
      }

      pending.set(id, {
        ask: payload,
        ackTimer: setTimer(fallBackToNative, ackMs),
        contents,
        settle,
        shown: false,
        shownAt: Number.POSITIVE_INFINITY
      })
      win.once('closed', onGone)
      contents.once('render-process-gone', onGone)

      try {
        contents.send(NATIVE_DECISION_ASK, payload)
      } catch {
        fallBackToNative()
      }
    })
  }

  const notice = (options: NoticeOptions) => {
    const entry: NativeNotice = {
      at: now(),
      detail: options.detail,
      historyOnly: options.historyOnly === true,
      id: newId(),
      kind: options.kind,
      message: options.message,
      nextStep: options.nextStep,
      title: options.title
    }

    const fallback = options.nativeFallback
    const slot: { notice: NativeNotice; deadline: Timer | null } = { deadline: null, notice: entry }

    if (fallback) {
      slot.deadline = setTimer(() => {
        const index = notices.indexOf(slot)

        if (index < 0) {
          return
        }

        notices.splice(index, 1)
        const text = [entry.message, entry.detail, entry.nextStep].filter(Boolean).join('\n\n')

        deps.log(`[notice] no window took "${entry.title}" in ${noticeDeadlineMs} ms; showing it natively`)

        if (fallback.kind === 'error-box') {
          deps.showErrorBox(entry.title, text)
        } else {
          const win = deps.window()

          void deps
            .showNativeBox(liveWindow(win) ? win : null, {
              buttons: ['OK'],
              detail: [entry.detail, entry.nextStep].filter(Boolean).join('\n\n'),
              message: entry.title === entry.message ? entry.title : `${entry.title}\n${entry.message}`,
              type: fallback.type
            })
            .catch(() => {})
        }
      }, noticeDeadlineMs)
    }

    notices.push(slot)

    const win = deps.window()

    if (liveWindow(win)) {
      try {
        win.webContents.send(NATIVE_NOTICE_READY)
      } catch {
        // The renderer drains on mount too; the deadline covers a renderer that never comes.
      }
    }
  }

  return { ask, notice }
}

// ── The process-wide instance: main.ts installs it once the app is ready; the modules that used to open a native box
// (main.ts quit prompt, setup-ipc restart prompt, updates.ts hand-off result) call these. Before install (or in a unit
// test of those modules) they behave exactly as the native box did.
let installed: RendererDialogs | null = null

export function installRendererDialogs(deps: RendererDialogsDeps): RendererDialogs {
  installed = createRendererDialogs(deps)

  return installed
}

/** Test-only. */
export function resetRendererDialogsForTest() {
  installed = null
}

export function askDecision(
  options: DecisionOptions,
  nativeBox: (options: MessageBoxOptions) => Promise<{ response: number }>
): Promise<{ response: number }> {
  return installed ? installed.ask(options) : nativeBox(nativeOptions(options))
}

export function postNotice(options: NoticeOptions, native: () => void): void {
  if (installed) {
    installed.notice(options)
  } else {
    native()
  }
}
