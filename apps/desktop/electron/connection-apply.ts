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

/**
 * The reap's own cap inside the quit's 6 s SSH teardown race (main.ts): a serve that rides out SIGTERM costs the reap
 * 5 s of TERM wait plus up to 2 s of SIGKILL wait plus the ownership probe, which can overrun 6 s. Capped here, the
 * forward is cancelled and the transport closed inside the race. The SIGKILL is sent at about 5.1 s, before the cap.
 */
export const REMOTE_REAP_CAP_MS = 5_500

/** The reap, or 'timed out' once its cap passed (the reap's own later settlement, either way, is ignored). */
function withReapCap(work: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined

  const cap = new Promise<'timed out'>(resolve => {
    timer = setTimeout(() => resolve('timed out'), ms)
  })

  return Promise.race([work, cap]).finally(() => clearTimeout(timer))
}

/**
 * The one desktop-log line a remote serve reap gives, on every path that reaps (the quit's teardown, and a bootstrap
 * the quit aborted after its spawn): the outcome token, or the failure by error class and kind only. Never a message:
 * it may carry a host, a path or a command.
 */
function remoteReapLogLine(result: { outcome: unknown } | { error: unknown }): string {
  if ('outcome' in result) {
    return `[ssh] remote serve reap: ${typeof result.outcome === 'string' ? result.outcome : 'done'}`
  }

  const { error } = result
  const kind = (error as { kind?: unknown } | null)?.kind

  return `[ssh] remote serve reap: error (${error instanceof Error ? error.name : 'unknown'}${typeof kind === 'string' ? `, ${kind}` : ''})`
}

/** An error's class for a log line: never its message (it may carry a host, a path or a command). */
const errorClass = (error: unknown) => (error instanceof Error ? error.name : 'unknown')

async function teardownSshState(
  state: SshTeardownState,
  {
    cleanupRemote,
    log,
    reapCapMs = REMOTE_REAP_CAP_MS
  }: {
    cleanupRemote: (ssh: SshTeardownTransport, ownershipId: string) => Promise<unknown>
    /** One line per reap: its outcome, or the failure (error class and kind only: no host, path or command). */
    log?: (line: string) => void
    reapCapMs?: number
  }
) {
  // Remote process first, while the SSH channel can still exec kill.
  // Then drop the local forward and close the transport. Each step is
  // best-effort so a failed remote cleanup cannot trap Cmd+Q (#91668).
  try {
    const outcome = await withReapCap(cleanupRemote(state.ssh, state.ownershipId), reapCapMs)

    log?.(remoteReapLogLine({ outcome }))
  } catch (error) {
    // Remote teardown is best-effort; always release the local tunnel and SSH transport. The failure is logged,
    // redacted: the error's class and kind only.
    log?.(remoteReapLogLine({ error }))
  }

  try {
    if (state.localPort && state.remotePort) {
      await state.ssh.cancelForward(state.localPort, state.remotePort)
    }
  } catch (error) {
    // Best effort; closing the transport below drops any remaining forwards. Logged by class only.
    log?.(`[ssh] cancel forward failed: ${errorClass(error)}`)
  }

  try {
    await state.ssh.close()
  } catch (error) {
    // The app must still be able to quit when SSH teardown fails. A master left alive (ControlPersist) shows here.
    log?.(`[ssh] closing the connection failed: ${errorClass(error)}`)
  }
}

export {
  applyConnectionChange,
  commitConnectionFailure,
  remoteReapLogLine,
  resolveTerminalConnection,
  resolveTerminalConnectionForSender,
  teardownSshState
}
