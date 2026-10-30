import { describe, expect, it } from 'vitest'

import type { AcpFailure } from '../cli'

import type { MailMessage, MailPage } from './email-data'
import { EMPTY_LIST, type ListState } from './mail-shared'
import { threadChanged, withPageOne } from './use-mailbox'

function row(id: string, threadId: string, patch: Partial<MailMessage> = {}): MailMessage {
  return {
    id,
    threadId,
    direction: 'inbound',
    from: { address: 'a@b.c', name: 'A' },
    to: [],
    subject: `s ${id}`,
    preview: `p ${id}`,
    isRead: false,
    receivedAt: '2026-10-16T00:00:00Z',
    at: 1,
    attachments: 0,
    safety: 'clean',
    ...patch
  }
}

const PAGE: MailPage = { messages: [row('m1', 't1'), row('m2', 't2')], nextCursor: null }
const REAUTH: AcpFailure = { ok: false, kind: 'reauth', error: 'Sign-in required' }

function hydrated(): ListState {
  return { ...EMPTY_LIST, page: PAGE, loaded: true, hydrated: true }
}

describe('withPageOne', () => {
  it('a mount/timer read (force=false) on a hydrated list keeps the rows and records the state', () => {
    const next = withPageOne(hydrated(), REAUTH, false)

    expect(next.page).toBe(PAGE)
    expect(next.error).toBe(REAUTH)
  })

  it('a live list keeps its rows on a timer tick too, and an identical failure keeps the state object', () => {
    const live: ListState = { ...EMPTY_LIST, page: PAGE, loaded: true }
    const once = withPageOne(live, REAUTH, false)

    expect(once.page.messages).toHaveLength(2)
    expect(withPageOne(once, { ...REAUTH }, false)).toBe(once)
  })

  it('a forced read wipes rows from disk so the Setup action shows', () => {
    const next = withPageOne(hydrated(), REAUTH, true)

    expect(next.page.messages).toHaveLength(0)
    expect(next.error).toBe(REAUTH)
  })
})

describe('threadChanged', () => {
  it('is false for the same rows, true for a new row (a reply) or changed content', () => {
    const before = [row('m1', 't1')]

    expect(threadChanged(before, [row('m1', 't1')])).toBe(false)
    expect(threadChanged(before, [row('m9', 't1'), row('m1', 't1')])).toBe(true)
    expect(threadChanged(before, [row('m1', 't1', { preview: 'edited' })])).toBe(true)
    // Read state alone is not a reason to re-read the thread.
    expect(threadChanged(before, [row('m1', 't1', { isRead: true })])).toBe(false)
    expect(threadChanged(before, [])).toBe(false)
  })
})
