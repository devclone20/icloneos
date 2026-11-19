/**
 * v0.0.9 F6 — what the 3D iNFT carries between the main window and its own window: WHICH iNFT (id, name, model URL)
 * and the owner's camera on it. Both windows are the same app document (same origin), so the record rides
 * localStorage; nothing of it crosses IPC, and the main process never reads it (the bridge's open() takes no
 * argument — there is nothing a page could smuggle through it).
 *
 * The camera is NOT remembered across summons: an iNFT always opens on the standard view (owner rule, home-view.tsx).
 * It is queued only for the one hand-over — the next stage mount of that model takes it, once.
 *
 * Keys: `iclone.stage3d.handoff` and `iclone.stage3d.camera`, registered in home/lib/storage-keys.ts (R-f6-4).
 */
import { readJson, writeJson, writeKey } from '@/lib/storage'

import { ICLONE_STORAGE } from '../lib/storage-keys'
import type { StageCameraPose } from '../stage-director'

export const STAGE_HANDOFF_KEY = ICLONE_STORAGE.stage3dHandoff.key
export const STAGE_CAMERA_KEY = ICLONE_STORAGE.stage3dCamera.key

export interface StageHandoff {
  id: string
  name: string
  modelUrl: string
  /** The field colour the main window was painting, so the window opens on the same field. */
  field: null | string
}

interface StoredCamera {
  modelUrl: string
  pose: StageCameraPose
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function validPose(value: unknown): null | StageCameraPose {
  const pose = value as Partial<StageCameraPose> | null

  return pose && isNumber(pose.azimuth) && isNumber(pose.elevation) && isNumber(pose.dolly)
    ? { azimuth: pose.azimuth, elevation: pose.elevation, dolly: pose.dolly }
    : null
}

export function writeStageHandoff(handoff: StageHandoff): void {
  writeJson(STAGE_HANDOFF_KEY, handoff)
}

export function readStageHandoff(): null | StageHandoff {
  const raw = readJson<Partial<StageHandoff>>(STAGE_HANDOFF_KEY)

  if (!raw || !isString(raw.id) || !isString(raw.name) || !isString(raw.modelUrl)) {
    return null
  }

  return { id: raw.id, name: raw.name, modelUrl: raw.modelUrl, field: isString(raw.field) ? raw.field : null }
}

export function clearStageHandoff(): void {
  writeKey(STAGE_HANDOFF_KEY, null)
}

// ── the camera ──────────────────────────────────────────────────────────────

/** The live stage's last camera in THIS renderer, by model URL (what a detach carries away). */
const lastCamera = new Map<string, StageCameraPose>()
/** A camera waiting for the next mount of that model in THIS renderer (what a hand-over brought in). */
const queuedCamera = new Map<string, StageCameraPose>()
const listeners = new Set<(modelUrl: string, pose: StageCameraPose) => void>()

/** The stage reports the owner's camera after each drag / wheel. */
export function noteStageCamera(modelUrl: string, pose: StageCameraPose): void {
  lastCamera.set(modelUrl, pose)
  listeners.forEach(listener => listener(modelUrl, pose))
}

export function lastStageCamera(modelUrl: string): null | StageCameraPose {
  return lastCamera.get(modelUrl) ?? null
}

export function onStageCamera(listener: (modelUrl: string, pose: StageCameraPose) => void): () => void {
  listeners.add(listener)

  return () => listeners.delete(listener)
}

/** Taken once by the next Stage3D of that model (stage3d.tsx). */
export function takeQueuedStageCamera(modelUrl: string): null | StageCameraPose {
  const pose = queuedCamera.get(modelUrl) ?? null

  queuedCamera.delete(modelUrl)

  return pose
}

export function queueStageCamera(modelUrl: string, pose: null | StageCameraPose): void {
  if (pose) {
    queuedCamera.set(modelUrl, pose)
  } else {
    queuedCamera.delete(modelUrl)
  }
}

/** The camera crosses windows through storage: written by the side that hands over, taken by the side that receives. */
export function writeHandedCamera(modelUrl: string, pose: null | StageCameraPose): void {
  if (pose) {
    writeJson(STAGE_CAMERA_KEY, { modelUrl, pose } satisfies StoredCamera)
  } else {
    writeKey(STAGE_CAMERA_KEY, null)
  }
}

/** Read the handed camera for this model and clear it (one hand-over, one use). */
export function takeHandedCamera(modelUrl: string): null | StageCameraPose {
  const raw = readJson<Partial<StoredCamera>>(STAGE_CAMERA_KEY)

  if (!raw || raw.modelUrl !== modelUrl) {
    return null
  }

  writeKey(STAGE_CAMERA_KEY, null)

  return validPose(raw.pose)
}

/**
 * The stage window's side of a hand-over (stage3d-window-root.tsx): take the camera the main window handed over,
 * queue it for this window's stage, and hand it straight back through storage — so an untouched window (no drag, no
 * wheel, so no `onStageCamera`) still returns what it received, and Bring back never lands on the standard view
 * (v0.0.9 Q correctness 6). Idempotent: a second call (StrictMode) finds the same pose and does the same thing.
 */
export function receiveHandedCamera(modelUrl: string): null | StageCameraPose {
  const pose = takeHandedCamera(modelUrl)

  if (pose) {
    queueStageCamera(modelUrl, pose)
    writeHandedCamera(modelUrl, pose)
  }

  return pose
}

/** Tests only. */
export function resetStageCameraForTests(): void {
  lastCamera.clear()
  queuedCamera.clear()
  listeners.clear()
}
