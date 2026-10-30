import type { SshEndpoint, SshExec } from './ssh-connection'

/** The SSH link a window's terminal rides (main/backend.ts activeSshTerminalTarget, when not 'pending' or null). */
export interface TerminalSshTarget {
  scope: string
  ssh: SshEndpoint
}

/** The teardown steps a connection change runs, injected by main so the order is unit-testable. */
interface ConnectionChangeSteps<Scope> {
  cancelAndWait: (scope: Scope) => Promise<unknown>
  isPrimary: boolean
  rehomePrimary?: (() => Promise<unknown>) | null
  scope: Scope
  sendApplied: () => void
  stopPool: (scope: Scope) => void
  teardownPrimary: () => Promise<unknown>
  teardownSsh: (scope: Scope) => Promise<unknown>
}

/** cleanupRemote execs on the same transport that teardown then unforwards and closes. */
type SshTeardownTransport = SshExec & {
  cancelForward: (localPort: number, remotePort: number) => Promise<unknown>
  close: () => Promise<unknown>
}

interface SshTeardownState {
  ssh: SshTeardownTransport
  ownershipId: string
  localPort?: number | null
  remotePort?: number | null
}

async function applyConnectionChange<Scope>({
  cancelAndWait,
  isPrimary,
  rehomePrimary = null,
  scope,
  sendApplied,
  stopPool,
  teardownPrimary,
  teardownSsh
}: ConnectionChangeSteps<Scope>) {
  await cancelAndWait(scope)
  await teardownSsh(scope)

  if (!isPrimary) {
    stopPool(scope)

    return
  }

  if (rehomePrimary) {
    await rehomePrimary()

    return
  }

  await teardownPrimary()
  sendApplied()
}

function commitConnectionFailure(current: unknown, starting: unknown, commit: () => void) {
  if (current !== starting) {
    return false
  }

  commit()

  return true
}

async function resolveTerminalConnection<Target>(
  getTarget: () => Target | 'pending',
  ensureBackend: () => Promise<unknown>
): Promise<Target> {
  let target = getTarget()

  if (target !== 'pending') {
    return target
  }

  await ensureBackend()
  target = getTarget()

  if (target === 'pending') {
    throw new Error('Remote connection is not ready yet. Try again in a moment.')
  }

  return target
}

async function resolveTerminalConnectionForSender<Target>(
  webContentsId: number,
  getTarget: (webContentsId: number) => Target | 'pending',
  ensureBackend: (webContentsId: number) => Promise<unknown>
) {
  return resolveTerminalConnection(
    () => getTarget(webContentsId),
    () => ensureBackend(webContentsId)
  )
}

async function teardownSshState(
  state: SshTeardownState,
  { cleanupRemote }: { cleanupRemote: (ssh: SshTeardownTransport, ownershipId: string) => Promise<unknown> }
) {
  // Remote process first, while the SSH channel can still exec kill.
  // Then drop the local forward and close the transport. Each step is
  // best-effort so a failed remote cleanup cannot trap Cmd+Q (#91668).
  try {
    await cleanupRemote(state.ssh, state.ownershipId)
  } catch {
    // Remote teardown is best-effort; always release the local tunnel and SSH transport.
  }

  try {
    if (state.localPort && state.remotePort) {
      await state.ssh.cancelForward(state.localPort, state.remotePort)
    }
  } catch {
    // Best effort; closing the transport below drops any remaining forwards.
  }

  try {
    await state.ssh.close()
  } catch {
    // The app must still be able to quit when SSH teardown fails.
  }
}

export {
  applyConnectionChange,
  commitConnectionFailure,
  resolveTerminalConnection,
  resolveTerminalConnectionForSender,
  teardownSshState
}
