// Ownership of backend child processes: claims, identity checks, orphan reaping and the backend lock.
import { type ChildProcess, execFileSync } from 'node:child_process'
import fs from 'node:fs'

import { errorMessage } from '../../src/iclone-shared/errors'
import { execText, isPidOnlyStartMarker, processStartMarker } from '../backend-claim'
import {
  backendCommandMatches,
  type BackendIdentity,
  type BackendOwnershipEntry,
  createBackendOwnership
} from '../backend-ownership'
import { writeFileAtomicSync } from '../lib/atomic-write'
import { createParentStartMarkerResolver } from '../parent-process-identity'
import { hiddenWindowsChildOptions } from '../windows-child-options'

import { IS_WINDOWS } from './env'
import { rememberLog } from './log'
import { DESKTOP_BACKEND_OWNERSHIP_PATH } from './paths'

let backendOrphanReapPromise: Promise<void> | null = null

// Force-kill the entire process TREE rooted at each PID. Node's child.kill()
// only signals the direct child, so on Windows a backend `hermes.exe` that
// spawned its own grandchildren (a `hermes` REPL, a pty terminal session, the
// gateway) would survive and keep the venv shim locked. taskkill /T /F reaps
// the whole tree synchronously. Windows-only: this is called solely from the
// Windows shim-unlock path, and the backend is NOT spawned detached (so it's
// not a process-group leader — a POSIX negative-pgid kill would be meaningless
// here anyway). POSIX teardown stays with the existing before-quit SIGTERM.
export function forceKillProcessTree(pid: number) {
  if (!IS_WINDOWS) {
    return
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    return
  }

  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], hiddenWindowsChildOptions({ stdio: 'ignore' }))
  } catch {
    // Already gone, or no permission — best effort; the unlock wait below is
    // the real gate.
  }
}

function writeBackendOwnership(contents: string | Uint8Array<ArrayBufferLike>) {
  writeFileAtomicSync(DESKTOP_BACKEND_OWNERSHIP_PATH, contents, { mode: 0o600 })
}

// execText and processStartMarker moved to backend-claim.ts (#93608) so the
// claim/probe policy is testable — including on Windows CI with real
// PowerShell — without booting Electron. main.ts calls through the module.

async function backendCommandForPid(pid: number) {
  try {
    const command = IS_WINDOWS ? 'powershell.exe' : 'ps'

    const args = IS_WINDOWS
      ? [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`
        ]
      : ['-p', String(pid), '-o', 'command=']

    return (await execText(command, args)) || null
  } catch {
    return null
  }
}

async function processIdentityMatches(identity: { startMarker: unknown; pid: number }) {
  // Degraded PID-only identity (#93608): the start-marker probe failed while
  // the child was verifiably alive, so only PID liveness can be checked here.
  // backendIdentityMatches layers the command-line check on top before
  // anything destructive relies on the answer.
  if (isPidOnlyStartMarker(identity.startMarker)) {
    try {
      process.kill(identity.pid, 0)

      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code

      return code === 'ESRCH' || code === 'ENOENT' ? false : code === 'EPERM' ? true : undefined
    }
  }

  try {
    return (await processStartMarker(identity.pid)) === identity.startMarker
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error as NodeJS.ErrnoException)?.code === 'ESRCH'
      ? false
      : undefined
  }
}

async function backendIdentityMatches(identity: BackendIdentity) {
  const processMatches = await processIdentityMatches(identity)

  if (processMatches !== true) {
    return processMatches
  }

  const command = await backendCommandForPid(identity.pid)

  return command === null ? undefined : backendCommandMatches(command)
}

// True when the recorded parent Electron is still running (same PID AND start
// marker); false when it is gone or its PID was reused; undefined when the
// ownership record predates parent tracking. Undefined deliberately falls back
// to the pre-parent reap behaviour so legacy orphan cleanup keeps working.
async function backendParentMatches(entry: BackendOwnershipEntry) {
  if (
    typeof entry.parentPid !== 'number' ||
    !Number.isInteger(entry.parentPid) ||
    typeof entry.parentStartMarker !== 'string' ||
    !entry.parentStartMarker
  ) {
    return undefined
  }

  try {
    return (await processStartMarker(entry.parentPid)) === entry.parentStartMarker
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error as NodeJS.ErrnoException)?.code === 'ESRCH'
      ? false
      : undefined
  }
}

async function stopOwnedBackend(identity: BackendIdentity) {
  if ((await processIdentityMatches(identity)) !== true) {
    return
  }

  if (IS_WINDOWS) {
    forceKillProcessTree(identity.pid)
  } else {
    try {
      process.kill(-identity.pid, 'SIGTERM')
    } catch {
      try {
        process.kill(identity.pid, 'SIGTERM')
      } catch {
        return
      }
    }

    const deadline = Date.now() + 1500

    while (Date.now() < deadline) {
      if ((await processIdentityMatches(identity)) !== true) {
        return
      }

      await new Promise(resolve => setTimeout(resolve, 50))
    }

    // Revalidate immediately before escalation so PID reuse cannot target a
    // replacement process.
    if ((await processIdentityMatches(identity)) === true) {
      try {
        process.kill(-identity.pid, 'SIGKILL')
      } catch {
        process.kill(identity.pid, 'SIGKILL')
      }
    }
  }

  await new Promise(resolve => setTimeout(resolve, 50))
  const remaining = await processIdentityMatches(identity)

  if (remaining !== false) {
    throw new Error(`Backend PID ${identity.pid} did not stop cleanly.`)
  }
}

export const backendOwnership = createBackendOwnership({
  matchesIdentity: backendIdentityMatches,
  matchesParent: backendParentMatches,
  stop: stopOwnedBackend,
  store: {
    read: () => {
      try {
        return fs.readFileSync(DESKTOP_BACKEND_OWNERSHIP_PATH, 'utf8')
      } catch {
        return null
      }
    },
    write: writeBackendOwnership,
    // A corrupt ownership file is moved aside instead of being rewritten
    // away by the reap sweep — its records are the only pointer to any
    // still-running backends it described (#89298).
    quarantine: () => {
      const parked = `${DESKTOP_BACKEND_OWNERSHIP_PATH}.corrupt`

      try {
        fs.renameSync(DESKTOP_BACKEND_OWNERSHIP_PATH, parked)
        rememberLog(`Backend ownership file was unreadable; moved to ${parked}`)
      } catch {
        // Nothing to move (or no permission) — the sweep already skipped.
      }
    }
  }
})

export const desktopParentStartMarker = createParentStartMarkerResolver({
  load: () => processStartMarker(process.pid),
  onError: error => {
    const detail = error instanceof Error ? error.message : String(error)

    rememberLog(
      `Could not resolve the Desktop process start marker; starting the backend with PID-only parent tracking: ${detail}`
    )
  }
})

/** A spawned backend; `claimBackendChild` stamps the ownership entry on the handle. */
export type OwnedBackendChild = ChildProcess & { hermesBackendIdentity?: BackendOwnershipEntry }

export function releaseBackendChild(child: OwnedBackendChild | null | undefined) {
  const identity = child?.hermesBackendIdentity

  if (!identity) {
    return
  }

  try {
    backendOwnership.release(identity)
  } catch (error) {
    rememberLog(`Could not release backend ownership for PID ${identity.pid}: ${errorMessage(error)}`)
  }
}

export function reapOrphanedBackendsOnce() {
  if (!backendOrphanReapPromise) {
    backendOrphanReapPromise = backendOwnership
      .reapOrphans()
      .then(pids => {
        if (pids.length) {
          rememberLog(`Reaped orphaned desktop backend PID(s): ${pids.join(', ')}`)
        }
      })
      .catch(error => {
        backendOrphanReapPromise = null
        throw error
      })
  }

  return backendOrphanReapPromise
}
