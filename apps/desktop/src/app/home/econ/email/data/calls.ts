/** The email data module's `calls` section — its public names are re-exported by ../email-data.ts. */
import { defineEconData } from '../../app-data'
import { type AcpCallOptions, acpJson, type AcpResult, acpWrite, invalidateAcp } from '../../cli'
import { liveCadenceSecs, parallelPrefetch } from '../../live'
import { writeSnapshot } from '../../snapshot'
import { folderRows, type MailState, mirrorAllMailStateFiles, mirrorMailStateFile, readMailState } from '../email-state'
import { forgetParsedBodies } from '../parsed-bodies'

import { publishUnread } from './counts'
import { nextMailbox } from './mailbox'
import { withReadablePreviews } from './merges'
import { shapeInbox, shapeMailbox, shapeReceipt, shapeSearch, shapeThread } from './shapers'
import { EMAIL_SNAPSHOT_VERSION, readMailSnapshot, snapshotOf } from './snapshot'
import { createThreadPrefetcher, type PrefetchRow } from './thread-prefetch'
import { type Draft, type MailThread, PAGE_SIZE, SEARCH_MAX, type SendReceipt, type ServerFolder } from './types'

// ── the CLI ─────────────────────────────────────────────────────────────────

export interface MailScope {
  inftId: string
  slug: string
}

type ReadOptions = Pick<AcpCallOptions, 'ahead' | 'force' | 'urgent'>

const INBOX_TTL_CAP_MS = 60_000
const INBOX_TTL_FLOOR_MS = 10_000
// A tick must find page one expired, or it would serve the last answer again
// and the list would refresh at half the owner's rate.
const TICK_MARGIN_MS = 5_000
const OLDER_PAGE_TTL_MS = 120_000
const SEARCH_TTL_MS = 60_000
const THREAD_TTL_MS = 30_000
const WHOAMI_TTL_MS = 10 * 60_000
const WRITE_TIMEOUT_MS = 90_000
const THREAD_MEMO_MAX = 40

// The newest answer per thread, kept past its TTL: a re-open paints it at once
// and the read behind it only reconciles. Memory only — bodies never go to disk.
// `print` is the answer's content: an equal answer keeps the remembered object,
// so a pane already showing it never renders again.
const threadMemo = new Map<string, { print: string; thread: MailThread }>()

function memoKey(scope: MailScope, threadId: string): string {
  return `${scope.slug}\u0000${threadId}`
}

function remember(scope: MailScope, threadId: string, thread: MailThread): MailThread {
  const key = memoKey(scope, threadId)
  const print = JSON.stringify(thread)
  const known = threadMemo.get(key)
  const kept = known?.print === print ? known.thread : thread

  threadMemo.delete(key)
  threadMemo.set(key, { print, thread: kept })

  for (const oldest of threadMemo.keys()) {
    if (threadMemo.size <= THREAD_MEMO_MAX) {
      break
    }

    threadMemo.delete(oldest)
  }

  return kept
}

/** Forget one iNFT's remembered threads and the parsed bodies (signed out), or every one (tests). */
export function forgetThreads(slug?: string): void {
  forgetParsedBodies()

  for (const key of [...threadMemo.keys()]) {
    if (slug === undefined || key.startsWith(`${slug}\u0000`)) {
      threadMemo.delete(key)
    }
  }
}

/** Page one's cache life: long enough that a prefetch at summon still serves
 *  the window's open, never a minute or more, and shorter than the owner's
 *  refresh interval so every tick reaches the CLI. */
export function inboxTtlMs(intervalSecs: number): number {
  return Math.min(INBOX_TTL_CAP_MS, Math.max(INBOX_TTL_FLOOR_MS, intervalSecs * 1000 - TICK_MARGIN_MS))
}

export function inboxArgv(folder: ServerFolder, cursor: null | string): string[] {
  return [
    'email',
    'inbox',
    ...(folder === 'spam' ? ['--folder', 'spam'] : []),
    ...(cursor ? ['--cursor', cursor] : []),
    '--limit',
    String(PAGE_SIZE),
    '--json'
  ]
}

export function composeArgv(draft: Draft): string[] {
  return [
    'email',
    'compose',
    '--to',
    draft.to.trim(),
    '--subject',
    draft.subject.trim(),
    '--body',
    draft.body,
    '--json'
  ]
}

export function replyArgv(threadId: string, body: string): string[] {
  return ['email', 'reply', '--thread-id', threadId, '--body', body, '--json']
}

// What a send can change. The address (`email whoami`) never does, so a
// write must not cost the reload a whoami spawn.
const WRITE_STALES: string[][] = [
  ['email', 'inbox'],
  ['email', 'thread'],
  ['email', 'search']
]

async function write(scope: MailScope, argv: string[]): Promise<AcpResult<SendReceipt>> {
  const result = await acpWrite(scope.inftId, scope.slug, argv, WRITE_TIMEOUT_MS)

  // Even a failed write may have reached the service (a timeout), so the
  // cached reads are stale either way.
  WRITE_STALES.forEach(prefix => invalidateAcp(scope.slug, prefix))

  return result.ok ? { ...result, data: shapeReceipt(result.data) } : result
}

export const mail = {
  whoami: (scope: MailScope, options: ReadOptions = {}) =>
    acpJson(scope.inftId, scope.slug, ['email', 'whoami', '--json'], shapeMailbox, {
      ttlMs: WHOAMI_TTL_MS,
      ...options
    }),

  inbox: (scope: MailScope, folder: ServerFolder, cursor: null | string, options: ReadOptions = {}) =>
    acpJson(scope.inftId, scope.slug, inboxArgv(folder, cursor), shapeInbox, {
      ttlMs: cursor ? OLDER_PAGE_TTL_MS : inboxTtlMs(liveCadenceSecs('email', scope.slug)),
      ...options
    }),

  search: (scope: MailScope, query: string, options: ReadOptions = {}) =>
    acpJson(
      scope.inftId,
      scope.slug,
      ['email', 'search', '--query', query.slice(0, SEARCH_MAX), '--json'],
      shapeSearch,
      {
        ttlMs: SEARCH_TTL_MS,
        ...options
      }
    ),

  /** An `urgent` read is the owner's open: the read-ahead holds back until it settled. */
  thread: (scope: MailScope, threadId: string, options: ReadOptions = {}) => {
    const read = readThread(scope, threadId, options)

    if (options.urgent) {
      threadReadAhead.yieldTo(read)
    }

    return read
  },

  /** The last answer for a thread, however old — what a re-open paints. */
  lastThread: (scope: MailScope, threadId: string): MailThread | null =>
    threadMemo.get(memoKey(scope, threadId))?.thread ?? null,

  /** The cursor's thread leads the read-ahead (never forced: the open then
   *  hits the same cache key). A thread already remembered costs no read —
   *  its open paints the memory and reconciles. */
  prefetchThread: (scope: MailScope, threadId: string): void => threadReadAhead.lead(scope, threadId),

  /** The newest rows' threads read ahead into the memo, `lead` (the selected
   *  row) first, one speculative read at a time and never in front of an
   *  owner's open (thread-prefetch.ts); replaces the pending plan. */
  prefetchThreads: (scope: MailScope, rows: readonly PrefetchRow[], lead?: null | string): void =>
    threadReadAhead.plan(scope, rows, lead),

  /** Drop the pending read-ahead (an iNFT switch, the window closing). */
  cancelThreadPrefetch: (slug?: string): void => threadReadAhead.cancel(slug),

  compose: (scope: MailScope, draft: Draft) => write(scope, composeArgv(draft)),

  reply: (scope: MailScope, threadId: string, body: string) => write(scope, replyArgv(threadId, body))
}

async function readThread(scope: MailScope, threadId: string, options: ReadOptions) {
  const result = await acpJson(
    scope.inftId,
    scope.slug,
    ['email', 'thread', '--thread-id', threadId, '--json'],
    shapeThread,
    { ttlMs: THREAD_TTL_MS, ...options }
  )

  return result.ok && result.data ? { ...result, data: remember(scope, threadId, result.data) } : result
}

const threadReadAhead = createThreadPrefetcher<MailScope>({
  read: (scope, threadId) => readThread(scope, threadId, { ahead: true }),
  known: (scope, threadId) => threadMemo.has(memoKey(scope, threadId))
})

/**
 * Warm the window's first paint while the iNFT loads: page one (the same argv
 * and TTL the window reads), then the address — never forced, so both land in
 * the CLI cache. The dock learns the unread count and the snapshot is brought
 * up to date, so even an open after the cache expired paints this answer.
 */
const econData = defineEconData({
  kind: 'email',
  async warm(inftId, slug) {
    const scope: MailScope = { inftId, slug }
    const seen = readMailSnapshot(slug)

    const pin = (state: MailState) => {
      if (seen) {
        threadReadAhead.warm(scope, folderRows(state, { base: seen.data.base.messages }, 'inbox'))
      }
    }

    // The newest bodies of the inbox the list paints first (the last page seen, under the marks this window
    // already holds) reach the CLI queue before this warm's own list read; the leveled marks re-pin them only when
    // their rows differ, and the fresh page re-pins its own newest below.
    pin(readMailState(slug))

    // Both copies of the owner's marks level at stage time, not only when
    // Email opens — every iNFT's, so a cache clear never brings back a mail
    // deleted forever. Runs beside the inbox read, never in front of it.
    const marks = mirrorMailStateFile(slug).catch(() => null)

    void mirrorAllMailStateFiles()
    void marks.then(state => state && pin(state))

    const inbox = await mail.inbox(scope, 'inbox', null)

    if (!inbox.ok) {
      return
    }

    const rows = folderRows((await marks) ?? readMailState(slug), { base: inbox.data.messages }, 'inbox')

    publishUnread(slug, rows)
    // The newest bodies too, so the first open of a new mail paints from memory.
    threadReadAhead.warm(scope, rows)

    const whoami = await mail.whoami(scope)
    // Read after the await: an open Email window may have stored a preview its thread read rebuilt meanwhile.
    const known = readMailSnapshot(slug)?.data ?? null
    const { mailbox, note } = nextMailbox(whoami, known?.mailbox ?? null)
    const page = withReadablePreviews(inbox.data, known?.base.messages ?? [])

    writeSnapshot('email', slug, EMAIL_SNAPSHOT_VERSION, snapshotOf(page, mailbox, note), inbox.at)
  }
})

/** Returns at once: the reads queue behind nobody's awaits (live.ts). */
export const prefetch = parallelPrefetch('email', econData.prefetch)
