import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as setup from '../../acp-setup'
import { invalidateAcp } from '../cli'
import { resetLiveCadence } from '../live'
import { writeSnapshot } from '../snapshot'

import { EMAIL_SNAPSHOT_VERSION, snapshotOf } from './data/snapshot'
import { THREAD_READ_AHEAD_IDLE_MS } from './data/thread-prefetch'
import type { MailMessage } from './data/types'
import { forgetThreads, mail, type MailScope, prefetch } from './email-data'
import { parsedBody } from './parsed-bodies'

const SCOPE: MailScope = { inftId: 'robinhood:0xabc:7', slug: 'robinhood-0xabc-7' }

function answer(id: string) {
  return { ok: true, code: 0, stdout: JSON.stringify({ id, subject: `s-${id}`, messages: [] }), stderr: '' }
}

describe('thread memory', () => {
  let run: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    run = vi.spyOn(setup, 'runAcp').mockImplementation(async (_id: string, argv: string[]) => answer(argv[3]))
    invalidateAcp(SCOPE.slug)
    forgetThreads()
  })

  afterEach(() => {
    run.mockRestore()
  })

  it('remembers a thread past its TTL, so a re-open paints it at once', async () => {
    expect(mail.lastThread(SCOPE, 't1')).toBeNull()
    await mail.thread(SCOPE, 't1')
    // The CLI cache expires; the memory does not.
    invalidateAcp(SCOPE.slug)
    expect(mail.lastThread(SCOPE, 't1')?.id).toBe('t1')
  })

  it('a read-ahead of a remembered thread costs no CLI call', async () => {
    await mail.thread(SCOPE, 't1')
    invalidateAcp(SCOPE.slug)
    mail.prefetchThread(SCOPE, 't1')
    mail.prefetchThread(SCOPE, 't2')
    // The read-ahead waits for the quiet window (THREAD_READ_AHEAD_IDLE_MS) before its first speculative read.
    await vi.waitFor(() => expect(mail.lastThread(SCOPE, 't2')).not.toBeNull(), {
      timeout: THREAD_READ_AHEAD_IDLE_MS + 2000
    })
    expect(run.mock.calls.map((call: unknown[]) => (call[1] as string[])[3])).toEqual(['t1', 't2'])
  })

  it('the stage warm hands the last-seen inbox’s newest bodies to the CLI before page one; the owner’s slot stays free', async () => {
    const at = Date.parse('2026-10-18T03:00:00Z')

    const messages: MailMessage[] = ['old', 'newest', 'middle'].map((id, i) => ({
      id: `m-${id}`,
      threadId: id,
      direction: 'inbound',
      from: { name: 'A', address: 'a@b.c' },
      to: [{ name: '', address: 'me@b.c' }],
      subject: id,
      preview: '',
      isRead: true,
      receivedAt: new Date(at + [0, 2, 1][i] * 60_000).toISOString(),
      at: at + [0, 2, 1][i] * 60_000,
      attachments: 0,
      safety: 'clean'
    }))

    let landInbox: (value: unknown) => void = () => undefined

    writeSnapshot(
      'email',
      SCOPE.slug,
      EMAIL_SNAPSHOT_VERSION,
      snapshotOf({ messages, nextCursor: null }, null, null),
      at
    )
    const bodies: (() => void)[] = []

    run.mockImplementation(async (_id: string, argv: string[]) =>
      argv[1] === 'thread'
        ? new Promise(resolve => bodies.push(() => resolve(answer(argv[3]))))
        : new Promise(resolve => {
            landInbox = () => resolve({ ok: false, code: 1, stdout: '', stderr: '', error: 'offline' })
          })
    )

    try {
      await prefetch(SCOPE.inftId, SCOPE.slug)

      const threads = () =>
        run.mock.calls
          .filter((call: unknown[]) => (call[1] as string[])[1] === 'thread')
          .map((call: unknown[]) => (call[1] as string[])[3])

      const inboxCalls = () => run.mock.calls.filter((call: unknown[]) => (call[1] as string[])[1] === 'inbox').length

      // The newest body holds the background slot from the first call; page one waits behind the pinned bodies.
      await vi.waitFor(() => expect(threads()).toEqual(['newest']))
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(inboxCalls()).toBe(0)
      // The second slot is the owner's: an open of another thread starts beside the warm.
      const open = mail.thread(SCOPE, 'other', { urgent: true })
      await vi.waitFor(() => expect(threads()).toEqual(['newest', 'other']))
      bodies.splice(1).forEach(answerBody => answerBody())
      await open
      expect(inboxCalls()).toBe(0)
      // One speculative read at a time, back to back: the next body once the first answered, then page one.
      bodies.splice(0).forEach(answerBody => answerBody())
      await vi.waitFor(() => expect(threads()).toEqual(['newest', 'other', 'middle']))
      bodies.splice(0).forEach(answerBody => answerBody())
      await vi.waitFor(() => expect(threads()).toEqual(['newest', 'other', 'middle', 'old']))
      bodies.splice(0).forEach(answerBody => answerBody())
      await vi.waitFor(() => expect(inboxCalls()).toBe(1))
      expect(mail.lastThread(SCOPE, 'middle')).not.toBeNull()
      expect(mail.lastThread(SCOPE, 'newest')).not.toBeNull()
    } finally {
      landInbox(undefined)
      bodies.splice(0).forEach(answerBody => answerBody())
      resetLiveCadence()
    }
  })

  it('an equal answer keeps the remembered object, and a memo write for B leaves A’s object as it was', async () => {
    const first = await mail.thread(SCOPE, 'A')
    const shown = mail.lastThread(SCOPE, 'A')

    expect(first.ok && first.data).toBe(shown)
    await mail.thread(SCOPE, 'B')
    expect(mail.lastThread(SCOPE, 'A')).toBe(shown)

    // A forced re-read with the same content: the pane showing A gets the very object it holds (no render).
    const again = await mail.thread(SCOPE, 'A', { force: true })

    expect(run).toHaveBeenCalledTimes(3)
    expect(again.ok && again.data).toBe(shown)

    // New content is a new object.
    run.mockImplementationOnce(async () => ({
      ...answer('A'),
      stdout: JSON.stringify({ id: 'A', subject: 'new', messages: [] })
    }))
    const changed = await mail.thread(SCOPE, 'A', { force: true })

    expect(changed.ok && changed.data).not.toBe(shown)
    expect(mail.lastThread(SCOPE, 'A')?.subject).toBe('new')
  })

  it('forgets one iNFT’s threads on sign-out and keeps the others', async () => {
    const other: MailScope = { inftId: 'robinhood:0xabc:6', slug: 'robinhood-0xabc-6' }

    await mail.thread(SCOPE, 't1')
    await mail.thread(other, 't9')
    forgetThreads(SCOPE.slug)
    expect(mail.lastThread(SCOPE, 't1')).toBeNull()
    expect(mail.lastThread(other, 't9')?.id).toBe('t9')
  })
  it('the warm read-ahead fills the memory newest first, so a first open paints from it — R3d r4', async () => {
    const rows = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'].map((threadId, i) => ({ threadId, at: i }))

    mail.prefetchThreads(SCOPE, rows)
    await vi.waitFor(() => expect(mail.lastThread(SCOPE, 't2')).not.toBeNull(), {
      timeout: THREAD_READ_AHEAD_IDLE_MS + 4000
    })
    expect(mail.lastThread(SCOPE, 't1')).toBeNull()
    expect(run.mock.calls.map((call: unknown[]) => (call[1] as string[])[3])).toEqual([
      't7',
      't6',
      't5',
      't4',
      't3',
      't2'
    ])

    // A first open now paints the remembered body; its read joins the cache.
    expect(mail.lastThread(SCOPE, 't7')?.id).toBe('t7')
    await mail.thread(SCOPE, 't7')
    expect(run).toHaveBeenCalledTimes(6)
  })
})

describe("the read-ahead never delays the owner's open — R3d r5", () => {
  const L = 200
  let run: ReturnType<typeof vi.spyOn>
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const reads = () => run.mock.calls.map((call: unknown[]) => (call[1] as string[])[3])

  beforeEach(() => {
    run = vi.spyOn(setup, 'runAcp').mockImplementation(async (_id: string, argv: string[]) => {
      await sleep(L)

      return answer(argv[3])
    })
    invalidateAcp(SCOPE.slug)
    forgetThreads()
  })

  afterEach(async () => {
    mail.cancelThreadPrefetch()
    await sleep(L + 50)
    run.mockRestore()
  })

  it('an open right after the list paints runs on an idle CLI, in front of every speculative read', async () => {
    mail.prefetchThreads(
      SCOPE,
      ['t1', 't2', 't3', 't4'].map((threadId, at) => ({ threadId, at }))
    )
    await sleep(100)
    const t0 = performance.now()

    await mail.thread(SCOPE, 't1', { urgent: true })
    expect((performance.now() - t0) / L).toBeLessThan(1.25)
    expect(reads()).toEqual(['t1'])
  })

  it('the read-ahead resumes only after the open settled and the quiet window passed, one read at a time', async () => {
    mail.prefetchThreads(
      SCOPE,
      ['u1', 'u2', 'u3'].map((threadId, at) => ({ threadId, at }))
    )
    await mail.thread(SCOPE, 'u2', { urgent: true })
    await sleep(THREAD_READ_AHEAD_IDLE_MS - 100)
    expect(reads()).toEqual(['u2'])
    await vi.waitFor(() => expect(reads()).toEqual(['u2', 'u3', 'u1']), { timeout: 3000 })
  })

  it('the selected row leads the plan', async () => {
    mail.prefetchThreads(
      SCOPE,
      ['v1', 'v2', 'v3'].map((threadId, at) => ({ threadId, at })),
      'v1'
    )
    await vi.waitFor(() => expect(reads()).toEqual(['v1', 'v3', 'v2']), { timeout: 3000 })
  })
})

describe('sign-out', () => {
  it('forgetThreads drops the parsed body cache with the thread memo', () => {
    const text = 'Hi there,\n\n> quoted'
    const parsed = parsedBody(text)

    expect(parsedBody(text)).toBe(parsed)
    forgetThreads('inft-7')
    expect(parsedBody(text)).not.toBe(parsed)
  })
})
