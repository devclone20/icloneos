/**
 * The confinement launcher's lifecycle, as main sees it. Under the runtime profile Hermes cannot apply a second
 * sandbox (profiles do not nest), so every confined command is started by a launcher that main runs OUTSIDE any
 * sandbox: the runtime's own Python with `-I -S`, the launcher script from the runtime's plugin folder, and exactly
 * the env below — nothing inherited from main. The env names the runtime profile's own read and write roots
 * (runtime-profile.ts `runtimeRoots`): the launcher admits a widened helper profile only inside them, and one started
 * without them admits no widened profile at all. Python owns both ends of the socket protocol; main only starts the
 * launcher, waits for it to say it is ready, restarts it if it dies, and stops it.
 *
 * - Ready = the stdout line `ICLONE-LAUNCHER-READY <pid>` (the launcher's own pid) within READY_TIMEOUT_MS; anything
 *   else is killed and reported `down`.
 * - Never two launchers: a start while one is starting joins it; a start while one is up returns `up`.
 * - An unexpected exit is restarted with backoff, at most MAX_RESTARTS per RESTART_WINDOW_MS; past that the launcher
 *   stays down (logged once) until the next explicit start.
 * - `stop` sends SIGTERM, then SIGKILL after STOP_GRACE_MS; idempotent. The launcher also exits by itself when main
 *   dies (it checks its parent), so it is never orphaned.
 * - The socket's directory is a real directory, created 0700 (re-tightened if it existed): a symlink there refuses
 *   the start rather than putting the socket somewhere else.
 */
import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { RuntimeRoots } from './runtime-profile'

export const READY_TIMEOUT_MS = 5_000
export const STOP_GRACE_MS = 2_000
export const MAX_RESTARTS = 3
export const RESTART_WINDOW_MS = 60_000
/** First restart delay; doubled for each restart still inside the window. */
export const RESTART_BACKOFF_MS = 500

export const LAUNCHER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const READY_RE = /^ICLONE-LAUNCHER-READY (\d+)$/

export type LauncherState = 'down' | 'up'

/** What the launcher needs of a child process (node's ChildProcess, or a fake in tests). */
export type LauncherChild = Pick<
  ChildProcess,
  'exitCode' | 'kill' | 'on' | 'once' | 'pid' | 'signalCode' | 'stderr' | 'stdout'
>

export type LauncherSpawn = (command: string, args: string[], options: SpawnOptions) => LauncherChild

export interface LauncherOptions {
  /** The runtime's Python (the interpreter main already asks the kernel with). */
  python: string
  /** `<runtimeRoot>/plugins/iclone-confinement/launcher.py`. */
  script: string
  socketPath: string
  journalDir: string
  /** Main's own answers, never its environment: a packed app started from the Finder has no HERMES_HOME there. */
  home: string
  hermesHome: string
  /** The profile spec main generated (read at every start, so a restart carries the current one). */
  spec: string | (() => string)
  /** The runtime profile's read and write roots (read at every start, like the spec). */
  roots: RuntimeRoots | (() => RuntimeRoots)
  log: (line: string) => void
  spawn?: LauncherSpawn
  now?: () => number
}

export interface Launcher {
  start(): Promise<LauncherState>
  stop(): Promise<void>
  state(): LauncherState
}

/** The launcher's whole environment: the contract's variables, nothing else. */
export function launcherEnv(
  options: Pick<LauncherOptions, 'hermesHome' | 'home' | 'journalDir' | 'socketPath'> & { roots: RuntimeRoots; spec: string }
) {
  return {
    ICLONE_CONFINEMENT_SPEC: options.spec,
    ICLONE_LAUNCHER_SOCKET: options.socketPath,
    ICLONE_LAUNCHER_JOURNAL_DIR: options.journalDir,
    ICLONE_LAUNCHER_READ_ROOTS: JSON.stringify(options.roots.reads),
    ICLONE_LAUNCHER_WRITE_ROOTS: JSON.stringify(options.roots.writes),
    ICLONE_LAUNCHER_GRANT_ROOTS: JSON.stringify(options.roots.grants),
    // S10: where a real user's CuaDriver may be. Never a path to run: driver_door.py checks the signature of what it finds.
    ICLONE_LAUNCHER_HOME: options.home,
    ICLONE_LAUNCHER_HERMES_HOME: options.hermesHome,
    PATH: LAUNCHER_PATH,
    LANG: 'C'
  }
}

/** A private directory for the socket and the journal: 0700, ours, never a symlink. Throws otherwise. */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  const stat = fs.lstatSync(dir)

  if (!stat.isDirectory()) {
    throw new Error(`${dir} is not a directory`)
  }

  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${dir} is not owned by this user`)
  }

  if ((stat.mode & 0o777) !== 0o700) {
    fs.chmodSync(dir, 0o700)
  }
}

const alive = (child: LauncherChild | null): child is LauncherChild =>
  child !== null && child.exitCode === null && child.signalCode === null

export function createLauncher(options: LauncherOptions): Launcher {
  const spawn: LauncherSpawn =
    options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions))

  const now = options.now ?? Date.now
  const spec = () => (typeof options.spec === 'function' ? options.spec() : options.spec)
  const roots = () => (typeof options.roots === 'function' ? options.roots() : options.roots)

  let child: LauncherChild | null = null
  let current: LauncherState = 'down'
  let starting: Promise<LauncherState> | null = null
  let stopping: Promise<void> | null = null
  /** True between an explicit start and an explicit stop: an exit inside it is unexpected. */
  let wanted = false
  let restarts: number[] = []
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let gaveUp = false

  const clearRestart = () => {
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
  }

  const scheduleRestart = () => {
    const at = now()

    restarts = restarts.filter(t => at - t < RESTART_WINDOW_MS)

    if (restarts.length >= MAX_RESTARTS) {
      if (!gaveUp) {
        gaveUp = true
        options.log(
          `[confinement] launcher stopped ${MAX_RESTARTS} times within a minute; it stays down and confined commands are refused until it is started again`
        )
      }

      return
    }

    const delay = RESTART_BACKOFF_MS * 2 ** restarts.length

    restarts.push(at)
    clearRestart()
    restartTimer = setTimeout(() => {
      restartTimer = null

      if (wanted && !starting && !alive(child)) {
        void launch()
      }
    }, delay)
  }

  const launch = (): Promise<LauncherState> => {
    starting = new Promise<LauncherState>(resolve => {
      let settled = false
      let failed = false
      let readyTimer: ReturnType<typeof setTimeout> | undefined
      let launched: LauncherChild

      const settle = (state: LauncherState) => {
        if (!settled) {
          settled = true
          clearTimeout(readyTimer)
          current = state
          starting = null
          resolve(state)
        }
      }

      // One failure per launch, however it is reported (error, exit, both): restarted while still wanted.
      const fail = () => {
        if (!failed) {
          failed = true

          if (wanted && stopping === null) {
            scheduleRestart()
          }
        }
      }

      try {
        ensurePrivateDir(path.dirname(options.socketPath))
        ensurePrivateDir(options.journalDir)
        launched = spawn(options.python, ['-I', '-S', options.script], {
          env: launcherEnv({
            hermesHome: options.hermesHome,
            home: options.home,
            journalDir: options.journalDir,
            roots: roots(),
            socketPath: options.socketPath,
            spec: spec()
          }),
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (error) {
        options.log(`[confinement] launcher could not start: ${(error as Error).message}`)
        settle('down')
        fail()

        return
      }

      child = launched

      readyTimer = setTimeout(() => {
        options.log(`[confinement] launcher was not ready within ${READY_TIMEOUT_MS / 1000} s; stopping it`)
        settle('down')
        void terminate(launched)
      }, READY_TIMEOUT_MS)

      let pending = ''

      launched.stdout?.on('data', (chunk: Buffer | string) => {
        pending += String(chunk)

        let newline = pending.indexOf('\n')

        while (newline >= 0) {
          const line = pending.slice(0, newline).trim()
          pending = pending.slice(newline + 1)
          newline = pending.indexOf('\n')

          const ready = READY_RE.exec(line)

          if (ready && !settled) {
            if (launched.pid !== undefined && Number(ready[1]) !== launched.pid) {
              options.log(
                `[confinement] launcher announced pid ${ready[1]}, not its own (${launched.pid}); stopping it`
              )
              settle('down')
              void terminate(launched)
            } else {
              options.log(`[confinement] launcher ready (pid ${launched.pid ?? ready[1]})`)
              settle('up')
            }
          }
        }

        // A line that never ends: keep the buffer bounded.
        if (pending.length > 4096) {
          pending = pending.slice(-4096)
        }
      })
      launched.stderr?.on('data', (chunk: Buffer | string) => {
        for (const line of String(chunk).split('\n')) {
          if (line.trim()) {
            options.log(`[confinement] launcher: ${line.trim()}`)
          }
        }
      })
      launched.once('error', error => {
        options.log(`[confinement] launcher failed: ${error.message}`)

        if (child === launched && !alive(launched)) {
          child = null
        }

        settle('down')
        fail()
      })
      launched.once('exit', (code, signal) => {
        if (child === launched) {
          child = null
          current = 'down'
        }

        if (!settled) {
          options.log(`[confinement] launcher exited before it was ready (${signal ?? code})`)
          settle('down')
        } else if (wanted && stopping === null && !failed) {
          options.log(`[confinement] launcher exited unexpectedly (${signal ?? code}); restarting`)
        }

        fail()
      })
    })

    return starting
  }

  /** SIGTERM now, SIGKILL after the grace period if it is still alive. */
  const terminate = (target: LauncherChild): Promise<void> =>
    new Promise(resolve => {
      if (!alive(target)) {
        resolve()

        return
      }

      const force = setTimeout(() => {
        if (alive(target)) {
          target.kill('SIGKILL')
        }
      }, STOP_GRACE_MS)

      target.once('exit', () => {
        clearTimeout(force)
        resolve()
      })
      target.kill('SIGTERM')
    })

  return {
    start(): Promise<LauncherState> {
      if (stopping) {
        return stopping.then(() => this.start())
      }

      wanted = true
      gaveUp = false
      clearRestart()

      if (starting) {
        return starting
      }

      if (alive(child) && current === 'up') {
        return Promise.resolve('up')
      }

      restarts = []

      return launch()
    },
    stop(): Promise<void> {
      wanted = false
      clearRestart()

      if (stopping) {
        return stopping
      }

      const target = child

      if (!alive(target)) {
        current = 'down'

        return Promise.resolve()
      }

      stopping = terminate(target).then(() => {
        stopping = null
        current = 'down'
      })

      return stopping
    },
    state: () => (alive(child) ? current : 'down')
  }
}
