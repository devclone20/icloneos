// Child process of the `pty.pane_bus` row: the real broker (iclone-pane-bus/broker.ts) behind its real Unix-socket
// transport (iclone-pane-bus/ipc.ts createBusServer). Prints one JSON line. Electron is replaced by an inert stub
// (only `app`/`ipcMain` are imported by ipc.ts and neither is on the timed path).
import '../lib/ts-hook.mjs'

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { writeResult } from '../lib/child_result.mjs'

const args = JSON.parse(process.argv[2] ?? '{}')
const BUS = new URL('../../apps/desktop/electron/iclone-pane-bus/', import.meta.url)
const { createPaneBroker } = await import(new URL('broker.ts', BUS).href)
const { createBusServer } = await import(new URL('ipc.ts', BUS).href)

const broker = createPaneBroker()
const injectMs = Number(args.injectMs ?? 0)
const bus = injectMs
  ? { ...broker, run: (...a) => new Promise(r => setTimeout(() => r(broker.run(...a)), injectMs)) }
  : broker
const server = createBusServer(bus)
// Unix socket paths are capped at 104 bytes on macOS: the socket lives in a short private temp dir, like the app's.
const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-bus-'))
const sock = path.join(sockDir, 'bus.sock')
// Every exit path (success, throw, process.exit, the runner's SIGTERM) closes the socket and removes its dir; a
// SIGKILL cannot be caught, so the runner's timeout sends SIGTERM first and waits for the group.
process.on('exit', () => {
  server.close()
  fs.rmSync(sockDir, { recursive: true, force: true })
})
process.once('SIGTERM', () => process.exit(143))
await new Promise((resolve, reject) => server.listen(sock, resolve).once('error', reject))

const hr = () => Number(process.hrtime.bigint()) / 1e6
// One connection per request, like one `it bus …` CLI invocation.
const call = (token, argv) =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify({ argv })
    const req = http.request(
      {
        socketPath: sock,
        method: 'POST',
        path: '/bus',
        agent: false,
        headers: {
          authorization: `Pane ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body)
        }
      },
      res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.once('error', reject)
    req.end(body)
  })

const tA = broker.register({ paneId: 'p-a', name: 'a' })
const tB = broker.register({ paneId: 'p-b', name: 'b' })
const body = 'x'.repeat(Number(args.bodyBytes ?? 256))

// Round trip: B is parked in a long-poll `recv`; A sends; stop when B's recv returns the message.
async function roundTrip(i) {
  const waiting = call(tB, ['recv', '--wait', '5', '--max', '1', '--json'])
  await new Promise(r => setImmediate(r))
  const t0 = hr()
  const sent = await call(tA, ['send', '--to', 'b', `m${i} ${body}`])
  const got = await waiting
  const t1 = hr()
  if (sent.status !== 200 || got.status !== 200 || !got.text.includes(`m${i} `)) {
    throw new Error(`round trip ${i} failed: send ${sent.status} recv ${got.status}`)
  }
  return t1 - t0
}
const samples = []
for (let i = 0; i < Number(args.n ?? 200); i += 1) samples.push(await roundTrip(i))

const out = { cold: samples[0], warm: samples.slice(1) }
if (args.load) {
  // Loss under load: 8 senders x 400 messages at once to one reader that drains with recv --max 1000.
  const senders = []
  for (let s = 0; s < 8; s += 1) senders.push(broker.register({ paneId: `p-s${s}`, name: `s${s}` }))
  const tR = broker.register({ paneId: 'p-r', name: 'r' })
  const status = {}
  const accepted = new Set()
  const delivered = new Set()
  let sending = true
  // The reader drains WHILE the senders send (a live pane), with long-polls of up to 1 s.
  const drain = (async () => {
    for (;;) {
      const got = await call(tR, ['recv', '--wait', '1', '--max', '1000', '--json'])
      const lines = got.text.split('\n').filter(Boolean)
      for (const line of lines) delivered.add(JSON.parse(line).body.split(' ')[0])
      if (!lines.length && !sending) break
    }
  })()
  await Promise.all(
    senders.map(async (tok, s) => {
      for (let i = 0; i < 400; i += 1) {
        const tag = `s${s}m${i}`
        const res = await call(tok, ['send', '--to', 'r', `${tag} ${body}`])
        status[res.status] = (status[res.status] ?? 0) + 1
        if (res.status === 200) accepted.add(tag)
      }
    })
  )
  sending = false
  await drain
  const lost = [...accepted].filter(tag => !delivered.has(tag)).length
  out.load = {
    attempted: 3200,
    status,
    accepted: accepted.size,
    delivered: delivered.size,
    lost,
    stats: broker.stats()
  }

  // Memory per pane: 1 000 bus panes, each holding 10 queued 1 KiB messages (gc'd heap delta / 1 000).
  globalThis.gc?.()
  const before = process.memoryUsage()
  let queued = 0
  broker.register({ paneId: 'p-f', name: 'f' })
  for (let p = 0; p < 1000; p += 1) {
    broker.register({ paneId: `p-m${p}`, name: `m${p}` })
    for (let k = 0; k < 10; k += 1) {
      const res = broker.run('p-f', ['send', '--to', `m${p}`, randomBytes(512).toString('hex')])
      queued += res.status === 200 ? 1 : 0
    }
  }
  globalThis.gc?.()
  const after = process.memoryUsage()
  out.memory = {
    panes: 1000,
    queued_per_pane: 10,
    heap_kb_per_pane: (after.heapUsed - before.heapUsed) / 1024 / 1000,
    rss_kb_per_pane: (after.rss - before.rss) / 1024 / 1000,
    queued_ok: queued
  }
}
writeResult(args.result, out)
process.exit(0)
