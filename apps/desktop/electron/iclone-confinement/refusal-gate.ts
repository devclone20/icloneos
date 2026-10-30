/**
 * K97 — the Seatbelt refusal stream runs only while it can hear something of ours: confinement is on AND a confined
 * run is live. Before this, a `log stream` child lived for the app's whole life on every Mac and every foreign
 * sandbox denial cost a `ps` fold.
 *
 * Start: every confined run creates its token in the members folder before it spawns (`members.ts`, the plugin's
 * `core.py`), so a token appearing there is the signal; it is watched (FSEvents, no polling). At start-up a token
 * already present starts one check, since Hermes may have outlived a window reload.
 * Stop: while the stream runs, liveness is re-read every `checkEveryMs` (one `ps` fold, only then); when confinement
 * is off or no confined process is left, the stream stops. Tokens linger until the sweep, so only a token's
 * CREATION starts the stream, never its presence or removal.
 */
import fs from 'node:fs'
import path from 'node:path'

import { parseRunToken } from './members'

export interface RefusalGateDeps {
  membersDir: string
  /** Confinement's own setting, read on every use (signed file). */
  enabled: () => boolean
  /** One `ps` fold: is any process confined right now? */
  live: () => Promise<boolean>
  /** Starts the stream; `backfillSeconds` covers the moment between the token and the connection. */
  start: (backfillSeconds: number) => { stop: () => void }
  checkEveryMs?: number
  /** Test seams. */
  watch?: (dir: string, onName: (name: string | null) => void) => { close: () => void }
  tokenExists?: (dir: string, name: string) => boolean
  tokenNames?: (dir: string) => string[]
}

const CHECK_EVERY_MS = 15_000
const BACKFILL_SECONDS = 5

function watchDir(dir: string, onName: (name: string | null) => void): { close: () => void } {
  try {
    const watcher = fs.watch(dir, { persistent: false }, (_event, name) => onName(name ? String(name) : null))

    watcher.on('error', () => watcher.close())

    return watcher
  } catch {
    return { close: () => undefined }
  }
}

const exists = (dir: string, name: string): boolean => {
  try {
    return fs.statSync(path.join(dir, name)).isFile()
  } catch {
    return false
  }
}

const names = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

export function createRefusalGate(deps: RefusalGateDeps) {
  const every = deps.checkEveryMs ?? CHECK_EVERY_MS
  const tokenExists = deps.tokenExists ?? exists
  let stream: { stop: () => void } | null = null
  let timer: NodeJS.Timeout | null = null
  let checking = false
  let closed = false

  const halt = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }

    stream?.stop()
    stream = null
  }

  const schedule = () => {
    if (!closed && stream && !timer) {
      timer = setTimeout(() => void check(), every)
      timer.unref?.()
    }
  }

  const check = async () => {
    timer = null

    if (checking || closed || !stream) {
      return
    }

    checking = true

    try {
      const keep = deps.enabled() && (await deps.live().catch(() => false))

      if (!keep) {
        halt()
      }
    } finally {
      checking = false
      schedule()
    }
  }

  const begin = () => {
    if (closed || stream || !deps.enabled()) {
      return
    }

    stream = deps.start(BACKFILL_SECONDS)
    schedule()
  }

  const watcher = (deps.watch ?? watchDir)(deps.membersDir, name => {
    // A run token was created (rename events also fire for removals: the file must exist now).
    if (name && parseRunToken(name) && tokenExists(deps.membersDir, name)) {
      begin()
    }
  })

  if ((deps.tokenNames ?? names)(deps.membersDir).some(name => parseRunToken(name) !== null)) {
    begin()
  }

  return {
    running: (): boolean => stream !== null,
    stop(): void {
      closed = true
      watcher.close()
      halt()
    }
  }
}
