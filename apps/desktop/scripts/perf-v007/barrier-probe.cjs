'use strict'
// Barrier latency per design. argv: <addon> <N> <design: m2fix|nowait> <stress: none|loop>
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const { performance, monitorEventLoopDelay } = require('node:perf_hooks')
const addon = require(process.argv[2]); const N = Number(process.argv[3] || 300); const DESIGN = process.argv[4]; const STRESS = process.argv[5] || 'none'; const RENUDGE = Number(process.argv[6] || 100)
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'br-')))
const root = path.join(base, 'r'), dir = path.join(base, 'c'); fs.mkdirSync(root); fs.mkdirSync(dir)
const arrivals = new Map(); let lastId = 0n
const h = addon.start([root, dir], evs => { for (const e of evs) { const id = BigInt(e.id); if (id > lastId) lastId = id; arrivals.get(e.path)?.(id) } })
const inFlight = new Set(); let streamFlush = null; const flushMs = []
const sync = []; const t = (f) => { const s = performance.now(); const r = f(); sync.push(performance.now() - s); return r }
const startFlush = (force) => { if (streamFlush && !force) return; const s = performance.now(); const p = t(() => addon.flush(h)).then(() => {}, () => {}); const tr = p.finally(() => { inFlight.delete(tr); flushMs.push(performance.now() - s); if (streamFlush === tr) streamFlush = null }); inFlight.add(tr); streamFlush = tr; return tr }
let stop = false
const loop = async () => { while (!stop) { if (!streamFlush) startFlush(); await streamFlush; await new Promise(r => setImmediate(r)) } }
async function settled(ms) { const d = performance.now() + ms; while (inFlight.size) { const l = d - performance.now(); if (l <= 0) return false; await Promise.race([Promise.allSettled([...inFlight]), new Promise(r => setTimeout(r, l))]) } return true }
let seq = 0, idReadsWithFlush = 0, localBefore = 0, fail = 0
async function barrier() {
  const started = performance.now()
  if (DESIGN === 'm2fix' && !(await settled(2000))) { fail++; return performance.now() - started }
  let before
  if (inFlight.size === 0) before = BigInt(t(() => addon.currentEventId())); else { if (DESIGN === 'm2fix') idReadsWithFlush++; before = lastId; localBefore++ }
  const f = path.join(dir, `c${seq++}`); let got = null
  const delivered = new Promise(r => arrivals.set(f, id => { got = id; r(id) }))
  await fsp.writeFile(f, '')
  let timer; const nudge = () => { if (got !== null) return; if (performance.now() - started > 2000) return; startFlush(); timer = setTimeout(nudge, RENUDGE) }
  timer = setTimeout(nudge, 10)
  const id = await Promise.race([delivered, new Promise(r => setTimeout(() => r(null), 2100))]); clearTimeout(timer)
  const latest = t(() => addon.latestEventId(h))
  arrivals.delete(f); fsp.unlink(f).catch(() => {})
  if (id === null || id <= before || BigInt(latest) < id) fail++
  return performance.now() - started
}
;(async () => {
  const eld = monitorEventLoopDelay({ resolution: 1 }); eld.enable()
  if (STRESS === 'loop') loop()
  const ms = []; for (let i = 0; i < N; i++) { ms.push(await barrier()); await new Promise(r => setTimeout(r, 2)) }
  stop = true; await settled(5000); eld.disable()
  const s = [...ms].sort((a, b) => a - b), q = p => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]
  console.log(JSON.stringify({ DESIGN, STRESS, RENUDGE, slow50: s.filter(x => x > 50).length, N, p50: +q(0.5).toFixed(2), p99: +q(0.99).toFixed(2), max: +s[s.length - 1].toFixed(2), over500: s.filter(x => x > 500).length, fail, localBefore, idReadsWithFlush, flushStalls: flushMs.filter(x => x > 500).length, flushes: flushMs.length, addonSyncMax: +sync.reduce((a, b) => Math.max(a, b), 0).toFixed(3), eldMax: +(eld.max / 1e6).toFixed(2) }))
  addon.stop(h); setTimeout(() => fs.rmSync(base, { recursive: true, force: true }), 300)
})()
