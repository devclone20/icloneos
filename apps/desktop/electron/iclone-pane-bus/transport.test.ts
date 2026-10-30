/**
 * The bus over its real transport: a Unix socket, the real installed `it`
 * script, curl. Token isolation (G8): a pane's token is its identity, the
 * `it.json` bearer is not a bus credential, and no token ever reaches argv.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { PERF, PERF_TAG, skipUnderLoad } from '../perf-gate.test-helpers'

import { createPaneBroker, type PaneBroker } from './broker'

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: vi.fn(() => os.tmpdir()) },
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

let home = ''
let server: http.Server | null = null
let broker: PaneBroker
let socket = ''
const tokens: Record<string, string> = {}

beforeEach(async () => {
  // A short base: macOS caps a Unix socket path at 104 bytes.
  home = mkdtempSync(path.join('/tmp', 'v3d-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.resetModules()

  const { createBusServer, listenOnSocket } = await import('./ipc')
  const { initIcloneIt } = await import('../iclone-it')

  initIcloneIt({ getMainWindow: () => null })
  broker = createPaneBroker()

  for (const name of ['a', 'b']) {
    tokens[name] = broker.register({ paneId: `pane-${name}`, name })
  }

  socket = path.join(home, '.iclone-os', 'bus', 'bus.sock')
  server = createBusServer(broker)
  await listenOnSocket(server, socket)
  await vi.waitFor(() => expect(statSync(path.join(home, '.iclone-os', 'bin', 'it')).isFile()).toBe(true))
})

afterEach(async () => {
  await new Promise(resolve => server?.close(resolve))
  vi.restoreAllMocks()
  rmSync(home, { force: true, recursive: true })
})

const cli = () => path.join(home, '.iclone-os', 'bin', 'it')

function itAs(pane: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    ICLONE_PANE_TOKEN: tokens[pane] ?? '',
    ICLONE_PANE_SOCK: socket
  }

  return new Promise(resolve => {
    execFile('/bin/sh', [cli(), 'bus', ...argv], { env }, (error, stdout, stderr) =>
      resolve({ code: error ? Number(error.code ?? 1) : 0, out: String(stdout).trim(), err: String(stderr).trim() })
    )
  })
}

function rawPost(authorization: string, argv: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: socket,
        method: 'POST',
        path: '/bus',
        headers: { authorization, 'content-type': 'application/json' }
      },
      res => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }
    )

    req.on('error', reject)
    req.end(JSON.stringify({ argv }))
  })
}

test('the socket is 0600 in a 0700 dir, and the bus opens no TCP port', () => {
  expect(statSync(socket).mode & 0o777).toBe(0o600)
  expect(statSync(path.dirname(socket)).mode & 0o777).toBe(0o700)
  expect(typeof server?.address()).toBe('string')
})

test('round trip through the real `it` script: identity, ack, recv, ask/reply', async () => {
  expect((await itAs('a', 'whoami')).out).toBe('a')

  const sent = await itAs('a', 'send', '--to', 'b', 'line one\nline "two"')

  expect(sent.code).toBe(0)
  expect(sent.out).toMatch(/^sent \S+ → b #1$/)

  const got = await itAs('b', 'recv', '--json')
  const message = JSON.parse(got.out) as { from: string; body: string }

  expect(message).toMatchObject({ from: 'a', body: 'line one\nline "two"' })

  const asking = itAs('a', 'ask', '--to', 'b', '--timeout', '10', 'go?')
  const question = JSON.parse((await itAs('b', 'recv', '--wait', '5', '--json')).out) as { id: string }

  expect((await itAs('b', 'reply', '--corr', question.id, 'go')).code).toBe(0)
  expect(await asking).toMatchObject({ code: 0, out: 'go' })
})

test('token isolation: pane A cannot speak as B, and no other credential is a pane', async () => {
  const forged = await itAs('a', 'send', '--from', 'b', '--to', 'b', 'from b, honest')

  expect(forged.code).toBe(1)
  expect(forged.err).toContain('cannot speak as "b"')
  expect((await itAs('b', 'recv')).out).toBe('')

  const itJson = JSON.parse(execFileSync('cat', [path.join(home, '.iclone-os', 'it.json')], { encoding: 'utf8' })) as {
    token: string
  }

  expect(await rawPost(`Bearer ${itJson.token}`, ['whoami'])).toBe(401)
  expect(await rawPost(`Pane ${itJson.token}`, ['whoami'])).toBe(401)
  expect(await rawPost('Pane v1.00.00', ['whoami'])).toBe(401)

  // B's token with A's nonce, or A's token after A died, are no one.
  const [, nonceA] = tokens.a.split('.')
  const [, , macB] = tokens.b.split('.')

  expect(await rawPost(`Pane v1.${nonceA}.${macB}`, ['whoami'])).toBe(401)
  broker.exited('pane-a', { code: null, signal: 9 })
  expect(await rawPost(`Pane ${tokens.a}`, ['whoami'])).toBe(401)
  expect(await rawPost(`Pane ${tokens.b}`, ['whoami'])).toBe(200)
})

test('a pane token never appears in argv while a request is in flight', async () => {
  const env = { PATH: process.env.PATH ?? '', HOME: home, ICLONE_PANE_TOKEN: tokens.a, ICLONE_PANE_SOCK: socket }
  const child = spawn('/bin/sh', [cli(), 'bus', 'recv', '--wait', '3'], { env })

  try {
    await vi.waitFor(
      () => {
        const listing = execFileSync('ps', ['-A', '-ww', '-o', 'args='], { encoding: 'utf8' })

        expect(listing).toContain('--unix-socket')
      },
      { timeout: 2500, interval: 50 }
    )

    const listing = execFileSync('ps', ['-A', '-ww', '-o', 'args='], { encoding: 'utf8' })

    expect(listing).not.toContain(tokens.a)
    expect(listing).not.toContain(tokens.a.split('.')[2])
  } finally {
    child.kill()
  }
})

test('a shell outside a pane is told so', async () => {
  const outside = await new Promise<{ code: number; err: string }>(resolve => {
    execFile(
      '/bin/sh',
      [cli(), 'bus', 'who'],
      { env: { PATH: process.env.PATH ?? '', HOME: home } },
      (error, _out, err) => resolve({ code: error ? 1 : 0, err: String(err) })
    )
  })

  expect(outside.code).toBe(1)
  expect(outside.err).toContain('not an iT pane')
})

function busCall(token: string, argv: string[], fresh = false): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: socket,
        method: 'POST',
        path: '/bus',
        headers: { authorization: `Pane ${token}` },
        // A new connection per call, as the CLI's curl makes: no kept-alive socket that already authenticated.
        ...(fresh ? { agent: false } : {})
      },
      res => {
        let text = ''

        res.setEncoding('utf8')
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      }
    )

    req.on('error', reject)
    req.end(JSON.stringify({ argv }))
  })
}

// K105: the default run checks delivery and order on 250 trips; the perf project runs 2 500 with the budget.
test(`G1 over the socket: A→B→C→D→A, every hop acknowledged and read once, in order${PERF_TAG}`, async ctx => {
  const trips = Number(process.env.V3D_G1_TRIPS ?? (PERF ? 2_500 : 250))
  const ring = ['c', 'd']

  for (const name of ring) {
    tokens[name] = broker.register({ paneId: `pane-${name}`, name })
  }

  const names = ['a', 'b', 'c', 'd']
  const hops: number[] = []
  const lastSeq = new Map<string, number>()
  let lost = 0
  let outOfOrder = 0

  for (let trip = 0; trip < trips; trip += 1) {
    for (let i = 0; i < names.length; i += 1) {
      const to = names[(i + 1) % names.length]
      const started = performance.now()
      const ack = await busCall(tokens[names[i]], ['send', '--to', to, `trip ${trip}`])
      const read = await busCall(tokens[to], ['recv', '--json'])

      hops.push(performance.now() - started)

      const [message] = read.text
        ? read.text.split('\n').map(line => JSON.parse(line) as { from: string; seq: number })
        : []

      if (ack.status !== 200 || !message) {
        lost += 1

        continue
      }

      const pair = `${message.from}>${to}`

      if (message.seq !== (lastSeq.get(pair) ?? 0) + 1) {
        outOfOrder += 1
      }

      lastSeq.set(pair, message.seq)
    }
  }

  hops.sort((x, y) => x - y)
  const p50 = hops[Math.floor(hops.length * 0.5)]
  const p99 = hops[Math.floor(hops.length * 0.99)]

  console.info(
    `[V3D G1-socket] trips=${trips} hops=${hops.length} lost=${lost} ooo=${outOfOrder} p50=${p50.toFixed(2)}ms p99=${p99.toFixed(2)}ms`
  )

  expect(lost).toBe(0)
  expect(outOfOrder).toBe(0)
  expect(broker.stats()).toMatchObject({ duplicates: 0, deadLetters: 0, delivered: trips * 4 })

  if (!PERF) {
    return
  }

  skipUnderLoad(ctx)
  expect(p50).toBeLessThanOrEqual(5)
  expect(p99).toBeLessThanOrEqual(25)
}, 300_000)

test('the installed CLI hop (sh + curl per call, spawned from node) is measured, not assumed', async () => {
  const hops = 200
  const samples: number[] = []

  for (let i = 0; i < hops; i += 1) {
    const started = performance.now()

    await itAs('a', 'send', '--to', 'b', `cli ${i}`)
    await itAs('b', 'recv')
    samples.push(performance.now() - started)
  }

  samples.sort((x, y) => x - y)

  const at = (q: number) => samples[Math.min(hops - 1, Math.floor(hops * q))].toFixed(1)

  console.info(`[V3D G1-cli] hops=${hops} p50=${at(0.5)}ms p99=${at(0.99)}ms max=${at(1)}ms`)
  expect(broker.stats().delivered).toBe(hops)
}, 120_000)

/** A request that is left open: its status when it is answered, and a way to hang up. */
function openCall(token: string, argv: string[]): { status: Promise<number>; hangUp: () => void } {
  let hangUp = () => {}

  const status = new Promise<number>(resolve => {
    const req = http.request(
      { socketPath: socket, method: 'POST', path: '/bus', headers: { authorization: `Pane ${token}` } },
      res => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }
    )

    req.on('error', () => resolve(-1))
    req.end(JSON.stringify({ argv }))
    hangUp = () => req.destroy()
  })

  return { status, hangUp: () => hangUp() }
}

async function settled(statuses: Promise<number>[], ms: number): Promise<number[]> {
  const pending = Symbol('pending')
  const timeout = new Promise<typeof pending>(resolve => setTimeout(() => resolve(pending), ms))

  return Promise.all(
    statuses.map(async status => {
      const result = await Promise.race([status, timeout])

      return result === pending ? 0 : result
    })
  )
}

test('flood: 100 concurrent long-polls from one pane — 8 held, 92 refused; hanging up frees the slot', async () => {
  const calls = Array.from({ length: 100 }, () => openCall(tokens.a, ['recv', '--wait', '30']))

  const statuses = await settled(
    calls.map(call => call.status),
    1_500
  )

  expect(statuses.filter(status => status === 0)).toHaveLength(8)
  expect(statuses.filter(status => status === 429)).toHaveLength(92)

  // The other pane is not starved by A's flood.
  expect((await busCall(tokens.b, ['whoami'])).status).toBe(200)

  calls.forEach(call => call.hangUp())
  await vi.waitFor(async () => expect((await busCall(tokens.a, ['whoami'])).status).toBe(200))

  // The abandoned waits left the broker too: a message now is read by the next reader, not by a ghost.
  await busCall(tokens.b, ['send', '--to', 'a', 'after the flood'])
  expect((await busCall(tokens.a, ['recv'])).text).toContain('after the flood')
}, 20_000)

test('flood across panes: 64 open requests on the bus in total, the rest refused', async () => {
  const names = Array.from({ length: 9 }, (_, i) => `f${i}`)

  for (const name of names) {
    tokens[name] = broker.register({ paneId: `pane-${name}`, name })
  }

  const calls = names.flatMap(name => Array.from({ length: 8 }, () => openCall(tokens[name], ['recv', '--wait', '30'])))

  const statuses = await settled(
    calls.map(call => call.status),
    1_500
  )

  expect(statuses.filter(status => status === 0)).toHaveLength(64)
  expect(statuses.filter(status => status === 429)).toHaveLength(8)
  calls.forEach(call => call.hangUp())
}, 20_000)

/** A raw socket on the bus that sends `head` and then nothing: a slow-loris. Resolves once connected or closed. */
function halfOpen(head: string): Promise<{ closedAt: () => null | number }> {
  return new Promise(resolve => {
    let closedAt: null | number = null
    const raw = net.createConnection(socket)

    // Read whatever the server sends (a 408), or the client never sees the end of the socket.
    raw.resume()
    raw.on('error', () => {})
    raw.on('close', () => {
      closedAt = performance.now()
      resolve({ closedAt: () => closedAt })
    })
    raw.on('connect', () => {
      raw.write(head)
      resolve({ closedAt: () => closedAt })
    })
  })
}

test('slow-loris: 140 sockets that never authenticate, plus 8 slow bodies, block a pane for at most one 10 s timeout', async () => {
  const started = performance.now()

  // First: 8 authenticated requests whose body never finishes (they hold pane b's slots).
  const slowBodies = await Promise.all(
    Array.from({ length: 8 }, () =>
      halfOpen(
        `POST /bus HTTP/1.1\r\nHost: pane\r\nAuthorization: Pane ${tokens.b}\r\ncontent-length: 100\r\n\r\n{"argv":`
      )
    )
  )

  await vi.waitFor(async () => expect((await busCall(tokens.b, ['whoami'])).status).toBe(429))

  const loris = await Promise.all(Array.from({ length: 140 }, () => halfOpen('POST /bus HTTP/1.1\r\n')))

  // Beyond 32 unauthenticated sockets the rest are closed at once, not queued for 30 s.
  await vi.waitFor(() => expect(loris.filter(entry => entry.closedAt() !== null).length).toBeGreaterThanOrEqual(108))

  let servedAt: null | number = null

  while (servedAt === null && performance.now() - started < 12_000) {
    const answer = await busCall(tokens.a, ['whoami'], true).catch(() => null)

    if (answer?.status === 200) {
      servedAt = performance.now()
    } else {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  expect(servedAt).not.toBeNull()
  expect((servedAt ?? Infinity) - started).toBeLessThanOrEqual(11_500)

  // The authenticated slow bodies are cut at 10 s too (Node checked every 30 s before).
  await vi.waitFor(() => expect(slowBodies.every(entry => entry.closedAt() !== null)).toBe(true), {
    timeout: 13_000 - (performance.now() - started),
    interval: 100
  })
  const slowClosed = Math.max(...slowBodies.map(entry => entry.closedAt() ?? Infinity)) - started

  console.info(
    `[V3D slow-loris] sockets=140+8 pane_served_ms=${((servedAt ?? Infinity) - started).toFixed(0)} slow_bodies_closed_ms=${slowClosed.toFixed(0)}`
  )
  // requestTimeout (10 s) plus Node's check interval (1 s).
  expect(slowClosed).toBeLessThanOrEqual(12_000)
  expect((await busCall(tokens.b, ['whoami'], true)).status).toBe(200)
  expect(loris.every(entry => entry.closedAt() !== null)).toBe(true)
}, 20_000)

test(`G1 as written: A→B→C→D→A by four plain shell scripts on the bus, through the installed \`it\`${PERF_TAG}`, async ctx => {
  const trips = Number(process.env.V3D_G1_SH_TRIPS ?? 50)

  for (const name of ['c', 'd']) {
    tokens[name] = broker.register({ paneId: `pane-${name}`, name })
  }

  // Each pane's script: wait for the token message, pass it on. A starts the ring and counts trips.
  const script = path.join(home, 'ring.sh')

  execFileSync('/bin/sh', [
    '-c',
    `cat > '${script}' <<'SH'
IT="$1"; NEXT="$2"; TRIPS="$3"; START="$4"
[ "$START" = 1 ] && sh "$IT" bus send --to "$NEXT" go >/dev/null
n=0
while [ "$n" -lt "$TRIPS" ]; do
  m=$(sh "$IT" bus recv --wait 10 --max 1)
  [ -n "$m" ] || { echo lost >&2; exit 2; }
  n=$((n + 1))
  [ "$START" = 1 ] && [ "$n" -ge "$TRIPS" ] && break
  sh "$IT" bus send --to "$NEXT" go >/dev/null
done
SH`
  ])

  const ring = ['a', 'b', 'c', 'd']
  const started = performance.now()

  const runs = ring.map(
    (name, i) =>
      new Promise<number>(resolve => {
        const child = spawn('/bin/sh', [script, cli(), ring[(i + 1) % 4], String(trips), i === 0 ? '1' : '0'], {
          env: {
            PATH: process.env.PATH ?? '',
            HOME: home,
            ICLONE_PANE_TOKEN: tokens[name],
            ICLONE_PANE_SOCK: socket
          },
          stdio: 'ignore'
        })

        child.on('exit', code => resolve(code ?? -1))
      })
  )

  // B, C and D end once they have passed `trips` messages; A once it has received them.
  const codes = await Promise.all(runs)
  const hops = trips * 4
  const perHop = (performance.now() - started) / hops

  console.info(`[V3D G1-sh] trips=${trips} hops=${hops} exit=${codes.join(',')} mean=${perHop.toFixed(1)}ms/hop`)

  expect(codes).toEqual([0, 0, 0, 0])
  expect(broker.stats()).toMatchObject({ sent: hops, delivered: hops, duplicates: 0, deadLetters: 0 })

  // K105: the per-hop budget is the perf project's (the G1-sh p99 K14 asks for is printed there, on an idle machine).
  if (!PERF) {
    return
  }

  skipUnderLoad(ctx)
  expect(perHop).toBeLessThanOrEqual(25)
}, 120_000)
