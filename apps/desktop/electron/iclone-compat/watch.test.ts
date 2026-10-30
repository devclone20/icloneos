import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { createWatch, type Transition, type WatchVerdict } from './watch'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-watch-'))
const OLD = '0'.repeat(39) + '1'
const NEW = '0'.repeat(39) + '2'

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function fixture(name: string) {
  const runtimeDir = path.join(tmp, name, 'hermes-agent')
  const receiptsDir = path.join(tmp, name, 'logs', 'update_receipts')
  fs.mkdirSync(path.join(runtimeDir, '.git', 'logs'), { recursive: true })
  fs.mkdirSync(receiptsDir, { recursive: true })
  fs.writeFileSync(path.join(runtimeDir, '.git', 'HEAD'), `${OLD}\n`)
  fs.writeFileSync(
    path.join(runtimeDir, '.git', 'logs', 'HEAD'),
    `${'0'.repeat(40)} ${OLD} u <u@x.invalid> 1757800000 +0000\tclone\n`
  )

  return { runtimeDir, receiptsDir }
}

function fastForward(runtimeDir: string, to = NEW) {
  fs.writeFileSync(path.join(runtimeDir, '.git', 'HEAD'), `${to}\n`)
  fs.appendFileSync(
    path.join(runtimeDir, '.git', 'logs', 'HEAD'),
    `${OLD} ${to} u <u@x.invalid> 1757980800 +0000\tpull: Fast-forward\n`
  )
}

function start(fx: ReturnType<typeof fixture>, health: string | null = NEW) {
  const verdicts: WatchVerdict[] = []
  const asked: Transition[] = []
  let resolve: (v: WatchVerdict) => void = () => undefined
  const first = new Promise<WatchVerdict>(r => (resolve = r))

  const w = createWatch({
    ...fx,
    debounceMs: 50,
    verdictFor: async t => {
      asked.push(t)

      return { level: 'GREEN', cards: [] }
    },
    healthCommit: async () => health,
    onVerdict: v => {
      verdicts.push(v)
      resolve(v)
    }
  })

  return { w, verdicts, asked, first }
}

describe('iclone-compat watch', () => {
  it('P4a.watch: a new update receipt gets a post-update verdict', async () => {
    const fx = fixture('receipt')
    const s = start(fx)
    fs.writeFileSync(
      path.join(fx.receiptsDir, '20260916T101500.json'),
      JSON.stringify({ outcome: 'ok', pre_update: { sha: OLD }, post_update: { sha: NEW }, steps: [] })
    )
    const v = await s.first
    s.w.close()
    expect(v).toMatchObject({ kind: 'post-update', from: OLD, to: NEW, level: 'GREEN' })
  })

  it('P4a.watch: a reflog fast-forward without a receipt gets a verdict within 2 s', async () => {
    const fx = fixture('reflog')
    const s = start(fx)
    const t0 = performance.now()
    fastForward(fx.runtimeDir)
    const v = await s.first
    const elapsed = performance.now() - t0
    s.w.close()
    expect(v).toMatchObject({ kind: 'reflog', from: OLD, to: NEW })
    expect(elapsed).toBeLessThanOrEqual(2000)
  })

  it('P4a.watch: a stale backend (health commit is not the new HEAD) yields a card and never GREEN', async () => {
    const fx = fixture('stale')
    const s = start(fx, OLD)
    fastForward(fx.runtimeDir)
    const v = await s.first
    s.w.close()
    expect(v.level).toBe('UNKNOWN')
    expect(v.cards[0]).toMatchObject({ root: 'stale-backend', level: 'UNKNOWN' })
  })

  it('P4a.watch: a receipt with pre == post plus a reflog move is verified once, from the reflog', async () => {
    const fx = fixture('pre-eq-post')
    const s = start(fx)
    fs.writeFileSync(
      path.join(fx.receiptsDir, '20260916T120000.json'),
      JSON.stringify({ outcome: 'ok', pre_update: { sha: OLD }, post_update: { sha: OLD }, steps: [] })
    )
    fastForward(fx.runtimeDir)
    await s.first
    await s.w.poll()
    s.w.close()
    expect(s.asked.map(t => `${t.kind}:${t.to}`)).toEqual([`reflog:${NEW}`])
  })
})
