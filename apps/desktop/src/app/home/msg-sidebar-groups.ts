/**
 * The Message sidebar's groups, as pure data (no React, no stores): every
 * session the three stores hold, deduped by id, sorted into the fixed order
 * Pinned → Sessions → one group per messaging platform → Scheduled jobs →
 * Archived. A group with no rows is never returned.
 *
 * Only real session fields decide (`pinned`, `archived`, `source`,
 * `parent_session_id`) plus the store a row came from (cron). A branch always
 * sits in its parent's group so the shared session list can nest it.
 */
import { sessionRecency } from '@/app/chat/sidebar/projects/workspace-groups'
import { buildSessionByAnyId, resolvePinnedSessions } from '@/app/chat/sidebar/session-index'
import { isMessagingSource, normalizeSessionSource, sessionSourceLabel } from '@/lib/session-source'
import type { SessionInfo } from '@/types/hermes'

type MsgGroupKind = 'archived' | 'pinned' | 'platform' | 'scheduled' | 'sessions'

export interface MsgSessionGroup {
  /** Stable React key and open-state key: the kind, or `platform:<id>`. */
  key: string
  kind: MsgGroupKind
  /** The platform's display name; null for the fixed groups (the view labels those). */
  label: null | string
  sessions: SessionInfo[]
}

export interface MsgGroupSources {
  sessions: readonly SessionInfo[]
  messaging: readonly SessionInfo[]
  cron: readonly SessionInfo[]
  pinnedIds: readonly string[]
  unconfirmedPinWrites: ReadonlySet<string>
  /** Optimistic delete tombstones: gone from the list before the stores refresh. */
  removedIds?: ReadonlySet<string>
}

type Home = 'scheduled' | 'sessions' | `platform:${string}`

const byRecency = (a: SessionInfo, b: SessionInfo) => sessionRecency(b) - sessionRecency(a)

/** First occurrence wins, in store order: recents, then messaging, then cron. */
function dedupe(lists: readonly (readonly SessionInfo[])[]): SessionInfo[] {
  const seen = new Set<string>()
  const out: SessionInfo[] = []

  for (const list of lists) {
    for (const session of list) {
      if (!seen.has(session.id)) {
        seen.add(session.id)
        out.push(session)
      }
    }
  }

  return out
}

function ownHome(session: SessionInfo, cronIds: ReadonlySet<string>): Home {
  if (cronIds.has(session.id)) {
    return 'scheduled'
  }

  return isMessagingSource(session.source) ? `platform:${normalizeSessionSource(session.source)}` : 'sessions'
}

/** A branch follows its parent's group (walking up to the first ancestor present), cycle-safe. */
function homeOf(session: SessionInfo, byId: ReadonlyMap<string, SessionInfo>, cronIds: ReadonlySet<string>): Home {
  let current = session
  const visited = new Set<string>([session.id])

  while (current.parent_session_id) {
    const parent = byId.get(current.parent_session_id)

    if (!parent || visited.has(parent.id)) {
      break
    }

    visited.add(parent.id)
    current = parent
  }

  return ownHome(current, cronIds)
}

/** Every non-archived row the sidebar lists — what `D3.sessions_listed` counts. */
export function listedSessionIds(sources: Pick<MsgGroupSources, 'cron' | 'messaging' | 'sessions'>): string[] {
  return dedupe([sources.sessions, sources.messaging, sources.cron])
    .filter(session => session.archived !== true)
    .map(session => session.id)
}

export function groupMsgSessions(sources: MsgGroupSources): MsgSessionGroup[] {
  const removed = sources.removedIds
  const all = dedupe([sources.sessions, sources.messaging, sources.cron]).filter(session => !removed?.has(session.id))
  const live = all.filter(session => session.archived !== true)
  const archived = all.filter(session => session.archived === true).sort(byRecency)
  const cronIds = new Set(sources.cron.map(session => session.id))

  const liveIds = new Set(live.map(session => session.id))
  const keep = (list: readonly SessionInfo[]) => list.filter(session => liveIds.has(session.id))
  const [liveRecents, liveCron, liveMessaging] = [keep(sources.sessions), keep(sources.cron), keep(sources.messaging)]

  const pinned = resolvePinnedSessions(
    sources.pinnedIds,
    buildSessionByAnyId(liveRecents, liveCron, liveMessaging),
    live,
    sources.unconfirmedPinWrites
  )

  const pinnedIds = new Set(pinned.map(session => session.id))
  const rest = live.filter(session => !pinnedIds.has(session.id))
  const byId = new Map(rest.map(session => [session.id, session]))
  const homes = new Map<Home, SessionInfo[]>()

  for (const session of rest) {
    const home = homeOf(session, byId, cronIds)
    const list = homes.get(home) ?? []

    list.push(session)
    homes.set(home, list)
  }

  for (const list of homes.values()) {
    list.sort(byRecency)
  }

  const platforms = [...homes.entries()]
    .filter(([home]) => home.startsWith('platform:'))
    .map(([home, list]): MsgSessionGroup => {
      const id = home.slice('platform:'.length)

      return { key: home, kind: 'platform', label: sessionSourceLabel(id) ?? id, sessions: list }
    })
    .sort((a, b) => sessionRecency(b.sessions[0]) - sessionRecency(a.sessions[0]))

  const groups: MsgSessionGroup[] = [
    { key: 'pinned', kind: 'pinned', label: null, sessions: pinned },
    { key: 'sessions', kind: 'sessions', label: null, sessions: homes.get('sessions') ?? [] },
    ...platforms,
    { key: 'scheduled', kind: 'scheduled', label: null, sessions: homes.get('scheduled') ?? [] },
    { key: 'archived', kind: 'archived', label: null, sessions: archived }
  ]

  return groups.filter(group => group.sessions.length > 0)
}

/** The profile chip earns its place only when rows from more than one profile are listed. */
export function hasManyProfiles(groups: readonly MsgSessionGroup[]): boolean {
  const profiles = new Set<string>()

  for (const group of groups) {
    for (const session of group.sessions) {
      profiles.add(session.profile || 'default')
    }
  }

  return profiles.size > 1
}
