// v0.0.9 r3 (lead order 5): the fixture wallet through the REAL privy and balances handlers (electron mocked): status
// signed in to the fixture, Connect / Sign out flip it with no Privy window, the scan answers the scenario (error then
// the grid on Retry), balances answer fixture rows with no network — and a packaged build ignores the variable.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const st = vi.hoisted(() => ({
  appPath: '/nonexistent',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  packaged: false,
  sent: [] as unknown[],
  userData: ''
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => st.appPath,
    getPath: () => st.userData,
    get isPackaged() {
      return st.packaged
    },
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
      clearStorageData: () => Promise.reject(new Error('a fixture run never clears the real partition')),
      getStoragePath: () => st.userData
    })
  },
  shell: { openExternal: () => undefined }
}))

// The model fetcher's network path: refused at once (a fixture run must never reach it; a packaged one fails here).
const httpsGet = vi.hoisted(() => vi.fn())

vi.mock('node:https', () => {
  const get = (...args: unknown[]) => {
    httpsGet(...args)

    const request: Record<string, unknown> = { destroy: () => undefined }

    request.on = (event: string, listener: (error: Error) => void) => {
      if (event === 'error') {
        queueMicrotask(() => listener(new Error('getaddrinfo ENOTFOUND fixture.invalid')))
      }

      return request
    }

    return request
  }

  return { get, default: { get } }
})

vi.mock('node:http', () => {
  const createServer = () => {
    const server: Record<string, unknown> = { listening: true, listen: () => server, close: () => server }

    server.on = () => server
    server.once = () => server

    return server
  }

  return { createServer, default: { createServer } }
})

const dirs: string[] = []
const fetchMock = vi.fn(() => Promise.reject(new Error('no network in a fixture run')))

async function boot(value: string | undefined, packaged = false) {
  vi.resetModules()
  st.handlers.clear()
  st.sent = []
  st.packaged = packaged
  st.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-privy-fixture-'))
  dirs.push(st.userData)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)

  if (value === undefined) {
    delete process.env.HERMES_DESKTOP_FIXTURE_WALLET
  } else {
    process.env.HERMES_DESKTOP_FIXTURE_WALLET = value
  }

  const privy = await import('./iclone-privy')
  const model = await import('./iclone-model')
  const balances = await import('./iclone-balances')
  const fixture = await import('./fixture-wallet')
  const book = await import('./iclone-inft-book')
  const win = { isDestroyed: () => false, webContents: { send: (_channel: string, payload: unknown) => st.sent.push(payload) } }

  privy.initIclonePrivy({ getMainWindow: () => win as never, isTrustedSender: () => true })
  model.initIcloneModel()
  balances.initIcloneBalances()
  // The real Book channel over a reader that would go to the network (it must never be reached in a fixture run).
  book.initInftBook({
    chains: ['Base', 'Robinhood'],
    readPage: () => fetchMock() as never,
    isTrustedSender: () => true
  })

  const call = (channel: string, ...args: unknown[]) => st.handlers.get(channel)!({}, ...args) as Promise<any>

  return { call, fixture, privy }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  st.appPath = '/nonexistent'
  httpsGet.mockClear()
  fetchMock.mockClear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete process.env.HERMES_DESKTOP_FIXTURE_WALLET
})

afterAll(() => dirs.forEach(dir => fs.rmSync(dir, { force: true, recursive: true })))

const settle = async <T>(promise: Promise<T>) => {
  await vi.runAllTimersAsync()

  return promise
}

describe('a dev run with HERMES_DESKTOP_FIXTURE_WALLET=builtin:retry', () => {
  it('signed in to the fixture; the first scan fails (error + Retry), the Retry answers the grid; no network', async () => {
    const { call, fixture, privy } = await boot('builtin:retry')
    const wallet = fixture.activeFixtureWallet()!
    const status = await call('iclone:privy-status')

    expect(status).toMatchObject({ status: 'in', address: wallet.address })

    const first = await settle(call('iclone:inft-scan', wallet.address))
    const retry = await settle(call('iclone:inft-scan', wallet.address))

    expect(first).toMatchObject({ ok: false, agents: [] })
    expect(retry).toMatchObject({ ok: true, complete: true })
    expect(retry.agents).toHaveLength(6)
    // r3b (MR3-1): a fixture scan is noted like a real one, so the agent path (acp-run) admits the fixture iNFTs.
    const one = retry.agents[0]

    expect(privy.isScannedInftId(`${one.chain.toLowerCase()}:${one.contract.toLowerCase()}:${one.tokenId}`)).toBe(true)

    const rows = (await settle(call('iclone:balances', wallet.address))).rows as { key: string; balance: string }[]

    expect(rows.find(row => row.key === 'base')?.balance).toBe('0.042817')
    expect(rows).toHaveLength(7)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Sign out flips to out at once (no partition cleared); Connect wallet signs back in, no Privy window', async () => {
    const { call, fixture } = await boot('builtin:grid')
    const wallet = fixture.activeFixtureWallet()!

    expect(await call('iclone:privy-logout')).toEqual({ ok: true })
    expect(await call('iclone:privy-status')).toMatchObject({ status: 'out' })
    expect(st.sent.at(-1)).toMatchObject({ status: 'out' })
    expect(await settle(call('iclone:inft-scan', wallet.address))).toMatchObject({ ok: false })

    expect(await call('iclone:privy-open')).toEqual({ ok: true })
    expect(st.sent.at(-1)).toMatchObject({ status: 'in', address: wallet.address })
    expect((await settle(call('iclone:inft-scan', wallet.address))).agents).toHaveLength(6)
  })

  it('another address is never answered with the fixture roster', async () => {
    const { call } = await boot('builtin:grid')

    expect(await settle(call('iclone:inft-scan', '0x1111111111111111111111111111111111111111'))).toMatchObject({
      ok: false,
      agents: []
    })
  })
})

describe('r3 follow-up: every Collection, Book and wallet state is reachable offline', () => {
  // Red on b40532ef32: the Book's page channel was not faked, so with builtin:error the Book read the real indexer
  // for the fixture address (an empty wallet) and showed "No iNFTs in this wallet yet." instead of its error + Retry.
  it('builtin:error: the Book page fails too (the Book shows error + Retry), no network', async () => {
    const { call, fixture } = await boot('builtin:error')
    const wallet = fixture.activeFixtureWallet()!
    const page = await settle(call('iclone:inft-book-scan', wallet.address, null))

    expect(page).toMatchObject({ ok: false, items: [], done: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('builtin:retry: the Book fails once, its Retry answers the six', async () => {
    const { call, fixture } = await boot('builtin:retry')
    const wallet = fixture.activeFixtureWallet()!

    expect(await settle(call('iclone:inft-book-scan', wallet.address, null))).toMatchObject({ ok: false })

    const retry = await settle(call('iclone:inft-book-scan', wallet.address, null))

    expect(retry).toMatchObject({ ok: true, done: true })
    expect(retry.items).toHaveLength(6)
  })

  it('builtin:partial: the roster names the unread chain; the Book reads a page, then fails on that chain', async () => {
    const { call, fixture } = await boot('builtin:partial')
    const wallet = fixture.activeFixtureWallet()!
    const roster = await settle(call('iclone:inft-scan', wallet.address))

    expect(roster).toMatchObject({ ok: true, complete: false, incomplete: ['Robinhood'] })
    expect(roster.agents).toHaveLength(6)

    const first = await settle(call('iclone:inft-book-scan', wallet.address, null))

    expect(first).toMatchObject({ ok: true, done: false })
    expect((await settle(call('iclone:inft-book-scan', wallet.address, first.cursor))).ok).toBe(false)
  })

  it('builtin:balances-slow holds the popover loading; builtin:balances-error fails every fetch', async () => {
    const slow = await boot('builtin:balances-slow')
    const address = slow.fixture.activeFixtureWallet()!.address
    let settled = false

    const pending = slow.call('iclone:balances', address).then(answer => {
      settled = true

      return answer
    })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(settled).toBe(false)
    expect((await settle(pending)).ok).toBe(true)

    const failing = await boot('builtin:balances-error')

    expect(await settle(failing.call('iclone:balances', address))).toMatchObject({ ok: false, rows: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('a packaged build', () => {
  it('ignores the variable: no fixture is active, the real scan path runs', async () => {
    const { call, fixture } = await boot('builtin:grid', true)

    expect(fixture.activeFixtureWallet()).toBeNull()

    const result = await settle(call('iclone:inft-scan', '0x00000000000000000000000000000000f1c7a7e5'))

    expect(result.agents).toEqual([])
    expect(String(result.error ?? '')).not.toMatch(/fixture/)
  })

  it('builtin:reopen too: nothing is noted, no fixture soul, and the fixture model URL is never served', async () => {
    const { acpRunInftRefusal } = await import('./iclone-acp')
    const { call, fixture, privy } = await boot('builtin:reopen', true)
    const id = 'base:0x000000000000000000000000000000000000c10e:101'

    expect(fixture.activeFixtureWallet()).toBeNull()
    expect(privy.isScannedInftId(id)).toBe(false)
    expect(acpRunInftRefusal(id, privy.isScannedInftId, () => false)).toBe('unknown iNFT: it is not in this wallet')

    const profile = await settle(
      call('iclone:inft-profile-resolve', { contract: '0x000000000000000000000000000000000000c10e', tokenId: '101', name: 'x', bootstrap: null })
    )

    expect(profile.soulMd).toBe('')

    const served = await settle(call('iclone:fetch-model', fixture.FIXTURE_MODEL_URL))

    expect(served).toMatchObject({ ok: false })
    expect(httpsGet).toHaveBeenCalled()
  })
})

describe('r3b (MR3-1): builtin:reopen through the real handlers (dev build)', () => {
  it('status → first scan → the model iNFT is admitted by acp-run, its soul resolves offline, its model is served', async () => {
    const { acpRunInftRefusal } = await import('./iclone-acp')
    const { call, fixture, privy } = await boot('builtin:reopen')
    const wallet = fixture.activeFixtureWallet()!

    expect(await call('iclone:privy-status')).toMatchObject({ status: 'in', address: wallet.address })

    const roster = await settle(call('iclone:inft-scan', wallet.address))
    const aurora = roster.agents[0]
    const id = `${aurora.chain.toLowerCase()}:${aurora.contract.toLowerCase()}:${aurora.tokenId}`

    expect(aurora).toMatchObject({ model: fixture.FIXTURE_MODEL_URL, bootstrap: { protocol: 'iclone-fixture' } })
    expect(acpRunInftRefusal(id, privy.isScannedInftId, () => false)).toBeNull()

    const profile = await settle(call('iclone:inft-profile-resolve', aurora))

    expect(profile).toMatchObject({ slug: 'inft-000000-101', name: 'iCLONE Aurora', source: 'genesis' })
    expect(profile.soulMd).toContain('# iCLONE Aurora')

    const served = await settle(call('iclone:fetch-model', fixture.FIXTURE_MODEL_URL))

    expect(served.ok).toBe(true)
    expect(Buffer.from(served.data).subarray(0, 4).toString('latin1')).toBe('glTF')
    // Built in code, never cached on disk, never fetched.
    expect(fs.existsSync(path.join(st.userData, 'iclone-models'))).toBe(false)
    expect(httpsGet).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a sign-out forgets the admission; Connect wallet and the next scan bring it back', async () => {
    const { call, fixture, privy } = await boot('builtin:reopen')
    const wallet = fixture.activeFixtureWallet()!
    const id = 'base:0x000000000000000000000000000000000000c10e:101'

    await call('iclone:privy-status')
    await settle(call('iclone:inft-scan', wallet.address))
    expect(privy.isScannedInftId(id)).toBe(true)

    await call('iclone:privy-logout')
    expect(privy.isScannedInftId(id)).toBe(false)

    await call('iclone:privy-open')
    await settle(call('iclone:inft-scan', wallet.address))
    expect(privy.isScannedInftId(id)).toBe(true)
  })
})

// v0.0.9 r4 (design r3 MAJOR 2): a dev run's fixture iNFTs carry the art tiles of fixtures/inft-art, read from disk —
// red on 5470b2b185, where every fixture card was the placeholder head (image ''). A packaged build never reads them.
describe('r4: fixture art through the real scan handler', () => {
  const DESKTOP = path.resolve(__dirname, '..')

  it('a dev run: all six built-in iNFTs arrive with distinct data:image/svg+xml art, nothing fetched', async () => {
    st.appPath = DESKTOP
    const { call, fixture } = await boot('builtin:grid')
    const roster = await settle(call('iclone:inft-scan', fixture.activeFixtureWallet()!.address))
    const images = roster.agents.map((agent: { image: string }) => agent.image)

    expect(images).toHaveLength(6)
    expect(images.every((image: string) => image.startsWith('data:image/svg+xml;base64,'))).toBe(true)
    expect(new Set(images).size).toBe(6)
    expect(httpsGet).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a packaged build with the same app path: no fixture, no art, the real scan path', async () => {
    st.appPath = DESKTOP
    const { call, fixture } = await boot('builtin:grid', true)

    expect(fixture.activeFixtureWallet()).toBeNull()

    const result = await settle(call('iclone:inft-scan', '0x00000000000000000000000000000000f1c7a7e5'))

    expect(JSON.stringify(result)).not.toContain('data:image/svg+xml')
  })
})

