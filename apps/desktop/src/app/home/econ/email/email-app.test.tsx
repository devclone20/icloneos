import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createContext } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { $econBadges } from '../badges'
import { $econStatus, prefetchesSettled, SAVED_MAIL_TEXT, statusText } from '../live'
import { readSnapshot, writeSnapshot } from '../snapshot'
import type { EconAppProps } from '../types'

import { EMAIL_SNAPSHOT_VERSION, type EmailSnapshot, prefetch, shapeInbox, snapshotOf } from './email-data'
import { EMPTY_MAIL_STATE, readMailState, setRead, writeMailState } from './email-state'

// The CLI bridge is the only seam mocked: shapers, queue, cache, list logic,
// keyboard and rendering all run for real.
const runAcp = vi.fn()
const ask = vi.fn()
const openSetup = vi.fn()

vi.mock('../../acp-setup', () => ({ runAcp: (...args: unknown[]) => runAcp(...args) }))

vi.mock('../handoff', () => ({
  EconWindowContext: createContext({ close: () => undefined, agentName: 'Vega' }),
  useAskInft: () => ask,
  useOpenSetup: () => openSetup
}))

const { default: EmailApp } = await import('./email-app')

const ADDRESS = 'agent-6@example.com'

// Every test runs at local midday: "Today" / "Yesterday" grouping is relative to the local clock, and
// fixtures stamped minutes before a real midnight landed in the wrong group.
const NOW = (() => {
  const day = new Date()

  day.setHours(12, 0, 0, 0)

  return day.getTime()
})()

const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString()

const INBOUND = {
  id: 'in-1',
  threadId: 'thr-in',
  direction: 'inbound',
  fromAddress: 'jane@example.com',
  from: 'Jane Doe <jane@example.com>',
  to: [ADDRESS],
  subject: 'Deck for Thursday',
  bodyPreview: 'Could you send the deck?\r\n> old quoted line',
  isRead: false,
  receivedAt: hoursAgo(0.1),
  scanStatus: 'clean',
  _count: { attachments: 1 }
}

const OUTBOUND = {
  id: 'out-1',
  threadId: 'thr-out',
  direction: 'outbound',
  fromAddress: ADDRESS,
  to: ['bob@example.com'],
  subject: 'Intro',
  bodyPreview: 'Hi Bob',
  isRead: true,
  receivedAt: hoursAgo(30),
  scanStatus: 'clean',
  _count: { attachments: 0 }
}

const THREAD = {
  id: 'thr-in',
  externalFrom: 'jane@example.com',
  subject: 'Deck for Thursday',
  lastMessageAt: INBOUND.receivedAt,
  messages: [
    {
      id: 'in-1',
      direction: 'inbound',
      fromAddress: 'jane@example.com',
      from: 'Jane Doe <jane@example.com>',
      to: [ADDRESS],
      receivedAt: INBOUND.receivedAt,
      isRead: true,
      scanStatus: 'clean',
      attachments: [{ filename: 'brief.pdf' }],
      textBody: '',
      htmlBody:
        '<p>Could you <b>send</b> the deck? https://example.com/deck</p><script>window.pwned = true</script><img src="https://tracker.example/p.gif">'
    }
  ]
}

let sent: null | Record<string, unknown> = null

function answer(payload: unknown) {
  return { ok: true, code: 0, stdout: JSON.stringify(payload), stderr: '' }
}

function reply(payload: unknown) {
  return Promise.resolve(answer(payload))
}

/** A CLI answer the test releases by hand. */
function held(payload: unknown): { promise: Promise<unknown>; release: () => void } {
  let release = () => undefined as void

  const promise = new Promise(resolve => {
    release = () => resolve(answer(payload))
  })

  return { promise, release: () => release() }
}

/** Whether any node matching `selector` was ever in the DOM — even for one
 *  commit: a node taken out again shows up among the removed ones. */
function everShown(records: MutationRecord[], selector: string): boolean {
  return records.some(record =>
    [...record.addedNodes, ...record.removedNodes].some(
      node => node instanceof Element && (node.matches(selector) || node.querySelector(selector) !== null)
    )
  )
}

function storeSnapshot(slug: string, at: number) {
  writeSnapshot(
    'email',
    slug,
    EMAIL_SNAPSHOT_VERSION,
    snapshotOf(shapeInbox({ messages: [INBOUND] }), { address: ADDRESS, status: 'active' }, null),
    at
  )
}

function route(_inftId: string, argv: string[]) {
  const [group, command] = argv

  if (group !== 'email') {
    return reply({ error: 'unexpected command' })
  }

  switch (command) {
    case 'whoami':
      return reply({ id: 'mb', emailAddress: ADDRESS, status: 'active' })

    case 'inbox':
      if (argv.includes('spam')) {
        return reply({ messages: [], nextCursor: null })
      }

      return reply({ messages: sent ? [sent, INBOUND, OUTBOUND] : [INBOUND, OUTBOUND], nextCursor: null })

    case 'thread':
      return argv[3] === 'thr-new'
        ? reply({ id: 'thr-new', subject: 'Hello', messages: [{ ...sent, textBody: 'Nice to meet you.' }] })
        : reply(THREAD)
    case 'compose': {
      sent = {
        ...OUTBOUND,
        id: 'out-new',
        threadId: 'thr-new',
        subject: argv[5],
        to: [argv[3]],
        receivedAt: new Date().toISOString()
      }

      return reply({ messageId: 'out-new', threadId: 'thr-new' })
    }

    default:
      return reply({ ok: true })
  }
}

const props: EconAppProps = {
  inftId: 'eip155:8453:0xabc:7',
  slug: 'inft-7',
  identity: null,
  refreshKey: 0,
  expanded: false
}

function argvsOf(command: string): string[][] {
  return runAcp.mock.calls.map(call => call[1] as string[]).filter(argv => argv[1] === command)
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()

  if (typeof globalThis.CSS === 'undefined' || typeof globalThis.CSS.escape !== 'function') {
    Object.defineProperty(globalThis, 'CSS', { value: { escape: (value: string) => value }, configurable: true })
  }
})

beforeEach(() => {
  // The open-window rhythm (60 s) these tests count ticks by.
  vi.spyOn(window.document, 'hasFocus').mockReturnValue(false)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  sent = null
  window.localStorage.clear()
  runAcp.mockReset()
  runAcp.mockImplementation(route)
  ask.mockReset()
  openSetup.mockReset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function threadReads(): number {
  return runAcp.mock.calls.filter(call => (call[1] as string[])[1] === 'thread').length
}

function inboxReads(): number {
  return runAcp.mock.calls.filter(call => {
    const argv = call[1] as string[]

    return argv[1] === 'inbox' && !argv.includes('spam')
  }).length
}

async function renderApp(slug = props.slug) {
  const view = render(<EmailApp {...props} slug={slug} />)

  await screen.findByText('Deck for Thursday')

  return view
}

describe('EmailApp', () => {
  it('shows the inbox grouped by day, with the unread count and the agent address', async () => {
    await renderApp('inft-list')

    expect(screen.getByRole('heading', { name: 'Today' })).toBeTruthy()
    // The agent's own mail stays out of the Inbox view.
    expect(screen.queryByText('Intro')).toBeNull()
    expect(screen.getByText('Could you send the deck?')).toBeTruthy()
    expect(screen.queryByText(/old quoted line/)).toBeNull()
    expect(within(screen.getByRole('button', { name: /Inbox/ })).getByText('1')).toBeTruthy()
    expect(await screen.findByText(ADDRESS)).toBeTruthy()
    expect(argvsOf('inbox')[0].at(-1)).toBe('--json')
  })

  it('moves with the keyboard, opens a thread as plain text, and closes it with Esc', async () => {
    const { container } = await renderApp('inft-keys')
    const root = container.querySelector('.em') as HTMLElement

    fireEvent.keyDown(root, { key: 'j' })
    fireEvent.keyDown(root.ownerDocument.activeElement as HTMLElement, { key: 'Enter' })
    // A focused row answers Enter with its own click, as a real button would.
    fireEvent.click(root.ownerDocument.activeElement as HTMLElement)

    const pane = await screen.findByRole('region', { name: 'Reading pane' })

    expect(await within(pane).findByText(/Could you send the deck\?/)).toBeTruthy()
    // HTML is reduced to text: no markup, no script, no remote image reaches the DOM.
    expect(pane.querySelector('.em-body b, script, img')).toBeNull()
    expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined()
    expect(within(pane).getByText('Shown as plain text')).toBeTruthy()
    expect(within(pane).getByText('brief.pdf')).toBeTruthy()
    // Clean mail keeps its links, labelled by host.
    expect(within(pane).getByRole('button', { name: /example\.com\/deck/ })).toBeTruthy()

    fireEvent.keyDown(root, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Reading pane' })).toBeNull())
  })

  it('reads the thread under the cursor ahead, so opening it costs no second read', async () => {
    const { container } = await renderApp('inft-prefetch-thread')
    const root = container.querySelector('.em') as HTMLElement

    expect(threadReads()).toBe(0)
    fireEvent.keyDown(root, { key: 'j' })

    await waitFor(() => expect(threadReads()).toBe(1))

    fireEvent.click(root.ownerDocument.activeElement as HTMLElement)

    const pane = await screen.findByRole('region', { name: 'Reading pane' })

    expect(await within(pane).findByText(/Could you send the deck\?/)).toBeTruthy()
    expect(threadReads()).toBe(1)
  })

  it('validates a draft, sends it with compose, and lands on the sent message', async () => {
    const { container } = await renderApp('inft-compose')
    const root = container.querySelector('.em') as HTMLElement

    await screen.findByText(ADDRESS)
    const whoamis = argvsOf('whoami').length

    fireEvent.keyDown(root, { key: 'c' })

    const sheet = await screen.findByRole('region', { name: 'New message' })

    fireEvent.click(within(sheet).getByRole('button', { name: /Send/ }))
    expect(within(sheet).getByText('Add a recipient')).toBeTruthy()
    expect(within(sheet).getByText('Add a subject')).toBeTruthy()
    expect(argvsOf('compose')).toHaveLength(0)

    fireEvent.change(within(sheet).getByLabelText('To'), { target: { value: 'not-an-address' } })
    expect(within(sheet).getByText('That isn’t a valid email address')).toBeTruthy()

    fireEvent.change(within(sheet).getByLabelText('To'), { target: { value: 'bob@example.com' } })
    fireEvent.change(within(sheet).getByLabelText('Subject'), { target: { value: 'Hello' } })
    fireEvent.change(within(sheet).getByLabelText('Message'), { target: { value: 'Nice to meet you.' } })

    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: /Send/ }))
    })

    await waitFor(() => expect(argvsOf('compose')).toHaveLength(1))
    expect(argvsOf('compose')[0]).toEqual([
      'email',
      'compose',
      '--to',
      'bob@example.com',
      '--subject',
      'Hello',
      '--body',
      'Nice to meet you.',
      '--json'
    ])

    // The mailbox is re-read (cache dropped), the Sent folder shows, the new thread opens.
    const pane = await screen.findByRole('region', { name: 'Reading pane' })

    expect(await within(pane).findByText('Nice to meet you.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Sent/ }).getAttribute('aria-current')).toBe('true')
    expect(screen.queryByRole('region', { name: 'New message' })).toBeNull()
    // A send never changes the address, so the reload does not re-ask for it.
    expect(argvsOf('whoami')).toHaveLength(whoamis)
  })

  it('hands the thread to the agent as a brief instead of acting on it', async () => {
    await renderApp('inft-ask')

    fireEvent.click(screen.getByText('Deck for Thursday'))

    const pane = await screen.findByRole('region', { name: 'Reading pane' })

    fireEvent.click(within(pane).getByRole('button', { name: 'Ask Vega about this thread' }))
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toContain('acp email thread --thread-id thr-in --json')
  })

  it('paints the last snapshot before the CLI answers, says how old it is, then takes the live answer', async () => {
    const slug = 'inft-snapshot'
    const at = Date.now() - 3 * 3_600_000

    storeSnapshot(slug, at)

    const answers: Array<(value: unknown) => void> = []

    runAcp.mockImplementation(() => new Promise(resolve => answers.push(resolve)))
    render(<EmailApp {...props} slug={slug} />)

    expect(await screen.findByText('Deck for Thursday')).toBeTruthy()
    expect(screen.getByText(ADDRESS)).toBeTruthy()
    expect($econStatus.get()[`email:${slug}`]?.updatedAt).toBe(at)
    // The header (not the list) says the rows are a saved copy: the routine
    // line lives in the window's status span, the scroll container never
    // gains it.
    expect($econStatus.get()[`email:${slug}`]?.snapshotAt).toBe(at)
    expect(statusText($econStatus.get()[`email:${slug}`]!, 'email', 60_000)).toBe(SAVED_MAIL_TEXT)
    expect(screen.queryByText(/Showing mail saved/)).toBeNull()
    expect(runAcp).toHaveBeenCalledTimes(1)

    const fresh = { ...INBOUND, id: 'in-2', threadId: 'thr-2', subject: 'Fresh news', receivedAt: hoursAgo(0.01) }

    await act(async () => {
      answers[0]({ ok: true, code: 0, stdout: JSON.stringify({ messages: [fresh], nextCursor: null }), stderr: '' })
    })

    expect(await screen.findByText('Fresh news')).toBeTruthy()
    expect(screen.queryByText('Deck for Thursday')).toBeNull()
    expect($econStatus.get()[`email:${slug}`]?.snapshotAt).toBe(0)
  })

  it('puts the snapshot in its very first commit — never a skeleton first', () => {
    const slug = 'inft-first-commit'

    storeSnapshot(slug, Date.now() - 60_000)
    runAcp.mockImplementation(() => new Promise(() => undefined))

    const observer = new MutationObserver(() => undefined)

    observer.observe(window.document.body, { childList: true, subtree: true })
    render(<EmailApp {...props} slug={slug} />)

    const records = observer.takeRecords()

    observer.disconnect()
    expect(everShown(records, '.e-skeleton')).toBe(false)
    expect(everShown(records, '[data-mail-id="in-1"]')).toBe(true)
  })

  it('a timer tick re-reads the open thread only when one of its rows is new or changed', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
    Object.defineProperty(window.document, 'visibilityState', { value: 'visible', configurable: true })

    let rows = [INBOUND, OUTBOUND]

    runAcp.mockImplementation((inftId: string, argv: string[]) =>
      argv[1] === 'inbox' && !argv.includes('spam') ? reply({ messages: rows, nextCursor: null }) : route(inftId, argv)
    )
    await renderApp('inft-thread-tick')
    fireEvent.click(screen.getByText('Deck for Thursday'))
    await waitFor(() => expect(threadReads()).toBeGreaterThan(0))
    await act(async () => {
      await Promise.resolve()
    })

    // Opening reads what it reads; from here on only the ticks count.
    const opened = threadReads()

    const tick = async () => {
      await act(async () => {
        vi.advanceTimersByTime(60_000)
      })
      await waitFor(() => expect(inboxReads()).toBeGreaterThanOrEqual(ticks + 1))
      ticks += 1
    }

    let ticks = inboxReads()

    // An unchanged inbox: no thread spawn.
    await tick()
    await tick()
    expect(threadReads()).toBe(opened)

    // A reply lands in the open thread: it is read once.
    rows = [{ ...INBOUND, id: 'in-reply', receivedAt: hoursAgo(0.01) }, INBOUND, OUTBOUND]
    await tick()
    await waitFor(() => expect(threadReads()).toBe(opened + 1))
    await tick()
    expect(threadReads()).toBe(opened + 1)
  })

  it('a sign-in state on the mount read keeps the saved rows under a Setup note; only a forced read wipes them', async () => {
    const slug = 'inft-reauth'

    storeSnapshot(slug, Date.now() - 60_000)
    runAcp.mockImplementation((inftId: string, argv: string[]) =>
      argv[1] === 'inbox' ? reply({ error: 'HTTP 401 REAUTH:abc' }) : route(inftId, argv)
    )
    const { rerender } = render(<EmailApp {...props} slug={slug} />)

    // The mount read is not the owner's: a (possibly transient) 401 never
    // empties the list nor deletes the saved mail.
    const note = await screen.findByText(/Sign-in required — showing the last messages read/)

    fireEvent.click(within(note).getByRole('button', { name: 'Open Setup' }))
    expect(openSetup).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Deck for Thursday')).toBeTruthy()
    expect(readSnapshot('email', slug, EMAIL_SNAPSHOT_VERSION)).not.toBeNull()

    // The owner's refresh lands on the same state: the list gives way to its
    // Setup action and nothing of a signed-out mailbox repaints from disk.
    rerender(<EmailApp {...props} refreshKey={1} slug={slug} />)
    await waitFor(() => expect(screen.queryByText('Deck for Thursday')).toBeNull())
    expect(screen.getByRole('button', { name: 'Open Setup' })).toBeTruthy()
    expect(readSnapshot('email', slug, EMAIL_SNAPSHOT_VERSION)).toBeNull()
  })

  it('when a live mailbox loses its sign-in, the note over the rows offers Setup', async () => {
    const slug = 'inft-reauth-live'
    const { rerender } = await renderApp(slug)

    runAcp.mockImplementation((inftId: string, argv: string[]) =>
      argv[1] === 'inbox' ? reply({ error: 'HTTP 401 REAUTH:abc' }) : route(inftId, argv)
    )
    rerender(<EmailApp {...props} refreshKey={1} slug={slug} />)

    const note = await screen.findByText(/Sign-in required — showing the last messages read/)

    fireEvent.click(within(note).getByRole('button', { name: 'Open Setup' }))
    expect(openSetup).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Deck for Thursday')).toBeTruthy()
  })

  it('stops a search at the 500 characters the bridge admits', async () => {
    await renderApp('inft-search-cap')

    const box = screen.getByRole('searchbox', { name: 'Search mail' }) as HTMLInputElement

    fireEvent.change(box, { target: { value: 'x'.repeat(600) } })
    expect(box.value).toHaveLength(500)

    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(argvsOf('search')).toHaveLength(1))
    expect(argvsOf('search')[0][3]).toHaveLength(500)
  })

  it('keeps page one on disk after a live load — previews and the address, never a thread body', async () => {
    const slug = 'inft-persist'

    await renderApp(slug)
    await screen.findByText(ADDRESS)

    const stored = readSnapshot<EmailSnapshot>('email', slug, EMAIL_SNAPSHOT_VERSION)

    expect(stored?.data.base.messages.map(row => row.id)).toEqual(['in-1', 'out-1'])
    expect(stored?.data.mailbox?.address).toBe(ADDRESS)

    fireEvent.click(screen.getByText('Deck for Thursday'))

    const pane = await screen.findByRole('region', { name: 'Reading pane' })

    await within(pane).findByRole('button', { name: /example\.com\/deck/ })
    expect(window.localStorage.getItem(`iclone.econ.snap.${slug}.email`)).not.toContain('example.com/deck')
  })

  it('stores the preview a thread read rebuilt, and a later flat answer keeps it on disk', async () => {
    const slug = 'inft-preview-disk'
    const flat = { ...INBOUND, bodyPreview: 'Hi there,Test Pat RBest Regards' }
    let subject = INBOUND.subject

    const body = {
      ...THREAD,
      messages: [{ ...THREAD.messages[0], textBody: 'Hi there,\nTest\n\nPat R\nBest Regards', htmlBody: '' }]
    }

    runAcp.mockImplementation((inftId: string, argv: string[]) => {
      if (argv[1] === 'inbox' && !argv.includes('spam')) {
        return reply({ messages: [{ ...flat, subject }, OUTBOUND], nextCursor: null })
      }

      return argv[1] === 'thread' ? reply(body) : route(inftId, argv)
    })

    const stored = () => readSnapshot<EmailSnapshot>('email', slug, EMAIL_SNAPSHOT_VERSION)?.data.base.messages[0]
    const { rerender } = render(<EmailApp {...props} slug={slug} />)

    await waitFor(() => expect(stored()?.preview).toBe('Hi there,Test Pat RBest Regards'))
    fireEvent.click(screen.getByText('Deck for Thursday'))
    await waitFor(() => expect(stored()?.preview).toBe('Hi there, Test Pat R Best Regards'))

    // The owner's refresh brings the flattened preview again (and a new subject, to see the write land).
    subject = 'Deck for Friday'
    rerender(<EmailApp {...props} refreshKey={1} slug={slug} />)
    await waitFor(() => expect(stored()?.subject).toBe('Deck for Friday'))
    expect(stored()?.preview).toBe('Hi there, Test Pat R Best Regards')
  })

  it('opens on the prefetched answer with no second CLI call, and the dock already has the count', async () => {
    const slug = 'inft-prefetch'

    await prefetch(props.inftId, slug)
    await prefetchesSettled()

    expect($econBadges.get()[slug]?.email).toBe(1)
    expect(argvsOf('inbox')).toHaveLength(1)
    expect(argvsOf('whoami')).toHaveLength(1)

    await renderApp(slug)
    await screen.findByText(ADDRESS)

    expect(argvsOf('inbox')).toHaveLength(1)
    expect(argvsOf('whoami')).toHaveLength(1)
  })

  describe('threads in sequence', () => {
    const row = (id: string, hours: number, isRead = true) => ({
      ...INBOUND,
      id: `in-${id}`,
      threadId: `thr-${id}`,
      subject: `Subject ${id}`,
      bodyPreview: `Preview ${id}`,
      receivedAt: hoursAgo(hours),
      isRead
    })

    /** Pages keyed by cursor (`''` is page one); each thread reads "Body of <id>". */
    function paged(pages: Record<string, { rows: unknown[]; next: null | string }>) {
      return (_inftId: string, argv: string[]) => {
        const [, command] = argv

        if (command === 'inbox') {
          const at = argv.indexOf('--cursor')
          const page = pages[at >= 0 ? argv[at + 1] : '']

          return reply({ messages: page.rows, nextCursor: page.next })
        }

        if (command === 'thread') {
          const id = argv[3]

          return reply({
            id,
            subject: id,
            messages: [{ ...INBOUND, id: `msg-${id}`, threadId: id, textBody: `Body of ${id}`, htmlBody: '' }]
          })
        }

        return route(_inftId, argv)
      }
    }

    it('with a thread open, j opens the next one, u goes back to the list, [ opens the previous', async () => {
      runAcp.mockImplementation(paged({ '': { rows: [row('a', 1), row('b', 2)], next: null } }))

      const { container } = render(<EmailApp {...props} slug="inft-advance" />)
      const root = container.querySelector('.em') as HTMLElement

      fireEvent.click(await screen.findByText('Subject a'))
      expect(await screen.findByText('Body of thr-a')).toBeTruthy()

      fireEvent.keyDown(root, { key: 'j' })
      expect(await screen.findByText('Body of thr-b')).toBeTruthy()

      fireEvent.keyDown(root, { key: 'u' })
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Reading pane' })).toBeNull())

      // Typed as ⌥8 on a Portuguese Mac layout.
      fireEvent.keyDown(root, { key: '[', altKey: true })
      expect(await screen.findByText('Body of thr-a')).toBeTruthy()
    })

    it('a step past the last row pages in the next page, then opens it', async () => {
      runAcp.mockImplementation(
        paged({
          '': { rows: [row('a', 1)], next: 'c1' },
          c1: { rows: [row('b', 30)], next: null }
        })
      )

      const { container } = render(<EmailApp {...props} slug="inft-page-step" />)
      const root = container.querySelector('.em') as HTMLElement

      fireEvent.click(await screen.findByText('Subject a'))
      await screen.findByText('Body of thr-a')

      fireEvent.keyDown(root, { key: ']' })

      expect(await screen.findByText('Body of thr-b')).toBeTruthy()
      expect(argvsOf('inbox').some(argv => argv.includes('c1'))).toBe(true)
    })

    it('going back to the list drops a step still waiting for its page', async () => {
      const next = held({ messages: [row('b', 30)], nextCursor: null })
      const pages = paged({ '': { rows: [row('a', 1)], next: 'c1' } })

      runAcp.mockImplementation((inftId: string, argv: string[]) =>
        argv[1] === 'inbox' && argv.includes('c1') ? next.promise : pages(inftId, argv)
      )

      const { container } = render(<EmailApp {...props} slug="inft-step-dropped" />)
      const root = container.querySelector('.em') as HTMLElement

      fireEvent.click(await screen.findByText('Subject a'))
      await screen.findByText('Body of thr-a')

      fireEvent.keyDown(root, { key: ']' })
      await waitFor(() => expect(argvsOf('inbox').some(argv => argv.includes('c1'))).toBe(true))

      fireEvent.keyDown(root, { key: 'u' })
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Reading pane' })).toBeNull())

      await act(async () => next.release())

      expect(await screen.findByText('Subject b')).toBeTruthy()
      expect(screen.queryByRole('region', { name: 'Reading pane' })).toBeNull()
    })

    it('a spam page in flight never stalls Unread looking further back', async () => {
      const spamPage = held({ messages: [], nextCursor: null })

      const pages = paged({
        '': { rows: [row('a', 1)], next: 'c1' },
        c1: { rows: [row('b', 30, false)], next: null }
      })

      runAcp.mockImplementation((inftId: string, argv: string[]) => {
        if (argv[1] === 'inbox' && argv.includes('spam')) {
          return argv.includes('--cursor') ? spamPage.promise : reply({ messages: [], nextCursor: 's1' })
        }

        return pages(inftId, argv)
      })

      render(<EmailApp {...props} slug="inft-paging-split" />)
      await screen.findByText('Subject a')

      fireEvent.click(screen.getByRole('button', { name: /Spam/ }))
      await waitFor(() => expect(argvsOf('inbox').some(argv => argv.includes('s1'))).toBe(true))

      fireEvent.click(screen.getByRole('button', { name: /Unread/ }))
      await act(async () => spamPage.release())

      expect(await screen.findByText('Subject b')).toBeTruthy()
      expect(argvsOf('inbox').some(argv => argv.includes('c1'))).toBe(true)
    })

    it('paging older mail in never moves the dock tile — it counts page one', async () => {
      const slug = 'inft-badge'

      runAcp.mockImplementation(
        paged({
          '': { rows: [row('a', 1)], next: 'c1' },
          c1: { rows: [row('e', 30, false)], next: null }
        })
      )

      render(<EmailApp {...props} slug={slug} />)
      await screen.findByText('Subject a')
      await waitFor(() => expect($econBadges.get()[slug]?.email).toBe(0))

      fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

      expect(await screen.findByText('Subject e')).toBeTruthy()
      expect($econBadges.get()[slug]?.email).toBe(0)
      // The rail counts every loaded row.
      expect(within(screen.getByRole('button', { name: /Inbox/ })).getByText('1')).toBeTruthy()
    })

    it('a retried page does not page again by itself when the end is still in view', async () => {
      // As a browser does: observing a target already in view reports it at once.
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(private readonly callback: IntersectionObserverCallback) {}

          observe() {
            queueMicrotask(() =>
              this.callback(
                [{ isIntersecting: true } as IntersectionObserverEntry],
                this as unknown as IntersectionObserver
              )
            )
          }

          disconnect() {}
        }
      )

      let failFirst = true

      const pages = paged({
        '': { rows: [row('a', 1)], next: 'c1' },
        c1: { rows: [row('b', 30)], next: 'c2' },
        c2: { rows: [row('c', 60)], next: null }
      })

      runAcp.mockImplementation((inftId: string, argv: string[]) => {
        if (argv.includes('c1') && failFirst) {
          failFirst = false

          return reply({ error: 'HTTP 500: {"message":"Upstream hiccup"}' })
        }

        return pages(inftId, argv)
      })

      render(<EmailApp {...props} slug="inft-retry-sentinel" />)

      // The end is in view on open: one page, which fails.
      fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
      expect(await screen.findByText('Subject b')).toBeTruthy()
      await act(async () => undefined)

      // Only the owner's "Try again" paged again; the end still in view did not.
      expect(argvsOf('inbox').filter(argv => argv.includes('c1'))).toHaveLength(2)
      expect(argvsOf('inbox').some(argv => argv.includes('c2'))).toBe(false)
    })

    it('Unread looks a few pages further back by itself, then offers older mail', async () => {
      runAcp.mockImplementation(
        paged({
          '': { rows: [row('a', 1)], next: 'c1' },
          c1: { rows: [row('b', 30)], next: 'c2' },
          c2: { rows: [row('c', 60)], next: 'c3' },
          c3: { rows: [row('d', 90)], next: 'c4' },
          c4: { rows: [row('e', 120, false)], next: null }
        })
      )

      render(<EmailApp {...props} slug="inft-unread" />)
      await screen.findByText('Subject a')

      fireEvent.click(screen.getByRole('button', { name: /Unread/ }))

      const paging = () => argvsOf('inbox').filter(argv => argv.includes('--cursor'))
      const older = await screen.findByRole('button', { name: 'Load older mail' })

      // The button only appears once the budget is spent — never between pages.
      expect(paging()).toHaveLength(3)
      expect(screen.getByText('Nothing unread so far')).toBeTruthy()

      fireEvent.click(older)

      expect(await screen.findByText('Subject e')).toBeTruthy()
      expect(paging()).toHaveLength(4)
    })

    it('loads the next page when the end of the list scrolls into reach', async () => {
      const observers: IntersectionObserverCallback[] = []

      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(callback: IntersectionObserverCallback) {
            observers.push(callback)
          }

          observe() {}

          disconnect() {}
        }
      )

      runAcp.mockImplementation(
        paged({
          '': { rows: [row('a', 1)], next: 'c1' },
          c1: { rows: [row('b', 30)], next: null }
        })
      )

      render(<EmailApp {...props} slug="inft-sentinel" />)
      await screen.findByText('Subject a')
      await waitFor(() => expect(observers.length).toBeGreaterThan(0))

      await act(async () => {
        observers.at(-1)!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
      })

      expect(await screen.findByText('Subject b')).toBeTruthy()
    })
  })

  describe('the owner’s marks', () => {
    const dotOn = (container: HTMLElement, id: string) =>
      container.querySelector(`[data-mail-id="${id}"] .em-row__dot--on`) !== null

    const rail = (name: RegExp | string) => screen.getByRole('button', { name })
    const bar = () => screen.getByRole('toolbar', { name: 'Selected messages' })
    const box = (subject: string) => screen.getByRole('checkbox', { name: new RegExp(`Select “${subject}”`) })

    const unreadRow = (id: string, hours: number) => ({
      ...INBOUND,
      id: `in-${id}`,
      threadId: `thr-${id}`,
      subject: `Subject ${id}`,
      bodyPreview: `Preview ${id}`,
      receivedAt: hoursAgo(hours),
      isRead: false
    })

    /** Three unread messages; each thread reads "Body of <thread>". */
    function threeUnread(_inftId: string, argv: string[]) {
      if (argv[1] === 'inbox' && !argv.includes('spam')) {
        return reply({ messages: [unreadRow('a', 1), unreadRow('b', 2), unreadRow('c', 3)], nextCursor: null })
      }

      if (argv[1] === 'thread') {
        const id = argv[3]

        return reply({
          id,
          subject: id,
          messages: [{ ...INBOUND, id: `in-${id.slice(4)}`, threadId: id, textBody: `Body of ${id}`, htmlBody: '' }]
        })
      }

      return route(_inftId, argv)
    }

    it('opening a message reads it in the same frame — row, counts and dock tile — before the thread answers', async () => {
      const slug = 'inft-read-now'
      const thread = held(THREAD)

      runAcp.mockImplementation((inftId: string, argv: string[]) =>
        argv[1] === 'thread' ? thread.promise : route(inftId, argv)
      )

      const { container } = await renderApp(slug)

      await waitFor(() => expect($econBadges.get()[slug]?.email).toBe(1))
      expect(dotOn(container, 'in-1')).toBe(true)

      fireEvent.click(screen.getByText('Deck for Thursday'))

      // The thread is still out…
      expect(within(screen.getByRole('region', { name: 'Reading pane' })).getByText('Opening…')).toBeTruthy()
      // …and the row, the Inbox count and the dock tile have already read it.
      expect(dotOn(container, 'in-1')).toBe(false)
      expect(within(rail(/^Inbox/)).queryByText('1')).toBeNull()
      expect($econBadges.get()[slug]?.email).toBe(0)

      fireEvent.click(rail('Unread'))
      expect(screen.getByText('All caught up')).toBeTruthy()

      await act(async () => thread.release())
      // The service's own answer (read) agrees; nothing moves back.
      expect($econBadges.get()[slug]?.email).toBe(0)
    })

    it('select all, then Archive: the Inbox empties, Archive holds the rows, Undo puts them back', async () => {
      await renderApp('inft-archive')

      fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
      expect(within(bar()).getByText('1 selected')).toBeTruthy()
      expect(box('Deck for Thursday').getAttribute('aria-checked')).toBe('true')

      fireEvent.click(within(bar()).getByRole('button', { name: 'Archive' }))

      expect(screen.queryByText('Deck for Thursday')).toBeNull()
      expect(screen.getByText('Nothing here yet')).toBeTruthy()
      expect(screen.queryByRole('toolbar', { name: 'Selected messages' })).toBeNull()
      expect(screen.getByText('Message archived.')).toBeTruthy()
      expect(within(rail(/^Archive/)).getByText('1')).toBeTruthy()

      fireEvent.click(rail(/^Archive/))
      expect(await screen.findByText('Deck for Thursday')).toBeTruthy()
      // Archive and Trash draw on the spam list too — it is read once.
      await waitFor(() => expect(argvsOf('inbox').some(argv => argv.includes('spam'))).toBe(true))

      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      expect(screen.getByText('Nothing archived')).toBeTruthy()
      fireEvent.click(rail(/^Inbox/))
      expect(screen.getByText('Deck for Thursday')).toBeTruthy()
    })

    it('Trash, then Delete forever — asked twice — is gone for good, even after the window reopens', async () => {
      const slug = 'inft-purge'
      const first = await renderApp(slug)

      fireEvent.click(box('Deck for Thursday'))
      fireEvent.click(within(bar()).getByRole('button', { name: 'Trash' }))
      expect(screen.queryByText('Deck for Thursday')).toBeNull()

      fireEvent.click(rail(/^Trash/))
      fireEvent.click(await screen.findByRole('checkbox', { name: /Select “Deck for Thursday”/ }))
      fireEvent.click(within(bar()).getByRole('button', { name: 'Delete forever' }))

      // Armed, not done: the row is still there, the button says what comes next.
      expect(screen.getByText('Deck for Thursday')).toBeTruthy()
      fireEvent.click(within(bar()).getByRole('button', { name: 'Delete 1 forever?' }))

      expect(screen.queryByText('Deck for Thursday')).toBeNull()
      expect(screen.getByText('Trash is empty')).toBeTruthy()
      expect(screen.getByText('Message deleted forever.')).toBeTruthy()
      // Deleted forever offers no Undo.
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()

      first.unmount()
      render(<EmailApp {...props} slug={slug} />)
      await screen.findByText(ADDRESS)

      // Page one (from disk, then live) still carries it; it shows nowhere.
      expect(screen.queryByText('Deck for Thursday')).toBeNull()
      fireEvent.click(rail(/^Trash/))
      expect(screen.getByText('Trash is empty')).toBeTruthy()
      expect(readMailState(slug).purged.has('in-1')).toBe(true)

      // U1p2-T2 — the service still sends it: Trash and the empty Inbox say
      // so, never "Nothing here yet", and Recover brings it back for good.
      expect(screen.getByText(/One message deleted forever on this device/)).toBeTruthy()
      fireEvent.click(rail(/^Inbox/))
      expect(screen.queryByText('Nothing here yet')).toBeNull()
      expect(screen.getByText('Deleted forever on this device')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Recover 1' }))
      expect(screen.getByText('Deck for Thursday')).toBeTruthy()
      expect(screen.getByText('Message brought back.')).toBeTruthy()
      expect(readMailState(slug).purged.has('in-1')).toBe(false)
    })

    it('Empty trash asks twice, then deletes everything in Trash forever', async () => {
      await renderApp('inft-empty-trash')

      fireEvent.click(box('Deck for Thursday'))
      fireEvent.click(within(bar()).getByRole('button', { name: 'Trash' }))
      fireEvent.click(rail(/^Trash/))
      await screen.findByText('Deck for Thursday')

      fireEvent.click(screen.getByRole('button', { name: 'Empty trash' }))
      expect(screen.getByText('Deck for Thursday')).toBeTruthy()

      // Esc disarms it — and does nothing else.
      fireEvent.keyDown(screen.getByRole('button', { name: 'Delete all forever?' }), { key: 'Escape' })
      fireEvent.click(screen.getByRole('button', { name: 'Empty trash' }))
      fireEvent.click(screen.getByRole('button', { name: 'Delete all forever?' }))

      expect(screen.getByText('Trash is empty')).toBeTruthy()
      expect(readMailState('inft-empty-trash').purged.has('in-1')).toBe(true)
    })

    it('Mark unread brings back the dot, the count and the dock tile — from the pane and from the bar', async () => {
      const slug = 'inft-unread-again'
      const { container } = await renderApp(slug)

      fireEvent.click(screen.getByText('Deck for Thursday'))

      const pane = await screen.findByRole('region', { name: 'Reading pane' })

      await within(pane).findByText('Shown as plain text')
      expect($econBadges.get()[slug]?.email).toBe(0)

      fireEvent.click(within(pane).getByRole('button', { name: 'Mark unread · ⇧U' }))

      expect(screen.queryByRole('region', { name: 'Reading pane' })).toBeNull()
      expect(dotOn(container, 'in-1')).toBe(true)
      expect(within(rail(/^Inbox/)).getByText('1')).toBeTruthy()
      expect($econBadges.get()[slug]?.email).toBe(1)

      fireEvent.click(box('Deck for Thursday'))
      fireEvent.click(within(bar()).getByRole('button', { name: 'Mark read' }))
      expect(dotOn(container, 'in-1')).toBe(false)
      expect($econBadges.get()[slug]?.email).toBe(0)

      fireEvent.click(within(bar()).getByRole('button', { name: 'Mark unread' }))
      expect(dotOn(container, 'in-1')).toBe(true)
      expect($econBadges.get()[slug]?.email).toBe(1)
      // The selection stays for the next action.
      expect(within(bar()).getByText('1 selected')).toBeTruthy()
    })

    it('Mark unread made while the thread is still loading holds once the service has read it', async () => {
      const slug = 'inft-unread-race'
      const thread = held(THREAD)
      let asked = false

      runAcp.mockImplementation((inftId: string, argv: string[]) => {
        if (argv[1] === 'thread') {
          asked = true

          return thread.promise
        }

        // Asking for the thread is what reads it at the service.
        if (argv[1] === 'inbox' && !argv.includes('spam')) {
          return reply({ messages: [{ ...INBOUND, isRead: asked }, OUTBOUND], nextCursor: null })
        }

        return route(inftId, argv)
      })

      const { container, rerender } = await renderApp(slug)

      fireEvent.click(screen.getByText('Deck for Thursday'))

      const pane = screen.getByRole('region', { name: 'Reading pane' })

      fireEvent.click(within(pane).getByRole('button', { name: 'Mark unread · ⇧U' }))
      await act(async () => thread.release())

      const reads = argvsOf('inbox').length

      rerender(<EmailApp {...props} refreshKey={1} slug={slug} />)
      await waitFor(() => expect(argvsOf('inbox').length).toBeGreaterThan(reads))
      await act(async () => undefined)

      expect(dotOn(container, 'in-1')).toBe(true)
      expect($econBadges.get()[slug]?.email).toBe(1)
    })

    it('x checks the cursor row, shift-click checks a range, Esc clears the selection', async () => {
      runAcp.mockImplementation(threeUnread)

      const { container } = render(<EmailApp {...props} slug="inft-select-keys" />)
      const root = container.querySelector('.em') as HTMLElement

      await screen.findByText('Subject a')

      fireEvent.keyDown(root, { key: 'j' })
      fireEvent.keyDown(root.ownerDocument.activeElement as HTMLElement, { key: 'x' })
      expect(box('Subject a').getAttribute('aria-checked')).toBe('true')

      fireEvent.click(box('Subject c'), { shiftKey: true })
      expect(within(bar()).getByText('3 selected')).toBeTruthy()
      expect(box('Subject b').getAttribute('aria-checked')).toBe('true')
      expect(screen.getByRole('checkbox', { name: 'Select all' }).getAttribute('aria-checked')).toBe('true')

      fireEvent.keyDown(root, { key: 'x' })
      expect(screen.getByRole('checkbox', { name: 'Select all' }).getAttribute('aria-checked')).toBe('mixed')

      fireEvent.keyDown(root, { key: 'Escape' })
      expect(screen.queryByRole('toolbar', { name: 'Selected messages' })).toBeNull()
      expect(box('Subject b').getAttribute('aria-checked')).toBe('false')
      // The search box is back where the bar was.
      expect(screen.getByRole('searchbox', { name: 'Search mail' })).toBeTruthy()
    })

    it('E archives the open message and closes it; Z undoes', async () => {
      const { container } = await renderApp('inft-archive-key')
      const root = container.querySelector('.em') as HTMLElement

      fireEvent.click(screen.getByText('Deck for Thursday'))
      await screen.findByRole('region', { name: 'Reading pane' })

      fireEvent.keyDown(root, { key: 'e' })
      expect(screen.queryByRole('region', { name: 'Reading pane' })).toBeNull()
      expect(screen.queryByText('Deck for Thursday')).toBeNull()

      fireEvent.keyDown(root, { key: 'z' })
      expect(screen.getByText('Deck for Thursday')).toBeTruthy()
    })

    it('reading through Unread: each message leaves as it is read, and j goes on to the next one down', async () => {
      runAcp.mockImplementation(threeUnread)

      const { container } = render(<EmailApp {...props} slug="inft-unread-walk" />)
      const root = container.querySelector('.em') as HTMLElement

      await screen.findByText('Subject a')
      fireEvent.click(rail('Unread'))
      fireEvent.click(screen.getByText('Subject b'))

      expect(await screen.findByText('Body of thr-b')).toBeTruthy()
      expect(screen.queryByText('Subject b')).toBeNull()

      fireEvent.keyDown(root, { key: 'j' })
      expect(await screen.findByText('Body of thr-c')).toBeTruthy()
      expect(screen.getByText('Subject a')).toBeTruthy()
    })

    it('the prefetch counts the dock tile with the owner’s marks', async () => {
      const slug = 'inft-prefetch-marks'

      writeMailState(slug, setRead(EMPTY_MAIL_STATE, [{ id: 'in-1', isRead: false }], true, 1))
      await prefetch(props.inftId, slug)
      await prefetchesSettled()

      expect($econBadges.get()[slug]?.email).toBe(0)
    })

    it('another iNFT keeps its own marks', async () => {
      writeMailState('inft-other', setRead(EMPTY_MAIL_STATE, [{ id: 'in-1', isRead: false }], true, 1))

      const { container } = await renderApp('inft-mine')

      expect(dotOn(container, 'in-1')).toBe(true)
    })
  })

  it('a participant opens a menu: write to them, or copy their address', async () => {
    const writeText = vi.fn(() => Promise.resolve())

    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    await renderApp('inft-people')

    fireEvent.click(screen.getByText('Deck for Thursday'))

    const pane = await screen.findByRole('region', { name: 'Reading pane' })

    await within(pane).findByText('Shown as plain text')
    fireEvent.click(within(pane).getByRole('button', { name: 'Jane Doe' }))

    const menu = within(pane).getByRole('menu', { name: 'Actions for jane@example.com' })

    fireEvent.click(within(menu).getByRole('menuitem', { name: /Copy address/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('jane@example.com'))
    expect(await within(menu).findByText('Copied')).toBeTruthy()

    fireEvent.click(within(menu).getByRole('menuitem', { name: /Write a message/ }))

    const sheet = await screen.findByRole('region', { name: 'New message' })

    expect((within(sheet).getByLabelText('To') as HTMLInputElement).value).toBe('jane@example.com')
    expect(sheet.ownerDocument.activeElement).toBe(within(sheet).getByLabelText('Subject'))
  })
})
