/**
 * v0.0.9 F4b — main's decisions asked in the window (spec F4 type 4) and main-only notices into the notification
 * centre (gate G-NATIVE). Each case fails on the old code, where these sites called `dialog.showMessageBox` /
 * `dialog.showErrorBox` directly and no renderer could ever see them. No Electron, no real HOME: every seam is a fake.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  NATIVE_DECISION_ANSWER,
  NATIVE_DECISION_ASK,
  NATIVE_DECISION_SHOWN,
  NATIVE_NOTICE_DRAIN,
  NATIVE_NOTICE_READY
} from '../../src/iclone-shared/native-decision'

import {
  askDecision,
  createRendererDialogs,
  type DecisionOptions,
  postNotice,
  type RendererDialogsDeps,
  resetRendererDialogsForTest
} from './renderer-dialogs'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function fakeContents() {
  const listeners = new Map<string, () => void>()
  const mainFrame = { name: 'main-frame' }

  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    listeners,
    mainFrame,
    once: vi.fn((name: string, fn: () => void) => void listeners.set(name, fn)),
    removeListener: vi.fn((name: string) => void listeners.delete(name)),
    send: vi.fn()
  }
}

function fakeWindow(visible = true) {
  const contents = fakeContents()
  const listeners = new Map<string, () => void>()

  return {
    contents,
    destroyed: false,
    focus: vi.fn(),
    isDestroyed() {
      return this.destroyed
    },
    isFocused: () => true,
    isVisible: () => visible,
    listeners,
    once: vi.fn((name: string, fn: () => void) => void listeners.set(name, fn)),
    removeListener: vi.fn((name: string) => void listeners.delete(name)),
    webContents: contents
  }
}

type FakeWindow = ReturnType<typeof fakeWindow>

function setup(win: FakeWindow | null, overrides: Partial<RendererDialogsDeps> = {}) {
  const handlers = new Map<string, Handler>()
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
  let clock = 1_000_000
  let lastInput = 0

  const deps: RendererDialogsDeps = {
    clearTimer: timer => {
      const entry = timers[timer as unknown as number]

      if (entry) {
        entry.cleared = true
      }
    },
    ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener as Handler) },
    isTrustedSender: () => true,
    lastTrustedInputAt: () => lastInput,
    log: () => {},
    newId: (() => {
      let n = 0

      return () => `id-${(n += 1)}`
    })(),
    now: () => clock,
    setTimer: (fn, ms) => {
      timers.push({ cleared: false, fn, ms })

      return (timers.length - 1) as unknown as ReturnType<typeof setTimeout>
    },
    showErrorBox: vi.fn(),
    showNativeBox: vi.fn(async () => ({ response: 0 })),
    window: () => win as never,
    ...overrides
  }

  const dialogs = createRendererDialogs(deps)

  const call = (channel: string, sender: unknown, frame: unknown, ...args: unknown[]) =>
    handlers.get(channel)!({ sender, senderFrame: frame }, ...args)

  const from = (w: FakeWindow) => ({
    answer: (body: unknown) => call(NATIVE_DECISION_ANSWER, w.webContents, w.webContents.mainFrame, body),
    drain: () => call(NATIVE_NOTICE_DRAIN, w.webContents, w.webContents.mainFrame),
    shown: (id: string) => call(NATIVE_DECISION_SHOWN, w.webContents, w.webContents.mainFrame, id)
  })

  const runDueTimers = (ms: number) => {
    for (const t of timers) {
      if (!t.cleared && t.ms <= ms) {
        t.cleared = true
        t.fn()
      }
    }
  }

  return {
    deps,
    dialogs,
    from,
    handlers,
    runDueTimers,
    setInput: (at: number) => (lastInput = at),
    tick: (ms: number) => (clock += ms),
    get clock() {
      return clock
    }
  }
}

const QUIT: DecisionOptions = {
  buttons: ['Keep Running', 'Quit Anyway'],
  cancelId: 0,
  defaultId: 0,
  detail: 'Your agent is still working on 2 sessions. Quitting stops them.',
  title: 'Quit while work is running?',
  tone: 'warning'
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => resetRendererDialogsForTest())

describe('F4b · a decision is asked in the window when one can answer', () => {
  it('no window → the native box, nothing sent', async () => {
    const t = setup(null)

    await expect(t.dialogs.ask(QUIT)).resolves.toEqual({ response: 0 })
    expect(t.deps.showNativeBox).toHaveBeenCalledWith(null, expect.objectContaining({ message: QUIT.title }))
  })

  it('a hidden window → the native box (nobody would see the in-app dialog)', async () => {
    const win = fakeWindow(false)
    const t = setup(win)

    await t.dialogs.ask(QUIT)

    expect(t.deps.showNativeBox).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('a live window gets the ask; the safe answer needs no gesture; no native box', async () => {
    const win = fakeWindow()
    const t = setup(win)
    const pending = t.dialogs.ask(QUIT)

    expect(win.webContents.send).toHaveBeenCalledWith(
      NATIVE_DECISION_ASK,
      expect.objectContaining({ buttons: QUIT.buttons, cancelId: 0, detail: QUIT.detail, id: 'id-1', title: QUIT.title })
    )
    expect(t.from(win).shown('id-1')).toBe(true)
    expect(t.from(win).answer({ activation: false, id: 'id-1', response: 0 })).toBe(true)
    await expect(pending).resolves.toEqual({ response: 0 })
    expect(t.deps.showNativeBox).not.toHaveBeenCalled()
  })

  it("a non-cancel answer needs the click on the dialog's own button after it was shown; refused answers keep it waiting", async () => {
    const win = fakeWindow()
    const t = setup(win)
    const pending = t.dialogs.ask(QUIT)
    let settled = false
    const click = { activation: true, confirm: true }

    void pending.then(() => (settled = true))

    // The keypress that raised the ask (Cmd+Q) is real, recent input, and the page still holds activation.
    t.setInput(t.clock - 100)
    t.tick(200)
    t.from(win).shown('id-1')

    // Lead decision 2 (security M2): activation alone, with real input that predates "shown", answers nothing. Red on
    // the old code, which took activation + input within 5 s.
    expect(t.from(win).answer({ activation: true, id: 'id-1', response: 1 })).toBe(false)
    expect(t.from(win).answer({ gesture: click, id: 'id-1', response: 1 })).toBe(false)

    // Input after "shown" but no trusted click on a marked button (a script holding activation).
    t.tick(100)
    t.setInput(t.clock)
    expect(t.from(win).answer({ activation: true, id: 'id-1', response: 1 })).toBe(false)
    expect(t.from(win).answer({ gesture: { activation: true, confirm: false }, id: 'id-1', response: 1 })).toBe(false)
    expect(t.from(win).answer({ gesture: { activation: false, confirm: true }, id: 'id-1', response: 1 })).toBe(false)

    // The click proof, but the real input is older than the gesture window (1.5 s).
    t.tick(2_000)
    expect(t.from(win).answer({ gesture: click, id: 'id-1', response: 1 })).toBe(false)
    await flush()
    expect(settled).toBe(false)

    // A real click on "Quit Anyway" after it was shown.
    t.setInput(t.clock - 200)
    expect(t.from(win).answer({ gesture: click, id: 'id-1', response: 1 })).toBe(true)
    await expect(pending).resolves.toEqual({ response: 1 })
  })

  it('the safe answer (Esc / close / Keep Running) never needs a click proof', async () => {
    const win = fakeWindow()
    const t = setup(win)
    const pending = t.dialogs.ask(QUIT)

    t.from(win).shown('id-1')
    expect(t.from(win).answer({ id: 'id-1', response: 0 })).toBe(true)
    await expect(pending).resolves.toEqual({ response: 0 })
  })

  it('refuses an answer from another window, another frame, before "shown", out of range, or malformed', async () => {
    const win = fakeWindow()
    const other = fakeWindow()
    const t = setup(win)

    void t.dialogs.ask(QUIT)

    expect(t.from(win).answer({ activation: false, id: 'id-1', response: 0 })).toBe(false) // not shown yet
    expect(t.from(other).shown('id-1')).toBe(false) // another window cannot claim it
    expect(t.from(win).shown('id-1')).toBe(true)
    expect(t.from(other).answer({ activation: false, id: 'id-1', response: 0 })).toBe(false)
    expect(
      t.handlers.get(NATIVE_DECISION_ANSWER)!(
        { sender: win.webContents, senderFrame: { name: 'iframe' } },
        { activation: false, id: 'id-1', response: 0 }
      )
    ).toBe(false)
    t.tick(10)
    t.setInput(t.clock)
    expect(t.from(win).answer({ gesture: { activation: true, confirm: true }, id: 'id-1', response: 2 })).toBe(false)
    expect(t.from(win).answer({ gesture: { activation: true, confirm: true }, id: 'id-1', response: 0.5 })).toBe(false)
    expect(t.from(win).answer('id-1')).toBe(false)
    expect(t.from(win).answer({ activation: false, id: 'id-1', response: 0 })).toBe(true)
  })

  it('a refused sender guard refuses everything', () => {
    const win = fakeWindow()
    const t = setup(win, { isTrustedSender: () => false })

    void t.dialogs.ask(QUIT)

    expect(t.from(win).shown('id-1')).toBe(false)
  })

  it('no "shown" within the ack window → the native box answers; a late "shown" is refused (never doubled)', async () => {
    const win = fakeWindow()
    const t = setup(win, { showNativeBox: vi.fn(async () => ({ response: 1 })) })
    const pending = t.dialogs.ask(QUIT)

    t.runDueTimers(1_500)

    await expect(pending).resolves.toEqual({ response: 1 })
    expect(t.deps.showNativeBox).toHaveBeenCalledWith(win, expect.objectContaining({ buttons: QUIT.buttons, cancelId: 0 }))
    expect(t.from(win).shown('id-1')).toBe(false)
  })

  it('the window closing while it asks → the safe answer', async () => {
    const win = fakeWindow()
    const t = setup(win)
    const pending = t.dialogs.ask(QUIT)

    t.from(win).shown('id-1')
    win.listeners.get('closed')?.()

    await expect(pending).resolves.toEqual({ response: 0 })
  })

  it('the renderer going away while it asks → the safe answer', async () => {
    const win = fakeWindow()
    const t = setup(win)
    const pending = t.dialogs.ask({ ...QUIT, cancelId: 1, defaultId: 0 })

    t.from(win).shown('id-1')
    win.webContents.listeners.get('render-process-gone')?.()

    await expect(pending).resolves.toEqual({ response: 1 })
  })
})

describe('F4b · notices main cannot show go to the notification centre', () => {
  it('queues, pings the window, and hands the queue once to the main window only', () => {
    const win = fakeWindow()
    const pet = fakeWindow()
    const t = setup(win)

    t.dialogs.notice({ kind: 'error', message: 'exit 1: swap failed', title: 'The update did not finish' })

    expect(win.webContents.send).toHaveBeenCalledWith(NATIVE_NOTICE_READY)
    expect(t.from(pet).drain()).toEqual([])

    const drained = t.from(win).drain() as { kind: string; message: string; title: string }[]

    expect(drained).toHaveLength(1)
    expect(drained[0]).toMatchObject({ kind: 'error', message: 'exit 1: swap failed', title: 'The update did not finish' })
    expect(t.from(win).drain()).toEqual([])
  })

  it('an error notice no window drained in time falls back to the error box, whole', () => {
    const t = setup(null)

    t.dialogs.notice({
      detail: 'Details: /tmp/handoff.log',
      kind: 'error',
      message: 'exit 1: swap failed',
      nativeFallback: { kind: 'error-box' },
      nextStep: 'Try again from Settings › Updates.',
      title: 'The update did not finish'
    })

    t.runDueTimers(20_000)

    expect(t.deps.showErrorBox).toHaveBeenCalledWith(
      'The update did not finish',
      'exit 1: swap failed\n\nDetails: /tmp/handoff.log\n\nTry again from Settings › Updates.'
    )
  })

  it('a drained notice never shows natively', () => {
    const win = fakeWindow()
    const t = setup(win)

    t.dialogs.notice({ kind: 'error', message: 'm', nativeFallback: { kind: 'error-box' }, title: 't' })
    t.from(win).drain()
    t.runDueTimers(20_000)

    expect(t.deps.showErrorBox).not.toHaveBeenCalled()
  })
})

describe('F4b · before install the old native behaviour is kept', () => {
  it('askDecision uses the native box with the same buttons and safe answer', async () => {
    const native = vi.fn(async () => ({ response: 0 }))

    await askDecision(QUIT, native)

    expect(native).toHaveBeenCalledWith(
      expect.objectContaining({ buttons: QUIT.buttons, cancelId: 0, defaultId: 0, message: QUIT.title })
    )
  })

  it('postNotice runs the native fallback', () => {
    const native = vi.fn()

    postNotice({ kind: 'error', message: 'm', title: 't' }, native)

    expect(native).toHaveBeenCalledTimes(1)
  })
})

describe('F4b · the sites moved off the native box (static)', () => {
  const read = (relative: string) => readFileSync(path.join(__dirname, relative), 'utf8')

  it('the quit prompt and the Screen-recording restart ask through askDecision', () => {
    expect(read('../main.ts')).toMatch(/askDecision\(\s*\{\s*buttons: \['Keep Running', 'Quit Anyway'\]/)
    expect(read('./setup-ipc.ts')).toMatch(/await askDecision\(\s*\{\s*title: 'Restart to use Screen recording'/)
  })

  it('the detached update result goes through postNotice; no bare "Hermes update" error box is left', () => {
    const updates = read('./updates.ts')

    expect(updates).not.toContain("showErrorBox('Hermes update did not finish'")
    expect(updates.match(/postNotice\(/g)).toHaveLength(2)
  })

  it('main installs the bridge, and the preload speaks the same channels', () => {
    expect(read('../main.ts')).toContain('installRendererDialogs({')

    const preload = read('../preload.ts')

    for (const channel of [
      NATIVE_DECISION_ASK,
      NATIVE_DECISION_SHOWN,
      NATIVE_DECISION_ANSWER,
      NATIVE_NOTICE_READY,
      NATIVE_NOTICE_DRAIN
    ]) {
      expect(preload).toContain(`'${channel}'`)
    }
  })

  it('main-only OS banners (app update, setup) are mirrored into the centre as history-only notices (gate N9)', () => {
    expect(read('../main.ts')).toMatch(/postNotice\(\s*\{ historyOnly: true, kind: 'info', message: options\.body/)
    expect(read('./setup-ipc.ts')).toMatch(/notification\.show\(\)\s*\n\s*\/\/[^\n]*\n\s*postNotice\(\{ historyOnly: true/)
  })

  it('the F-17 consents stay native (no renderer may answer them)', () => {
    expect(read('../iclone-permissions/ignore-dialog.ts')).not.toContain('askDecision')
    expect(read('../iclone-confinement/isolation-switch.ts')).not.toContain('askDecision')
  })
})
