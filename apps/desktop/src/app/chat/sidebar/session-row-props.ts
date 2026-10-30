import type { SessionInfo } from '@/hermes'
import { sessionPinId } from '@/store/session'

/** What every session row takes from the list that renders it. */
export interface SessionRowCommonProps {
  branchStem?: string
  card?: boolean
  isPinned: boolean
  isSelected: boolean
  unread: boolean
  onArchive: () => void
  onBranch?: () => void
  onDelete: () => void
  onPin: () => void
  onToggleUnread: () => void
  onResume: () => void
  reorderable?: boolean
  showProfile?: boolean
}

/** The list-level state and handlers a row's props are bound from. */
interface SessionRowListContext {
  activeSessionId?: null | string
  card?: boolean
  pinned: boolean
  showProfileTags?: boolean
  onArchiveSession: (sessionId: string) => void
  onBranchSession?: (sessionId: string, profile?: string) => void
  onDeleteSession: (sessionId: string) => void
  onResumeSession: (sessionId: string, session?: SessionInfo) => void
  onTogglePin: (sessionId: string) => void
  onToggleUnread: (sessionId: string) => void
}

/** One row's props, bound to its session — shared by the plain and the virtualized list. */
export function sessionRowProps(
  session: SessionInfo,
  list: SessionRowListContext,
  row: { branchStem?: string; reorderable: boolean }
): SessionRowCommonProps {
  const { onBranchSession } = list

  return {
    branchStem: row.branchStem,
    card: list.card,
    isPinned: list.pinned,
    isSelected: session.id === list.activeSessionId,
    onArchive: () => list.onArchiveSession(session.id),
    onBranch: onBranchSession ? () => onBranchSession(session.id, session.profile) : undefined,
    onDelete: () => list.onDeleteSession(session.id),
    onPin: () => list.onTogglePin(sessionPinId(session)),
    onToggleUnread: () => list.onToggleUnread(session.id),
    onResume: () => list.onResumeSession(session.id, session),
    reorderable: row.reorderable,
    showProfile: list.showProfileTags,
    unread: session.unread === true
  }
}

/**
 * Key by (profile, id): twins with the same stored id in two profiles are
 * distinct rows (#92454) — a bare-id key makes React misattribute one twin's
 * rendered state to the other.
 */
export function sessionRowKey(session: SessionInfo): string {
  return `${session.profile ?? ''}::${session.id}`
}
