import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const {
  BOOK_SCAN_CEILING,
  collectPages,
  maxPagesFor,
  parseBookCursor,
  parsePageParams,
  readBookPage,
  readPageWithRetry
} = await import('./iclone-inft-book')

type Params = Readonly<Record<string, number | string | null>> | null

const noSleep = { sleep: () => Promise.resolve() }

/** A deterministic wallet of `total` items served 50 per page; `fail` pages answer null `times` times. */
function wallet(total: number, fail: Record<number, number> = {}) {
  const calls: number[] = []
  const failures = { ...fail }

  const read = (params: Params) => {
    const page = typeof params?.page === 'number' ? params.page : 0

    calls.push(page)

    if ((failures[page] ?? 0) > 0) {
      failures[page] = (failures[page] ?? 0) - 1

      return Promise.resolve(null)
    }

    const items = Array.from({ length: Math.max(0, Math.min(50, total - page * 50)) }, (_, i) => page * 50 + i)
    const next = (page + 1) * 50 < total ? { page: page + 1, token_id: String((page + 1) * 50) } : null

    return Promise.resolve({ items, next })
  }

  return { calls, read }
}

describe('collectPages (the Home roster scan — the old 60-item cap is gone)', () => {
  it('reads a 1 000-item wallet to the end, in 20 pages, in order', async () => {
    const { calls, read } = wallet(1_000)
    const scan = await collectPages(read, { ceiling: BOOK_SCAN_CEILING, retries: 1, backoffMs: [0], ...noSleep })

    expect(scan.items).toHaveLength(1_000)
    expect(scan.items[999]).toBe(999)
    expect(scan).toMatchObject({ pages: 20, complete: true })
    expect(calls).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })

  it('the 60-item boundary: 2 pages, all 60 items', async () => {
    const scan = await collectPages(wallet(60).read, { ceiling: BOOK_SCAN_CEILING, retries: 0, backoffMs: [0] })

    expect(scan).toMatchObject({ pages: 2, complete: true })
    expect(scan.items).toHaveLength(60)
  })

  it('stops at the 5 000 ceiling and says the scan is not complete', async () => {
    const { calls, read } = wallet(6_000)
    const scan = await collectPages(read, { ceiling: BOOK_SCAN_CEILING, retries: 0, backoffMs: [0] })

    expect(scan.items).toHaveLength(5_000)
    expect(scan.complete).toBe(false)
    expect(scan.capped).toBe(true)
    expect(calls).toHaveLength(100)
  })

  it('exactly 5 000 items is complete', async () => {
    const scan = await collectPages(wallet(5_000).read, { ceiling: BOOK_SCAN_CEILING, retries: 0, backoffMs: [0] })

    expect(scan).toMatchObject({ complete: true, pages: 100 })
  })

  it('a page that fails for good keeps the pages before it (page 3 down → pages 1-2 kept)', async () => {
    const scan = await collectPages(wallet(1_000, { 2: 9 }).read, {
      ceiling: BOOK_SCAN_CEILING,
      retries: 3,
      backoffMs: [0],
      ...noSleep
    })

    expect(scan).toMatchObject({ pages: 2, complete: false })
    expect(scan.items).toHaveLength(100)
  })

  it('a first page that fails reports 0 pages (the caller falls back to RPC)', async () => {
    const scan = await collectPages(wallet(100, { 0: 9 }).read, { ceiling: 10, retries: 1, backoffMs: [0], ...noSleep })

    expect(scan).toMatchObject({ pages: 0, items: [] })
  })
})

describe('collectPages never follows an endless indexer (K65)', () => {
  it('empty pages with a fresh next cursor forever: stops at the page cap, not complete', async () => {
    let calls = 0

    const read = (params: Params) => {
      calls += 1

      const page = typeof params?.page === 'number' ? params.page : 0

      // A safety stop for the test itself, far past the cap: an uncapped loop fails here instead of hanging.
      return Promise.resolve(calls > 1_000 ? null : { items: [] as number[], next: { page: page + 1 } })
    }

    const scan = await collectPages(read, { ceiling: BOOK_SCAN_CEILING, retries: 0, backoffMs: [0] })

    expect(maxPagesFor(BOOK_SCAN_CEILING)).toBe(110)
    expect(calls).toBe(110)
    expect(scan).toMatchObject({ pages: 110, complete: false, capped: false, items: [] })
  })

  it('a next cursor that names the page just read stops after that page, keeping its items', async () => {
    let calls = 0

    const read = (params: Params) => {
      calls += 1

      return Promise.resolve(
        params ? { items: [2], next: { page: 1, token_id: '50' } } : { items: [1], next: { page: 1, token_id: '50' } }
      )
    }

    const scan = await collectPages(read, { ceiling: BOOK_SCAN_CEILING, retries: 0, backoffMs: [0] })

    expect(calls).toBe(2)
    expect(scan).toMatchObject({ pages: 2, complete: false, capped: false, items: [1, 2] })
  })

  it('an explicit maxPages wins over the derived one', async () => {
    const scan = await collectPages(wallet(1_000).read, {
      ceiling: BOOK_SCAN_CEILING,
      maxPages: 3,
      retries: 0,
      backoffMs: [0]
    })

    expect(scan).toMatchObject({ pages: 3, complete: false })
    expect(scan.items).toHaveLength(150)
  })
})

describe('readPageWithRetry', () => {
  it('retries at most 3 times, waiting the backoff between tries', async () => {
    const sleep = vi.fn(() => Promise.resolve())
    const read = vi.fn(() => Promise.resolve(null))

    await expect(
      readPageWithRetry(read, null, { retries: 3, backoffMs: [500, 1_500, 4_000], sleep })
    ).resolves.toBeNull()
    expect(read).toHaveBeenCalledTimes(4)
    expect(sleep.mock.calls).toEqual([[500], [1_500], [4_000]])
  })

  it('a flap rescued by a retry returns the page; a thrown read counts as a failure', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('500'))
      .mockResolvedValueOnce({ items: [1], next: null })

    await expect(readPageWithRetry(read, null, { retries: 3, backoffMs: [0], ...noSleep })).resolves.toEqual({
      items: [1],
      next: null
    })
  })
})

describe('the Book cursor (renderer input, re-validated every call)', () => {
  it('accepts a known chain and a small flat record of scalars', () => {
    expect(parseBookCursor({ chain: 'Base', params: { token_id: '50', items_count: 50 } }, ['Base'])).toEqual({
      chain: 'Base',
      params: { token_id: '50', items_count: 50 }
    })
    expect(parseBookCursor({ chain: 'Base', params: null }, ['Base'])).toEqual({ chain: 'Base', params: null })
  })

  it.each([
    ['unknown chain', { chain: 'Evil', params: null }],
    ['nested value', { chain: 'Base', params: { a: { b: 1 } } }],
    ['odd key', { chain: 'Base', params: { 'a&b=': '1' } }],
    ['long value', { chain: 'Base', params: { a: 'x'.repeat(500) } }],
    ['array', ['Base']],
    ['string', 'Base']
  ])('rejects %s', (_name, raw) => {
    expect(parseBookCursor(raw, ['Base'])).toBeNull()
  })

  it('next_page_params of 9 keys or an empty record is not a cursor', () => {
    expect(parsePageParams({})).toBeNull()
    expect(
      parsePageParams(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${'a'.repeat(i)}`, i])))
    ).toBeNull()
  })
})

describe('readBookPage (one page per call, cursor in → cursor out)', () => {
  const chains = ['Base', 'Robinhood']

  it('walks a chain page by page, then the next chain, then says done', async () => {
    const read = vi.fn((chain: string, _address: string, params: Params) =>
      Promise.resolve(
        chain === 'Base' && !params ? { items: ['b0'], next: { page: 1 } } : { items: [`${chain}-last`], next: null }
      )
    )

    const first = await readBookPage(read, chains, '0xabc', null)
    const second = await readBookPage(read, chains, '0xabc', first.cursor)
    const third = await readBookPage(read, chains, '0xabc', second.cursor)

    expect(first).toMatchObject({ ok: true, done: false, cursor: { chain: 'Base', params: { page: 1 } } })
    expect(second).toMatchObject({ ok: true, done: false, cursor: { chain: 'Robinhood', params: null } })
    expect(third).toMatchObject({ ok: true, done: true, cursor: null, items: ['Robinhood-last'] })
  })

  it('K65: a page whose next cursor is the page just read is refused, with its items and its own cursor', async () => {
    const at = { chain: 'Base', params: { page: 3 } }

    const page = await readBookPage(() => Promise.resolve({ items: ['x'], next: { page: 3 } }), chains, '0xabc', at)

    expect(page).toEqual({ ok: false, items: ['x'], cursor: at, done: false, error: 'cursor repeated' })
  })

  it('a failed page hands back its own cursor for the retry', async () => {
    const at = { chain: 'Base', params: { page: 3 } }

    const page = await readBookPage(() => Promise.resolve(null), chains, '0xabc', at, {
      retries: 3,
      backoffMs: [0],
      ...noSleep
    })

    expect(page).toEqual({ ok: false, items: [], cursor: at, done: false, error: 'page failed' })
  })
})

describe('K23: an unreadable next cursor fails only the follow-up', () => {
  it('Home scan: page 1 with a broken cursor keeps its items and says incomplete (not a failed indexer)', async () => {
    const read = vi.fn(() => Promise.resolve({ items: [1, 2, 3], next: null, cursorBroken: true }))

    const scan = await collectPages(read, { ceiling: BOOK_SCAN_CEILING, retries: 1, backoffMs: [0], ...noSleep })

    expect(scan).toEqual({ items: [1, 2, 3], pages: 1, complete: false, capped: false })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('Home scan: a broken cursor on page 3 keeps pages 1-3', async () => {
    const pages = [
      { items: [1], next: { page: 1 } },
      { items: [2], next: { page: 2 } },
      { items: [3], next: null, cursorBroken: true }
    ]

    const scan = await collectPages(() => Promise.resolve(pages.shift() ?? null), {
      ceiling: BOOK_SCAN_CEILING,
      retries: 0,
      backoffMs: [0]
    })

    expect(scan).toEqual({ items: [1, 2, 3], pages: 3, complete: false, capped: false })
  })

  it('Book: the page is kept with its own cursor and a retry, never read as the last page', async () => {
    const at = { chain: 'Base', params: { page: 3 } }

    const page = await readBookPage(
      () => Promise.resolve({ items: ['x'], next: null, cursorBroken: true }),
      ['Base', 'Robinhood'],
      '0xabc',
      at
    )

    expect(page).toEqual({ ok: false, items: ['x'], cursor: at, done: false, error: 'cursor unreadable' })
  })
})

describe('K106: the renderer mirrors the page cap main enforces', () => {
  it('BOOK_SCAN_CEILING and BOOK_MAX_PAGES_PER_CHAIN (book-model.ts) equal main’s ceiling and maxPagesFor', async () => {
    // A computed path: book-model.ts is renderer code (its one import is type-only), outside the electron tsconfig.
    const file = new URL('../src/app/settings/inft-book/book-model.ts', import.meta.url).pathname

    const renderer = (await import(file)) as { BOOK_MAX_PAGES_PER_CHAIN: number; BOOK_SCAN_CEILING: number }

    expect(renderer.BOOK_SCAN_CEILING).toBe(BOOK_SCAN_CEILING)
    expect(renderer.BOOK_MAX_PAGES_PER_CHAIN).toBe(maxPagesFor(BOOK_SCAN_CEILING))
  })
})
