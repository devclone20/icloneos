// The embedded terminal's PTY host: shell resolution, env scrubbing, session
// registry, and the hermes:terminal:* IPC surface. Extracted from main.ts; the
// factory owns the session map and returns the dispose helpers main.ts needs
// for SSH teardown. findOnPath / logging / connection routing stay injected.
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import nodePty from 'node-pty'

import { resolveTerminalConnectionForSender } from './connection-apply'
import type { TerminalPaneHooks } from './iclone-pane-bus/ipc'
import { paneProcessEnv } from './iclone-pane-bus/pane-env'
import { sealTelemetryEnv } from './iclone-telemetry-seal'
import { codePathEnv, loginShell } from './packaged-env'
import { ensureSpawnHelperExecutable } from './spawn-helper-perms'
import { buildInteractiveSshArgs } from './ssh-connection'
import { buildWindowsInteractiveCommand } from './windows-remote-lifecycle'

type SshEndpoint = Parameters<typeof buildInteractiveSshArgs>[0]

/** The SSH connection a window's terminal rides (`'pending'` from the dep while that backend is still coming up). */
interface SshTerminalTarget {
  scope: string
  ssh: SshEndpoint
}

interface TerminalIpcDeps {
  isWindows: boolean
  findOnPath: (command: string) => null | string
  rememberLog: (line: string) => void
  activeSshTerminalTarget: (webContentsId: number) => SshTerminalTarget | 'pending' | null
  ensureBackend: (webContentsId: number) => Promise<unknown>
  getSshConnectionState: (scope: string) => undefined | { remotePlatform?: string }
  // Every hermes:terminal:* call reaches a login shell; only the app's own
  // renderer windows may drive one (ipc-sender-guard.ts).
  isTrustedSender: (event: IpcMainInvokeEvent, channel: string) => boolean
  /** The pane bus: identity env at spawn, pid once started, and the end of the shell. */
  paneHooks?: TerminalPaneHooks
}

interface TerminalIpcApi {
  disposeTerminalSession: (id: string) => boolean
  disposeTerminalSessionsForSshScope: (scope: string) => void
  disposeAllTerminalSessions: () => void
}

// node-pty 1.1.0 on macOS leaks three fds into this process per shell: the spare
// /dev/ptmx pty_posix_spawn opens to reserve a low fd (its cleanup loop never
// reaches index 0), the parent's copy of the slave tty, and the kqueue its exit
// thread waits on. The spare pins one of the system-wide kern.tty.ptmx_max (511)
// slots for the life of the app, so a long session ends in `posix_spawnp failed`
// here and in every other app. Upstream main closes all three; until that ships
// in a stable release, reclaim them here. The spawn is synchronous, so the fds it
// added are a diff of /dev/fd listings, and each is closed only on an identity
// match. The spare (same device major as the master) and the slave copy (same
// device as ptsName) close at once, as upstream does right after posix_spawn; the
// child already holds its own slave fds. The kqueue closes once the shell exits:
// the exit thread blocks on it until then, and a revoked slave would no longer
// match its identity by that time.
const LEAKY_NODE_PTY_VERSION = '1.1.0'
const EXIT_KQUEUE_WAIT_MS = 5

export interface SpawnFd {
  fd: number
  ino: number
  kqueue: boolean
  rdev: number
}

// The fd primitives the reclaim reads and closes through (a fake table in tests).
export interface SpawnFdSystem {
  close: (fd: number) => void
  fstat: (fd: number) => Pick<fs.Stats, 'ino' | 'isCharacterDevice' | 'isFIFO' | 'rdev'>
  list: () => string[]
  stat: (file: string) => Pick<fs.Stats, 'rdev'>
}

export interface DarwinPtyHandles {
  fd?: unknown
  ptsName?: unknown
}

const darwinSpawnFds: SpawnFdSystem = {
  close: fd => fs.closeSync(fd),
  fstat: fd => fs.fstatSync(fd),
  list: () => fs.readdirSync('/dev/fd'),
  stat: file => fs.statSync(file)
}

let reclaimSpawnFds: boolean | undefined

function nodePtyLeaksSpawnFds() {
  if (reclaimSpawnFds === undefined) {
    try {
      reclaimSpawnFds =
        process.platform === 'darwin' && require('node-pty/package.json').version === LEAKY_NODE_PTY_VERSION
    } catch {
      reclaimSpawnFds = false
    }
  }

  return reclaimSpawnFds
}

function describeSpawnFd(fd: number, sys: SpawnFdSystem): null | SpawnFd {
  try {
    const stat = sys.fstat(fd)
    // A kqueue reports as a FIFO without an inode; a real pipe has one.
    const kqueue = stat.isFIFO() && stat.ino === 0

    return kqueue || stat.isCharacterDevice() ? { fd, ino: stat.ino, kqueue, rdev: stat.rdev } : null
  } catch {
    return null
  }
}

// Keyed by fd but compared by identity: the listing's own directory fd is closed
// by the time it returns, and the spawn may reuse its number.
export function spawnFdSnapshot(sys: SpawnFdSystem = darwinSpawnFds): Map<number, SpawnFd> | null {
  try {
    const fds = new Map<number, SpawnFd>()

    for (const name of sys.list()) {
      const entry = describeSpawnFd(Number(name), sys)

      if (entry) {
        fds.set(entry.fd, entry)
      }
    }

    return fds
  } catch {
    return null
  }
}

const sameSpawnFd = (a: SpawnFd | undefined, b: SpawnFd) =>
  a !== undefined && a.kqueue === b.kqueue && a.rdev === b.rdev && a.ino === b.ino

export function closeSpawnFd(entry: SpawnFd, sys: SpawnFdSystem = darwinSpawnFds) {
  if (!sameSpawnFd(describeSpawnFd(entry.fd, sys) ?? undefined, entry)) {
    return
  }

  try {
    sys.close(entry.fd)
  } catch {
    // Already closed.
  }
}

// Darwin dev_t: 8-bit major, 24-bit minor.
const deviceMajor = (rdev: number) => (rdev >>> 24) & 0xff

// Closes the spare ptmx and the slave copy now; returns the exit thread's kqueue.
export function reclaimDarwinSpawnFds(
  before: Map<number, SpawnFd> | null,
  pty: DarwinPtyHandles,
  sys: SpawnFdSystem = darwinSpawnFds
): SpawnFd[] {
  const master = before && typeof pty.fd === 'number' ? describeSpawnFd(pty.fd, sys) : null

  if (!before || !master || typeof pty.ptsName !== 'string') {
    return []
  }

  let slaveRdev: null | number = null

  try {
    slaveRdev = sys.stat(pty.ptsName).rdev
  } catch {
    // The slave copy stays open; the spare and the kqueue are still matched.
  }

  // The exit thread creates its kqueue as it starts, normally before spawn returns.
  const deadline = Date.now() + EXIT_KQUEUE_WAIT_MS
  let added: SpawnFd[] = []

  do {
    const after = spawnFdSnapshot(sys)
    added = after ? [...after.values()].filter(entry => !sameSpawnFd(before.get(entry.fd), entry)) : []
  } while (!added.some(entry => entry.kqueue) && Date.now() < deadline)

  const kqueues = added.filter(entry => entry.kqueue)

  for (const entry of added) {
    if (entry.kqueue || entry.fd === master.fd) {
      continue
    }

    if (entry.rdev === slaveRdev || deviceMajor(entry.rdev) === deviceMajor(master.rdev)) {
      closeSpawnFd(entry, sys)
    }
  }

  // Two new kqueues in the window cannot be told apart: leave both.
  return kqueues.length === 1 ? kqueues : []
}

/** The renderer surface a PTY belongs to (an Electron WebContents, narrowed for tests). */
interface TerminalOwner {
  id: number
  on(event: string, listener: (...args: any[]) => void): unknown
  once(event: string, listener: (...args: any[]) => void): unknown
}

/**
 * A renderer that reloads, navigates or crashes drops every terminal it was showing — its new page revives the panes
 * with NEW PTYs (reviveBuffer/restoreCwd), so the old ones would live on in main with nobody reading them. Waiting for
 * `destroyed` alone (the window closing) leaked one ptmx per pane per reload: a lab that reloads per skin exhausted
 * the system's 511 ptys and every terminal on the machine failed with `posix_spawnp failed`. Watch each owner once.
 */
export function watchTerminalOwner(
  owner: TerminalOwner,
  disposeOwned: (ownerId: number) => void,
  watched: Set<number>
) {
  if (watched.has(owner.id)) {
    return
  }

  watched.add(owner.id)
  const release = () => disposeOwned(owner.id)

  // Electron 40 passes the details on the event; the positional (url, isInPlace, isMainFrame) form is the fallback.
  owner.on('did-start-navigation', (details: any, _url?: string, isInPlace?: boolean, isMainFrame?: boolean) => {
    const mainFrame = details?.isMainFrame ?? isMainFrame
    const sameDocument = details?.isSameDocument ?? isInPlace

    if (mainFrame && !sameDocument) {
      release()
    }
  })
  owner.on('render-process-gone', release)
  owner.once('destroyed', () => {
    watched.delete(owner.id)
    release()
  })
}

export function registerTerminalIpc({
  isWindows,
  findOnPath,
  rememberLog,
  activeSshTerminalTarget,
  ensureBackend,
  getSshConnectionState,
  isTrustedSender,
  paneHooks
}: TerminalIpcDeps): TerminalIpcApi {
  const terminalSessions = new Map()
  const watchedOwners = new Set<number>()

  function disposeTerminalSessionsForOwner(ownerId: number) {
    for (const [id, info] of [...terminalSessions.entries()]) {
      if (info.webContentsId === ownerId) {
        disposeTerminalSession(id)
      }
    }
  }

  function isExecutableFile(filePath: string | null | undefined) {
    if (!filePath || !path.isAbsolute(filePath)) {
      return false
    }

    try {
      fs.accessSync(filePath, fs.constants.X_OK)

      return true
    } catch {
      return false
    }
  }

  function posixShellSpec(shellPath: string) {
    const shellName = path.basename(shellPath)
    const interactiveArgs = shellName.includes('zsh') || shellName.includes('bash') ? ['-il'] : ['-i']

    return { args: interactiveArgs, command: shellPath, name: shellName }
  }

  // Windows PowerShell 5.1 ships at a fixed System32 path on every Windows box;
  // prefer it only after PowerShell 7+ (`pwsh`).
  function windowsPowerShellPath() {
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    const builtin = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

    return isExecutableFile(builtin) ? builtin : findOnPath('powershell.exe')
  }

  // Map a resolved shell path to its spawn spec, picking interactive flags by
  // family: PowerShell drops its logo banner (so the prompt sits flush like the
  // POSIX shells), cmd needs nothing, and everything else (zsh/bash/fish/sh…)
  // gets POSIX interactive-login flags.
  function shellSpecFor(shellPath: string) {
    const name = path.basename(shellPath).toLowerCase()

    if (name.startsWith('pwsh') || name.startsWith('powershell')) {
      return { args: ['-NoLogo'], command: shellPath, name }
    }

    if (name.startsWith('cmd')) {
      return { args: [], command: shellPath, name }
    }

    return posixShellSpec(shellPath)
  }

  // Best installed Windows shell: PowerShell 7+ (`pwsh`), then Windows PowerShell
  // 5.1, then comspec/cmd.exe as the universal fallback.
  function windowsShellSpec() {
    const command =
      findOnPath('pwsh.exe') || findOnPath('pwsh') || windowsPowerShellPath() || process.env.COMSPEC || 'cmd.exe'

    return shellSpecFor(command)
  }

  // Resolve the interactive shell for the embedded terminal: an explicit user
  // override wins, otherwise auto-detect the best one installed for the platform.
  function terminalShellCommand() {
    // HERMES_DESKTOP_SHELL is the cross-platform escape hatch (a path or a bare
    // name on PATH); $SHELL is honored on POSIX, where it's the user's canonical
    // choice, but ignored on Windows, where it's usually a stray MSYS/Git path
    // node-pty can't spawn natively. Packaged builds ignore both and use the
    // account's login shell (packaged-env.ts).
    const override = (codePathEnv('HERMES_DESKTOP_SHELL') || (isWindows ? '' : loginShell()) || '').trim()

    if (override) {
      const resolved = isExecutableFile(override) ? override : findOnPath(override)

      if (resolved) {
        return shellSpecFor(resolved)
      }
    }

    if (isWindows) {
      return windowsShellSpec()
    }

    const shellPath = ['/bin/zsh', '/bin/bash', '/bin/sh'].find(candidate => isExecutableFile(candidate))

    return posixShellSpec(shellPath || '/bin/sh')
  }

  function safeTerminalCwd(cwd: unknown) {
    const candidate = path.resolve(String(cwd || app.getPath('home')))

    try {
      const stat = fs.statSync(candidate)

      return stat.isDirectory() ? candidate : path.dirname(candidate)
    } catch {
      return app.getPath('home')
    }
  }

  function terminalShellEnv() {
    const env = { ...process.env }

    // Electron is commonly launched through `npm run dev`; do not leak npm's
    // managed prefix into a user's interactive shell (nvm/proto warn loudly).
    for (const key of Object.keys(env)) {
      if (key === 'npm_config_prefix' || key.startsWith('npm_config_') || key.startsWith('npm_package_')) {
        delete env[key]
      }
    }

    // Strip color/theme-detection vars that ride along when Electron is launched
    // from a non-tty agent shell (Cursor's runner sets NO_COLOR/FORCE_COLOR=0
    // /TERM=dumb; some terminals set COLORFGBG which would flip Hermes' TUI into
    // light-mode). Our PTY is a real xterm-compat terminal — force truecolor.
    delete env.NO_COLOR
    delete env.FORCE_COLOR
    delete env.COLORFGBG

    env.COLORTERM = 'truecolor'
    env.LC_CTYPE = env.LC_CTYPE || 'UTF-8'
    env.TERM = 'xterm-256color'
    env.TERM_PROGRAM = 'Hermes'
    env.TERM_PROGRAM_VERSION = app.getVersion()

    // Let a hermes/--tui launched in this pane know it's embedded in the desktop
    // GUI (build_environment_hints surfaces this). Distinct from HERMES_DESKTOP,
    // which marks the agent *backend* and gates cron/gateway behavior.
    env.HERMES_DESKTOP_TERMINAL = '1'

    return env
  }

  function terminalChannel(id: string, suffix: string) {
    return `hermes:terminal:${id}:${suffix}`
  }

  // Best-effort read of a live PTY child's current working directory so a
  // reopened tab can restart the shell where the user last `cd`'d, instead of the
  // tab's original launch dir. Shell-agnostic (no prompt/OSC config needed) on
  // POSIX; Windows has no cheap per-process cwd query without a native module, so
  // it returns null and the caller falls back to the launch cwd.
  function readProcessCwd(pid: unknown) {
    return new Promise(resolve => {
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        resolve(null)

        return
      }

      if (process.platform === 'linux') {
        fs.promises
          .readlink(`/proc/${pid}/cwd`)
          .then(target => resolve(target || null))
          .catch(() => resolve(null))

        return
      }

      if (process.platform === 'darwin') {
        // lsof ships with macOS; -Fn emits the cwd fd's path on an `n<path>` line.
        execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 2000 }, (err, stdout) => {
          if (err) {
            resolve(null)

            return
          }

          const line = String(stdout || '')
            .split('\n')
            .find(entry => entry.startsWith('n'))

          resolve(line ? line.slice(1) : null)
        })

        return
      }

      resolve(null)
    })
  }

  function disposeTerminalSession(id: string) {
    const sessionInfo = terminalSessions.get(id)

    if (!sessionInfo) {
      return false
    }

    terminalSessions.delete(id)

    // Closed by the app, not killed from outside: the bus records `exited`,
    // and the SIGHUP the kill below raises is not mistaken for a death.
    if (sessionInfo.paneId) {
      paneHooks?.exited(sessionInfo.paneId, { code: null, signal: null })
    }

    try {
      sessionInfo.pty.kill()
    } catch {
      // Process may already be gone.
    }

    return true
  }

  // SSH teardown: close every pane whose PTY rode the disconnected tunnel.
  function disposeTerminalSessionsForSshScope(scope: string) {
    for (const [id, info] of [...terminalSessions.entries()]) {
      if (info.sshScope === scope) {
        disposeTerminalSession(id)
      }
    }
  }

  // App shutdown: kill every open PTY before environment teardown.
  function disposeAllTerminalSessions() {
    for (const id of [...terminalSessions.keys()]) {
      disposeTerminalSession(id)
    }
  }

  // node-pty's published tarball ships the POSIX `spawn-helper` without an exec
  // bit; the dev flow resolves node-pty straight from node_modules (nothing
  // chmods it there), so the first terminal spawn dies with `posix_spawnp
  // failed`. Restore the bit once, lazily, right before the first spawn. Packaged
  // builds already stage an executable copy, so this is a no-op there.
  let _spawnHelperEnsured = false

  function ensureNodePtySpawnHelper() {
    if (_spawnHelperEnsured || isWindows) {
      return
    }

    _spawnHelperEnsured = true

    try {
      const nodePtyRoot = path.dirname(require.resolve('node-pty/package.json'))
      const { fixed, errors } = ensureSpawnHelperExecutable(nodePtyRoot)

      for (const helperPath of fixed) {
        rememberLog(`[terminal] restored +x on node-pty spawn-helper: ${helperPath}`)
      }

      for (const failure of errors) {
        rememberLog(`[terminal] could not chmod spawn-helper ${failure.path}: ${failure.error}`)
      }
    } catch (error) {
      rememberLog(
        `[terminal] spawn-helper exec check skipped: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  ipcMain.handle('hermes:terminal:start', async (event, payload = {}) => {
    if (!isTrustedSender(event, 'hermes:terminal:start')) {
      throw new Error('Terminal is only available to the app window')
    }

    ensureNodePtySpawnHelper()

    const id = crypto.randomUUID()
    const { args, command, name } = terminalShellCommand()
    const cwd = safeTerminalCwd(payload?.cwd)
    const cols = Math.max(2, Number.parseInt(String(payload?.cols || 80), 10) || 80)
    const rows = Math.max(2, Number.parseInt(String(payload?.rows || 24), 10) || 24)

    const sshTarget = await resolveTerminalConnectionForSender(event.sender.id, activeSshTerminalTarget, ensureBackend)

    const remote = !!sshTarget
    const remoteState = remote ? getSshConnectionState(sshTarget.scope) : null

    // Throws before any process exists when the pane must not start (remote tmux while it is off).
    const pane =
      paneHooks?.prepare(
        payload?.pane,
        remote
          ? { remote: true, scope: sshTarget.scope, host: sshTarget.ssh.host }
          : { remote: false, scope: 'local', host: null }
      ) ?? null

    // No ICLONE_PANE_* ever reaches tmux (its server would keep it for every later session) or ssh.
    const env = paneProcessEnv(terminalShellEnv(), pane)
    const tmuxBinary = pane?.tmux && !remote ? findOnPath('tmux') : null

    if (pane?.tmux && !remote && !tmuxBinary) {
      paneHooks?.exited(pane.paneId, { code: null, signal: null })

      throw new Error('tmux is not installed on this Mac. To install it yourself: brew install tmux')
    }

    const remoteCommand =
      remoteState?.remotePlatform === 'Windows'
        ? buildWindowsInteractiveCommand(String(payload?.cwd || '').trim())
        : (pane?.tmux?.remoteCommand ?? undefined)

    const fdsBeforeSpawn = nodePtyLeaksSpawnFds() ? spawnFdSnapshot() : null

    const ptyProcess = remote
      ? nodePty.spawn(
          process.platform === 'win32'
            ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
            : 'ssh',
          buildInteractiveSshArgs(sshTarget.ssh, String(payload?.cwd || '').trim(), undefined, remoteCommand),
          { cols, cwd: app.getPath('home'), env: sealTelemetryEnv(env), name: 'xterm-256color', rows }
        )
      : tmuxBinary && pane?.tmux
        ? nodePty.spawn(tmuxBinary, pane.tmux.localArgs, {
            cols,
            cwd,
            env: sealTelemetryEnv(env),
            name: 'xterm-256color',
            rows
          })
        : nodePty.spawn(command, args, { cols, cwd, env: sealTelemetryEnv(env), name: 'xterm-256color', rows })

    const exitFds = reclaimDarwinSpawnFds(fdsBeforeSpawn, ptyProcess as DarwinPtyHandles)

    terminalSessions.set(id, {
      pty: ptyProcess,
      webContentsId: event.sender.id,
      ...(pane ? { paneId: pane.paneId } : {}),
      ...(remote ? { sshScope: sshTarget.scope, remoteCwd: String(payload?.cwd || '') } : {})
    })

    if (pane) {
      paneHooks?.started(pane.paneId, ptyProcess.pid)

      if (pane.initialInput && !pane.tmux) {
        ptyProcess.write(pane.initialInput)
      }
    }

    const send = (suffix: string, payload: unknown) => {
      if (event.sender.isDestroyed()) {
        return
      }

      event.sender.send(terminalChannel(id, suffix), payload)
    }

    ptyProcess.onData(data => send('data', data))
    ptyProcess.onExit(({ exitCode, signal }) => {
      terminalSessions.delete(id)

      if (pane) {
        paneHooks?.exited(pane.paneId, { code: exitCode, signal: signal || null })
      }

      exitFds.forEach(entry => closeSpawnFd(entry))
      send('exit', { code: exitCode, signal: signal || null })
    })
    watchTerminalOwner(event.sender, disposeTerminalSessionsForOwner, watchedOwners)

    return { cwd: remote ? null : cwd, id, shell: pane?.tmux ? 'tmux' : remote ? 'ssh' : name }
  })

  ipcMain.handle('hermes:terminal:write', (event, id, data) => {
    if (!isTrustedSender(event, 'hermes:terminal:write')) {
      return false
    }

    const sessionInfo = terminalSessions.get(String(id || ''))

    if (!sessionInfo) {
      return false
    }

    sessionInfo.pty.write(String(data || ''))

    return true
  })

  ipcMain.handle('hermes:terminal:resize', (event, id, size = {}) => {
    if (!isTrustedSender(event, 'hermes:terminal:resize')) {
      return false
    }

    const sessionInfo = terminalSessions.get(String(id || ''))

    if (!sessionInfo) {
      return false
    }

    const cols = Math.max(2, Number.parseInt(String(size?.cols || 80), 10) || 80)
    const rows = Math.max(2, Number.parseInt(String(size?.rows || 24), 10) || 24)

    sessionInfo.pty.resize(cols, rows)

    return true
  })
  ipcMain.handle('hermes:terminal:cwd', async (event, id) => {
    if (!isTrustedSender(event, 'hermes:terminal:cwd')) {
      return null
    }

    const sessionInfo = terminalSessions.get(String(id || ''))

    if (!sessionInfo) {
      return null
    }

    return sessionInfo.sshScope !== undefined ? null : readProcessCwd(sessionInfo.pty.pid)
  })

  ipcMain.handle('hermes:terminal:dispose', (event, id) =>
    isTrustedSender(event, 'hermes:terminal:dispose') ? disposeTerminalSession(String(id || '')) : false
  )

  return { disposeTerminalSession, disposeTerminalSessionsForSshScope, disposeAllTerminalSessions }
}
