/**
 * v0.0.7 FSEV — the typed loader of our own FSEvents addon (native/iclone-fsevents/iclone_fsevents.c), which replaces
 * the `fsevents` npm module in the F7 hard-link guard. What the addon guarantees is in the C file's header; in short:
 * `start` throws whenever FSEvents did not take the stream (missing or unreadable path, FSEventStreamCreate NULL,
 * FSEventStreamStart false), batches arrive on the JS thread in id order, and `flush` resolves only after every event
 * fseventsd held for the stream has reached the callback. A batch it cannot hand on is reported, never dropped
 * silently: the next batch starts with a MustScanSubDirs event (v0.0.7 CF1).
 *
 * Loaded from exactly two places, never from a search path: `dist/native/iclone_fsevents.node` beside the bundled main
 * (stage-native-deps.mjs puts it there; in the packed app Electron reads it from app.asar.unpacked, Team-signed), and
 * the build output beside the sources (dev and tests). Null when neither loads (not macOS, not built): the guard then
 * walks every root, as V-1 did.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface FsEventRecord {
  path: string
  flags: number
  /** FSEventStreamEventId, a uint64 in decimal. */
  id: string
}

/** Opaque: only the addon reads it. */
export type FsEventsHandle = { readonly __icloneFsevents: unique symbol }

export interface IcloneFsevents {
  currentEventId(): string
  start(paths: string | readonly string[], onEvents: (events: FsEventRecord[]) => void): FsEventsHandle
  flush(handle: FsEventsHandle): Promise<void>
  /** Null once the stream is stopped. */
  latestEventId(handle: FsEventsHandle): string | null
  stop(handle: FsEventsHandle): void
  activeCount(): number
  /** Test seam (CF1): the stream's next batch is dropped as an allocation failure would drop it; the batch after it
   *  then starts with a synthetic MustScanSubDirs event on the first watched path (the addon never loses silently). */
  testDropNextBatch?(handle: FsEventsHandle): void
  /** statfs(2) off the JS thread: the filesystem type NAME and whether the mount is MNT_LOCAL. */
  volume(path: string): Promise<{ fstypename: string; local: boolean }>
}

const FUNCTIONS = ['currentEventId', 'start', 'flush', 'latestEventId', 'stop', 'activeCount', 'volume'] as const

const isAddon = (value: unknown): value is IcloneFsevents =>
  typeof value === 'object' &&
  value !== null &&
  FUNCTIONS.every(name => typeof (value as Record<string, unknown>)[name] === 'function')

/** The two places the addon may come from, nearest first. */
export function addonCandidates(moduleUrl: string = import.meta.url): string[] {
  const here = path.dirname(fileURLToPath(moduleUrl))

  return [
    path.join(here, 'native', 'iclone_fsevents.node'),
    path.resolve(here, '..', '..', 'native', 'iclone-fsevents', 'build', 'iclone_fsevents.node')
  ]
}

let loaded: IcloneFsevents | null | undefined

export function loadIcloneFsevents(): IcloneFsevents | null {
  if (loaded !== undefined) {
    return loaded
  }

  loaded = null

  if (process.platform !== 'darwin') {
    return loaded
  }

  const requireNative = createRequire(import.meta.url)

  for (const candidate of addonCandidates()) {
    if (!existsSync(candidate)) {
      continue
    }

    try {
      const required: unknown = requireNative(candidate)

      loaded = isAddon(required) ? required : null
    } catch {
      loaded = null
    }

    break
  }

  return loaded
}
