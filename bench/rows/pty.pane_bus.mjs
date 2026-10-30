import os from 'node:os'
import { fileURLToPath } from 'node:url'

import { newResultFile, readResult } from '../lib/child_result.mjs'
import { median } from '../lib/stats.mjs'

const CHILD = fileURLToPath(new URL('./_pty.pane_bus.child.mjs', import.meta.url))
const INJECT_MS = 20

async function runChild(ctx, args) {
  const result = newResultFile(ctx.scratch)
  const r = await ctx.sh(
    process.execPath,
    ['--expose-gc', CHILD, JSON.stringify({ scratch: ctx.scratch, result, ...args })],
    {
      cwd: ctx.app,
      // The socket path is capped at 104 bytes: keep the runner's short temp dir, not the scratch's nested one.
      env: ctx.scratchEnv({ TMPDIR: os.tmpdir() })
    }
  )
  return readResult(result, r, 'pane bus child')
}

export default {
  id: 'pty.pane_bus',
  part: 'Pane bus between terminal panes: broker + its Unix-socket HTTP transport',
  what:
    'one message round trip: pane A `send --to b` starts -> pane B, parked in a long-poll `recv --wait`, gets it; ' +
    'cold = first round trip of a fresh process, warm = the next ones; extra: loss under 8x400 concurrent sends, heap ' +
    'per pane (measured via broker.run directly, socket transport excluded)',
  hot_path:
    'apps/desktop/electron/iclone-pane-bus/ipc.ts createBusServer -> broker.ts run/sendLike/recv -> mailbox.ts Mailbox',
  unit: 'ms',
  lang: 'TypeScript',
  miss_class: 'cpu',
  budget: {
    value: 16,
    op: '<=',
    stat: 'warm.p95',
    reason: 'one 60 Hz frame: a pane must see a message before the next paint'
  },
  risk: 'every pane-to-pane message and every `ask` long-poll crosses this single broker in main',
  failure_mode:
    'refuses with 409 when a mailbox is full (1 000 messages / 8 MiB, mailbox.ts:9-10) and 429 past the open-request caps; it never drops an accepted message (measured: extra.load.lost)',
  async measure(ctx) {
    const full = ctx.mode === 'full'
    const runs = full ? 5 : 2
    const cold = []
    const warm = []
    let extra = {}
    for (let i = 0; i < runs; i += 1) {
      const res = await runChild(ctx, { n: full ? 300 : 40, load: i === 0 })
      cold.push(res.cold)
      warm.push(...res.warm)
      if (i === 0) extra = { load: res.load, memory: res.memory }
    }
    const perPane = Number(extra.memory.heap_kb_per_pane.toFixed(1))
    extra.secondary = [
      {
        name: 'messages lost under load',
        value: extra.load.lost,
        unit: 'messages',
        budget: 0,
        op: '<=',
        ok: extra.load.lost === 0,
        reason: 'a message between panes is an instruction from one agent to another: losing one is never acceptable'
      },
      {
        name: 'heap per pane (10 x 1 KiB queued)',
        value: perPane,
        unit: 'KiB',
        budget: 64,
        op: '<=',
        ok: perPane <= 64,
        reason: 'a thousand panes must stay within 64 MB of main-process heap; the queued payload alone is 10 KiB'
      }
    ]
    return { cold, warm, extra }
  },
  async control(ctx) {
    const base = await runChild(ctx, { n: 40 })
    const slow = await runChild(ctx, { n: 40, injectMs: INJECT_MS })
    const value = median(slow.warm) - median(base.warm)
    return {
      name: `inject ${INJECT_MS} ms before broker.run`,
      expected: `median warm round trip grows by >= ${0.8 * INJECT_MS} ms`,
      observed: `+${value.toFixed(2)} ms (n=${base.warm.length} vs ${slow.warm.length})`,
      value,
      threshold: 0.8 * INJECT_MS,
      op: '>=',
      ok: value >= 0.8 * INJECT_MS,
      base: base.warm,
      variant: slow.warm
    }
  }
}
