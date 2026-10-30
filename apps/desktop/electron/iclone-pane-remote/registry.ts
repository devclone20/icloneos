/**
 * Which pane rode which tmux session, kept in userData (0600) so a relaunch
 * can offer the owner a re-attach. The registry only remembers; tmux is the
 * truth about whether a session still exists.
 */
import fs from 'node:fs'

import { writeFileAtomicSync } from '../lib/atomic-write'

import { isTmuxSessionName } from './tmux-cmd'

interface RemoteSessionEntry {
  /** `local`, or the ssh connection scope the session lives behind. */
  scope: string
  session: string
  createdAt: number
}

type Registry = Record<string, RemoteSessionEntry>

const isEntry = (value: unknown): value is RemoteSessionEntry => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const { scope, session, createdAt } = value as Record<string, unknown>

  return (
    typeof scope === 'string' &&
    typeof session === 'string' &&
    isTmuxSessionName(session) &&
    typeof createdAt === 'number'
  )
}

export function readRemoteRegistry(file: string): Registry {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))

    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }

    return Object.fromEntries(Object.entries(parsed).filter(([, entry]) => isEntry(entry)))
  } catch {
    return {}
  }
}

export function rememberRemoteSession(file: string, paneId: string, entry: RemoteSessionEntry): void {
  writeFileAtomicSync(file, JSON.stringify({ ...readRemoteRegistry(file), [paneId]: entry }), { mode: 0o600 })
}

export function forgetRemoteSession(file: string, session: string): void {
  const kept = Object.entries(readRemoteRegistry(file)).filter(([, entry]) => entry.session !== session)

  writeFileAtomicSync(file, JSON.stringify(Object.fromEntries(kept)), { mode: 0o600 })
}
