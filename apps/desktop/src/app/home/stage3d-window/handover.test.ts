// v0.0.9 F6 gate: the 3D iNFT leaves for its own window and comes back 10 times in a row without ever holding two
// live WebGL stage contexts (gpu-lease counted), and it comes back on the same iNFT and the same camera. Fails on the
// code before F6: there was no hand-over, no stage counter (reserveStageContext / liveStageContexts) and no camera API.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { liveStageContexts, reserveStageContext } from '../gpu-lease'

import type { Stage3dWindowBridge } from './bridge'
import {
  noteStageCamera,
  readStageHandoff,
  receiveHandedCamera,
  resetStageCameraForTests,
  takeQueuedStageCamera,
  writeHandedCamera
} from './handoff'
import { $stagePlace, createStageHandover } from './handover'

vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))

const INFT = { id: '46630:0xabc:7', name: 'iNFT #7', modelUrl: 'https://example.invalid/7.glb' }

/**
 * Both windows, simulated: the main window's stage holds a context while the stage is docked (React mounts Stage3D
 * when $stagePlace is 'docked' and unmounts it otherwise — home-view.tsx); the stage window holds one from the moment
 * main opens it until main closes it. `peak` is the most contexts ever alive at once, across both.
 */
function harness() {
  let mainRelease: (() => void) | null = null
  let windowAlive = false
  let peak = 0
  let closedListener: (() => void) | null = null

  const total = () => liveStageContexts() + (windowAlive ? 1 : 0)

  const measure = () => {
    peak = Math.max(peak, total())
  }

  const syncMainStage = () => {
    if ($stagePlace.get() === 'docked' && mainRelease === null) {
      mainRelease = reserveStageContext(() => () => undefined)
    } else if ($stagePlace.get() !== 'docked' && mainRelease !== null) {
      mainRelease()
      mainRelease = null
    }

    measure()
  }

  const unsubscribe = $stagePlace.subscribe(syncMainStage)

  const markWindowClosed = () => {
    windowAlive = false
    measure()
    closedListener?.()
  }

  const bridge: Stage3dWindowBridge = {
    open: vi.fn(async () => {
      measure()
      windowAlive = true
      measure()

      return { ok: true }
    }),
    close: vi.fn(async () => {
      // The camera the owner left in the window rides back through storage.
      writeHandedCamera(INFT.modelUrl, { azimuth: 0.4, elevation: -0.2, dolly: 0.1 })
      markWindowClosed()
    }),
    onClosed: vi.fn(callback => {
      closedListener = callback

      return () => {
        closedListener = null
      }
    })
  }

  const handover = createStageHandover({
    bridge: () => bridge,
    liveContexts: liveStageContexts,
    // A frame: React has committed the 'releasing' render, so the docked stage is gone.
    nextFrame: async () => syncMainStage(),
    onFailed: vi.fn()
  })

  return {
    bridge,
    handover,
    markWindowClosed,
    peak: () => peak,
    total,
    dispose: () => {
      unsubscribe()
      mainRelease?.()
      mainRelease = null
    }
  }
}

beforeEach(() => {
  window.localStorage.clear()
  resetStageCameraForTests()
  $stagePlace.set('docked')
})

afterEach(() => {
  $stagePlace.set('docked')
})

describe('detach and return, 10 times', () => {
  it('never more than ONE live 3D context, and exactly one at rest', async () => {
    const h = harness()

    expect(h.total()).toBe(1)

    for (let round = 0; round < 10; round += 1) {
      expect(await h.handover.detach(INFT, '#123456')).toBe(true)
      expect($stagePlace.get()).toBe('away')
      expect(h.total()).toBe(1)

      await h.handover.bringBack()
      expect($stagePlace.get()).toBe('docked')
      expect(h.total()).toBe(1)
    }

    expect(h.peak()).toBe(1)
    expect(h.bridge.open).toHaveBeenCalledTimes(10)
    expect(h.bridge.close).toHaveBeenCalledTimes(10)
    // One closed-listener for the whole session, not one per detach.
    expect(h.bridge.onClosed).toHaveBeenCalledTimes(1)
    h.dispose()
    expect(liveStageContexts()).toBe(0)
  })

  it('the window is opened only after the main stage released its context', async () => {
    const h = harness()

    vi.mocked(h.bridge.open).mockImplementationOnce(async () => {
      expect(liveStageContexts()).toBe(0)

      return { ok: true }
    })

    await h.handover.detach(INFT, null)
    h.dispose()
  })

  it('the hand-off names the iNFT and carries the camera out and back', async () => {
    const h = harness()

    noteStageCamera(INFT.modelUrl, { azimuth: 1.1, elevation: 0.3, dolly: -0.2 })
    await h.handover.detach(INFT, '#123456')

    expect(readStageHandoff()).toEqual({ ...INFT, field: '#123456' })
    expect(JSON.parse(window.localStorage.getItem('iclone.stage3d.camera')!)).toEqual({
      modelUrl: INFT.modelUrl,
      pose: { azimuth: 1.1, elevation: 0.3, dolly: -0.2 }
    })

    await h.handover.bringBack()

    // The next main stage of that model takes the window's camera, once.
    expect(takeQueuedStageCamera(INFT.modelUrl)).toEqual({ azimuth: 0.4, elevation: -0.2, dolly: 0.1 })
    expect(takeQueuedStageCamera(INFT.modelUrl)).toBeNull()
    h.dispose()
  })

  it('an untouched window hands back the camera it received (Q correctness 6)', async () => {
    const h = harness()

    // The window side of close() writes nothing: the owner never dragged or wheeled in it.
    vi.mocked(h.bridge.close).mockImplementationOnce(async () => {
      h.markWindowClosed()
    })
    noteStageCamera(INFT.modelUrl, { azimuth: 1.1, elevation: 0.3, dolly: -0.2 })
    await h.handover.detach(INFT, null)

    // The stage window mounts: it takes the camera for its own stage (twice under StrictMode, same answer)…
    expect(receiveHandedCamera(INFT.modelUrl)).toEqual({ azimuth: 1.1, elevation: 0.3, dolly: -0.2 })
    expect(receiveHandedCamera(INFT.modelUrl)).toEqual({ azimuth: 1.1, elevation: 0.3, dolly: -0.2 })
    expect(takeQueuedStageCamera(INFT.modelUrl)).toEqual({ azimuth: 1.1, elevation: 0.3, dolly: -0.2 })

    await h.handover.bringBack()

    // …and Bring back lands the main stage on that camera, not on the standard view.
    expect(takeQueuedStageCamera(INFT.modelUrl)).toEqual({ azimuth: 1.1, elevation: 0.3, dolly: -0.2 })
    h.dispose()
  })

  it('a refused open docks the stage again where it was', async () => {
    const h = harness()

    vi.mocked(h.bridge.open).mockResolvedValueOnce({ ok: false, error: 'refused' })

    expect(await h.handover.detach(INFT, null)).toBe(false)
    expect($stagePlace.get()).toBe('docked')
    expect(h.total()).toBe(1)
    h.dispose()
  })

  it('a stage release is idempotent: a double cleanup never drives the count below zero', () => {
    const release = reserveStageContext(() => () => undefined)

    expect(liveStageContexts()).toBe(1)
    release()
    release()
    expect(liveStageContexts()).toBe(0)
  })
})
