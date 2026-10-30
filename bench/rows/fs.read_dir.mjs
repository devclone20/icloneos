import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { newResultFile, readResult } from '../lib/child_result.mjs'
import { percentile } from '../lib/stats.mjs'

const CHILD = fileURLToPath(new URL('./_fs.read_dir.child.mjs', import.meta.url))
const INJECT_MS = 2
const FOLDERS = 1101
const WORKERS = 16
// Each of the 16 workers reads ~69 folders one after another, so a per-readdir delay adds at least 69 x INJECT_MS.
const CONTROL_THRESHOLD_MS = 0.8 * Math.floor(FOLDERS / WORKERS) * INJECT_MS

async function runChild(ctx, args) {
  const result = newResultFile(ctx.scratch)
  const tree = path.join(ctx.scratch, 'tree')
  const r = await ctx.sh(process.execPath, [CHILD, JSON.stringify({ tree, result, ...args })], {
    timeoutMs: 10 * 60 * 1000
  })
  return readResult(result, r, 'fs.read_dir child')
}

const generated = new Set()
const ensureTree = async ctx => {
  if (!generated.has(ctx.scratch)) {
    await runChild(ctx, { generate: true })
    generated.add(ctx.scratch)
  }
}

const round = v => +v.toFixed(3)

export default {
  id: 'fs.read_dir',
  part: 'Project tree folder reader (the app lists folders on demand; it keeps no workspace index)',
  what:
    'wall time of one full walk of a synthetic 100 000-file / 1 101-folder tree through readDirForIpc, one call per ' +
    'folder, 16 in flight, from the first read to the last folder listed. The tree is generated in the row scratch just ' +
    'before, so the OS file cache is HOT in every sample (purging it needs sudo): cold = the first walk of a fresh ' +
    'process (module load and JIT cold, OS cache hot), warm = later walks of the same process. extra: incremental = ' +
    're-read of one 100-file folder after a file is added',
  hot_path:
    'apps/desktop/electron/fs-read-dir.ts readDirForIpc (resolveDirectoryForIpc + readdir withFileTypes + hidden filter)',
  unit: 'ms',
  lang: 'TypeScript',
  miss_class: 'io',
  budget: {
    value: 1000,
    op: '<=',
    stat: 'warm.p95',
    reason:
      'opening a 100 k-file project in the file tree must take under one second with the OS cache hot, or the ' +
      'user waits on an empty tree; a cold-disk walk is not measured (needs sudo purge)'
  },
  risk: 'the tree is read lazily per folder; anything that needs the whole workspace (search, quick-open) has no index to use',
  failure_mode:
    'an unreadable folder returns { entries: [], error: code } (fs-read-dir.ts:111-117); the walk throws on any error ' +
    'and on a file or folder count other than 100 000 / 1 101, so a failed read is an error, never a fast sample',
  async measure(ctx) {
    await ensureTree(ctx)
    const full = ctx.mode === 'full'
    const cold = []
    const warm = []
    const incremental = []
    for (let i = 0; i < (full ? 5 : 2); i += 1) {
      const res = await runChild(ctx, { n: full ? 60 : 20, warm: 2 })
      cold.push(res.cold)
      warm.push(...res.warm)
      incremental.push(...res.incremental)
    }
    const inc95 = round(percentile(incremental, 95))
    return {
      cold,
      warm,
      extra: {
        tree: { files: 100000, folders: FOLDERS, generated_in_run: true, os_cache: 'hot (no purge)' },
        incremental_ms: { p50: round(percentile(incremental, 50)), p95: inc95, n: incremental.length },
        not_measured: 'a cold-disk walk (needs sudo purge) and agent-side search (Python tools)',
        secondary: [
          {
            name: 'incremental folder re-read p95',
            value: inc95,
            unit: 'ms',
            budget: 100,
            op: '<=',
            ok: inc95 <= 100,
            reason:
              'a file the agent just wrote must show in its folder within 100 ms, below what a user perceives as a lag'
          }
        ]
      }
    }
  },
  async control(ctx) {
    await ensureTree(ctx)
    const { base, variant } = await runChild(ctx, { control: true, injectMs: INJECT_MS })
    const sorted = xs => [...xs].sort((a, b) => a - b)
    const value = percentile(variant, 50) - percentile(base, 50)
    return {
      name: `every readdir delayed ${INJECT_MS} ms through the reader's options.fs seam (full walk)`,
      expected: `median full walk grows by >= ${CONTROL_THRESHOLD_MS} ms (0.8 x 68 sequential reads per worker x ${INJECT_MS} ms)`,
      observed: `base ${sorted(base).map(round).join('/')} ms, delayed ${sorted(variant).map(round).join('/')} ms`,
      value,
      threshold: CONTROL_THRESHOLD_MS,
      op: '>=',
      ok: value >= CONTROL_THRESHOLD_MS,
      base,
      variant
    }
  }
}
