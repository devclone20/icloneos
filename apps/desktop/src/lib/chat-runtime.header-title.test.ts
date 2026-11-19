/**
 * v0.0.9 G design verdict GF-1: the prompt showed twice, as the thread header's title and as the pinned (sticky)
 * prompt right under it. A session with no title of its own is labelled by its preview, which is that same first
 * prompt, so the header repeated what the thread already pins. The header keeps a real title, and names an untitled
 * session plainly when its preview only repeats the pinned prompt.
 */
import { describe, expect, it } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

import { headerSessionTitle, sessionTitle } from './chat-runtime'

const session = (over: Partial<SessionInfo>) => ({ id: 's1', ...over }) as SessionInfo

describe('headerSessionTitle', () => {
  it('does not repeat the pinned prompt when the session has no title of its own', () => {
    const untitled = session({ preview: 'E2E_TASK_PANEL_RESUME_TRIGGER show the plan' })

    expect(headerSessionTitle(untitled, 'E2E_TASK_PANEL_RESUME_TRIGGER show the plan')).toBe(sessionTitle(session({})))
    // The preview is a truncation of a long prompt: still the same line.
    expect(headerSessionTitle(session({ preview: 'Plan the move of the' }), 'Plan the move of the  whole repo')).toBe(
      sessionTitle(session({}))
    )
  })

  // Design delta at 3112b338f3: in F1c the session's TITLE equals the prompt (the title fallback copies it), so the
  // header still repeated the pinned slab.
  it('does not repeat the pinned prompt when the session title is that prompt', () => {
    const titled = session({ preview: 'x', title: 'E2E_TASK_PANEL_RESUME_TRIGGER show the plan' })

    expect(headerSessionTitle(titled, 'E2E_TASK_PANEL_RESUME_TRIGGER show the plan')).toBe(sessionTitle(session({})))
  })

  it('keeps a real title, and a preview that is not the pinned prompt', () => {
    expect(headerSessionTitle(session({ preview: 'x', title: 'Restored layout plan' }), 'x')).toBe('Restored layout plan')
    // A short real title that only begins the prompt is still the session's name.
    expect(headerSessionTitle(session({ title: 'Plan' }), 'Plan the move of the whole repo')).toBe('Plan')
    expect(headerSessionTitle(session({ preview: 'first ask' }), 'a later ask')).toBe('first ask')
    expect(headerSessionTitle(session({ preview: 'first ask' }), null)).toBe('first ask')
  })
})
