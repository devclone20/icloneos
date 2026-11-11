/** The renderer's side of the Screen record button: what main says is happening. Main owns the recording. */
import { atom } from 'nanostores'

import { screenTimeline } from '@/iclone-shared/screen-timeline'

export type ScreenRecordRefusal = 'blank' | 'consent' | 'failed' | 'needs-grant' | 'needs-restart' | 'restricted'

export interface ScreenRecordStatus {
  consentOn?: boolean
  ended: null | ScreenRecordRefusal
  framesKept: number
  pending: boolean
  recording: boolean
  startedAt: null | number
}

export interface ScreenRecordResult {
  blankDropped: number
  durationMs: number
  folder: string
  frames: { path: string; tMs: number }[]
  hitTimeLimit: boolean
  /** Frames the user took off the message: never counted as thinning. */
  removedFrames?: number
  thinnedFrom: number
  timeline: string
}

export interface ScreenRecordBridge {
  discard: (file: string) => Promise<void>
  onState: (callback: (status: ScreenRecordStatus) => void) => () => void
  start: () => Promise<{ ok: false; reason: ScreenRecordRefusal } | { ok: true; status: ScreenRecordStatus }>
  status: () => Promise<ScreenRecordStatus>
  stop: () => Promise<ScreenRecordStatus>
  take: () => Promise<null | ScreenRecordResult>
}

export const IDLE_SCREEN_RECORD: ScreenRecordStatus = {
  ended: null,
  framesKept: 0,
  pending: false,
  recording: false,
  startedAt: null
}

export const $screenRecord = atom<ScreenRecordStatus>(IDLE_SCREEN_RECORD)
/** A click on its way to main: the button ignores a second one. */
export const $screenRecordBusy = atom(false)

export const screenRecordBridge = (): ScreenRecordBridge | undefined => window.hermesDesktop?.screenRecord

/** Where a recording's frames live on disk, as main lays it out: decides whether removing a chip also removes a file. */
export const isScreenFramePath = (file: string): boolean => /[\\/]composer-images[\\/]screen[\\/]/.test(file)

/** Each recording now in a message and the words it wrote there. Frames in a message do not outlive the app, so neither does this. */
const delivered = new Map<string, ScreenRecordResult>()

export const timelineDelivered = (result: ScreenRecordResult): void => void delivered.set(result.folder, result)

/**
 * A frame taken off the message: the words to change, rebuilt from the frames that remain, so the count, the numbers and
 * the times the model reads match the images it gets. `to` is empty with the last frame gone.
 */
export function timelineAfterRemoval(file: string): null | { from: string; to: string } {
  const recording = [...delivered.values()].find(({ frames }) => frames.some(frame => frame.path === file))

  if (!recording) {
    return null
  }

  const frames = recording.frames.filter(frame => frame.path !== file)
  const remaining = { ...recording, frames, removedFrames: (recording.removedFrames ?? 0) + 1 }
  const to = frames.length > 0 ? screenTimeline(remaining) : ''

  if (frames.length > 0) {
    delivered.set(recording.folder, { ...remaining, timeline: to })
  } else {
    delivered.delete(recording.folder)
  }

  return { from: recording.timeline, to }
}

/** Frame time on the button: 0:07, 4:59. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))

  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export const refreshScreenRecord = async (): Promise<void> => {
  const status = await screenRecordBridge()
    ?.status()
    .catch(() => null)

  if (status) {
    $screenRecord.set(status)
  }
}

let wired = false

/** Idempotent: every window of the app follows the one recording. */
export function wireScreenRecord(): void {
  if (wired) {
    return
  }

  wired = true
  screenRecordBridge()?.onState(status => $screenRecord.set({ ...$screenRecord.get(), ...status }))
  void refreshScreenRecord()
  // Consent is set in Settings: reading it again on the way back keeps the button's words true.
  window.addEventListener('focus', () => void refreshScreenRecord())
  window.addEventListener('hashchange', () => void refreshScreenRecord())
}
