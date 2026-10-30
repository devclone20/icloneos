import { useStore } from '@nanostores/react'

import { liveSessionProjectId } from '@/app/chat/sidebar/projects/workspace-groups'
import { $projects } from '@/store/projects'
import { $sessions } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

/**
 * The branch / cwd / ± strip is developer chrome: it shows only for a session
 * the person anchored to one of THEIR projects. A cwd that merely happens to
 * be a git repo (the backend's working directory, the app's own checkout) is
 * not a project they opened (U1-p2-03, U2-p2-04).
 */
export function useCodingStatusVisible(sessionId: null | string | undefined, cwd: null | string | undefined): boolean {
  const sessions = useStore($sessions)
  const projects = useStore($projects)

  const session: null | SessionInfo =
    sessions.find(s => s.id === sessionId) ?? (cwd ? ({ cwd, id: sessionId ?? '' } as SessionInfo) : null)

  if (!session) {
    return false
  }

  // liveSessionProjectId falls back to the repo root as an AUTO project: after
  // the first reply the backend reports git_repo_root for any checkout, which
  // re-lit the strip for a fresh user (U1-p2-03-p2b). Only a project the
  // person opened counts.
  const projectId = liveSessionProjectId(session, projects)

  return Boolean(projectId && projects.some(project => project.id === projectId))
}
