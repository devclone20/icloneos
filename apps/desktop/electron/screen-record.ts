/**
 * The owner's Screen record button (ruling R6): what main does when the user clicks it. Every decision lives here, the
 * real desktopCapturer / systemPreferences / disk arrive through the seam (electron/main/screen-record-ipc.ts).
 *
 * Output: precise native-resolution screenshots, only the ones that changed, each with its time. Nothing here sends
 * anything anywhere: frames go to a local folder, and reach a model only when the user sends the message.
 *
 * Runs in main, on the user's own click: no permission mode and no Seatbelt state decides it. Only the consent key
 * `screen` (Settings › Privacy) and the macOS grant do.
 */
import { SCREEN_RECORD_MAX_MS, screenTimeline } from '../src/iclone-shared/screen-timeline'

/** About one frame a second. */
export const SCREEN_RECORD_TICK_MS = 1_000
export { SCREEN_RECORD_MAX_MS, screenTimeline }

/**
 * Twenty frames in one message. Providers charge each image a capped amount (about 1.5k tokens on the large vision
 * models), so a recording costs about 30k tokens at worst; and past twenty images in one request some providers lower
 * what they accept per image, which would undo the native resolution this exists for.
 */
export const SCREEN_RECORD_MAX_FRAMES = 20
/** A pixel changed when one channel moved by more than this: ignores compositor noise and gradients redrawn a level off. */
const PIXEL_DELTA = 8
/** On the 640 px fingerprint, about 50 pixels: one typed character counts, a blinking caret does not. */
export const FRAME_CHANGED_FRACTION = 0.0002
/** A frame is blank when this much of it sits at one value: what macOS hands back in place of a screen it refuses. */
const BLANK_FRACTION = 0.999
/** Consecutive failed captures that end a recording rather than leave it running and silent. */
const MAX_CAPTURE_FAILURES = 3

export interface FrameFingerprint {
  /** BGRA or RGBA bytes, four to a pixel. Only compared, never stored. */
  bytes: Uint8Array | Buffer
  height: number
  width: number
}

/** The share of pixels that differ. Sizes that differ (the display changed) count as all changed. */
export function frameChange(previous: FrameFingerprint, current: FrameFingerprint): number {
  if (previous.width !== current.width || previous.height !== current.height) {
    return 1
  }

  const a = previous.bytes
  const b = current.bytes
  const pixels = Math.floor(Math.min(a.length, b.length) / 4)

  if (pixels === 0) {
    return 0
  }

  let changed = 0

  for (let i = 0; i < pixels * 4; i += 4) {
    if (
      Math.abs(a[i] - b[i]) > PIXEL_DELTA ||
      Math.abs(a[i + 1] - b[i + 1]) > PIXEL_DELTA ||
      Math.abs(a[i + 2] - b[i + 2]) > PIXEL_DELTA
    ) {
      changed += 1
    }
  }

  return changed / pixels
}

/** No pixels at all, or one colour edge to edge. A true screen has a menu bar on it. */
export function isBlankFrame(frame: FrameFingerprint): boolean {
  const { bytes } = frame
  const pixels = Math.floor(bytes.length / 4)

  if (pixels === 0 || frame.width === 0 || frame.height === 0) {
    return true
  }

  const [r, g, b] = [bytes[0], bytes[1], bytes[2]]
  let same = 0

  for (let i = 0; i < pixels * 4; i += 4) {
    if (
      Math.abs(bytes[i] - r) <= PIXEL_DELTA &&
      Math.abs(bytes[i + 1] - g) <= PIXEL_DELTA &&
      Math.abs(bytes[i + 2] - b) <= PIXEL_DELTA
    ) {
      same += 1
    }
  }

  return same / pixels >= BLANK_FRACTION
}

export interface KeptFrame {
  /** How much changed since the frame kept before it, 0 to 1. */
  change: number
  path: string
  tMs: number
}

/**
 * Which frame to give up when over the cap: never the first or the last, otherwise the one that says least, weighing
 * how much it changed by the span of time it alone stands for. A small change in a busy stretch goes first; a large one,
 * or the only frame of a quiet minute, stays. So the kept frames cover the whole span, not only its start.
 */
export function leastImportantFrame(frames: readonly KeptFrame[]): number {
  let best = -1
  let bestCost = Infinity

  for (let i = 1; i < frames.length - 1; i += 1) {
    const cost = frames[i].change * (frames[i + 1].tMs - frames[i - 1].tMs)

    if (cost < bestCost) {
      bestCost = cost
      best = i
    }
  }

  return best
}

export interface ScreenCapture {
  fingerprint: FrameFingerprint
  /** Encoded only when the frame is kept: most ticks change nothing. */
  png: () => Buffer
}

export type ScreenGrant = 'granted' | 'needs-grant' | 'needs-restart' | 'restricted'

export interface ScreenRecordSeam {
  capture: () => Promise<ScreenCapture | null>
  /** Sets up one recording's folder (private to the user) and returns it. */
  makeFolder: () => Promise<string>
  now: () => number
  onChange: (status: ScreenRecordStatus) => void
  removeFile: (file: string) => Promise<void>
  /**
   * Starts the removal and returns at once (L4-06: off the main thread). A quit does not wait for a promise: whoever
   * implements this finishes the removals still running on the way out (screen-record-ipc's teardown).
   */
  removeFolder: (folder: string) => void
  screenConsent: () => boolean
  screenGrant: () => Promise<ScreenGrant>
  schedule: (run: () => void, ms: number) => unknown
  cancel: (handle: unknown) => void
  writeFrame: (folder: string, tMs: number, bytes: Buffer) => Promise<string>
}

export type ScreenRecordRefusal = 'blank' | 'consent' | 'failed' | 'needs-grant' | 'needs-restart' | 'restricted'

export interface ScreenRecordResult {
  blankDropped: number
  durationMs: number
  folder: string
  frames: { path: string; tMs: number }[]
  hitTimeLimit: boolean
  thinnedFrom: number
  timeline: string
}

export interface ScreenRecordStatus {
  /** Why the last recording ended with nothing, until the next start. */
  ended: null | ScreenRecordRefusal
  framesKept: number
  /** Frames of a finished recording that no window has taken yet. */
  pending: boolean
  recording: boolean
  startedAt: null | number
}

export type ScreenRecordStart = { ok: false; reason: ScreenRecordRefusal } | { ok: true; status: ScreenRecordStatus }

interface Run {
  blankDropped: number
  changedFrames: number
  failures: number
  folder: string
  frames: KeptFrame[]
  hitTimeLimit: boolean
  inFlight: Promise<void> | null
  last: FrameFingerprint | null
  startedAt: number
  timer: unknown
}

export function createScreenRecorder(seam: ScreenRecordSeam) {
  let run: null | Run = null
  let pending: null | ScreenRecordResult = null
  let ended: null | ScreenRecordRefusal = null
  let starting = false
  let closed = false

  const status = (): ScreenRecordStatus => ({
    ended,
    framesKept: run?.frames.length ?? 0,
    pending: pending !== null,
    recording: run !== null,
    startedAt: run?.startedAt ?? null
  })

  const notify = () => seam.onChange(status())

  const keep = async (current: Run, capture: ScreenCapture, change: number, tMs: number) => {
    const path = await seam.writeFrame(current.folder, tMs, capture.png())

    current.frames.push({ change, path, tMs })
    current.changedFrames += 1

    if (current.frames.length > SCREEN_RECORD_MAX_FRAMES) {
      const drop = leastImportantFrame(current.frames)
      const [gone] = current.frames.splice(drop, 1)

      // Its change is not lost: the next frame now stands for both.
      current.frames[drop].change = Math.min(1, current.frames[drop].change + gone.change)
      await seam.removeFile(gone.path)
    }
  }

  /** One tick. A failed or blank capture never counts as a frame. */
  const take = async (current: Run) => {
    const tMs = seam.now() - current.startedAt

    try {
      const capture = await seam.capture()

      current.failures = 0

      if (!capture || isBlankFrame(capture.fingerprint)) {
        current.blankDropped += 1

        return
      }

      const change = current.last ? frameChange(current.last, capture.fingerprint) : 1

      if (current.last && change < FRAME_CHANGED_FRACTION) {
        return
      }

      await keep(current, capture, change, tMs)
      current.last = capture.fingerprint
    } catch {
      current.failures += 1
    }
  }

  const finish = (current: Run, refusal: null | ScreenRecordRefusal): null | ScreenRecordResult => {
    const durationMs = seam.now() - current.startedAt

    run = null

    if (current.frames.length === 0) {
      seam.removeFolder(current.folder)
      ended = refusal ?? 'blank'
      pending = null
      notify()

      return null
    }

    const frames = current.frames.map(({ path, tMs }) => ({ path, tMs }))

    pending = {
      blankDropped: current.blankDropped,
      durationMs,
      folder: current.folder,
      frames,
      hitTimeLimit: current.hitTimeLimit,
      thinnedFrom: current.changedFrames,
      timeline: screenTimeline({
        blankDropped: current.blankDropped,
        durationMs,
        frames,
        hitTimeLimit: current.hitTimeLimit,
        thinnedFrom: current.changedFrames
      })
    }
    ended = null
    notify()

    return pending
  }

  const stopRun = async (current: Run, refusal: null | ScreenRecordRefusal = null) => {
    seam.cancel(current.timer)
    current.timer = null
    // A stop arriving mid-capture waits for that capture, so no file lands after the result is read.
    await current.inFlight

    if (run !== current) {
      return null
    }

    return finish(current, refusal)
  }

  const schedule = (current: Run) => {
    current.timer = seam.schedule(() => {
      if (run !== current) {
        return
      }

      if (seam.now() - current.startedAt >= SCREEN_RECORD_MAX_MS) {
        current.hitTimeLimit = true
        void stopRun(current)

        return
      }

      // The turn stopped being allowed while it ran: switching the key off ends it at the next tick, as the titles do.
      if (!seam.screenConsent()) {
        void stopRun(current, 'consent')

        return
      }

      current.inFlight = take(current).then(() => {
        current.inFlight = null

        if (run !== current || current.timer === null) {
          return
        }

        if (current.failures >= MAX_CAPTURE_FAILURES) {
          void stopRun(current, 'failed')

          return
        }

        schedule(current)
      })
    }, SCREEN_RECORD_TICK_MS)
  }

  return {
    /** One click. Refuses with the plain reason; never a recording that cannot record. */
    start: async (): Promise<ScreenRecordStart> => {
      if (run) {
        return { ok: true, status: status() }
      }

      if (starting || closed) {
        return { ok: false, reason: 'failed' }
      }

      starting = true

      try {
        if (!seam.screenConsent()) {
          return { ok: false, reason: 'consent' }
        }

        const grant = await seam.screenGrant()

        if (grant !== 'granted') {
          return { ok: false, reason: grant }
        }

        // The first frame decides: a grant that reads yes and hands back a blank screen is a no, said plainly.
        const first = await seam.capture().catch(() => null)

        if (!first || isBlankFrame(first.fingerprint)) {
          return { ok: false, reason: 'blank' }
        }

        const folder = await seam.makeFolder()
        const startedAt = seam.now()

        const current: Run = {
          blankDropped: 0,
          changedFrames: 0,
          failures: 0,
          folder,
          frames: [],
          hitTimeLimit: false,
          inFlight: null,
          last: first.fingerprint,
          startedAt,
          timer: null
        }

        try {
          await keep(current, first, 1, 0)
        } catch {
          seam.removeFolder(folder)

          return { ok: false, reason: 'failed' }
        }

        if (closed) {
          seam.removeFolder(folder)

          return { ok: false, reason: 'failed' }
        }

        run = current
        ended = null
        pending = null
        schedule(current)
        notify()

        return { ok: true, status: status() }
      } finally {
        starting = false
      }
    },

    /** One click, the window closing, or the cap. The frames wait for `takeResult`. */
    stop: async (): Promise<null | ScreenRecordResult> => {
      if (!run) {
        return pending
      }

      return stopRun(run)
    },

    status,

    /** The frames, once: to the window that attaches them. */
    takeResult: (): null | ScreenRecordResult => {
      const result = pending

      pending = null

      if (result) {
        notify()
      }

      return result
    },

    /** A frame the user removed from the message: only files of this recorder's folder ever reach the seam. */
    discardFrame: (file: string, isOurs: (file: string) => boolean): Promise<void> | void => {
      if (isOurs(file)) {
        return seam.removeFile(file).catch(() => undefined)
      }
    },

    /** Quit. Nothing left running, and frames no one ever saw do not stay on the disk. */
    shutdown: () => {
      closed = true

      if (run) {
        const current = run

        seam.cancel(current.timer)
        current.timer = null
        run = null
        seam.removeFolder(current.folder)
      }

      if (pending) {
        seam.removeFolder(pending.folder)
        pending = null
      }
    }
  }
}

export type ScreenRecorder = ReturnType<typeof createScreenRecorder>
