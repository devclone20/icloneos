/** The palette's row shape for a Hermes session, and the mapper to it. */

import type { listAllProfileSessions } from '@/hermes'
import { sessionTitle } from '@/lib/chat-runtime'

export interface SessionEntry {
  git_branch?: null | string
  id: string
  preview?: string
  title: string
}

type SessionRow = Awaited<ReturnType<typeof listAllProfileSessions>>['sessions'][number]

export const toSessionEntry = (session: SessionRow): SessionEntry => ({
  git_branch: session.git_branch ?? null,
  id: session.id,
  preview: session.preview ?? undefined,
  title: sessionTitle(session)
})
