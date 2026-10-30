// Managed SSH connections: recovery records, bootstrap and teardown.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { isRecord } from '../../src/iclone-shared/guards'
import { execText } from '../backend-claim'
import { teardownSshState } from '../connection-apply'
import { connectionScopeKey, normalizeSshConfig, resolveRemoteSshDashboardProfile } from '../connection-config'
import type { RegistryConnection } from '../connection-registry'
import { backendScopePrefix, shouldRetrySshInventory } from '../connection-registry'
import { sshOwnershipId } from '../desktop-installation'
import { tightenSecretFileMode, writeSecretFileAtomic } from '../hardening'
import { ManagedConnectionUpdateGate, managedSshRecoveryScopes, validateCorrelationId } from '../managed-ssh-update'
import type { PreviewReachRegistry } from '../preview-reach'
import * as remoteLifecycle from '../remote-lifecycle'
import { createBootstrapCoordinator } from '../ssh-bootstrap-coordinator'
import { createSshProbeConnection, redactSecrets } from '../ssh-connection'
import { terminateOwnedWindowsDashboardForUpdate } from '../windows-remote-lifecycle'

import {
  desktopInstallationId,
  managedConnectionRecoveries,
  managedConnectionUpdates,
  SSH_INVENTORY_RETRY_MS,
  sshConnections,
  sshInventoryAttemptedAt,
  sshRosterCache
} from './connection-config'
import type { RegistryEntry, SshConnectionEntry } from './connection-config'
import { fetchJson } from './http'
import { rememberLog } from './log'
import { DESKTOP_MANAGED_SSH_RECOVERY_PATH } from './paths'
import { lateBound } from './state'

// Managed SSH update lifecycle (#93042): while an update owns a registered
// SSH connection, the gate pauses new dials and dial-material mutations for
// that connection id; the durable recovery journal below survives a crash
// mid-transaction so the next launch can restore every drained scope.
export const managedConnectionUpdateGate = new ManagedConnectionUpdateGate(
  connectionId =>
    readManagedSshRecoveryRecords().find(record => record.connectionId === connectionId)?.correlationId || null
)

export const managedPrimaryRestoreOwners = new Map<string, { correlationId: string; profile: string; source: any }>()

export function assertCanMutateManagedPrimaryRouting() {
  const durableIds = readManagedSshRecoveryRecords().map(record => record.connectionId)

  const ids = new Set([
    ...managedConnectionUpdates.keys(),
    ...managedConnectionRecoveries.keys(),
    ...managedPrimaryRestoreOwners.keys(),
    ...durableIds
  ])

  if (ids.size > 0) {
    const error: any = new Error(
      `Primary connection routing cannot change while managed SSH update recovery is pending for ${[...ids].join(', ')}.`
    )

    error.code = 'managed-update-in-progress'
    throw error
  }
}

type ManagedSshRecoveryScope = ReturnType<typeof managedSshRecoveryScopes>[number]

/** One journal entry; readManagedSshRecoveryRecords validates every field before returning it. */
interface ManagedSshRecoveryRecord {
  connectionId: string
  correlationId: string
  createdAt: string
  phase: 'prepared' | 'launching'
  scopes: ManagedSshRecoveryScope[]
  source: RegistryEntry
}

export function readManagedSshRecoveryRecords(): ManagedSshRecoveryRecord[] {
  try {
    const stat = fs.lstatSync(DESKTOP_MANAGED_SSH_RECOVERY_PATH)

    if (!stat.isFile() || stat.isSymbolicLink() || !tightenSecretFileMode(DESKTOP_MANAGED_SSH_RECOVERY_PATH)) {
      throw new Error('Managed SSH recovery journal is not a safe owner-only file.')
    }

    const payload: unknown = JSON.parse(fs.readFileSync(DESKTOP_MANAGED_SSH_RECOVERY_PATH, 'utf8'))

    if (!isRecord(payload) || payload.version !== 1 || !Array.isArray(payload.records)) {
      throw new Error('Managed SSH recovery journal has an unsupported shape.')
    }

    const valid = payload.records.every((record: unknown): record is ManagedSshRecoveryRecord => {
      if (
        !isRecord(record) ||
        typeof record.connectionId !== 'string' ||
        !isRecord(record.source) ||
        record.source.kind !== 'ssh' ||
        record.source.id !== record.connectionId ||
        (record.phase !== 'prepared' && record.phase !== 'launching') ||
        typeof record.correlationId !== 'string' ||
        !Array.isArray(record.scopes) ||
        record.scopes.length > 256
      ) {
        return false
      }

      try {
        validateCorrelationId(record.correlationId)
      } catch {
        return false
      }

      const scopesValid = record.scopes.every(
        scope =>
          scope &&
          typeof scope === 'object' &&
          typeof scope.key === 'string' &&
          scope.key.length <= 256 &&
          typeof scope.profile === 'string' &&
          scope.profile.length > 0 &&
          scope.profile.length <= 128 &&
          ['legacy', 'primary', 'registry'].includes(scope.kind) &&
          (scope.kind === 'primary' || scope.key.length > 0)
      )

      const identities = record.scopes.map(scope => `${scope.kind}\0${scope.key}\0${scope.profile}`)

      return (
        scopesValid &&
        new Set(identities).size === identities.length &&
        record.scopes.filter(scope => scope.kind === 'primary').length <= 1
      )
    })

    if (!valid) {
      throw new Error('Managed SSH recovery journal contains an invalid record.')
    }

    return payload.records
  } catch (cause: any) {
    if (cause?.code === 'ENOENT') {
      return []
    }

    const error: any = new Error(
      'Managed SSH recovery state is unreadable or malformed; refusing connection startup and edits.'
    )

    error.code = 'managed-update-recovery-unavailable'
    error.cause = cause
    throw error
  }
}

function writeManagedSshRecoveryRecords(records: unknown) {
  fs.mkdirSync(path.dirname(DESKTOP_MANAGED_SSH_RECOVERY_PATH), { recursive: true })
  writeSecretFileAtomic(
    DESKTOP_MANAGED_SSH_RECOVERY_PATH,
    JSON.stringify({ version: 1, records, updatedAt: new Date().toISOString() }, null, 2)
  )
}

export function persistManagedSshRecovery(
  source: RegistryEntry,
  correlationId: string,
  scopes: Parameters<typeof managedSshRecoveryScopes>[0]
) {
  const prefix = backendScopePrefix(source.id)
  const recoveryScopes = managedSshRecoveryScopes(scopes, prefix)

  const records = readManagedSshRecoveryRecords().filter(record => record.connectionId !== source.id)
  records.push({
    connectionId: source.id,
    correlationId: validateCorrelationId(correlationId),
    createdAt: new Date().toISOString(),
    phase: 'prepared',
    scopes: recoveryScopes,
    // Registry secrets are already safeStorage envelopes. Persist the exact
    // connection snapshot so crash recovery does not silently switch hosts or
    // credentials after a Settings edit.
    source
  })
  writeManagedSshRecoveryRecords(records)
}

export function markManagedSshRecoveryLaunching(connectionId: string, correlationId: string) {
  const records = readManagedSshRecoveryRecords()

  const index = records.findIndex(
    record => record.connectionId === connectionId && record.correlationId === correlationId
  )

  if (index < 0) {
    throw new Error('Managed SSH recovery record disappeared before remote update launch.')
  }

  records[index] = { ...records[index], phase: 'launching' }
  writeManagedSshRecoveryRecords(records)
}

export function clearManagedSshRecovery(connectionId: string, correlationId: string) {
  const records = readManagedSshRecoveryRecords()

  const remaining = records.filter(
    record => record.connectionId !== connectionId || record.correlationId !== correlationId
  )

  if (remaining.length === records.length) {
    return
  }

  if (remaining.length > 0) {
    writeManagedSshRecoveryRecords(remaining)
  } else {
    try {
      fs.unlinkSync(DESKTOP_MANAGED_SSH_RECOVERY_PATH)
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error
      }
    }
  }
}

export const sshBootstrapCoordinator: ReturnType<typeof createBootstrapCoordinator> = createBootstrapCoordinator()

export function sshScopeKey(profile: string | null) {
  return connectionScopeKey(profile) || ''
}

export function sshOwnershipKey(profile: string | null) {
  return sshOwnershipId(desktopInstallationId, sshScopeKey(profile))
}

export function sshRememberLog(chunk: string | null) {
  rememberLog(redactSecrets(String(chunk == null ? '' : chunk)))
}

export async function sshProbeReuseProof(baseUrl: string, token: string, spawnNonce: string) {
  try {
    const proof: any = await fetchJson(`${baseUrl}/api/ssh/ownership`, token)

    return remoteLifecycle.classifySshReuseProof(proof, spawnNonce)
  } catch (error: any) {
    if (/^(401|403|404):/.test(String(error?.message || ''))) {
      return 'authenticated-stale'
    }

    throw error
  }
}

export async function teardownSshConnection(profile: string | null) {
  const scope = sshScopeKey(profile)
  const state = sshConnections.get(scope)

  if (!state) {
    return
  }

  sshConnections.delete(scope)

  lateBound.terminalIpc?.disposeTerminalSessionsForSshScope(scope)

  // Kill the owned remote serve --isolated *before* closing the SSH
  // transport. Spawn detaches with setsid/nohup, so closing the tunnel
  // alone leaves the backend at pid 1 holding state.db (#91668).
  // Windows remotes use a different lifecycle (connectWindowsRemote) and
  // are left to a follow-up; POSIX is the leak that OOM'd gateways.
  await teardownSshState(
    {
      ...state,
      ownershipId: state.ownershipId || sshOwnershipKey(profile)
    },
    {
      cleanupRemote:
        state.remotePlatform === 'Windows'
          ? async () => {
              // connectWindowsRemote does not share POSIX lock/kill. Stay
              // silent on the kill path, but leave a log so quit is not a
              // mysterious no-op on Windows remotes.
              sshRememberLog('[ssh] skip remote serve teardown on Windows remotes; POSIX disconnect does not apply')
            }
          : remoteLifecycle.disconnect
    }
  )
}

// Loopback reach for the browser pane. Scoped to the SSH connection that
// authorized it: a different host (or none) must never inherit live forwards
// into somebody else's machine.
export const previewReachByWebContents = new Map<number, { registry: PreviewReachRegistry; scope: string }>()

export async function resetPreviewReach(webContentsId?: number) {
  if (typeof webContentsId === 'number') {
    const current = previewReachByWebContents.get(webContentsId)

    previewReachByWebContents.delete(webContentsId)

    if (current) {
      await current.registry.closeAll()
    }

    return
  }

  const open = [...previewReachByWebContents.values()]

  previewReachByWebContents.clear()
  await Promise.allSettled(open.map(entry => entry.registry.closeAll()))
}

export async function effectiveSshConfigFingerprint(sshConfig: {
  host: string
  user?: string | null
  port?: number | null
  keyPath?: string | null
}) {
  const ssh =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
      : 'ssh'

  const args = ['-G']

  if (sshConfig.port) {
    args.push('-p', String(sshConfig.port))
  }

  if (sshConfig.keyPath) {
    args.push('-i', sshConfig.keyPath)
  }

  args.push('--', sshConfig.user ? `${sshConfig.user}@${sshConfig.host}` : sshConfig.host)
  const output = await execText(ssh, args, { timeout: 10_000 })

  return crypto.createHash('sha256').update(output).digest('hex')
}

// Tear down a bootstrap result whose publication lost the managed-update
// fence: exact-terminate the serve this bootstrap owns (never a foreign one),
// drop its forward and transport, and surface a fence error so the managed
// updater refuses to mutate a remote install with an unfenced serve.
/** The part of a bootstrap result the rollback needs: the lock identity plus the remote runtime paths. */
type SshBootstrapRollbackResult = Pick<
  SshConnectionEntry,
  'ownershipId' | 'pid' | 'spawnNonce' | 'hermesPath' | 'hermesHome' | 'pythonPath' | 'localPort' | 'remotePort'
> &
  Partial<Pick<SshConnectionEntry, 'startedAt' | 'creationTimeNs' | 'creationTime'>> & { platform?: { os?: string } }

export async function rollbackSshBootstrapResult(
  ssh: SshConnectionEntry['ssh'],
  result: SshBootstrapRollbackResult,
  profile: string | null,
  sshConfig: { remoteProfile: unknown },
  boundaryError: unknown
) {
  const cleanupErrors: string[] = []
  const scope = sshScopeKey(profile)

  try {
    const expected = {
      ownershipId: result.ownershipId,
      pid: result.pid,
      spawnNonce: result.spawnNonce,
      profile: resolveRemoteSshDashboardProfile(sshConfig.remoteProfile, profile),
      hermesPath: result.hermesPath,
      hermesHome: result.hermesHome,
      startedAt: result.startedAt,
      creationTimeNs: result.creationTimeNs,
      creationTime: result.creationTime
    }

    if (result.platform?.os === 'Windows') {
      await terminateOwnedWindowsDashboardForUpdate(
        ssh,
        { hermesPath: result.hermesPath, hermesHome: result.hermesHome, python: result.pythonPath },
        expected
      )
    } else if (result.platform?.os === 'Linux' || result.platform?.os === 'Darwin') {
      await remoteLifecycle.terminateOwnedDashboardForUpdate(ssh, expected)
    } else {
      cleanupErrors.push(`unsupported remote platform ${result.platform?.os || 'unknown'}`)
    }
  } catch (error: any) {
    cleanupErrors.push(String(error?.message || error))
  }

  try {
    await ssh.cancelForward(result.localPort, result.remotePort)
  } catch (error: any) {
    cleanupErrors.push(String(error?.message || error))
  }

  try {
    await ssh.close()
  } catch (error: any) {
    cleanupErrors.push(String(error?.message || error))
  }

  if (sshConnections.get(scope)?.ssh === ssh) {
    sshConnections.delete(scope)
  }

  if (cleanupErrors.length > 0) {
    const unsafe: any = new Error(
      `An SSH bootstrap crossed the managed-update gate and its exact owned serve could not be fenced: ${cleanupErrors.join('; ')}`
    )

    unsafe.code = 'managed-update-bootstrap-fence-failed'
    unsafe.unsafeManagedBootstrap = true
    unsafe.cause = boundaryError
    throw unsafe
  }
}

export async function probeSshProfileInventory(connection: RegistryConnection) {
  if (
    !shouldRetrySshInventory(
      sshRosterCache.has(connection.id),
      sshInventoryAttemptedAt.get(connection.id),
      Date.now(),
      SSH_INVENTORY_RETRY_MS
    )
  ) {
    return
  }

  sshInventoryAttemptedAt.set(connection.id, Date.now())

  const sshConfig = normalizeSshConfig({
    mode: 'ssh',
    host: connection.host,
    user: connection.user,
    port: connection.port,
    keyPath: connection.keyPath,
    remoteHermesPath: connection.remoteHermesPath
  })

  if (!sshConfig) {
    return
  }

  const ssh = createSshProbeConnection(
    { host: sshConfig.host, user: sshConfig.user, port: sshConfig.port, keyPath: sshConfig.keyPath },
    { rememberLog: sshRememberLog }
  )

  try {
    await ssh.open()
    const profiles = await remoteLifecycle.listRemoteHermesProfiles(ssh)

    if (profiles.length > 0) {
      sshRosterCache.set(connection.id, profiles)
    }
  } catch (error: any) {
    sshRememberLog(`[ssh] profile inventory failed for ${connection.id}: ${error?.message || error}`)
  } finally {
    try {
      await ssh.close()
    } catch {
      void 0
    }
  }
}
