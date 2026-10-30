import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const frames = new Map<number, FrameRequestCallback>()
let lastFrame = 0

function runFrame() {
  const pending = [...frames.values()]

  frames.clear()
  pending.forEach(callback => callback(0))
}

async function loadAtlas() {
  vi.resetModules()

  return import('./atlas')
}

function fakeTerminal(log: string[], name: string) {
  return {
    clearTextureAtlas: vi.fn(() => {
      log.push(`clear:${name}`)
    }),
    refresh: vi.fn(() => {
      log.push(`refresh:${name}`)
    })
  }
}

// A WebglAddon's three shared-atlas events, fired by hand.
function fakeAddon() {
  const subscriptions = new Set<{ listener: () => void }>()

  const event = (listener: () => void) => {
    const subscription = { listener }

    subscriptions.add(subscription)

    return { dispose: () => subscriptions.delete(subscription) }
  }

  return {
    addon: { onAddTextureAtlasCanvas: event, onChangeTextureAtlas: event, onRemoveTextureAtlasCanvas: event },
    fire: () => [...subscriptions].forEach(subscription => subscription.listener()),
    subscriptions: () => subscriptions.size
  }
}

describe('terminal atlas coordinator', () => {
  beforeEach(() => {
    frames.clear()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      lastFrame += 1
      frames.set(lastFrame, callback)

      return lastFrame
    })
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(window, 'hermesDesktop')
    Reflect.deleteProperty(document, 'fonts')
  })

  it('rebuilds the WebGL atlas in two phases: clears every mounted terminal before any refresh', async () => {
    const { registerAtlasTerminal, requestAtlasRebuild } = await loadAtlas()
    const log: string[] = []

    registerAtlasTerminal(fakeTerminal(log, 'a'))
    registerAtlasTerminal(fakeTerminal(log, 'b'))
    registerAtlasTerminal(fakeTerminal(log, 'c'))
    requestAtlasRebuild()

    expect(log).toEqual([])
    runFrame()
    expect(log).toEqual(['clear:a', 'clear:b', 'clear:c', 'refresh:a', 'refresh:b', 'refresh:c'])
  })

  it('coalesces atlas rebuild requests into one pass per frame', async () => {
    const { registerAtlasTerminal, requestAtlasRebuild } = await loadAtlas()
    const a = fakeTerminal([], 'a')
    const b = fakeTerminal([], 'b')

    registerAtlasTerminal(a)
    registerAtlasTerminal(b)
    requestAtlasRebuild()
    requestAtlasRebuild()
    requestAtlasRebuild()

    expect(frames.size).toBe(1)
    runFrame()
    expect(a.clearTextureAtlas).toHaveBeenCalledOnce()
    expect(b.clearTextureAtlas).toHaveBeenCalledOnce()
    expect(b.refresh).toHaveBeenCalledOnce()

    requestAtlasRebuild()
    runFrame()
    expect(a.clearTextureAtlas).toHaveBeenCalledTimes(2)
  })

  it('skips the atlas rebuild with nothing mounted and cancels a pending one on the last unmount', async () => {
    const { registerAtlasTerminal, requestAtlasRebuild } = await loadAtlas()

    requestAtlasRebuild()
    expect(frames.size).toBe(0)

    const terminal = fakeTerminal([], 'a')
    const unregister = registerAtlasTerminal(terminal)

    requestAtlasRebuild()
    unregister()
    unregister()

    expect(frames.size).toBe(0)
    expect(terminal.clearTextureAtlas).not.toHaveBeenCalled()
  })

  it('rebuilds the atlas on power resume and stops listening after the last terminal unmounts', async () => {
    let resume = () => {}
    const unsubscribe = vi.fn()

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        onPowerResume: vi.fn((callback: () => void) => {
          resume = callback

          return unsubscribe
        })
      }
    })

    const { registerAtlasTerminal } = await loadAtlas()
    const terminal = fakeTerminal([], 'a')
    const unregister = registerAtlasTerminal(terminal)

    resume()
    runFrame()
    expect(terminal.clearTextureAtlas).toHaveBeenCalledOnce()
    expect(terminal.refresh).toHaveBeenCalledOnce()

    unregister()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('rebuilds the atlas when document.fonts reports loadingdone (late webfont)', async () => {
    const fonts = new EventTarget()

    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })

    const { registerAtlasTerminal } = await loadAtlas()
    const terminal = fakeTerminal([], 'a')
    const unregister = registerAtlasTerminal(terminal)

    fonts.dispatchEvent(new Event('loadingdone'))
    runFrame()
    expect(terminal.clearTextureAtlas).toHaveBeenCalledOnce()

    unregister()
    fonts.dispatchEvent(new Event('loadingdone'))
    expect(frames.size).toBe(0)
  })

  it('rebuilds the atlas when the device pixel ratio changes and keeps watching the new ratio', async () => {
    const queries: Array<{ listener: (() => void) | null; media: string }> = []

    vi.stubGlobal('matchMedia', (media: string) => {
      const query = { listener: null as (() => void) | null, media }

      queries.push(query)

      return {
        addEventListener: (_type: string, listener: () => void) => {
          query.listener = listener
        },
        removeEventListener: () => {
          query.listener = null
        }
      }
    })

    const { registerAtlasTerminal } = await loadAtlas()
    const terminal = fakeTerminal([], 'a')

    registerAtlasTerminal(terminal)
    queries[0].listener?.()
    runFrame()

    expect(terminal.clearTextureAtlas).toHaveBeenCalledOnce()
    expect(queries).toHaveLength(2)
    expect(queries[1].listener).not.toBeNull()
  })

  it('subscribes each WebGL addon to every shared-atlas event', async () => {
    const { bindAtlasAddon, registerAtlasTerminal } = await loadAtlas()
    const a = fakeTerminal([], 'a')
    const addon = fakeAddon()

    registerAtlasTerminal(a)
    bindAtlasAddon(a, addon.addon as never)

    expect(addon.subscriptions()).toBe(3)
  })

  it('redraws every OTHER WebGL terminal in full when one changes the shared atlas, once per frame', async () => {
    const { bindAtlasAddon, registerAtlasTerminal } = await loadAtlas()
    const log: string[] = []
    const a = fakeTerminal(log, 'a')
    const b = fakeTerminal(log, 'b')
    const c = fakeTerminal(log, 'c')
    const dom = fakeTerminal(log, 'dom')

    const addonA = fakeAddon()

    ;[a, b, c, dom].forEach(terminal => registerAtlasTerminal(terminal))
    bindAtlasAddon(a, addonA.addon as never)
    bindAtlasAddon(b, fakeAddon().addon as never)
    bindAtlasAddon(c, fakeAddon().addon as never)

    addonA.fire()
    addonA.fire()
    expect(frames.size).toBe(1)
    expect(log).toEqual([])

    runFrame()
    expect(log).toEqual(['refresh:b', 'refresh:c'])
    expect(a.clearTextureAtlas).not.toHaveBeenCalled()
  })

  it('redraws both sources when two terminals change the atlas in the same frame', async () => {
    const { bindAtlasAddon, registerAtlasTerminal } = await loadAtlas()
    const log: string[] = []
    const a = fakeTerminal(log, 'a')
    const b = fakeTerminal(log, 'b')
    const addonA = fakeAddon()
    const addonB = fakeAddon()

    registerAtlasTerminal(a)
    registerAtlasTerminal(b)
    bindAtlasAddon(a, addonA.addon as never)
    bindAtlasAddon(b, addonB.addon as never)
    addonA.fire()
    addonB.fire()
    runFrame()

    expect(log).toEqual(['refresh:a', 'refresh:b'])
  })

  it('follows renderer switches and unregistering: a released addon no longer triggers redraws', async () => {
    const { bindAtlasAddon, registerAtlasTerminal } = await loadAtlas()
    const log: string[] = []
    const a = fakeTerminal(log, 'a')
    const b = fakeTerminal(log, 'b')
    const first = fakeAddon()
    const second = fakeAddon()

    registerAtlasTerminal(a)
    const unregisterB = registerAtlasTerminal(b)
    bindAtlasAddon(b, fakeAddon().addon as never)
    bindAtlasAddon(a, first.addon as never)
    bindAtlasAddon(a, second.addon as never)
    expect(first.subscriptions()).toBe(0)

    first.fire()
    expect(frames.size).toBe(0)

    bindAtlasAddon(a, null)
    expect(second.subscriptions()).toBe(0)

    bindAtlasAddon(a, second.addon as never)
    unregisterB()
    second.fire()
    runFrame()
    expect(log).toEqual([])
  })

  it('a coordinated rebuild does not schedule a second redraw from the events its clears provoke', async () => {
    const { bindAtlasAddon, registerAtlasTerminal, requestAtlasRebuild } = await loadAtlas()
    const log: string[] = []
    const addonA = fakeAddon()
    const a = fakeTerminal(log, 'a')
    const b = fakeTerminal(log, 'b')

    a.clearTextureAtlas.mockImplementation(() => {
      log.push('clear:a')
      addonA.fire()
    })
    registerAtlasTerminal(a)
    registerAtlasTerminal(b)
    bindAtlasAddon(a, addonA.addon as never)
    bindAtlasAddon(b, fakeAddon().addon as never)
    requestAtlasRebuild()
    runFrame()

    expect(log).toEqual(['clear:a', 'clear:b', 'refresh:a', 'refresh:b'])
    expect(frames.size).toBe(0)
  })
})
