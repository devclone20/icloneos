// readIndexerPage — the one indexer page reader both the Home roster scan and the
// iNFT Book use: next_page_params in and out, set through URLSearchParams only.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { INDEXER_CHAINS, readIndexerPage } from './iclone-privy'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/nonexistent', isPackaged: false, once: vi.fn() },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  session: { fromPartition: () => ({ setPermissionRequestHandler: vi.fn(), clearStorageData: vi.fn() }) }
}))

const ADDRESS = '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631'

function answer(body: unknown, ok = true) {
  const fetchMock = vi.fn((_url: URL) => Promise.resolve({ ok, json: () => Promise.resolve(body) }))

  vi.stubGlobal('fetch', fetchMock)

  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('readIndexerPage', () => {
  it('scans Base then Robinhood', () => {
    expect(INDEXER_CHAINS).toEqual(['Base', 'Robinhood'])
  })

  it('adapts a page and hands back next_page_params', async () => {
    answer({
      items: [{ id: 7, metadata: { name: 'Seven', image: 'https://img/7.png' }, token: { address_hash: '0xC0' } }],
      next_page_params: { items_count: 50, token_id: '7' }
    })

    const page = await readIndexerPage('Base', ADDRESS, null)

    expect(page?.items).toEqual([
      expect.objectContaining({ contract: '0xC0', tokenId: '7', name: 'Seven', chain: 'Base' })
    ])
    expect(page?.next).toEqual({ items_count: 50, token_id: '7' })
  })

  it('sends the cursor as query params, encoded — never spliced into the path', async () => {
    const fetchMock = answer({ items: [], next_page_params: null })

    await readIndexerPage('Base', ADDRESS, { token_id: '1&type=evil', items_count: 50 })

    const url = fetchMock.mock.calls[0]?.[0]

    expect(url?.pathname).toBe(`/api/v2/addresses/${ADDRESS}/nft`)
    expect(url?.searchParams.get('token_id')).toBe('1&type=evil')
    expect(url?.searchParams.get('type')).toBe('ERC-721,ERC-1155,ERC-404')
  })

  it('a last page has no next; a non-OK answer or a bad chain/address is null', async () => {
    answer({ items: [] })
    await expect(readIndexerPage('Base', ADDRESS, null)).resolves.toEqual({ items: [], next: null })
    answer({}, false)
    await expect(readIndexerPage('Base', ADDRESS, null)).resolves.toBeNull()
    await expect(readIndexerPage('Nowhere', ADDRESS, null)).resolves.toBeNull()
    await expect(readIndexerPage('Base', 'not-an-address', null)).resolves.toBeNull()
  })

  it('the token filter is set last: even a `type` key in the params cannot widen it', async () => {
    const fetchMock = answer({ items: [], next_page_params: null })

    await readIndexerPage('Base', ADDRESS, { type: 'ERC-20', items_count: 50 })

    expect(fetchMock.mock.calls[0]?.[0]?.searchParams.getAll('type')).toEqual(['ERC-721,ERC-1155,ERC-404'])
  })

  it('K23: a next_page_params this reader cannot follow (unknown key) keeps the page, marked broken, never a silent last page', async () => {
    answer({
      items: [{ id: 1, token: { address_hash: '0xC0' } }],
      next_page_params: { items_count: 50, cursor_v2: 'x' }
    })

    const page = await readIndexerPage('Base', ADDRESS, null)

    expect(page?.items).toEqual([expect.objectContaining({ contract: '0xC0', tokenId: '1' })])
    expect(page).toMatchObject({ next: null, cursorBroken: true })
  })

  it('an aborted signal stops the request', async () => {
    const fetchMock = vi.fn((_url: URL, init: { signal: AbortSignal }) =>
      init.signal.aborted
        ? Promise.reject(new DOMException('aborted', 'AbortError'))
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }) })
    )

    vi.stubGlobal('fetch', fetchMock)

    const abort = new AbortController()

    abort.abort()
    await expect(readIndexerPage('Base', ADDRESS, null, abort.signal)).resolves.toBeNull()
  })
})
