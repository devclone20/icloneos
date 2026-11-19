/**
 * v0.0.9 F6 — the 3D iNFT leaving for its own window and coming back, with ONE live WebGL context at any time.
 *
 * The order is the whole point:
 *   detach:  write the hand-off (iNFT + camera) → the main stage unmounts ('releasing') and its context is released
 *            (gpu-lease liveStageContexts() back to 0, waited for frame by frame) → only then main opens the window,
 *            whose stage reserves its own context → 'away' (the main window shows the calm plate);
 *   return:  Bring back (or the window's own close) → main destroys the window, its context dies with it → main says
 *            'closed' → the main stage mounts again on the handed camera ('docked').
 * A failure at any step docks the stage again where it was.
 */
import { atom } from 'nanostores'

import { liveStageContexts } from '../gpu-lease'

import { type Stage3dWindowBridge, stage3dWindowBridge } from './bridge'
import {
  lastStageCamera,
  queueStageCamera,
  readStageHandoff,
  takeHandedCamera,
  writeHandedCamera,
  writeStageHandoff
} from './handoff'

export type StagePlace = 'away' | 'docked' | 'releasing'

/** Where the 3D iNFT performs: on the home stage, on its way out, or in its own window. */
export const $stagePlace = atom<StagePlace>('docked')

/** Frames the detach waits for the main stage to give its context back before it gives up. */
export const RELEASE_FRAMES_MAX = 30

export interface StageInft {
  id: string
  name: string
  modelUrl: string
}

interface HandoverDeps {
  bridge: () => null | Stage3dWindowBridge
  liveContexts: () => number
  nextFrame: () => Promise<void>
  onFailed: () => void
}

export interface StageHandover {
  available: () => boolean
  detach: (inft: StageInft, field: null | string) => Promise<boolean>
  bringBack: () => Promise<void>
  /** Main said the window is gone: dock the stage on the camera the window handed back. */
  closed: () => void
}

export function createStageHandover(deps: HandoverDeps): StageHandover {
  let unsubscribe: (() => void) | null = null

  const closed = () => {
    const handoff = readStageHandoff()

    if (handoff) {
      queueStageCamera(handoff.modelUrl, takeHandedCamera(handoff.modelUrl))
    }

    $stagePlace.set('docked')
  }

  const listen = (bridge: Stage3dWindowBridge) => {
    unsubscribe ??= bridge.onClosed(closed)
  }

  const dockAgain = (modelUrl: string) => {
    queueStageCamera(modelUrl, takeHandedCamera(modelUrl))
    $stagePlace.set('docked')
    deps.onFailed()
  }

  return {
    available: () => deps.bridge() !== null,

    async detach(inft, field) {
      const bridge = deps.bridge()

      if (!bridge || $stagePlace.get() !== 'docked') {
        return false
      }

      writeStageHandoff({ ...inft, field })
      writeHandedCamera(inft.modelUrl, lastStageCamera(inft.modelUrl))
      $stagePlace.set('releasing')

      for (let frame = 0; frame < RELEASE_FRAMES_MAX && deps.liveContexts() > 0; frame += 1) {
        await deps.nextFrame()
      }

      if (deps.liveContexts() > 0) {
        dockAgain(inft.modelUrl)

        return false
      }

      listen(bridge)

      let opened = false

      try {
        opened = (await bridge.open()).ok === true
      } catch {
        opened = false
      }

      if (!opened || $stagePlace.get() !== 'releasing') {
        if ($stagePlace.get() === 'releasing') {
          dockAgain(inft.modelUrl)
        }

        return false
      }

      $stagePlace.set('away')

      return true
    },

    async bringBack() {
      const bridge = deps.bridge()

      if (!bridge || $stagePlace.get() !== 'away') {
        return
      }

      listen(bridge)

      try {
        await bridge.close()
      } catch {
        // The window is gone or main is going down: either way the stage belongs here again.
        closed()
      }
    },

    closed
  }
}

const nextAnimationFrame = () =>
  new Promise<void>(resolve => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
    } else {
      setTimeout(resolve, 16)
    }
  })

let failedListener: (() => void) | null = null

/** The app's one hand-over (home-view.tsx). */
export const stageHandover = createStageHandover({
  bridge: stage3dWindowBridge,
  liveContexts: liveStageContexts,
  nextFrame: nextAnimationFrame,
  onFailed: () => failedListener?.()
})

/** home-view says how a failed detach is told (a toast). */
export function onStageHandoverFailed(listener: (() => void) | null): void {
  failedListener = listener
}
