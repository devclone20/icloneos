import { describe, expect, test } from 'vitest'

import { PERF, PERF_TAG, skipUnderLoad } from '../perf-gate.test-helpers'

import { type BusLogEntry, createPaneBroker } from './broker'
import { BUS_BODY_CAP_BYTES } from './envelope'
import { MAILBOX_MAX_MESSAGES } from './mailbox'

interface Received {
  from: string
  kind: string
  id: string
  seq: number
  body: string
}

function setup(names: string[]) {
  const log: BusLogEntry[] = []
  const broker = createPaneBroker({ log: entry => log.push(entry) })
  const ids = Object.fromEntries(names.map(name => [name, `pane-${name}`]))

  for (const name of names) {
    broker.register({ paneId: ids[name], name, group: 'crew' })
  }

  const run = async (name: string, ...argv: string[]) => broker.run(ids[name], argv)

  const recv = async (name: string): Promise<Received[]> => {
    const reply = await run(name, 'recv', '--json', '--max', '1000')

    return reply.text ? reply.text.split('\n').map(line => JSON.parse(line) as Received) : []
  }

  return { broker, ids, log, run, recv }
}

describe('identity and acknowledgement', () => {
  test('the broker stamps the sender; the body cannot claim another name', async () => {
    const { run, recv, broker, log } = setup(['a', 'b'])

    const sent = await run('a', 'send', '--to', 'b', 'hello')

    expect(sent.status).toBe(200)
    expect(sent.text).toMatch(/^sent \S+ → b #1$/)

    const [message] = await recv('b')

    expect(message).toMatchObject({ from: 'a', kind: 'msg', seq: 1, body: 'hello' })

    const forged = await run('a', 'send', '--from', 'b', '--to', 'b', 'i am b')

    expect(forged.status).toBe(403)
    expect(await recv('b')).toEqual([])
    expect(broker.stats().forged).toBe(1)
    expect(log).toContainEqual({ verb: 'forged', pane: 'a', claimed: 'b' })
    expect((await run('a', 'whoami')).text).toBe('a')
  })

  test('a retry with the same id is acknowledged once and read once', async () => {
    const { run, recv, broker } = setup(['a', 'b'])

    expect((await run('a', 'send', '--to', 'b', '--id', 'retry-0001', 'x')).text).toMatch(/^sent retry-0001/)
    expect((await run('a', 'send', '--to', 'b', '--id', 'retry-0001', 'x')).text).toMatch(/^duplicate retry-0001/)
    expect((await run('a', 'send', '--to', 'b', 'y')).text).toMatch(/#2$/)

    const got = await recv('b')

    expect(got.map(message => [message.body, message.seq])).toEqual([
      ['x', 1],
      ['y', 2]
    ])
    expect(broker.stats().duplicates).toBe(1)
  })

  test('ask long-polls until the named pane replies with the question id', async () => {
    const { run, recv } = setup(['a', 'b'])

    const asking = run('a', 'ask', '--to', 'b', '--timeout', '5', 'ready?')
    const [question] = await recv('b')

    expect(question.kind).toBe('ask')
    expect((await run('a', 'reply', '--corr', question.id, 'not yours')).status).toBe(404)
    expect((await run('b', 'reply', '--corr', question.id, 'yes')).status).toBe(200)
    expect(await asking).toEqual({ status: 200, text: 'yes' })
  })

  test('a group send reaches every live member but the sender', async () => {
    const { run, recv } = setup(['a', 'b', 'c'])

    expect((await run('a', 'send', '--to', '@crew', 'all')).text.split('\n')).toHaveLength(2)
    expect((await recv('b')).map(message => message.body)).toEqual(['all'])
    expect((await recv('c')).map(message => message.body)).toEqual(['all'])
    expect(await recv('a')).toEqual([])
  })
})

describe('caps', () => {
  test('64 B, 4 KB and 8 KB pass; 8 KB + 1 is refused whole', async () => {
    const { run, recv } = setup(['a', 'b'])

    for (const size of [64, 4096, BUS_BODY_CAP_BYTES]) {
      expect((await run('a', 'send', '--to', 'b', 'x'.repeat(size))).status).toBe(200)
    }

    const over = await run('a', 'send', '--to', 'b', 'x'.repeat(BUS_BODY_CAP_BYTES + 1))

    expect(over.status).toBe(400)
    expect(over.text).toContain('nothing was sent')
    expect((await recv('b')).map(message => message.body.length)).toEqual([64, 4096, BUS_BODY_CAP_BYTES])
  })

  test('a full mailbox refuses the sender instead of dropping', async () => {
    const { run, broker } = setup(['a', 'b'])

    for (let i = 0; i < MAILBOX_MAX_MESSAGES; i += 1) {
      await run('a', 'send', '--to', 'b', `m${i}`)
    }

    const refused = await run('a', 'send', '--to', 'b', 'one too many')

    expect(refused.status).toBe(409)
    expect(refused.text).toContain('mailbox full')
    expect(broker.stats().sent).toBe(MAILBOX_MAX_MESSAGES)
  })
})

describe('death', () => {
  test('kill -9 marks the pane dead, dead-letters its unread mail, fails a pending ask at once', async () => {
    const { run, broker } = setup(['a', 'b'])

    await run('a', 'send', '--to', 'b', 'unread 1')
    await run('a', 'send', '--to', 'b', 'unread 2')

    const asking = run('a', 'ask', '--to', 'b', '--timeout', '30', 'still there?')
    const started = performance.now()

    broker.exited('pane-b', { code: null, signal: 9 })

    const answer = await asking

    expect(performance.now() - started).toBeLessThan(1000)
    expect(answer.status).toBe(409)
    expect(broker.snapshot().find(pane => pane.name === 'b')?.state).toBe('dead')
    expect(broker.stats().deadLetters).toBe(3)

    const after = await run('a', 'send', '--to', 'b', 'are you there')

    expect(after.status).toBe(409)
    expect(broker.stats().deadLetters).toBe(4)
    expect(broker.authenticate('anything')).toBeNull()
  })

  test('a clean exit is `exited`, not `dead`', () => {
    const { broker } = setup(['a'])

    broker.exited('pane-a', { code: 0, signal: null })

    expect(broker.snapshot()[0].state).toBe('exited')
  })
})

// K105: the default run checks the ring's correctness on 1 000 trips; the perf project runs 10 000 with the budget.
test(`G1 (in process): A→B→C→D→A — 0 lost, 0 doubled, 0 out of order${PERF_TAG}`, async ctx => {
  const names = ['a', 'b', 'c', 'd']
  const { run, recv, broker } = setup(names)
  const ROUND_TRIPS = PERF ? 10_000 : 1_000
  const hops: number[] = []
  const lastSeq = new Map<string, number>()
  const seen = new Set<string>()
  let doubled = 0
  let outOfOrder = 0
  let delivered = 0

  for (let trip = 0; trip < ROUND_TRIPS; trip += 1) {
    for (let i = 0; i < names.length; i += 1) {
      const from = names[i]
      const to = names[(i + 1) % names.length]
      const id = `t${trip}-${from}${to}`.padEnd(8, '0')
      const started = performance.now()

      await run(from, 'send', '--to', to, '--id', id, `${trip}`)
      const [message] = await recv(to)

      hops.push(performance.now() - started)

      if (!message) {
        continue
      }

      delivered += 1

      if (seen.has(message.id)) {
        doubled += 1
      }

      seen.add(message.id)

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
    `[V3D G1-inproc] hops=${hops.length} delivered=${delivered} p50=${p50.toFixed(3)}ms p99=${p99.toFixed(3)}ms`
  )

  expect(delivered).toBe(ROUND_TRIPS * names.length)
  expect(ROUND_TRIPS * names.length - delivered).toBe(0)
  expect(doubled).toBe(0)
  expect(outOfOrder).toBe(0)
  expect(broker.stats()).toMatchObject({ sent: ROUND_TRIPS * 4, delivered: ROUND_TRIPS * 4, deadLetters: 0 })

  if (!PERF) {
    return
  }

  skipUnderLoad(ctx)
  expect(p50).toBeLessThanOrEqual(5)
  expect(p99).toBeLessThanOrEqual(25)
}, 60_000)

describe('round 2', () => {
  test('a pane off the bus (tmux) is known but holds no identity: nothing is sent as it or queued for it', async () => {
    const { broker, run } = setup(['a', 'b'])

    broker.registerOffBus({ paneId: 'pane-t', name: 't', group: 'crew' })

    expect((await broker.run('pane-t', ['whoami'])).status).toBe(403)
    expect((await run('a', 'send', '--to', 't', 'hi')).text).toContain('runs in tmux and has no bus')
    expect((await run('a', 'send', '--to', '@crew', 'all')).text).toMatch(/→ b #1$/)
    expect((await run('a', 'who')).text).toContain('no bus (tmux)')
    expect(broker.snapshot().find(pane => pane.name === 't')).toMatchObject({ bus: false, unread: 0 })
  })

  test('a group send is all-or-nothing by BYTES too: a member full by size gets nothing, nor does anyone', async () => {
    const { run, recv } = setup(['a', 'b', 'c'])
    const big = 'x'.repeat(8 * 1024)

    // Fill c by bytes (8 MB cap): ~1 000 × 8 KB, well under the message count cap.
    let filled = 0

    while ((await run('a', 'send', '--to', 'c', big)).status === 200) {
      filled += 1
    }

    expect(filled).toBeLessThan(MAILBOX_MAX_MESSAGES)

    const group = await run('a', 'send', '--to', '@crew', big)

    expect(group.status).toBe(409)
    expect(group.text).toContain('nothing was sent')
    expect(await recv('b')).toEqual([])
  })

  test('one pane may hold at most 32 open questions; the 33rd is refused at once', async () => {
    const { run } = setup(['a', 'b'])
    const open = Array.from({ length: 32 }, (_, i) => run('a', 'ask', '--to', 'b', '--timeout', '1', `q${i}`))

    const extra = await run('a', 'ask', '--to', 'b', '--timeout', '1', 'one more')

    expect(extra.status).toBe(429)
    expect(extra.text).toContain('32 questions are already open')
    await Promise.all(open)
  })

  test('an ask whose client hung up is withdrawn, and a recv whose client left leaves the mail queued', async () => {
    const { broker, ids, run, recv } = setup(['a', 'b'])
    const left = new AbortController()
    const asking = broker.run(ids.a, ['ask', '--to', 'b', '--timeout', '60', 'still there?'], left.signal)

    left.abort()
    expect((await asking).status).toBe(408)

    const [question] = await recv('b')

    expect((await run('b', 'reply', '--corr', question.id, 'yes')).status).toBe(404)

    const gone = new AbortController()
    const waiting = broker.run(ids.b, ['recv', '--wait', '60'], gone.signal)

    gone.abort()
    expect((await waiting).status).toBe(408)
    await run('a', 'send', '--to', 'b', 'kept')
    expect((await recv('b')).map(message => message.body)).toEqual(['kept'])
  })

  test('OSC 9/777 text is shown as the program’s, never as the app’s own words', () => {
    const { broker, ids } = setup(['a'])

    broker.setSignal(ids.a, 'enter your password', 'osc9')
    expect(broker.snapshot()[0].signal?.text).toBe('[osc9] enter your password')
    broker.setSignal(ids.a, 'build done', 'attention')
    expect(broker.snapshot()[0].signal?.text).toBe('build done')
  })
})
