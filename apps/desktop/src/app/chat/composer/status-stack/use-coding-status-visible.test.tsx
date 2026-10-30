import { renderHook } from '@testing-library/react'
import { atom } from 'nanostores'
import { describe, expect, it, vi } from 'vitest'

import type { ProjectInfo, SessionInfo } from '@/types/hermes'

const $projects = atom<ProjectInfo[]>([{ id: 'p1', name: 'My app' } as ProjectInfo])
const $sessions = atom<SessionInfo[]>([{ cwd: '/proj/app', id: 'in-project' } as SessionInfo])

vi.mock('@/store/projects', () => ({ $projects }))
vi.mock('@/store/session', () => ({ $sessions }))
vi.mock('@/app/chat/sidebar/projects/workspace-groups', () => ({
  // Mirrors the real helper: an explicit project id under /proj, the repo root
  // itself (the AUTO project) for any other git checkout.
  liveSessionProjectId: (session: SessionInfo) =>
    session.cwd?.startsWith('/proj') ? 'p1' : session.cwd?.startsWith('/git/') ? '/git/repo' : null
}))

const { useCodingStatusVisible } = await import('./use-coding-status-visible')

/** The git strip is developer chrome: only a session anchored to a project the person opened shows it (U1-p2-03, U2-p2-04). */
describe('useCodingStatusVisible', () => {
  it('hides the strip for a cwd that is merely a git repo (the app checkout, the home folder)', () => {
    expect(renderHook(() => useCodingStatusVisible('fresh', '/Users/someone/app/apps/desktop')).result.current).toBe(
      false
    )
    expect(renderHook(() => useCodingStatusVisible(null, null)).result.current).toBe(false)
  })

  it('hides the strip when the session matches only the AUTO project (its own repo root) (U1-p2-03-p2b)', () => {
    expect(renderHook(() => useCodingStatusVisible('fresh', '/git/repo/apps/desktop')).result.current).toBe(false)
  })

  it("shows the strip for a session inside one of the person's projects", () => {
    expect(renderHook(() => useCodingStatusVisible('in-project', '/proj/app')).result.current).toBe(true)
    expect(renderHook(() => useCodingStatusVisible('unknown', '/proj/other')).result.current).toBe(true)
  })
})
