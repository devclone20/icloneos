// The Home roster scan through the real `iclone:inft-scan` / `iclone:inft-scan-tick`
// handlers (electron mocked, fetch stubbed per URL): every page of the wallet on a
// full scan (the old 60-item cap fails here), a refresh that costs 1 indexer page
// per chain + ceil(checked / 20) JSON-RPC batches, and a sign-out that stops the scan.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const st = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), userData: '' }))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/nonexistent',
    getPath: () => st.userData,
    isPackaged: false,
    once: () => undefined,
    on: () => undefined
  },
  BrowserWindow: class {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => st.handlers.set(channel, handler),
    on: () => undefined,
    removeListener: () => undefined
  },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: () => undefined,
      clearStorageData: () => Promise.resolve(),
      getStoragePath: () => st.userData
    })
  },
  shell: { openExternal: () => undefined }
}))

vi.mock('node:http', () => {
  const createServer = () => {
    const server: Record<string, unknown> = { listening: true, listen: () => server, close: () => server }

    server.on = () => server
    server.once = () => server

    return server
  }

  return { createServer, default: { createServer } }
})

const WALLET = '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631'
// Not a trusted agent contract: the scan does no on-chain enrichment, so every request is the scan's own.
const CONTRACT = '0x9999999999999999999999999999999999999999'
const PAGE = 50
const dirs: string[] = []

interface Wallet {
  /** Items per chain. */
  base: number
  robinhood?: number
  /** Base pages (0-based) that answer 500. */
  failing?: ReadonlySet<number>
  endless?: boolean
  delayMs?: number
}

function stubNetwork(wallet: Wallet) {
  const indexer: { chain: string; page: number }[] = []
  const signals: AbortSignal[] = []
  const rpcBodies: unknown[][] = []

  const fetchMock = vi.fn(
    async (input: string | URL, init?: { method?: string; body?: string; signal?: AbortSignal }) => {
      const url = new URL(String(input))

      if (init?.method === 'POST') {
        const calls = JSON.parse(init.body ?? '[]') as { id: number }[]

        rpcBodies.push(calls)

        return {
          ok: true,
          json: () =>
            Promise.resolve(calls.map(call => ({ id: call.id, result: `0x${WALLET.slice(2).padStart(64, '0')}` })))
        }
      }

      const chain = url.hostname.startsWith('base') ? 'Base' : 'Robinhood'
      const page = Number(url.searchParams.get('items_count') ?? 0) / PAGE

      indexer.push({ chain, page })

      if (init?.signal) {
        signals.push(init.signal)
      }

      if (wallet.delayMs) {
        await new Promise(resolve => setTimeout(resolve, wallet.delayMs))
      }

      if (init?.signal?.aborted) {
        throw new DOMException('aborted', 'AbortError')
      }

      if (chain === 'Base' && wallet.failing?.has(page)) {
        return { ok: false, json: () => Promise.resolve({}) }
      }

      const total = chain === 'Base' ? wallet.base : (wallet.robinhood ?? 0)
      const count = wallet.endless ? PAGE : Math.max(0, Math.min(PAGE, total - page * PAGE))
      const more = wallet.endless || (page + 1) * PAGE < total

      return {
        ok: true,
        json: () =>
          Promise.resolve({
            items: Array.from({ length: count }, (_, i) => ({
              id: page * PAGE + i + 1,
              metadata: { name: `#${page * PAGE + i + 1}` },
              token: { address_hash: CONTRACT }
            })),
            next_page_params: more ? { items_count: (page + 1) * PAGE, token_id: String((page + 1) * PAGE) } : null
          })
      }
    }
  )

  vi.stubGlobal('fetch', fetchMock)

  return { indexer, rpcBodies, signals }
}

async function boot() {
  vi.resetModules()
  st.handlers.clear()
  st.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-privy-homescan-'))
  dirs.push(st.userData)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)

  const { initIclonePrivy } = await import('./iclone-privy')

  initIclonePrivy({ getMainWindow: () => null, isTrustedSender: () => true })

  return {
    scan: (address: string) =>
      st.handlers.get('iclone:inft-scan')!({}, address) as Promise<{
        ok: boolean
        agents: unknown[]
        complete?: boolean
        capped?: boolean
        error?: string
      }>,
    tick: (address: string, ids: string[]) =>
      st.handlers.get('iclone:inft-scan-tick')!({}, address, ids) as Promise<{
        ok: boolean
        skipped: boolean
        arrivals: unknown[]
        owners: Record<string, string>
      }>,
    logout: () => st.handlers.get('iclone:privy-logout')!() as Promise<{ ok: boolean }>
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const word = (address: string) => `0x${address.slice(2).padStart(64, '0')}`

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.unstubAllGlobals())
afterAll(() => dirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))

describe('iclone:inft-scan — the full roster scan (sign-in, Rescan)', () => {
  it('a 3-page wallet (150 items) comes back whole, and complete', async () => {
    const net = stubNetwork({ base: 150 })
    const main = await boot()
    const result = await main.scan(WALLET)

    expect(result.agents).toHaveLength(150)
    expect(result.complete).toBe(true)
    expect(net.indexer.filter(r => r.chain === 'Base').map(r => r.page)).toEqual([0, 1, 2])
  })

  it('a page that fails (after its one retry) keeps the pages before it and says the scan is not complete', async () => {
    stubNetwork({ base: 150, failing: new Set([1]) })
    const main = await boot()
    const result = await main.scan(WALLET)

    expect(result.agents).toHaveLength(50)
    expect(result.complete).toBe(false)
  }, 10_000)

  it('N1: a wallet past the 5 000 ceiling is not complete but capped (the O1 seed may come from it); a flap is neither', async () => {
    const capped = stubNetwork({ base: 5_200 })
    const big = await (await boot()).scan(WALLET)

    expect(big.agents).toHaveLength(5_000)
    expect(big).toMatchObject({ complete: false, capped: true })
    expect(capped.indexer.filter(r => r.chain === 'Base')).toHaveLength(100)

    stubNetwork({ base: 150, failing: new Set([1]) })
    expect(await (await boot()).scan(WALLET)).toMatchObject({ complete: false, capped: false })
  }, 20_000)

  it('sign-out mid-scan aborts it in main: no indexer request after the abort settles', async () => {
    const net = stubNetwork({ base: 0, endless: true, delayMs: 5 })
    const main = await boot()
    const running = main.scan(WALLET)

    await sleep(40)
    await main.logout()

    const result = await running
    const settled = net.indexer.length

    await sleep(60)
    expect(result).toMatchObject({ ok: false, error: 'aborted' })
    expect(net.indexer.length).toBe(settled)
    expect(settled).toBeLessThan(40)
    // The abort reaches the request on the wire too, not only the next page.
    expect(net.signals.length).toBeGreaterThan(0)
    expect(net.signals.at(-1)?.aborted).toBe(true)
  })
})

describe('iclone:inft-scan-tick — the 3-minute refresh', () => {
  it.each([0, 1, 20, 45])('%i checked: 1 indexer page per chain + ceil(n / 20) JSON-RPC batches', async checked => {
    const net = stubNetwork({ base: 400, robinhood: 10 })
    const main = await boot()
    const ids = Array.from({ length: checked }, (_, i) => `base:${CONTRACT}:${i + 1}`)
    const result = await main.tick(WALLET, ids)

    expect(net.indexer).toEqual([
      { chain: 'Base', page: 0 },
      { chain: 'Robinhood', page: 0 }
    ])
    expect(net.rpcBodies).toHaveLength(Math.ceil(checked / 20))
    expect(net.indexer.length + net.rpcBodies.length).toBeLessThanOrEqual(2 + Math.ceil(checked / 20))
    net.rpcBodies.forEach(body => expect(body.length).toBeLessThanOrEqual(20))
    expect(result).toMatchObject({ ok: true, skipped: false })
    expect(result.arrivals).toHaveLength(60)
    expect(Object.values(result.owners).every(verdict => verdict === 'held')).toBe(true)
    expect(Object.keys(result.owners)).toHaveLength(checked)
  })

  it('is skipped while a full scan runs: 0 requests', async () => {
    const net = stubNetwork({ base: 0, endless: true, delayMs: 5 })
    const main = await boot()
    const running = main.scan(WALLET)

    await sleep(15)

    const tick = await main.tick(WALLET, [`base:${CONTRACT}:1`])

    expect(tick).toMatchObject({ skipped: true, arrivals: [], owners: {} })
    expect(net.rpcBodies).toHaveLength(0)
    await main.logout()
    await running
  })
})

describe('the in-flight bound under RPC failover', () => {
  it('200 checked with the first Base RPC down: 20 POSTs (10 batches × 2 RPCs), never more than 4 in flight', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const posts: string[] = []

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: { method?: string; body?: string }) => {
        const url = String(input)

        if (init?.method !== 'POST') {
          return { ok: true, json: () => Promise.resolve({ items: [], next_page_params: null }) }
        }

        posts.push(url)
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await sleep(2)
        inFlight -= 1

        const calls = JSON.parse(init.body ?? '[]') as { id: number }[]

        return url.includes('mainnet.base.org')
          ? { ok: false, json: () => Promise.resolve(null) }
          : { ok: true, json: () => Promise.resolve(calls.map(call => ({ id: call.id, result: word(WALLET) }))) }
      })
    )

    const main = await boot()
    const ids = Array.from({ length: 200 }, (_, i) => `base:${CONTRACT}:${i + 1}`)
    const result = await main.tick(WALLET, ids)

    expect(posts).toHaveLength(20)
    expect(maxInFlight).toBeLessThanOrEqual(4)
    expect(Object.values(result.owners).every(verdict => verdict === 'held')).toBe(true)
  })
})

describe('ethCallBatch — the RPC client in JSON-RPC batch form', () => {
  it('one POST per batch; answers aligned by id; an error or a bare 0x is null; a non-array answer fails over', async () => {
    const urls: string[] = []

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        urls.push(url)

        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              urls.length === 1
                ? { error: 'batch not supported' }
                : [
                    { id: 2, result: '0x02' },
                    { id: 0, result: '0x00' },
                    { id: 1, error: { message: 'execution reverted' } },
                    { id: 9, result: '0x09' }
                  ]
            )
        })
      })
    )

    const { ethCallBatch } = await import('./iclone-privy')
    const calls = [0, 1, 2].map(i => ({ to: CONTRACT, data: `0x6352211e${String(i).padStart(64, '0')}` }))

    await expect(ethCallBatch('Base', calls, new AbortController().signal)).resolves.toEqual(['0x00', null, '0x02'])
    expect(urls).toHaveLength(2)
    expect(new Set(urls).size).toBe(2)
  })

  it('an aborted signal sends nothing', async () => {
    const fetchMock = vi.fn()

    vi.stubGlobal('fetch', fetchMock)

    const { ethCallBatch } = await import('./iclone-privy')
    const abort = new AbortController()

    abort.abort()
    await expect(ethCallBatch('Base', [{ to: CONTRACT, data: '0x' }], abort.signal)).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
