// Child process of the `acp.watchdog` row: the real ACP work watchdog (iclone-acp-work/watchdog.ts) over the real ledger,
// polled on a real setInterval with an accelerated virtual clock. Prints one JSON line. Electron is replaced by an inert
// stub (nothing on the timed path imports it).
import '../lib/ts-hook.mjs'

import fs from 'node:fs'
import path from 'node:path'

import { writeResult } from '../lib/child_result.mjs'

const args = JSON.parse(process.argv[2] ?? '{}')
const W = new URL('../../apps/desktop/electron/iclone-acp-work/', import.meta.url)
const { createWatchdog } = await import(new URL('watchdog.ts', W).href)
const { fakeAcp, offerJob } = await import(new URL('fake-cli.ts', W).href)
const { createLedger } = await import(new URL('ledger.ts', W).href)
const { DEFAULT_POLICY } = await import(new URL('policy.ts', W).href)

const PROD_POLL_MS = 30_000 // iclone-acp-work/ipc.ts:48 WORK_POLL_MS
const tickMs = Number(args.tickMs ?? 50)
const memEvery = Number(args.memEvery ?? 200) // polls between two post-gc heap samples
const durationMs = Number(args.durationS ?? 10) * 1000
let virtual = Date.UTC(2026, 9, 30)
fs.mkdirSync(args.scratch, { recursive: true })
const acp = fakeAcp([])
const ledgers = new Map()
let audits = 0
const watchdog = createWatchdog({
  read: acp.read,
  actor: null,
  ledger: slug => {
    if (!ledgers.has(slug))
      ledgers.set(slug, createLedger({ file: path.join(args.scratch, `${slug}.jsonl`), now: () => new Date(virtual) }))
    return ledgers.get(slug)
  },
  policy: () => ({ ...DEFAULT_POLICY }),
  spendTradeOn: () => false,
  audit: () => {
    audits += 1
  },
  onChange: () => {},
  now: () => virtual
})

const lateness = []
const cycles = []
const memory = []
let ticks = 0
let offers = 0
let busy = false
let last = performance.now()
const started = last
await new Promise(resolve => {
  const timer = setInterval(async () => {
    const at = performance.now()
    lateness.push(at - last - tickMs)
    last = at
    if (busy) return
    // Control only: block the event loop for a known time on every tick.
    if (args.spinMs) for (const end = performance.now() + args.spinMs; performance.now() < end;);
    busy = true
    virtual += PROD_POLL_MS
    ticks += 1
    // One new offer every 10 polls (12 per production hour); an offer leaves the market 50 polls later.
    if (ticks % 10 === 0) {
      acp.state.jobs.push(offerJob(`job-${ticks}`))
      offers += 1
      if (acp.state.jobs.length > 5) acp.state.jobs.shift()
    }
    const t0 = performance.now()
    await watchdog.poll('agent01')
    cycles.push(performance.now() - t0)
    if (ticks % memEvery === 0) {
      globalThis.gc?.()
      memory.push({
        hours: ticks / (3_600_000 / PROD_POLL_MS),
        heapMB: process.memoryUsage().heapUsed / 2 ** 20,
        rssMB: process.memoryUsage().rss / 2 ** 20
      })
    }
    busy = false
    if (at - started >= durationMs) {
      clearInterval(timer)
      resolve()
    }
  }, tickMs)
})
const ledgerBytes = fs
  .readdirSync(args.scratch)
  .reduce((sum, f) => sum + fs.statSync(path.join(args.scratch, f)).size, 0)
writeResult(args.result, {
  tickMs,
  prodPollMs: PROD_POLL_MS,
  ticks,
  offers,
  audits,
  lateness,
  cycles,
  memory,
  ledgerBytes
})
process.exit(0)
