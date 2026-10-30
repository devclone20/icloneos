/**
 * Test fixture (gates G1–G7): a deterministic wallet of N scan items — 40 %
 * without an image, 5 % with a broken URL, names of varied length — served
 * 50 per page like the indexer. Never imported by app code.
 */
import type { InftScanResult } from '@/app/home/inft-scan'

import type { InftBookCursor, InftBookPage } from './book-types'

type InftScanItem = InftScanResult['agents'][number]

export const FIXTURE_ADDRESS = '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631'
const FIXTURE_CONTRACT = '0x3d9f35e08c41a80155353862f883f2b70119809f'
const PAGE = 50

export function fixtureItem(index: number): InftScanItem {
  const image =
    index % 5 < 2 ? '' : index % 20 === 2 ? `notascheme://broken/${index}` : `http://127.0.0.1:47999/img/${index}.png`

  return {
    contract: FIXTURE_CONTRACT,
    tokenId: String(index + 1),
    name: `${'iNFT '.repeat(1 + (index % 4))}#${index + 1}`,
    image,
    model: '',
    isAgentNft: true,
    chain: 'Base',
    backdrop: '',
    bootstrap: null
  }
}

export function fixtureId(index: number): string {
  return `base:${FIXTURE_CONTRACT}:${index + 1}`
}

/** A bookScan bridge over `total` items; `failPage` pages fail (as main does after its retries). */
export function fixtureBridge(total: number, failPage: ReadonlySet<number> = new Set()) {
  const requested: number[] = []

  const bookScan = (_address: string, cursor: InftBookCursor | null): Promise<InftBookPage> => {
    const page = typeof cursor?.params?.page === 'number' ? cursor.params.page : 0

    requested.push(page)

    if (failPage.has(page)) {
      return Promise.resolve({ ok: false, items: [], cursor: cursor ?? { chain: 'Base', params: null }, done: false })
    }

    const items = Array.from({ length: Math.max(0, Math.min(PAGE, total - page * PAGE)) }, (_, i) =>
      fixtureItem(page * PAGE + i)
    )

    const more = (page + 1) * PAGE < total

    return Promise.resolve({
      ok: true,
      items,
      cursor: more ? { chain: 'Base', params: { page: page + 1 } } : null,
      done: !more
    })
  }

  return { bookScan, requested }
}
