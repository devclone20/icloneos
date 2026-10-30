import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

import { newResultFile, readResult } from '../lib/child_result.mjs'
import { HarnessError, median, percentile } from '../lib/stats.mjs'

const MAIN = fileURLToPath(new URL('./_assets.inft_cards.electron.mjs', import.meta.url))
const CARDS = 1000
const SIZE = 512
const PAGE = 50
// Sensitivity control: a per-image delay on the image server must move the first paint.
const DELAY_MS = 150
// Secondary: the first page at a declared gateway latency per image.
const LATENCY_MS = 100
const LATENCY_BUDGET_MS = 2000
// Broken-image control: these first-page cards are answered with a 404 / non-PNG bytes, so their <img> fires `error`.
const BROKEN_IDS = [3, 17]
// Control: n mounts per side, interleaved base/variant in one Electron process after one discarded warm-up mount.
const CONTROL_N = 3

// A distinct 512 x 512 RGB PNG per card (gradient + per-card noise), so every card is a real decode.
function png(seed) {
  const crc = buf => zlib.crc32(buf)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const raw = Buffer.alloc((SIZE * 3 + 1) * SIZE)
  let x = seed * 2654435761
  for (let y = 0; y < SIZE; y += 1) {
    const row = y * (SIZE * 3 + 1)
    for (let i = 0; i < SIZE; i += 1) {
      x = (x * 1103515245 + 12345) >>> 0
      const o = row + 1 + i * 3
      raw[o] = (i + seed) & 255
      raw[o + 1] = (y * 2 + (x & 31)) & 255
      raw[o + 2] = (seed * 7 + (x >>> 27)) & 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
let prepared = null
async function prepare(ctx) {
  if (prepared) return prepared
  const images = path.join(ctx.scratch, 'images')
  fs.mkdirSync(images, { recursive: true })
  for (let i = 0; i < CARDS; i += 1) fs.writeFileSync(path.join(images, `${i}.png`), png(i))
  const bundle = path.join(ctx.scratch, 'thumb-cache.js')
  const esbuild = path.join(ctx.app, 'node_modules', '.bin', 'esbuild')
  const src = path.join(ctx.app, 'apps/desktop/src/app/settings/inft-book/thumb-cache.ts')
  const b = await ctx.sh(
    esbuild,
    [src, '--bundle', '--format=iife', '--global-name=ThumbCache', `--outfile=${bundle}`, '--log-level=error'],
    { cwd: ctx.app }
  )
  if (b.code !== 0) throw new Error(`esbuild failed: ${b.stderr}`)
  const bytes = fs.readdirSync(images).reduce((s, f) => s + fs.statSync(path.join(images, f)).size, 0)
  prepared = { images, bundle, mb: bytes / 2 ** 20 }
  return prepared
}

/** One Electron process that runs the mounts of `plan` in order (see the main's header) and returns `{ runs, peak }`. */
async function runElectron(ctx, plan) {
  const { images, bundle } = await prepare(ctx)
  const root = fs.mkdtempSync(path.join(ctx.scratch, 'run-'))
  // The Electron binary itself (the npm package exports its path), not the .bin shim that needs node on PATH.
  const electron = createRequire(path.join(ctx.app, 'apps/desktop/package.json'))('electron')
  const result = newResultFile(ctx.scratch)
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env = ctx.scratchEnv({
    PATH: '/usr/bin:/bin',
    HOME: home,
    BENCH_ARGS: JSON.stringify({ scratch: root, result, images, bundle, cards: CARDS, plan })
  })
  // Inherited from a parent Electron tool this would turn the binary into plain node.
  delete env.ELECTRON_RUN_AS_NODE
  const r = await ctx.sh(electron, [MAIN], { cwd: ctx.app, env, timeoutMs: 200_000 })
  const out = readResult(result, r, 'electron')
  if (out.runs.length !== plan.length) throw new HarnessError(`electron ran ${out.runs.length}/${plan.length} mounts`)
  return out
}

/**
 * A sample counts only if every card it mounted decoded. A card that fires `error` (404, wrong bundle path, bytes
 * Chromium cannot decode) resolves fast, so without this check a broken image path would show up as a good first paint.
 */
function assertDecoded(run, expected, label) {
  if (run.mounted !== expected || run.loaded !== expected || run.errored !== 0) {
    throw new HarnessError(
      `assets.inft_cards ${label}: onload ${run.loaded}/${expected}, onerror ${run.errored} ` +
        `(mounted ${run.mounted}); every card must decode`
    )
  }
  return run
}

const round = (v, d = 1) => +v.toFixed(d)

export default {
  id: 'assets.inft_cards',
  lang: 'TypeScript',
  // The renderer memory and decode time are Chromium's (image decode + image cache), not a TypeScript question.
  miss_class: 'browser',
  part: 'iNFT Book card images (renderer): thumbnail limiter + Chromium decode + paint',
  what:
    'navigation start -> the first 50 cards (the Book first page) loaded, decoded and painted (2 rAF), 1 000 distinct 512 px ' +
    'PNGs from a local server, offscreen Electron renderer; cold = fresh Electron process (empty in-memory partition), ' +
    'warm = reload of the same window (HTTP cache); a sample is valid only if every mounted card fired `load` and none ' +
    'fired `error`; extra: all 1 000 cards through a 100-card virtual window, peak working set of all Electron ' +
    `processes, first page at ${LATENCY_MS} ms added server latency per image (fresh partition, same process)`,
  hot_path:
    'apps/desktop/src/app/settings/inft-book/thumb-cache.ts requestThumbSlot/rememberThumb (MAX_IN_FLIGHT 8), used as book-card.tsx:38-73 uses it',
  unit: 'ms',
  budget: {
    value: 1000,
    op: '<=',
    stat: 'cold.p95',
    reason: 'the user opens the Book to see their cards: its first page must paint within 1 s'
  },
  risk: 'MAX_IN_FLIGHT = 8 serialises the first page into ~7 waves: first paint scales with gateway latency x 7',
  failure_mode:
    'a failed image becomes a `broken` outcome and its slot is released (book-card.tsx onError); no retry until a ' +
    'rescan. The row turns any `error` event into a harness error instead of a sample',
  async measure(ctx) {
    const full = ctx.mode === 'full'
    const cold = []
    const warm = []
    const all = []
    const latency = []
    const peaks = []
    const onload = { cold: [], warm: [], latency: [] }
    let onerror = 0
    const plan = [{ kind: 'fresh' }, { kind: 'reload' }, { kind: 'fresh', delayMs: LATENCY_MS, firstPageOnly: true }]
    for (let i = 0; i < (full ? 5 : 2); i += 1) {
      const res = await runElectron(ctx, plan)
      const [c, w, l] = res.runs
      assertDecoded(c, CARDS, `cold sample ${i}`)
      assertDecoded(w, CARDS, `warm sample ${i}`)
      assertDecoded(l, PAGE, `latency sample ${i}`)
      for (const [k, run] of Object.entries({ cold: c, warm: w, latency: l })) onload[k].push(run.loaded)
      onerror += c.errored + w.errored + l.errored
      cold.push(c.firstPaint)
      warm.push(w.firstPaint)
      all.push(c.all)
      latency.push(l.firstPaint)
      peaks.push(res.peak)
    }
    const peakTotal = Math.max(...peaks.map(p => p.totalMB))
    // The ceiling applies to the renderer that holds the decoded images; browser + GPU processes are the app-wide baseline.
    const peakRenderer = round(Math.max(...peaks.map(p => p.rendererMB)))
    const latencyP95 = round(percentile(latency, 95))
    return {
      cold,
      warm,
      extra: {
        cards: CARDS,
        image_px: SIZE,
        images_mb_on_disk: round(prepared.mb),
        decoded: { onload, onerror },
        all_1000_ms: { p50: round(percentile(all, 50)), p95: round(percentile(all, 95)) },
        peak_working_set_mb: { all_processes: round(peakTotal), renderer: peakRenderer },
        first_page_at_latency_ms: { latency_ms_per_image: LATENCY_MS, samples: latency.map(v => round(v)) },
        renderer: 'offscreen (OSR) Electron window, network = 127.0.0.1; cold/warm with no added latency',
        secondary: [
          {
            name: 'peak renderer working set (1 000 cards)',
            value: peakRenderer,
            unit: 'MB',
            budget: 300,
            op: '<=',
            ok: peakRenderer <= 300,
            reason:
              'the renderer holds every decoded thumbnail (Chromium image cache); 300 MB is the most the Book may ' +
              'add to the memory of the app the user is working in'
          },
          {
            name: `first paint at ${LATENCY_MS} ms gateway latency per image (p95)`,
            value: latencyP95,
            unit: 'ms',
            budget: LATENCY_BUDGET_MS,
            op: '<=',
            ok: latencyP95 <= LATENCY_BUDGET_MS,
            reason:
              `50 cards through 8 slots = 7 waves, so ${LATENCY_MS} ms per image costs ` +
              `>= ${7 * LATENCY_MS} ms on a slow gateway; ${LATENCY_BUDGET_MS} ms leaves room for decode and paint`
          }
        ]
      }
    }
  },
  async control(ctx) {
    // One Electron process: a discarded warm-up mount, then base/variant interleaved (n = CONTROL_N each), then the
    // broken-image mount. Every mount is a fresh in-memory partition (empty HTTP cache, own renderer), first page only.
    const plan = [{ kind: 'fresh', firstPageOnly: true }]
    for (let i = 0; i < CONTROL_N; i += 1) {
      plan.push({ kind: 'fresh', firstPageOnly: true }, { kind: 'fresh', delayMs: DELAY_MS, firstPageOnly: true })
    }
    plan.push({ kind: 'fresh', firstPageOnly: true, broken: BROKEN_IDS })
    const { runs } = await runElectron(ctx, plan)
    const base = []
    const variant = []
    for (let i = 0; i < CONTROL_N; i += 1) {
      base.push(assertDecoded(runs[1 + 2 * i], PAGE, `control base ${i}`).firstPaint)
      variant.push(assertDecoded(runs[2 + 2 * i], PAGE, `control variant ${i}`).firstPaint)
    }
    const delta = median(variant) - median(base)
    const threshold = 0.8 * DELAY_MS

    const brokenRun = runs[runs.length - 1]
    let fired = null
    try {
      assertDecoded(brokenRun, PAGE, 'control broken images')
    } catch (error) {
      if (!(error instanceof HarnessError)) throw error
      fired = error.message
    }
    const detected = fired ? Math.max(1, brokenRun.errored) : 0

    // 50 cards through 8 slots = 7 waves: a per-image delay must cost at least one full wave, normally ~7.
    return [
      {
        name: `image server delayed ${DELAY_MS} ms per image (median of ${CONTROL_N} vs ${CONTROL_N} fresh mounts)`,
        expected: `cold first paint median grows by >= ${threshold} ms`,
        observed: `+${delta.toFixed(0)} ms (base ${base.map(v => v.toFixed(0)).join('/')}, variant ${variant
          .map(v => v.toFixed(0))
          .join('/')})`,
        value: delta,
        threshold,
        op: '>=',
        ok: delta >= threshold,
        base,
        variant
      },
      {
        name: `${BROKEN_IDS.length} first-page images answered with 404 / non-PNG bytes`,
        expected: 'the decode assertion fires (broken cards detected >= 1)',
        observed: fired
          ? `assertion fired: onload ${brokenRun.loaded}/${PAGE}, onerror ${brokenRun.errored}`
          : `assertion did not fire: onload ${brokenRun.loaded}/${PAGE}, onerror ${brokenRun.errored}`,
        value: detected,
        threshold: 1,
        op: '>=',
        ok: detected >= 1
      }
    ]
  }
}
