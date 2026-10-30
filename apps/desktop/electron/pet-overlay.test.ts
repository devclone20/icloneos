import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, ipcMain: { handle: vi.fn(), on: vi.fn() }, screen: {} }))
vi.mock('./main/env', () => ({ DEV_SERVER: undefined, IS_MAC: true, PRELOAD_PATH: '/preload.js' }))
vi.mock('./main/log', () => ({ rememberLog: vi.fn() }))
vi.mock('./main/runtime', () => ({ resolveRendererIndex: () => '/app/index.html' }))
vi.mock('./main/shell-open', () => ({ loadWindowUrl: vi.fn() }))
vi.mock('./main/windows', () => ({ wireCommonWindowHandlers: vi.fn(), wireWindowReveal: vi.fn() }))
vi.mock('./window-renderer-lifecycle', () => ({ installWindowRendererLifecycle: vi.fn() }))

const {
  installPetOverlay,
  onSomeDisplay,
  PET_OVERLAY_CHANNELS: CH,
  popOutScreenBounds,
  sanitizeBounds
} = await import('./pet-overlay')

const { PET_PROMPT_MAX_CHARS } = await import('../src/iclone-shared/pet-prompt')

const PRIMARY = { height: 875, width: 1440, x: 0, y: 25 }
const SECOND = { height: 1080, width: 1920, x: 1440, y: 0 }

function harness(
  guard: (event: unknown, channel: string) => unknown = () => true,
  displays: { workArea: typeof PRIMARY }[] = [{ workArea: PRIMARY }]
) {
  const handles = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ons = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  const mainListeners = new Map<string, ((details?: unknown) => void)[]>()

  const mainContents = {
    on: vi.fn((event: string, listener: (details?: unknown) => void) => {
      mainListeners.set(event, [...(mainListeners.get(event) ?? []), listener])
    }),
    send: vi.fn()
  }

  const main = {
    focus: vi.fn(),
    getContentBounds: () => ({ height: 800, width: 1200, x: 100, y: 50 }),
    isDestroyed: () => false,
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    minimize: vi.fn(),
    restore: vi.fn(),
    show: vi.fn(),
    webContents: mainContents
  }

  let onClosed: () => void = () => {}
  const overlayContents = { send: vi.fn() }
  let destroyed = false

  const overlay = {
    close: vi.fn(() => {
      destroyed = true
    }),
    getSize: () => [160, 141],
    isDestroyed: () => destroyed,
    isResizable: () => false,
    focus: vi.fn(),
    setBounds: vi.fn(),
    setFocusable: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    setResizable: vi.fn(),
    showInactive: vi.fn(),
    webContents: overlayContents
  }

  const spawn = vi.fn((_bounds: unknown, closed: () => void) => {
    onClosed = closed

    return overlay
  })

  const api = installPetOverlay({
    getMainWindow: () => main,
    ipcMain: {
      handle: (channel, fn) => void handles.set(channel, fn),
      on: (channel, fn) => void ons.set(channel, fn)
    },
    isTrustedSender: guard as never,
    log: vi.fn(),
    screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0]! },
    spawnWindow: spawn
  })

  const fromMain = { sender: mainContents }
  const fromOverlay = { sender: overlayContents }

  return {
    api,
    closedByUser: () => onClosed(),
    /** Fire a WebContents event on the main window's renderer (its page reloading, crashing, going away). */
    emitMain: (event: string, details?: unknown) => (mainListeners.get(event) ?? []).forEach(fn => fn(details)),
    fromMain,
    fromOverlay,
    handle: (channel: string, event: unknown, ...args: unknown[]) => handles.get(channel)!(event, ...args),
    main,
    on: (channel: string, event: unknown, ...args: unknown[]) => ons.get(channel)!(event, ...args),
    overlay,
    spawn
  }
}

const BOUNDS = { height: 141, width: 160, x: 10, y: 20 }

describe('the pet overlay IPC (gate P7)', () => {
  let h: ReturnType<typeof harness>

  beforeEach(() => {
    h = harness()
  })

  it("opens at the pet's spot (viewport + content origin) or a remembered screen spot", async () => {
    expect(await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })).toEqual({
      bounds: { ...BOUNDS, x: 110, y: 70 },
      ok: true
    })
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(await h.handle(CH.open, h.fromMain, { bounds: BOUNDS, screen: true })).toEqual({ bounds: BOUNDS, ok: true })
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(h.overlay.setBounds).toHaveBeenLastCalledWith(BOUNDS)
    expect(await h.handle(CH.open, h.fromMain, { bounds: { ...BOUNDS, x: Number.NaN } })).toEqual({ ok: false })
  })

  it('mirrors the state to the overlay only; control comes back to the main window', async () => {
    await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })
    h.on(CH.state, h.fromMain, { petId: 'n2' })
    expect(h.overlay.webContents.send).toHaveBeenCalledWith(CH.state, { petId: 'n2' })
    expect(h.main.webContents.send).not.toHaveBeenCalled()

    h.on(CH.control, h.fromOverlay, { type: 'pop-in' })
    expect(h.main.webContents.send).toHaveBeenCalledWith(CH.control, { type: 'pop-in' })
    h.on(CH.control, h.fromOverlay, { type: 'run-shell' })
    h.on(CH.control, h.fromOverlay, null)
    expect(h.main.webContents.send).toHaveBeenCalledTimes(1)

    h.on(CH.control, h.fromOverlay, { type: 'open-app' })
    expect(h.main.focus).toHaveBeenCalled()
    h.on(CH.control, h.fromOverlay, { type: 'toggle-app' })
    expect(h.main.minimize).toHaveBeenCalled()

    h.on(CH.setBounds, h.fromOverlay, { height: 300, width: 200, x: 5, y: 6 })
    expect(h.overlay.setResizable).toHaveBeenCalledWith(true)
    expect(h.overlay.setBounds).toHaveBeenLastCalledWith({ height: 300, width: 200, x: 5, y: 6 })
    h.on(CH.ignoreMouse, h.fromOverlay, 'yes')
    expect(h.overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })
  })

  it("refuses every channel without the guard's exact true: false, undefined, a truthy non-true, a throw", async () => {
    for (const guard of [
      () => false,
      () => undefined,
      () => 1,
      () => 'true',
      () => {
        throw new Error('x')
      }
    ]) {
      const r = harness(guard)
      expect(await r.handle(CH.open, r.fromMain, { bounds: BOUNDS })).toBeNull()
      expect(await r.handle(CH.close, r.fromMain)).toBeNull()
      r.on(CH.state, r.fromMain, { petId: 'n2' })
      r.on(CH.control, r.fromOverlay, { type: 'toggle-app' })
      r.on(CH.setBounds, r.fromOverlay, BOUNDS)
      r.on(CH.ignoreMouse, r.fromOverlay, true)
      expect(r.spawn).not.toHaveBeenCalled()
      expect(r.main.minimize).not.toHaveBeenCalled()
      expect(r.main.webContents.send).not.toHaveBeenCalled()
    }
  })

  it("refuses a trusted sender on the other side's channels (each renderer its own role)", async () => {
    expect(await h.handle(CH.open, h.fromOverlay, { bounds: BOUNDS })).toBeNull()
    expect(await h.handle(CH.open, { sender: {} }, { bounds: BOUNDS })).toBeNull()
    await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })
    h.on(CH.state, h.fromOverlay, { petId: 'x' })
    expect(h.overlay.webContents.send).not.toHaveBeenCalled()
    h.on(CH.control, h.fromMain, { type: 'toggle-app' })
    expect(h.main.minimize).not.toHaveBeenCalled()
    h.on(CH.setBounds, h.fromMain, BOUNDS)
    expect(h.overlay.setBounds).not.toHaveBeenCalled()
    expect(await h.handle(CH.close, h.fromOverlay)).toBeNull()
    expect(h.overlay.close).not.toHaveBeenCalled()
  })

  it('closes on request and at quit; closed on its own, it tells the main window to pop the pet back in', async () => {
    await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })
    h.closedByUser()
    expect(h.main.webContents.send).toHaveBeenCalledWith(CH.control, { type: 'pop-in' })
    await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })
    expect(await h.handle(CH.close, h.fromMain)).toEqual({ ok: true })
    expect(h.overlay.close).toHaveBeenCalledTimes(1)
    h.api.close()
    expect(h.overlay.close).toHaveBeenCalledTimes(1)
  })

  it('sanitizes bounds: four finite numbers, sizes held to 80–1600, rounded', () => {
    expect(sanitizeBounds({ height: 9999, width: 1, x: 1.4, y: -2.6 })).toEqual({
      height: 1600,
      width: 80,
      x: 1,
      y: -3
    })
    expect(sanitizeBounds({ height: 1, width: 1, x: 0 })).toBeNull()
    expect(sanitizeBounds('{}')).toBeNull()
  })
})

describe('R4-F1: the first pop-out lands where the pet stood, at any UI zoom (gate P7)', () => {
  // The in-window pet: 43 × 69 CSS px at viewport (1000, 600); the overlay window 208 × 141, the pet's feet 12 px above
  // its bottom edge, centred — exactly what popOutPet asks for.
  const PET = { height: 69, width: 43, x: 1000, y: 600 }
  const anchor = { x: PET.x + PET.width / 2, y: PET.y + PET.height }
  const request = { anchor, bounds: { height: 141, width: 208, x: anchor.x - 104, y: anchor.y + 12 - 141 } }
  const CONTENT = { height: 800, width: 1200, x: 100, y: 50 }

  it.each([0.9, 1, 1.1])(
    "zoom %s: the overlay pet's feet are on the screen point where the pet's feet were (±1 px)",
    async zoom => {
      const h = harness()

      ;(h.main.webContents as unknown as { getZoomFactor: () => number }).getZoomFactor = () => zoom
      const res = (await h.handle(CH.open, h.fromMain, request)) as { bounds: typeof CONTENT; ok: boolean }
      expect(res.ok).toBe(true)

      // Where the feet were on screen: the main window's content origin + viewport CSS px × its zoom.
      const was = { x: CONTENT.x + anchor.x * zoom, y: CONTENT.y + anchor.y * zoom }
      // Where the overlay (zoom 1) draws them: its window, centred, 12 px up from the bottom.
      const now = { x: res.bounds.x + res.bounds.width / 2, y: res.bounds.y + res.bounds.height - 12 }
      expect(Math.abs(now.x - was.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(now.y - was.y)).toBeLessThanOrEqual(1)
      expect(h.spawn.mock.calls[0]![0]).toEqual(res.bounds)
    }
  )

  it('no anchor: the window bottom-centre is converted; no or odd zoom: 1; a remembered spot is not converted', () => {
    const b = { height: 141, width: 208, x: 10, y: 20 }
    expect(popOutScreenBounds(b, null, CONTENT, 2)).toEqual({ ...b, x: 100 + 114 * 2 - 104, y: 50 + 161 * 2 - 141 })

    for (const zoom of [undefined, 0, -1, Number.NaN, '0.9']) {
      expect(popOutScreenBounds(b, null, CONTENT, zoom)).toEqual({ ...b, x: 110, y: 70 })
    }
  })

  it('a remembered (screen) spot ignores the zoom; an odd anchor falls back to the bottom-centre', async () => {
    const h = harness()

    ;(h.main.webContents as unknown as { getZoomFactor: () => number }).getZoomFactor = () => 0.9
    expect(await h.handle(CH.open, h.fromMain, { bounds: BOUNDS, screen: true })).toEqual({ bounds: BOUNDS, ok: true })

    const r = harness()

    ;(r.main.webContents as unknown as { getZoomFactor: () => number }).getZoomFactor = () => 1
    expect(await r.handle(CH.open, r.fromMain, { anchor: { x: 'x', y: 1 }, bounds: BOUNDS })).toEqual({
      bounds: { ...BOUNDS, x: 110, y: 70 },
      ok: true
    })
  })
})

describe('the pop-out never opens where nobody can see it (m10)', () => {
  it('a remembered spot off every connected display: no window; the answer is a reset spot on the primary display', async () => {
    const h = harness()
    const gone = { height: 141, width: 160, x: 2600, y: 300 } // the second display was unplugged

    const res = (await h.handle(CH.open, h.fromMain, { bounds: gone, screen: true })) as {
      ok: boolean
      bounds: typeof gone
      reason: string
    }

    expect(res.ok).toBe(false)
    expect(res.reason).toBe('off-screen')
    expect(h.spawn).not.toHaveBeenCalled()
    expect(res.bounds).toEqual({ height: 141, width: 160, x: 1440 - 160, y: 300 })
    expect(onSomeDisplay(res.bounds, [{ workArea: PRIMARY }])).toBe(true)

    // Far up and left of everything: clamped into the primary work area too.
    const far = (await h.handle(CH.open, h.fromMain, { bounds: { ...gone, x: -9000, y: -9000 }, screen: true })) as {
      bounds: typeof gone
    }

    expect(far.bounds).toEqual({ height: 141, width: 160, x: 0, y: 25 })
  })

  it('a spot on a second display that is connected opens there; a sliver on screen is not enough', async () => {
    const h = harness(() => true, [{ workArea: PRIMARY }, { workArea: SECOND }])
    const there = { height: 141, width: 160, x: 2600, y: 300 }
    expect(await h.handle(CH.open, h.fromMain, { bounds: there, screen: true })).toEqual({ bounds: there, ok: true })
    expect(h.spawn).toHaveBeenCalledTimes(1)

    expect(onSomeDisplay({ height: 141, width: 160, x: 1440 + 1920 - 20, y: 300 }, [{ workArea: SECOND }])).toBe(false)
    expect(onSomeDisplay({ height: 141, width: 160, x: 1440 + 1920 - 40, y: 300 }, [{ workArea: SECOND }])).toBe(true)
  })

  it('the window failing to open answers ok:false (the renderer keeps the pet in the window)', async () => {
    const h = harness()
    h.spawn.mockImplementationOnce(() => {
      throw new Error('no GPU')
    })
    expect(await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })).toEqual({ ok: false, reason: 'failed' })
    // Nothing half-open is left: the next open spawns afresh.
    expect((await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })) as { ok: boolean }).toMatchObject({ ok: true })
    expect(h.spawn).toHaveBeenCalledTimes(2)
  })
})

describe("the pop-out's prompt box through main (gate P7)", () => {
  it('a typed message reaches the main window as a checked, rebuilt submit — trimmed; blank, over-cap or odd: refused', async () => {
    const h = harness()
    await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })

    h.on(CH.control, h.fromOverlay, { extra: 'dropped', id: 7, text: '  ship it  ', type: 'submit' })
    expect(h.main.webContents.send).toHaveBeenLastCalledWith(CH.control, { id: 7, text: 'ship it', type: 'submit' })
    // Sending a message does not yank the app forward.
    expect(h.main.focus).not.toHaveBeenCalled()

    for (const text of ['', '   \n\t ', 'x'.repeat(PET_PROMPT_MAX_CHARS + 1), 42, null, undefined, ['hi']]) {
      h.on(CH.control, h.fromOverlay, { id: 1, text, type: 'submit' })
    }

    // Without a usable id (the overlay could never match the answer): refused too.
    for (const id of [undefined, -1, 1.5, '3', Number.NaN, 2 ** 53]) {
      h.on(CH.control, h.fromOverlay, { id, text: 'hi', type: 'submit' })
    }

    expect(h.main.webContents.send).toHaveBeenCalledTimes(1)
    h.on(CH.control, h.fromOverlay, { id: 0, text: 'y'.repeat(PET_PROMPT_MAX_CHARS), type: 'submit' })
    expect(h.main.webContents.send).toHaveBeenCalledTimes(2)
  })

  it("only the overlay's own renderer, and only the guard's exact true, may submit or ask for the keyboard", async () => {
    const h = harness()
    await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })
    h.on(CH.control, h.fromMain, { id: 1, text: 'hi', type: 'submit' })
    h.on(CH.control, { sender: {} }, { id: 1, text: 'hi', type: 'submit' })
    h.on(CH.focusable, h.fromMain, true)
    expect(h.main.webContents.send).not.toHaveBeenCalled()
    expect(h.overlay.setFocusable).not.toHaveBeenCalled()

    for (const answer of [false, 'true', 1, undefined]) {
      // The window opens (its own channel trusted); the guard then answers anything but exactly true.
      const r = harness((_event, channel) => (channel === CH.open ? true : answer))
      await r.handle(CH.open, r.fromMain, { bounds: BOUNDS })
      expect(r.spawn).toHaveBeenCalledTimes(1)
      r.on(CH.control, r.fromOverlay, { id: 1, text: 'hi', type: 'submit' })
      r.on(CH.focusable, r.fromOverlay, true)
      expect(r.main.webContents.send).not.toHaveBeenCalled()
      expect(r.overlay.setFocusable).not.toHaveBeenCalled()
    }

    h.on(CH.focusable, h.fromOverlay, true)
    expect(h.overlay.setFocusable).toHaveBeenLastCalledWith(true)
    expect(h.overlay.focus).toHaveBeenCalledTimes(1)
    h.on(CH.focusable, h.fromOverlay, 'yes')
    expect(h.overlay.setFocusable).toHaveBeenLastCalledWith(false)
    expect(h.overlay.focus).toHaveBeenCalledTimes(1)
  })
})

describe('what became of a prompt-box message, back to the overlay (R3-S, gate P7)', () => {
  it("the main renderer's answer reaches the overlay rebuilt — sent, queued, refused with a known reason; nothing else", async () => {
    const h = harness()
    await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })

    h.on(CH.promptResult, h.fromMain, { extra: 'dropped', id: 3, outcome: 'sent' })
    expect(h.overlay.webContents.send).toHaveBeenLastCalledWith(CH.promptResult, { id: 3, outcome: 'sent' })
    h.on(CH.promptResult, h.fromMain, { id: 4, outcome: 'queued', reason: 'command' })
    expect(h.overlay.webContents.send).toHaveBeenLastCalledWith(CH.promptResult, { id: 4, outcome: 'queued' })

    for (const reason of ['command', 'no-session', 'not-sent'] as const) {
      h.on(CH.promptResult, h.fromMain, { id: 5, outcome: 'refused', reason })
      expect(h.overlay.webContents.send).toHaveBeenLastCalledWith(CH.promptResult, {
        id: 5,
        outcome: 'refused',
        reason
      })
    }

    const before = h.overlay.webContents.send.mock.calls.length

    for (const odd of [
      null,
      'sent',
      { id: 6 },
      { id: 6, outcome: 'refused' },
      { id: 6, outcome: 'refused', reason: '<img onerror=x>' },
      { id: 6, outcome: 'done' },
      { id: 6, outcome: 'unknown' },
      { id: -1, outcome: 'sent' },
      { id: '6', outcome: 'sent' }
    ]) {
      h.on(CH.promptResult, h.fromMain, odd)
    }

    expect(h.overlay.webContents.send).toHaveBeenCalledTimes(before)
  })

  it("only the main window's renderer, and only the guard's exact true, may answer", async () => {
    const h = harness()
    await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })
    h.on(CH.promptResult, h.fromOverlay, { id: 1, outcome: 'sent' })
    h.on(CH.promptResult, { sender: {} }, { id: 1, outcome: 'sent' })
    expect(h.overlay.webContents.send).not.toHaveBeenCalled()

    for (const answer of [false, 'true', 1, undefined]) {
      const r = harness((_event, channel) => (channel === CH.open ? true : answer))
      await r.handle(CH.open, r.fromMain, { bounds: BOUNDS })
      r.on(CH.promptResult, r.fromMain, { id: 1, outcome: 'sent' })
      expect(r.overlay.webContents.send).not.toHaveBeenCalled()
    }

    // No overlay open: nowhere to go, nothing sent.
    const closed = harness()
    closed.on(CH.promptResult, closed.fromMain, { id: 1, outcome: 'sent' })
    expect(closed.overlay.webContents.send).not.toHaveBeenCalled()
  })
})

describe('a submit the main renderer can no longer answer is answered not-sent (R3b n-A, gate P7)', () => {
  const answers = (h: ReturnType<typeof harness>) =>
    h.overlay.webContents.send.mock.calls.filter(([channel]) => channel === CH.promptResult).map(([, result]) => result)

  const forwarded = (h: ReturnType<typeof harness>) =>
    h.main.webContents.send.mock.calls.filter(([, p]) => (p as { type?: string }).type === 'submit')

  it('the main window is closed (macOS keeps the app and the pet): answered at once, nothing forwarded', async () => {
    const h = harness()
    await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })
    h.main.isDestroyed = () => true

    h.on(CH.control, h.fromOverlay, { id: 1, text: 'hello', type: 'submit' })
    expect(forwarded(h)).toHaveLength(0)
    expect(answers(h)).toEqual([{ id: 1, outcome: 'refused', reason: 'not-sent' }])

    // A bad submit is still refused outright (no answer to an id that is not one); other controls stay dropped.
    h.on(CH.control, h.fromOverlay, { id: 2, text: '   ', type: 'submit' })
    h.on(CH.control, h.fromOverlay, { id: -1, text: 'x', type: 'submit' })
    h.on(CH.control, h.fromOverlay, { type: 'toggle-app' })
    expect(answers(h)).toHaveLength(1)
    expect(h.main.show).not.toHaveBeenCalled()
    expect(h.main.minimize).not.toHaveBeenCalled()
  })

  it('the main window goes away after taking the submit: every unanswered one is answered not-sent', async () => {
    const h = harness()
    await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })
    h.on(CH.control, h.fromOverlay, { id: 1, text: 'one', type: 'submit' })
    h.on(CH.control, h.fromOverlay, { id: 2, text: 'two', type: 'submit' })
    expect(forwarded(h)).toHaveLength(2)
    // Its renderer is watched once, however many submits it takes.
    expect(h.main.webContents.on.mock.calls.map(([event]) => event).sort()).toEqual([
      'destroyed',
      'did-start-navigation',
      'render-process-gone'
    ])

    // id 1 was answered in time: only id 2 is still owed.
    h.on(CH.promptResult, h.fromMain, { id: 1, outcome: 'sent' })
    h.emitMain('destroyed')
    expect(answers(h)).toEqual([
      { id: 1, outcome: 'sent' },
      { id: 2, outcome: 'refused', reason: 'not-sent' }
    ])

    // Owed once: a second event answers nothing more.
    h.emitMain('destroyed')
    expect(answers(h)).toHaveLength(2)
  })

  it('the main renderer reloads (or crashes) mid-send: answered not-sent; a route change is not a reload', async () => {
    const h = harness()
    await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })
    h.on(CH.control, h.fromOverlay, { id: 3, text: 'mid-send', type: 'submit' })

    h.emitMain('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    h.emitMain('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    h.emitMain('did-start-navigation', undefined)
    expect(answers(h)).toHaveLength(0)

    h.emitMain('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(answers(h)).toEqual([{ id: 3, outcome: 'refused', reason: 'not-sent' }])

    h.on(CH.control, h.fromOverlay, { id: 4, text: 'again', type: 'submit' })
    h.emitMain('render-process-gone', { reason: 'crashed' })
    expect(answers(h)).toEqual([
      { id: 3, outcome: 'refused', reason: 'not-sent' },
      { id: 4, outcome: 'refused', reason: 'not-sent' }
    ])
  })

  it('R4-F2: lost AFTER the hand-off it is answered unknown (may have been sent), BEFORE it not-sent', async () => {
    const h = harness()
    await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })
    h.on(CH.control, h.fromOverlay, { id: 7, text: 'handed on', type: 'submit' })
    h.on(CH.control, h.fromOverlay, { id: 8, text: 'still here', type: 'submit' })

    // The main renderer marks id 7 handed on (it awaits this ack before the text leaves); id 8 never is.
    expect(await h.handle(CH.promptHandoff, h.fromMain, 7)).toBe(true)
    h.emitMain('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(answers(h)).toEqual([
      { id: 7, outcome: 'unknown' },
      { id: 8, outcome: 'refused', reason: 'not-sent' }
    ])

    // The same for a closed window and a crash.
    for (const event of ['destroyed', 'render-process-gone']) {
      const r = harness()
      await r.handle(CH.open, r.fromMain, { bounds: BOUNDS })
      r.on(CH.control, r.fromOverlay, { id: 1, text: 'one', type: 'submit' })
      expect(await r.handle(CH.promptHandoff, r.fromMain, 1)).toBe(true)
      r.emitMain(event, { reason: 'crashed' })
      expect(answers(r)).toEqual([{ id: 1, outcome: 'unknown' }])
    }
  })

  it('R4-F2: only the main renderer the submit went to may mark it handed on, and only an id still owed', async () => {
    const h = harness()
    await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })
    h.on(CH.control, h.fromOverlay, { id: 9, text: 'x', type: 'submit' })

    expect(await h.handle(CH.promptHandoff, h.fromOverlay, 9)).toBe(false)
    expect(await h.handle(CH.promptHandoff, { sender: {} }, 9)).toBe(false)
    expect(await h.handle(CH.promptHandoff, h.fromMain, 10)).toBe(false)
    expect(await h.handle(CH.promptHandoff, h.fromMain, '9')).toBe(false)
    expect(await harness(() => 'true').handle(CH.promptHandoff, h.fromMain, 9)).toBe(false)

    // Answered in time: nothing owed any more, so it cannot be marked; a loss answers nothing.
    h.on(CH.promptResult, h.fromMain, { id: 9, outcome: 'sent' })
    expect(await h.handle(CH.promptHandoff, h.fromMain, 9)).toBe(false)
    h.emitMain('destroyed')
    expect(answers(h)).toEqual([{ id: 9, outcome: 'sent' }])
  })

  it('R4b n1: a newer main renderer (the window re-created) cannot mark a submit that went to the old one', async () => {
    const h = harness()
    await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })
    h.on(CH.control, h.fromOverlay, { id: 11, text: 'to the old page', type: 'submit' })
    expect(forwarded(h)).toHaveLength(1)

    // The main window is now another one: its renderer passes the main-role check, but id 11 did not go to it.
    const oldContents = h.main.webContents
    const newer = { on: vi.fn(), send: vi.fn() }
    h.main.webContents = newer as never
    expect(await h.handle(CH.promptHandoff, { sender: newer }, 11)).toBe(false)

    // Not marked: the old renderer going away answers not-sent, never unknown.
    h.main.webContents = oldContents
    h.emitMain('destroyed')
    expect(answers(h)).toEqual([{ id: 11, outcome: 'refused', reason: 'not-sent' }])
  })

  it("a pet window closed and opened again does not inherit the old one's unanswered submits", async () => {
    const h = harness()
    await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })
    h.on(CH.control, h.fromOverlay, { id: 1, text: 'old', type: 'submit' })
    h.closedByUser()
    h.overlay.webContents.send.mockClear()
    await h.handle(CH.open, h.fromMain, { bounds: BOUNDS })
    h.emitMain('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(answers(h)).toHaveLength(0)
  })
})
