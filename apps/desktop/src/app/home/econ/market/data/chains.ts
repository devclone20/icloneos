/** The market data module's `chains` section — its public names are re-exported by ../market-data.ts. */
import { chainListReader } from '../../agent'
import { listAt, num, str } from '../../cli'

import type { AcpChain } from './types'

// ── chains ──────────────────────────────────────────────────────────────────

export function shapeChains(raw: unknown): AcpChain[] {
  return listAt(raw, ['chains', 'data'])
    .map(chain => ({
      id: num(chain, 'id') || num(chain, 'chainId'),
      name: str(chain, 'name'),
      family: str(chain, 'family')
    }))
    .filter(chain => chain.id > 0 && chain.name)
}

export const readChains = chainListReader(shapeChains)
