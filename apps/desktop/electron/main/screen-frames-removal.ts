/**
 * L4-06 — removing screen-recording frame folders off the main thread (no Electron import: the perf gate loads it).
 */
import { promises as fsp, rmSync } from 'node:fs'
import path from 'node:path'

/**
 * The app keeps a chat's images with no end date. Whole-screen frames can hold secrets, so a recording's folder goes
 * this long after it was made: its images in an old chat stop opening, what the model was sent is not affected.
 */
const KEEP_FRAMES_MS = 14 * 24 * 60 * 60 * 1000

/**
 * L4-06: a recording's folder is removed in the thread pool, never on the main thread (a 10-minute recording is ~600
 * PNGs). The folders still being removed when the app goes away are finished synchronously by the teardown below:
 * frames no one kept must not outlive a quit just because their removal was still running.
 */
const removing = new Set<string>()

export function removeFramesFolder(folder: string): Promise<void> {
  removing.add(folder)

  return fsp
    .rm(folder, { force: true, recursive: true })
    .catch(() => {
      // Left for the 14-day sweep of the next launch.
    })
    .finally(() => removing.delete(folder))
}

/** The teardown half: whatever is still being removed, removed now. */
export function finishRemovingFramesSync(): void {
  for (const folder of [...removing]) {
    try {
      rmSync(folder, { force: true, recursive: true })
    } catch {
      // The next launch's sweep tries again.
    }

    removing.delete(folder)
  }
}

/**
 * Folders past their time, swept in the background after launch (never on the startup path). Never the ones of a
 * running recording: they are minutes old. One folder at a time, so the sweep never floods the thread pool that the
 * window's own file reads share. Not finished at quit: an interrupted sweep resumes at the next launch.
 */
export async function sweepOldFrames(root: string, now: number): Promise<void> {
  let names: string[] = []

  try {
    names = await fsp.readdir(root)
  } catch {
    // No folder yet, or one that cannot be read: the next launch tries again.
    return
  }

  for (const name of names) {
    const folder = path.join(root, name)

    try {
      if (now - (await fsp.stat(folder)).mtimeMs > KEEP_FRAMES_MS) {
        await fsp.rm(folder, { force: true, recursive: true })
      }
    } catch {
      // This one waits for the next launch.
    }
  }
}
