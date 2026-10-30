// The Home roster scanner (V3-H r2, critic MAJOR-1): a full paged scan only when
// asked (sign-in, Rescan), a cheap bounded refresh every 3 minutes, one scan at a
// time, and an AbortSignal that stops a running scan's requests.
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const {
  collectPages,
  createHomeScanner,
  HOME_OWNER_BATCH,
  HOME_OWNER_CONCURRENCY,
  HOME_VERIFY_PER_TICK,
  nextPageParams,
  parseBookCursor,
  parseCheckedIds
} = await import('./iclone-inft-book')

type Params = Readonly<Record<string, number | string | null>> | null

const WALLET = '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631'
const CONTRACT = '0x3d9f35e08c41a80155353862f883f2b70119809f'
const CHAINS = ['Base', 'Robinhood']
const word = (address: string) => `0x${address.slice(2).padStart(64, '0')}`

const ids = (chain: string, n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => `${chain.toLowerCase()}:${CONTRACT}:${from + i}`)

/** Counts every request, per chain and kind; an endless wallet when `endless`. */
function fakeChain(options: { pageDelayMs?: number; endless?: boolean; owner?: (call: string) => string } = {}) {
  const pages: Record<string, number> = {}
  const batches: Record<string, number> = {}
  const batchSizes: number[] = []
  let inFlight = 0
  let maxInFlight = 0

  const readPage = vi.fn(async (chain: string, _address: string, params: Params, signal?: AbortSignal) => {
    pages[chain] = (pages[chain] ?? 0) + 1

    if (options.pageDelayMs) {
      await new Promise(resolve => setTimeout(resolve, options.pageDelayMs))
    }

    if (signal?.aborted) {
      return null
    }

    const page = typeof params?.items_count === 'number' ? params.items_count / 50 : 0

    return {
      items: [`${chain}-${page}`],
      next: options.endless || page < 2 ? { items_count: (page + 1) * 50 } : null
    }
  })

  const ethCallBatch = vi.fn(async (chain: string, calls: readonly { to: string; data: string }[]) => {
    batches[chain] = (batches[chain] ?? 0) + 1
    batchSizes.push(calls.length)
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise(resolve => setTimeout(resolve, 1))
    inFlight -= 1

    return calls.map(call => (options.owner ? options.owner(call.data) : word(WALLET)))
  })

  return { batchSizes, batches, ethCallBatch, maxInFlight: () => maxInFlight, pages, readPage }
}

function scannerOver(fake: ReturnType<typeof fakeChain>) {
  const fullScan = vi.fn((address: string, signal: AbortSignal) =>
    Promise.all(
      CHAINS.map(chain =>
        collectPages(params => fake.readPage(chain, address, params, signal), {
          ceiling: 5_000,
          retries: 0,
          backoffMs: [0],
          signal
        })
      )
    )
  )

  return {
    fullScan,
    scanner: createHomeScanner({ chains: CHAINS, readPage: fake.readPage, fullScan, ethCallBatch: fake.ethCallBatch })
  }
}

describe('the 3-minute refresh: page 1 + batched ownerOf, never the whole wallet', () => {
  it.each([0, 1, 20, 21, 57, 100])(
    '%i checked per chain: ≤ 1 + ceil(checked / batch) requests per chain',
    async checked => {
      const fake = fakeChain()
      const { scanner } = scannerOver(fake)
      const result = await scanner.tick(WALLET, [...ids('Base', checked), ...ids('Robinhood', checked)])

      for (const chain of CHAINS) {
        const requests = (fake.pages[chain] ?? 0) + (fake.batches[chain] ?? 0)

        expect(requests).toBeLessThanOrEqual(1 + Math.ceil(checked / HOME_OWNER_BATCH))
        expect(fake.pages[chain]).toBe(1)
      }

      expect(Math.max(0, ...fake.batchSizes)).toBeLessThanOrEqual(HOME_OWNER_BATCH)
      expect(result).toMatchObject({ ok: true, skipped: false, arrivals: ['Base-0', 'Robinhood-0'] })
      expect(Object.keys(result.owners)).toHaveLength(2 * checked)
    }
  )

  it('batches run at most HOME_OWNER_CONCURRENCY at once', async () => {
    const fake = fakeChain()
    const { scanner } = scannerOver(fake)

    await scanner.tick(WALLET, [...ids('Base', 100), ...ids('Robinhood', 100)])

    expect(fake.maxInFlight()).toBeGreaterThan(1)
    expect(fake.maxInFlight()).toBeLessThanOrEqual(HOME_OWNER_CONCURRENCY)
  })

  it('a checked set larger than the per-tick bound is proven in turns, never all at once', async () => {
    const fake = fakeChain()
    const { scanner } = scannerOver(fake)
    const checked = ids('Base', 450)
    const proven = new Set<string>()

    for (let tick = 0; tick < 3; tick++) {
      const result = await scanner.tick(WALLET, checked)

      expect(Object.keys(result.owners)).toHaveLength(HOME_VERIFY_PER_TICK)
      Object.keys(result.owners).forEach(id => proven.add(id))
    }

    expect(fake.batches.Base).toBe(3 * (HOME_VERIFY_PER_TICK / HOME_OWNER_BATCH))
    expect(proven.size).toBe(450)
  })

  it('K88: a wallet switched away from leaves no proof window behind (the rotation map holds one wallet)', async () => {
    const other = '0x2222222222222222222222222222222222222222'
    const { scanner } = scannerOver(fakeChain())
    const checked = ids('Base', 450)

    const first = await scanner.tick(WALLET, checked)
    await scanner.tick(other, checked)
    const again = await scanner.tick(WALLET, checked)

    // Back on the first wallet, its window starts over instead of resuming from a kept entry.
    expect(Object.keys(again.owners)).toEqual(Object.keys(first.owners))
  })

  it('verdicts: this wallet = held, another = gone, no answer or the zero address = unknown', async () => {
    const other = '0x2222222222222222222222222222222222222222'

    const fake = fakeChain({
      owner: data =>
        data.endsWith('1')
          ? word(WALLET)
          : data.endsWith('2')
            ? word(other)
            : data.endsWith('3')
              ? word('0x' + '0'.repeat(40))
              : '0x'
    })

    const { scanner } = scannerOver(fake)
    const result = await scanner.tick(WALLET, ids('Base', 4))
    const [one, two, three, four] = ids('Base', 4)

    expect(result.owners).toEqual({ [one!]: 'held', [two!]: 'gone', [three!]: 'unknown', [four!]: 'unknown' })
  })

  it('N2: an answer whose upper 12 bytes are not zero is not an address — unknown, never held or gone', async () => {
    const other = '0x2222222222222222222222222222222222222222'
    const dirty = (address: string) => `0xdeadbeef${'0'.repeat(16)}${address.slice(2)}`

    const fake = fakeChain({
      owner: data =>
        data.endsWith('1')
          ? dirty(WALLET)
          : data.endsWith('2')
            ? dirty(other)
            : data.endsWith('3')
              ? word(WALLET).toUpperCase().replace('0X', '0x')
              : `0x${'0'.repeat(23)}1${other.slice(2)}`
    })

    const { scanner } = scannerOver(fake)
    const result = await scanner.tick(WALLET, ids('Base', 4))
    const [one, two, three, four] = ids('Base', 4)

    expect(result.owners).toEqual({ [one!]: 'unknown', [two!]: 'unknown', [three!]: 'held', [four!]: 'unknown' })
  })

  it('K21: an answer spelled "0X…" is not an ownerOf word — unknown; upper-case hex digits after "0x" still read', async () => {
    const fake = fakeChain({
      owner: data =>
        data.endsWith('1') ? word(WALLET).replace('0x', '0X') : `0x${word(WALLET).slice(2).toUpperCase()}`
    })

    const { scanner } = scannerOver(fake)
    const result = await scanner.tick(WALLET, ids('Base', 2))
    const [one, two] = ids('Base', 2)

    expect(result.owners).toEqual({ [one!]: 'unknown', [two!]: 'held' })
  })

  it('K88: a token id past 2^256 - 1 is dropped; the largest uint256 is kept', () => {
    const max = ((1n << 256n) - 1n).toString()
    const over = (1n << 256n).toString()

    expect(parseCheckedIds([`base:${CONTRACT}:${max}`, `base:${CONTRACT}:${over}`], CHAINS)).toEqual([
      { id: `base:${CONTRACT}:${max}`, chain: 'Base', contract: CONTRACT, tokenId: max }
    ])
  })

  it('bad input is dropped, not trusted: unknown chain, bad contract, bad token id, extra parts, non-strings', () => {
    expect(
      parseCheckedIds(
        [
          `base:${CONTRACT}:7`,
          `base:${CONTRACT}:7`,
          `evil:${CONTRACT}:7`,
          `base:0xnot:7`,
          `base:${CONTRACT}:-1`,
          `base:${CONTRACT}:7:x`,
          `base:${CONTRACT.toUpperCase()}:7`,
          42,
          null
        ],
        CHAINS
      )
    ).toEqual([{ id: `base:${CONTRACT}:7`, chain: 'Base', contract: CONTRACT, tokenId: '7' }])
    expect(parseCheckedIds('nope', CHAINS)).toEqual([])
  })

  it('a bad wallet address reads nothing', async () => {
    const fake = fakeChain()
    const { scanner } = scannerOver(fake)

    await expect(scanner.tick('0xnope', ids('Base', 3))).resolves.toMatchObject({ ok: false })
    expect(fake.readPage).not.toHaveBeenCalled()
  })
})

describe('one scan at a time', () => {
  it('a refresh while a full scan runs is skipped (0 requests); the same wallet joins the running full scan', async () => {
    const fake = fakeChain({ pageDelayMs: 5 })
    const { fullScan, scanner } = scannerOver(fake)

    const first = scanner.full(WALLET)
    const joined = scanner.full(WALLET.toUpperCase().replace('0X', '0x'))
    const tick = await scanner.tick(WALLET, ids('Base', 3))

    expect(tick).toMatchObject({ ok: true, skipped: true, arrivals: [], owners: {} })
    expect(fake.ethCallBatch).not.toHaveBeenCalled()
    await Promise.all([first, joined])
    expect(fullScan).toHaveBeenCalledTimes(1)
    expect(fake.pages).toEqual({ Base: 3, Robinhood: 3 })
  })

  it('two refreshes never overlap', async () => {
    const fake = fakeChain({ pageDelayMs: 5 })
    const { scanner } = scannerOver(fake)
    const [a, b] = await Promise.all([scanner.tick(WALLET, []), scanner.tick(WALLET, [])])

    expect([a.skipped, b.skipped]).toEqual([false, true])
    expect(fake.pages).toEqual({ Base: 1, Robinhood: 1 })
  })

  it('after a scan ends, the next refresh runs', async () => {
    const fake = fakeChain()
    const { scanner } = scannerOver(fake)

    await scanner.full(WALLET)
    await expect(scanner.tick(WALLET, [])).resolves.toMatchObject({ skipped: false })
  })
})

describe('abort: sign-out and a wallet switch stop the running scan', () => {
  it('sign-out mid-scan: no page is requested after the abort', async () => {
    const fake = fakeChain({ pageDelayMs: 5, endless: true })
    const { scanner } = scannerOver(fake)
    const running = scanner.full(WALLET)

    await new Promise(resolve => setTimeout(resolve, 40))
    scanner.abort()

    const atAbort = { ...fake.pages }

    await running
    await new Promise(resolve => setTimeout(resolve, 40))

    // At most the request already on the wire per chain finishes; nothing new starts.
    for (const chain of CHAINS) {
      expect(fake.pages[chain]).toBeLessThanOrEqual((atAbort[chain] ?? 0) + 1)
    }

    const settled = { ...fake.pages }

    await new Promise(resolve => setTimeout(resolve, 40))
    expect(fake.pages).toEqual(settled)
  })

  it('the signal reaches the page reader', async () => {
    const fake = fakeChain({ pageDelayMs: 5, endless: true })
    const { scanner } = scannerOver(fake)
    const running = scanner.full(WALLET)

    await new Promise(resolve => setTimeout(resolve, 10))
    scanner.abort()
    await running

    const signal = fake.readPage.mock.calls[0]?.[3]

    expect(signal?.aborted).toBe(true)
  })

  it('a wallet switch aborts the old wallet scan and runs the new one', async () => {
    const fake = fakeChain({ pageDelayMs: 5, endless: true })
    const { fullScan, scanner } = scannerOver(fake)
    const old = scanner.full(WALLET)

    await new Promise(resolve => setTimeout(resolve, 15))

    const other = '0x2222222222222222222222222222222222222222'
    const next = scanner.full(other)

    expect(fullScan.mock.calls[0]?.[1].aborted).toBe(true)
    expect(fullScan.mock.calls[1]?.[0]).toBe(other)
    await old
    scanner.abort()
    await next
  })
})

describe('the cursor keys are allow-listed (critic MINOR-1)', () => {
  it('a forged cursor carrying `type` (or any key Blockscout does not send) is rejected', () => {
    expect(parseBookCursor({ chain: 'Base', params: { type: 'ERC-20' } }, CHAINS)).toBeNull()
    expect(parseBookCursor({ chain: 'Base', params: { token_id: '5', type: 'ERC-20' } }, CHAINS)).toBeNull()
    expect(
      parseBookCursor(
        {
          chain: 'Base',
          params: { items_count: 50, token_contract_address_hash: CONTRACT, token_id: '5', token_type: 'ERC-721' }
        },
        CHAINS
      )
    ).not.toBeNull()
  })

  it('an indexer next_page_params with an unknown key is an unusable page (undefined), not a last page (null)', () => {
    expect(nextPageParams(null)).toBeNull()
    expect(nextPageParams(undefined)).toBeNull()
    expect(nextPageParams({ items_count: 50, brand_new_key: 1 })).toBeUndefined()
    expect(nextPageParams({ items_count: 50, token_id: '9' })).toEqual({ items_count: 50, token_id: '9' })
  })
})
