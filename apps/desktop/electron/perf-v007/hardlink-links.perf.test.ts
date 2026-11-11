/**
 * v0.0.7 CF7 round 2 (critic B6-m1) — PERF.main.links: a refused root with 20 000 hard links (a pnpm project, a
 * `git clone --local`) costs main O(links log links) once per linked set, never O(links²) per check. The grouping
 * (hardlinks.ts groupLinks) is linear and memoised per (linked set, acknowledgements, store pass), so every refused
 * check, the post-exit (T3) check and the gesture read the groups instead of rebuilding them.
 *
 *   PERF.main.links.refused.block_max    main's longest stall over 10 refused checks (cached, nothing dirty) < 50 ms
 *   PERF.main.links.refused.check.p95    those checks, p95 < 30 ms
 *   PERF.main.links.dirty.block_max      a refused check after a write in another folder < 50 ms
 *   PERF.main.links.t3.block_max         the post-exit check (exitedAt given) < 50 ms
 *   PERF.main.links.allow.block_max      acknowledgeGroup over the 20 000-link group < 50 ms
 *   PERF.main.links.after_allow.check    the check after the gesture answers ok, < 30 ms
 *   PERF.main.links.addon_sync_max       M2 (B6-m2): the largest synchronous addon call from the first refused check to
 *                                        the gesture, < 5 ms (FSEventsGetCurrentEventId waits ~1 s on a stalled flush:
 *                                        Fable's 1 016 ms on a cached refusal). Each stall is printed with the addon call
 *                                        that overlaps it, or `unattributed`; the block maxima stay the raw verdict.
 *
 * Red on 1143b442e4: 206-256 ms per refused check, 413 ms T3, 230 ms Allow (the per-link array copy).
 */
import { linkSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { checkBeforeStart, createHardlinkGuard } from '../iclone-confinement/hardlinks'
import { createFsEventsSource, defaultFsEventsSource } from '../iclone-confinement/hardlinks-fsevents'
import { loadIcloneFsevents } from '../iclone-confinement/iclone-fsevents'

import {
  type AddonCall,
  addonSyncMax,
  attributeStalls,
  below,
  callsWithin,
  type Fixture,
  type GateItem,
  makeFixture,
  percentile,
  PERF_V007_ENABLED,
  report,
  startBlockMeter,
  timed,
  timedAddon,
  yieldToLoop
} from './gate-helpers'

const DIRS = 3_000
const LINKS = 20_000
const REFUSED_CHECKS = 10
const BLOCK_LIMIT_MS = 50
const CHECK_LIMIT_MS = 30

describe.skipIf(!PERF_V007_ENABLED)('v0.0.7 PERF: 20 000 hard links refused, acknowledged and re-checked', () => {
  let tree: Fixture
  let group: string

  beforeAll(() => {
    tree = makeFixture(['--files', String(DIRS), '--dirs', String(DIRS)])

    const outside = path.join(path.dirname(tree.root), 'outside')

    group = path.join(tree.root, 'node_modules', '.pnpm')
    mkdirSync(outside, { recursive: true })

    for (let index = 0; index < LINKS; index += 1) {
      const pkg = path.join(group, `pkg${index % 200}`)

      if (index < 200) {
        mkdirSync(pkg, { recursive: true })
      }

      writeFileSync(path.join(outside, `o${index}`), 'o')
      linkSync(path.join(outside, `o${index}`), path.join(pkg, `l${index}`))
    }
  }, 300_000)

  afterAll(async () => {
    await defaultFsEventsSource()?.close()
    tree?.remove()
  })

  it('PERF.main.links: every refused check, T3 and the gesture cost main a bounded turn', async () => {
    const addon = loadIcloneFsevents()
    const addonLog: AddonCall[] = []
    const fsEvents = addon ? createFsEventsSource(timedAddon(addon, addonLog)) : null

    const guard = createHardlinkGuard({
      ackFile: path.join(path.dirname(tree.root), 'userdata-links', 'confinement', 'acks.json'),
      ...(fsEvents ? { fsEvents } : {})
    })

    const items: GateItem[] = []
    const info: Record<string, unknown> = { fixture: tree.info, links: LINKS }

    try {
      await yieldToLoop(20)
      await guard.prewarm(tree.root)

      const first = await checkBeforeStart(guard, tree.root, 'build')
      const block = 'block' in first ? first.block : null
      const view = block?.kind === 'hard-links' ? block.groups.find(item => item.dir === group) : undefined

      expect(view?.count, JSON.stringify(first).slice(0, 200)).toBe(LINKS)

      const refusedMs: number[] = []
      const refusedMeter = startBlockMeter()
      const fromMs = performance.now()

      for (let index = 0; index < REFUSED_CHECKS; index += 1) {
        const check = await timed(refusedMeter, () => checkBeforeStart(guard, tree.root, 'build'))

        expect(check.value.ok).toBe(false)
        refusedMs.push(check.ms)
      }

      const refused = await refusedMeter.stop()

      writeFileSync(path.join(tree.root, 'written-elsewhere'), 'x')
      await yieldToLoop(50)

      const dirtyMeter = startBlockMeter()
      const dirty = await timed(dirtyMeter, () => checkBeforeStart(guard, tree.root, 'build'))
      const dirtyBlock = await dirtyMeter.stop()

      expect(dirty.value.ok).toBe(false)

      const t3Meter = startBlockMeter()
      const t3 = await timed(t3Meter, () => guard.check(tree.root, 'build', Date.now()))
      const t3Block = await t3Meter.stop()

      expect(t3.value.ok).toBe(false)

      const allowMeter = startBlockMeter()
      const allowed = await timed(allowMeter, () => guard.acknowledgeGroup(tree.root, group, view?.digest ?? ''))
      const toMs = performance.now()
      const allowBlock = await allowMeter.stop()
      const calls = callsWithin(addonLog, fromMs, toMs)

      expect(allowed.value).toMatchObject({ ok: true, count: LINKS })

      const after = await timed(null, () => checkBeforeStart(guard, tree.root, 'build'))

      items.push(
        below('PERF.main.links.refused.block_max', refused.maxMs, BLOCK_LIMIT_MS),
        below('PERF.main.links.refused.check.p95', percentile(refusedMs, 95), CHECK_LIMIT_MS),
        below('PERF.main.links.dirty.block_max', dirtyBlock.maxMs, BLOCK_LIMIT_MS),
        below('PERF.main.links.t3.block_max', t3Block.maxMs, BLOCK_LIMIT_MS),
        below('PERF.main.links.allow.block_max', allowBlock.maxMs, BLOCK_LIMIT_MS),
        below('PERF.main.links.addon_sync_max', addonSyncMax(calls), 5),
        {
          id: 'PERF.main.links.after_allow.check',
          value: after.value.ok ? `ok in ${Math.round(after.ms)} ms` : JSON.stringify(after.value).slice(0, 200),
          target: `ok, < ${CHECK_LIMIT_MS} ms`,
          pass: after.value.ok === true && after.ms < CHECK_LIMIT_MS
        }
      )
      info.stalls = {
        refused: attributeStalls(refused.stalls, addonLog),
        dirty: attributeStalls(dirtyBlock.stalls, addonLog),
        t3: attributeStalls(t3Block.stalls, addonLog),
        allow: attributeStalls(allowBlock.stalls, addonLog)
      }
      info.addonCalls = calls.length
      info.ms = {
        refused: refusedMs.map(Math.round),
        dirty: Math.round(dirty.ms),
        t3: Math.round(t3.ms),
        allow: Math.round(allowed.ms),
        afterAllow: Math.round(after.ms)
      }

      expect(report('PERF.main.links', items, info)).toBe(true)
    } finally {
      guard.close()
      fsEvents?.close()
    }
  }, 900_000)
})
