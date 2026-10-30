import { createServer } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CDP, devTargetOrExit, discoverTarget, envPort, SELECTORS } from './lib/cdp.mjs'
import * as oldPath from './perf/lib/cdp.mjs'

class FakeSocket extends EventTarget {
  sent = []

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.dispatchEvent(new Event('close'))
  }

  reply(message, { binary = false } = {}) {
    const event = new Event('message')
    const text = JSON.stringify(message)
    Object.defineProperty(event, 'data', { value: binary ? Buffer.from(text, 'utf8') : text })
    this.dispatchEvent(event)
  }
}

const servers = []

async function serveTargets(lists) {
  let calls = 0

  const server = createServer((req, res) => {
    const list = lists[Math.min(calls, lists.length - 1)]
    calls += 1
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url === '/json/list' ? list : []))
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)

  return { calls: () => calls, port: server.address().port }
}

const page = (url, extra = {}) => ({ type: 'page', url, webSocketDebuggerUrl: `ws://x/${url}`, ...extra })

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

describe('envPort', () => {
  it('reads HERMES_DESKTOP_CDP_PORT when it is a port the dev app accepts (1024-65535, trimmed)', () => {
    expect(envPort({ HERMES_DESKTOP_CDP_PORT: '9333' })).toBe(9333)
    expect(envPort({ HERMES_DESKTOP_CDP_PORT: ' 1024 ' })).toBe(1024)
    expect(envPort({ HERMES_DESKTOP_CDP_PORT: '65535' })).toBe(65535)
  })

  it('uses 9222 when the variable is unset or blank, as electron/dev-cdp.ts does', () => {
    for (const value of [undefined, '', '  ']) {
      expect(envPort({ HERMES_DESKTOP_CDP_PORT: value })).toBe(9222)
    }
  })

  it('refuses an opt-out: the dev app opened no port', () => {
    for (const value of ['off', 'OFF', '0', 'false', 'no']) {
      expect(() => envPort({ HERMES_DESKTOP_CDP_PORT: value })).toThrow(
        `HERMES_DESKTOP_CDP_PORT=${value} turns renderer debugging off`
      )
    }
  })

  it('refuses a value that is not a port instead of guessing 9222', () => {
    for (const value of ['-1', '1.5', '80', '65536', 'abc']) {
      expect(() => envPort({ HERMES_DESKTOP_CDP_PORT: value })).toThrow('HERMES_DESKTOP_CDP_PORT is not a valid port')
    }
  })
})

describe('old module path', () => {
  it('scripts/perf/lib/cdp.mjs re-exports the one client unchanged', () => {
    expect(oldPath.CDP).toBe(CDP)
    expect(oldPath.SELECTORS).toBe(SELECTORS)
    expect(oldPath.discoverTarget).toBe(discoverTarget)
  })
})

describe('discoverTarget', () => {
  it('prefers an http page and skips non-pages and targets without a socket url', async () => {
    const { port } = await serveTargets([
      [
        { type: 'worker', url: 'http://worker', webSocketDebuggerUrl: 'ws://w' },
        page('http://nows', { webSocketDebuggerUrl: undefined }),
        page('devtools://devtools'),
        page('http://127.0.0.1:5174/')
      ]
    ])

    await expect(discoverTarget({ port, timeoutMs: 0 })).resolves.toMatchObject({ url: 'http://127.0.0.1:5174/' })
  })

  it('falls back to the first page when none is http', async () => {
    const { port } = await serveTargets([[page('devtools://a'), page('file:///b')]])

    await expect(discoverTarget({ port, timeoutMs: 0 })).resolves.toMatchObject({ url: 'devtools://a' })
  })

  it('restricts to `match` and picks `prefer` first, falling back without it', async () => {
    const { port } = await serveTargets([[page('http://a/'), page('http://b:5174/')]])

    await expect(discoverTarget({ port, match: '5174', timeoutMs: 0 })).resolves.toMatchObject({
      url: 'http://b:5174/'
    })
    await expect(discoverTarget({ port, prefer: '5174', timeoutMs: 0 })).resolves.toMatchObject({
      url: 'http://b:5174/'
    })
    await expect(discoverTarget({ port, prefer: '9999', timeoutMs: 0 })).resolves.toMatchObject({ url: 'http://a/' })
    await expect(discoverTarget({ port, prefer: '', timeoutMs: 0 })).resolves.toMatchObject({ url: 'http://a/' })
    await expect(discoverTarget({ port, match: '9999', timeoutMs: 0 })).rejects.toThrow(
      `no CDP page target on :${port} matching "9999" within 0ms`
    )
  })

  it('polls until a target appears', async () => {
    const server = await serveTargets([[], [], [page('http://late/')]])

    await expect(discoverTarget({ port: server.port, timeoutMs: 5000 })).resolves.toMatchObject({ url: 'http://late/' })
    expect(server.calls()).toBe(3)
  })

  it('treats a closed debug port as "no target" and gives up at the deadline', async () => {
    const { port } = await serveTargets([[]])
    await new Promise(resolve => servers.pop().close(resolve))

    await expect(discoverTarget({ port, timeoutMs: 0 })).rejects.toThrow(`no CDP page target on :${port} within 0ms`)
  })
})

describe('devTargetOrExit', () => {
  const run = async (opts, env) => {
    const lines = []
    const exit = vi.fn(() => 'exited')
    const result = await devTargetOrExit(opts, { env, exit, log: line => lines.push(line) })

    return { exit, lines, result }
  }

  it('returns the target on the env port in one attempt', async () => {
    const { port } = await serveTargets([[page('http://a/'), page('http://b:5174/')]])
    const { exit, lines, result } = await run({ prefer: '5174' }, { HERMES_DESKTOP_CDP_PORT: String(port) })

    expect(result).toMatchObject({ url: 'http://b:5174/' })
    expect(exit).not.toHaveBeenCalled()
    expect(lines).toEqual([])
  })

  it('prints the opt-out reason and exits 1 without touching the network', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { exit, lines, result } = await run({}, { HERMES_DESKTOP_CDP_PORT: 'off' })

    expect(result).toBe('exited')
    expect(exit).toHaveBeenCalledWith(1)
    expect(lines).toEqual([
      'HERMES_DESKTOP_CDP_PORT=off turns renderer debugging off, so there is no port to connect to.'
    ])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('prints the discovery error with the disabled-port hint and exits 1 when nothing answers', async () => {
    const { port } = await serveTargets([[]])
    await new Promise(resolve => servers.pop().close(resolve))
    const { exit, lines } = await run({}, { HERMES_DESKTOP_CDP_PORT: String(port) })

    expect(exit).toHaveBeenCalledWith(1)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`no CDP page target on :${port} within 0ms.`)
    expect(lines[0]).toContain('HERMES_DESKTOP_CDP_PORT is not set to "off" or another port.')
  })
})

describe('CDP', () => {
  it('resolves replies by id, rejects protocol errors and ignores unknown ids', async () => {
    const ws = new FakeSocket()
    const cdp = CDP.attach(ws)
    const ok = cdp.send('Page.reload', { ignoreCache: true })
    const bad = cdp.send('Nope.method')

    expect(ws.sent).toEqual([
      { id: 1, method: 'Page.reload', params: { ignoreCache: true } },
      { id: 2, method: 'Nope.method', params: {} }
    ])
    ws.reply({ id: 99, result: { stray: true } })
    ws.reply({ id: 2, error: { message: 'method not found' } })
    ws.reply({ id: 1, result: { done: true } }, { binary: true })

    await expect(ok).resolves.toEqual({ done: true })
    await expect(bad).rejects.toThrow('method not found')
    expect(cdp.pending.size).toBe(0)
  })

  it('dispatches protocol events to every listener of that method', () => {
    const ws = new FakeSocket()
    const cdp = CDP.attach(ws)
    const seen = []
    cdp.on('Page.loadEventFired', params => seen.push(['a', params]))
    cdp.on('Page.loadEventFired', params => seen.push(['b', params]))
    cdp.on('Other.event', () => seen.push(['other']))

    ws.reply({ method: 'Page.loadEventFired', params: { timestamp: 1 } })

    expect(seen).toEqual([
      ['a', { timestamp: 1 }],
      ['b', { timestamp: 1 }]
    ])
  })

  it('rejects every pending call when the socket closes', async () => {
    const ws = new FakeSocket()
    const cdp = CDP.attach(ws)
    const pending = [cdp.send('A.a'), cdp.send('B.b')]

    cdp.close()

    for (const call of pending) {
      await expect(call).rejects.toThrow('CDP socket closed')
    }

    expect(cdp.pending.size).toBe(0)
  })

  it('eval returns the value and throws the exception description', async () => {
    const ws = new FakeSocket()
    const cdp = CDP.attach(ws)
    const value = cdp.eval('1+1')
    const thrown = cdp.eval('boom()')
    const bare = cdp.eval('bare()')

    expect(ws.sent[0].params).toEqual({ expression: '1+1', returnByValue: true, awaitPromise: true })
    ws.reply({ id: 1, result: { result: { type: 'number', value: 2 } } })
    ws.reply({ id: 2, result: { exceptionDetails: { exception: { description: 'ReferenceError: boom' } } } })
    ws.reply({ id: 3, result: { exceptionDetails: { text: 'Uncaught' } } })

    await expect(value).resolves.toBe(2)
    await expect(thrown).rejects.toThrow('ReferenceError: boom')
    await expect(bare).rejects.toThrow('Uncaught')
  })

  it('open() accepts a discovered target or its socket url and rejects a failed handshake', async () => {
    const urls = []

    vi.stubGlobal(
      'WebSocket',
      class extends FakeSocket {
        constructor(url) {
          super()
          urls.push(url)
          queueMicrotask(() => this.dispatchEvent(new Event(url.includes('refused') ? 'error' : 'open')))
        }
      }
    )

    expect(await CDP.open(page('http://a/'))).toBeInstanceOf(CDP)
    expect(await CDP.open('ws://direct')).toBeInstanceOf(CDP)
    await expect(CDP.open('ws://refused')).rejects.toBeInstanceOf(Event)
    expect(urls).toEqual(['ws://x/http://a/', 'ws://direct', 'ws://refused'])
  })
})
