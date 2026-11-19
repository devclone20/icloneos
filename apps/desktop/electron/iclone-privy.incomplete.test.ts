// v0.0.9 W1b (F5 partial names): which chains a whole-wallet scan could not read to the end. A chain whose indexer
// failed (null: only the trusted contracts come back over RPC) or stopped short is named; a complete chain or one that
// only reached the 5 000 ceiling is not. Red on the old code: `incompleteChains` did not exist.
import { describe, expect, it, vi } from 'vitest'

import { incompleteChains, INDEXER_CHAINS } from './iclone-privy'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/nonexistent', isPackaged: false, once: vi.fn() },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  session: { fromPartition: () => ({ setPermissionRequestHandler: vi.fn(), clearStorageData: vi.fn() }) }
}))

const whole = { complete: true, capped: false }
const ceiling = { complete: false, capped: true }
const short = { complete: false, capped: false }

describe('incompleteChains', () => {
  it('every chain read to the end, or only capped: none named', () => {
    expect(incompleteChains(INDEXER_CHAINS, [whole, whole])).toEqual([])
    expect(incompleteChains(INDEXER_CHAINS, [whole, ceiling])).toEqual([])
  })

  it('an indexer that failed (null) is named — the RPC recovery only covers the trusted contracts', () => {
    expect(incompleteChains(INDEXER_CHAINS, [whole, null])).toEqual(['Robinhood'])
  })

  it('a chain that stopped short (page or cursor error) is named; both, in scan order', () => {
    expect(incompleteChains(INDEXER_CHAINS, [short, whole])).toEqual(['Base'])
    expect(incompleteChains(INDEXER_CHAINS, [null, short])).toEqual(['Base', 'Robinhood'])
  })
})
