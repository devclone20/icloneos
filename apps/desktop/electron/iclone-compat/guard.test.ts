import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { guard, OPENRPC_PATH, staleBackendCard } from './guard'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-guard-'))
const HEAD = 'c'.repeat(40)

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function runtime(): string {
  const rt = path.join(tmp, 'rt')
  fs.mkdirSync(path.join(rt, '.git', 'refs', 'heads'), { recursive: true })
  fs.mkdirSync(path.join(rt, path.dirname(OPENRPC_PATH)), { recursive: true })
  fs.writeFileSync(path.join(rt, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  fs.writeFileSync(path.join(rt, '.git', 'refs', 'heads', 'main'), `${HEAD}\n`)
  // Sized like the real contract (~1.5 MB) so the timing is honest.
  const methods = Array.from({ length: 4000 }, (_, i) => ({ name: `m${i}.call`, params: [], result: { name: 'r' } }))
  fs.writeFileSync(
    path.join(rt, OPENRPC_PATH),
    JSON.stringify({ openrpc: '1.3.2', methods, pad: 'x'.repeat(1_000_000) })
  )

  return rt
}

describe('iclone-compat boot guard', () => {
  it('P4a.speed.guard: health check, contract hash and cache lookup take <= 20 ms on the boot path', () => {
    const rt = runtime()
    const cache = new Set<string>()

    const first = guard({
      runtimeDir: rt,
      healthCommit: HEAD.slice(0, 10),
      lockHash: 'f'.repeat(64),
      cached: k => cache.has(k)
    })

    expect(first.status).toBe('verify')

    if (first.status === 'verify') {
      cache.add(first.key)
    }

    const times: number[] = []

    for (let i = 0; i < 7; i++) {
      const t0 = performance.now()
      const r = guard({ runtimeDir: rt, healthCommit: HEAD, lockHash: 'f'.repeat(64), cached: k => cache.has(k) })
      times.push(performance.now() - t0)
      expect(r.status).toBe('cached')
    }

    expect(times.sort((a, b) => a - b)[3]).toBeLessThanOrEqual(20)
  })

  it('a backend whose health commit is not HEAD is stale and yields a card', () => {
    const r = guard({ runtimeDir: runtime(), healthCommit: 'd'.repeat(10), lockHash: 'f', cached: () => false })
    expect(r.status).toBe('stale-backend')
    expect(staleBackendCard(HEAD, HEAD)).toBeNull()
    expect(staleBackendCard(null, HEAD)).toMatchObject({ root: 'stale-backend', level: 'UNKNOWN' })
  })
})
