import { describe, expect, it } from 'vitest'

import {
  decide,
  type FetchLike,
  TRANSFER_SINGLE_TOPIC,
  TRANSFER_TOPIC,
  verifyOwnership
} from './iclone-ownership-proof'
import { BUNDLED_REGISTRY, type RegistryEntry } from './iclone-ownership-registry'

const OWNER = '0x' + 'a1'.repeat(20)
const BUYER = '0x' + 'b7'.repeat(20)
const ENTRY = BUNDLED_REGISTRY.entries[0]
const pad = (a: string) => '0x' + a.slice(2).padStart(64, '0')
const TX = '0x' + 'cd'.repeat(32)

interface World {
  chainId?: number
  holder?: string
  rpcDown?: boolean
  indexerStatus?: number
  indexerHolder?: string
  logs?: { from: string; to: string; block: number; tx?: string }[]
  logsFail?: boolean
  transfers?: { block_number: number; from: { hash: string } }[]
  rpcs?: Record<string, string>
  getLogsCalls?: number
}

function fakeFetch(w: World): FetchLike {
  return async (url, init) => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

    if (url.includes('/api/v2/')) {
      if (w.indexerStatus && w.indexerStatus !== 200) {
        return json({}, w.indexerStatus)
      }

      if (url.endsWith('/transfers')) {
        return json({ items: w.transfers ?? [] })
      }

      return json({ owner: { hash: w.indexerHolder ?? w.holder ?? OWNER } })
    }

    if (w.rpcDown) {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    }

    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] }
    const holder = w.rpcs?.[url] ?? w.holder ?? OWNER

    switch (method) {
      case 'eth_chainId':
        return json({ result: '0x' + (w.chainId ?? ENTRY.chainId).toString(16) })

      case 'eth_getBlockByNumber':
        return json({ result: { number: '0x2710', timestamp: params[0] === 'latest' ? '0x6700' : '0x6600' } })

      case 'eth_call':
        return json({ result: pad(holder) })
      case 'eth_getLogs':
        if (w.logsFail) {
          return json({ error: { message: 'range too large' } })
        }

        {
          const range = params[0] as { fromBlock: string; toBlock: string }
          const [lo, hi] = [Number.parseInt(range.fromBlock, 16), Number.parseInt(range.toBlock, 16)]
          w.getLogsCalls = (w.getLogsCalls ?? 0) + 1

          return json({
            result: (w.logs ?? [])
              .map((l, i) => ({ l, i }))
              .filter(({ l }) => l.block >= lo && l.block <= hi)
              .map(({ l, i }) => ({
                topics: [TRANSFER_TOPIC, pad(l.from), pad(l.to), pad('0x7')],
                data: '0x',
                blockNumber: '0x' + l.block.toString(16),
                logIndex: '0x' + i.toString(16),
                transactionHash: l.tx ?? TX
              }))
          })
        }

      default:
        return json({ error: { message: 'unsupported' } })
    }
  }
}

const run = (w: World, entry: RegistryEntry = ENTRY, sinceBlock: number | null = null) =>
  verifyOwnership({ entry, tokenId: '7', wallet: OWNER, sinceBlock, fetch: fakeFetch(w) })

const THIRD = '0x' + 'c3'.repeat(20)
const TX_OUT = '0x' + 'e1'.repeat(32)
const TX_RESALE = '0x' + 'e2'.repeat(32)

const sold = {
  holder: BUYER,
  logs: [
    { from: '0x' + '0'.repeat(40), to: OWNER, block: 10 },
    { from: OWNER, to: BUYER, block: 9000 }
  ]
}

describe('three deep ownership verifications', () => {
  it('held: ownerOf names the wallet, all three sources agree', async () => {
    const r = await run({ logs: [{ from: '0x' + '0'.repeat(40), to: OWNER, block: 10 }] })
    expect(r.verdict).toBe('held')
    expect(r.verifications.map(v => [v.source, v.ok, v.heldByWallet])).toEqual([
      ['indexer', true, true],
      ['chain', true, true],
      ['logs', true, true]
    ])
  })

  it('lost: indexer + ownerOf + Transfer log agree, with tx hash, block and time', async () => {
    const r = await run(sold)
    expect(r.verdict).toBe('lost')
    expect(r.transfer).toMatchObject({ txHash: TX, block: 9000, from: OWNER, to: BUYER, timestamp: 0x6600 })
    expect(r.transfer?.explorerUrl).toBe(`${ENTRY.explorer}/tx/${TX}`)
  })

  it('indexer 500 (partial scan) is never a loss', async () => {
    expect((await run({ ...sold, indexerStatus: 500 })).verdict).toBe('unknown')
  })

  it('network down / RPC timeout is never a loss', async () => {
    expect((await run({ ...sold, rpcDown: true })).verdict).toBe('unknown')
  })

  it('an RPC on the wrong chain id is never asked', async () => {
    const r = await run({ ...sold, chainId: 1 })
    expect(r.verdict).toBe('unknown')
    expect(r.verifications).toEqual([])
  })

  it('a lagging indexer that still names the wallet blocks the loss', async () => {
    expect((await run({ ...sold, indexerHolder: OWNER })).verdict).toBe('unknown')
  })

  it('no Transfer log out of the wallet blocks the loss', async () => {
    expect((await run({ holder: BUYER, logs: [] })).verdict).toBe('unknown')
    expect((await run({ ...sold, logsFail: true })).verdict).toBe('unknown')
  })

  it('holders that disagree block the loss', async () => {
    const other = '0x' + 'c3'.repeat(20)
    expect((await run({ ...sold, indexerHolder: other })).verdict).toBe('unknown')
  })

  it('a burned token (ownerOf zero) is unknown, not lost', async () => {
    expect((await run({ ...sold, holder: '0x' + '0'.repeat(40), indexerHolder: BUYER })).verdict).toBe('unknown')
  })

  it('two RPCs that disagree block the loss', async () => {
    const entry = { ...ENTRY, rpcs: ['https://a.example', 'https://b.example'] }
    const r = await run({ ...sold, rpcs: { 'https://a.example': BUYER, 'https://b.example': OWNER } }, entry)
    expect(r.verdict).toBe('unknown')
  })

  it('a token that came back is held', async () => {
    const back = { holder: OWNER, logs: [...sold.logs, { from: BUYER, to: OWNER, block: 9500 }] }
    expect((await run(back)).verdict).toBe('held')
  })

  it('resale A->B->C: the wallet OUT transfer is the proof, the holder is the current owner', async () => {
    const resold = {
      holder: THIRD,
      logs: [
        { from: '0x' + '0'.repeat(40), to: OWNER, block: 10 },
        { from: OWNER, to: BUYER, block: 9000, tx: TX_OUT },
        { from: BUYER, to: THIRD, block: 9800, tx: TX_RESALE }
      ]
    }

    const r = await run(resold, ENTRY, 5)
    expect(r.verdict).toBe('lost')
    expect(r.transfer).toMatchObject({ txHash: TX_OUT, block: 9000, from: OWNER, to: BUYER })
    expect(r.verifications.find(v => v.source === 'logs')).toMatchObject({ holder: THIRD, txHash: TX_OUT })
  })

  it('resale with the OUT transfer in an older log window is still found', async () => {
    const narrow = { ...ENTRY, logWindow: 500 }

    const resold = {
      holder: THIRD,
      logs: [
        { from: OWNER, to: BUYER, block: 7000, tx: TX_OUT },
        { from: BUYER, to: THIRD, block: 9900, tx: TX_RESALE }
      ]
    }

    const r = await run(resold, narrow, 100)
    expect(r.verdict).toBe('lost')
    expect(r.transfer?.txHash).toBe(TX_OUT)
  })

  it('resale older than the windows: the indexer hint names the OUT block and the chain confirms it', async () => {
    const narrow = { ...ENTRY, logWindow: 100 }

    const w: World = {
      holder: THIRD,
      logs: [
        { from: OWNER, to: BUYER, block: 2000, tx: TX_OUT },
        { from: BUYER, to: THIRD, block: 9950, tx: TX_RESALE }
      ],
      transfers: [
        { block_number: 9950, from: { hash: BUYER } },
        { block_number: 2000, from: { hash: OWNER } }
      ]
    }

    const r = await run(w, narrow, 0)
    expect(r.verdict).toBe('lost')
    expect(r.transfer?.block).toBe(2000)
    // a hint the chain does not confirm is no proof
    const lie = await run({ ...w, transfers: [{ block_number: 3000, from: { hash: OWNER } }] }, narrow, 0)
    expect(lie.verdict).toBe('unknown')
  })

  it('an OUT transfer before the last held block does not count; the resale holder must match ownerOf', async () => {
    const resold = {
      holder: THIRD,
      logs: [
        { from: OWNER, to: BUYER, block: 9000, tx: TX_OUT },
        { from: BUYER, to: THIRD, block: 9800, tx: TX_RESALE }
      ]
    }

    expect((await run(resold, ENTRY, 9500)).verdict).toBe('unknown')
    expect((await run({ ...resold, holder: BUYER }, ENTRY, 5)).verdict).toBe('unknown')
  })

  it('no move since the last held block: the logs agree it is held, and can never make a loss', async () => {
    const quiet = { logs: [{ from: '0x' + '0'.repeat(40), to: OWNER, block: 10 }] }
    const r = await run(quiet, ENTRY, 9000)
    expect(r.verdict).toBe('held')
    expect(r.verifications.find(v => v.source === 'logs')).toMatchObject({ ok: true, heldByWallet: true })
    // ownerOf names a buyer but no Transfer was seen: unknown, never lost
    expect((await run({ ...quiet, holder: BUYER }, ENTRY, 9000)).verdict).toBe('unknown')
  })

  it('decide() never says lost without a chain answer', () => {
    expect(decide([], true).verdict).toBe('unknown')
    expect(TRANSFER_SINGLE_TOPIC).toMatch(/^0x[0-9a-f]{64}$/)
  })
})
