import { JsonRpcGatewayClient } from '@hermes/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $serverRequests,
  $unseenServerRequestCancels,
  answerRoutedServerRequest,
  answerServerRequest,
  attachServerRequests,
  declineServerRequest,
  registerServerRequestHandler,
  replayOpenRequests,
  resetServerRequestsForTest,
  SERVER_REQUEST_POLICY,
  ServerRequestExpiredError,
  setServerRequestSessionVisibility
} from '.'

type Frame = Record<string, any>

class FakeWebSocket extends EventTarget {
  readyState = 0
  sent: Frame[] = []
  /** Reply to client.capabilities: a result (new runtime) or -32601 (pre-break runtime). */
  capabilities: 'legacy' | 'ok' = 'ok'

  send(data: string): void {
    const frame = JSON.parse(data) as Frame
    this.sent.push(frame)

    if (frame.method === 'client.capabilities') {
      queueMicrotask(() =>
        this.frame(
          this.capabilities === 'ok'
            ? { jsonrpc: '2.0', id: frame.id, result: { server_requests: [] } }
            : { jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'method not found' } }
        )
      )
    } else if (typeof frame.method === 'string' && frame.id !== undefined) {
      queueMicrotask(() => this.frame({ jsonrpc: '2.0', id: frame.id, result: { status: 'ok' } }))
    }
  }

  close(): void {
    this.readyState = 3
    this.dispatchEvent(new CloseEvent('close'))
  }

  open(): void {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  frame(obj: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(obj) }))
  }

  event(type: string, payload: unknown, sessionId = 's1'): void {
    this.frame({ jsonrpc: '2.0', method: 'event', params: { payload, session_id: sessionId, type } })
  }

  responses(id: string): Frame[] {
    return this.sent.filter(f => f.id === id && !f.method)
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

async function setup(capabilities: 'legacy' | 'ok' = 'ok') {
  const sockets: FakeWebSocket[] = []

  const gateway = new JsonRpcGatewayClient({
    connectTimeoutMs: 1000,
    heartbeatDeadlineMs: 0,
    heartbeatIntervalMs: 0,
    socketFactory: () => {
      const socket = new FakeWebSocket()
      socket.capabilities = capabilities
      sockets.push(socket)

      return socket as unknown as WebSocket
    }
  })

  const connect = async () => {
    const pending = gateway.connect('ws://gate')
    sockets[sockets.length - 1].open()
    await pending
    await flush()

    return sockets[sockets.length - 1]
  }

  const detach = attachServerRequests(gateway)

  return { connect, detach, gateway, socket: await connect(), sockets }
}

const request = (socket: FakeWebSocket, id: string, method: string, params: Frame = {}) =>
  socket.frame({ jsonrpc: '2.0', id, method, params: { session_id: 's1', ...params } })

beforeEach(() => resetServerRequestsForTest())
afterEach(() => vi.useRealTimers())

describe('server-request seam', () => {
  it('covers the 13 live server requests (D6)', () => {
    expect(Object.keys(SERVER_REQUEST_POLICY).sort()).toHaveLength(13)
    expect(
      Object.entries(SERVER_REQUEST_POLICY)
        .filter(([, p]) => p === 'declineOk')
        .map(([m]) => m)
    ).toEqual(['display.install.sudo', 'vault.code', 'vault.save_login', 'vault.unlock_prompt'])
  })

  it('advertises client.capabilities once per connected socket, after the handler is installed', async () => {
    const { connect, gateway, socket } = await setup()
    const caps = () => socket.sent.filter(f => f.method === 'client.capabilities')

    expect(caps()).toEqual([expect.objectContaining({ params: { server_requests: true } })])

    attachServerRequests(gateway) // idempotent: no second handler, no second advertise
    expect(caps()).toHaveLength(1)

    gateway.close()
    const next = await connect()
    expect(next.sent.filter(f => f.method === 'client.capabilities')).toHaveLength(1)
  })

  it('parks a handled request, answers it with the result shape, and ignores a late answer', async () => {
    const { socket } = await setup()
    request(socket, 'srq-a', 'clarify', { questions: [{ id: 'q1', question: 'Colour?' }] })

    expect($serverRequests.get()).toEqual([
      expect.objectContaining({ id: 'srq-a', method: 'clarify', protocol: 'request', sessionId: 's1' })
    ])

    await answerServerRequest('srq-a', { answers: { q1: 'blue' } })
    expect($serverRequests.get()).toEqual([])
    expect(socket.responses('srq-a')).toEqual([{ jsonrpc: '2.0', id: 'srq-a', result: { answers: { q1: 'blue' } } }])

    await answerServerRequest('srq-a', { answers: { q1: 'red' } })
    expect(socket.responses('srq-a')).toHaveLength(1)
  })

  it('declines declineOk methods and unknown methods at once (fail closed)', async () => {
    const { socket } = await setup()
    request(socket, 'srq-v', 'vault.code')
    request(socket, 'srq-u', 'iclone.unknown')

    expect($serverRequests.get()).toEqual([])
    expect(socket.responses('srq-v')[0].error.code).toBe(-32601)
    expect(socket.responses('srq-u')[0].error.code).toBe(-32601)
  })

  it('removes the entry on request.cancel and warns on a cancel for an unseen id', async () => {
    const { socket } = await setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    request(socket, 'srq-c', 'sudo')
    socket.event('request.cancel', { id: 'srq-c', method: 'sudo' })

    expect($serverRequests.get()).toEqual([])

    socket.event('request.cancel', { id: 'srq-never', method: 'clarify' })
    expect($unseenServerRequestCancels.get()).toEqual([
      expect.objectContaining({ id: 'srq-never', method: 'clarify', sessionId: 's1' })
    ])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('backstops at the runtime deadline + 30 s and drops the entry without answering the runtime', async () => {
    const { socket } = await setup()
    vi.useFakeTimers()
    request(socket, 'srq-a', 'approval')
    request(socket, 'srq-s', 'sudo')
    request(socket, 'srq-k', 'secret')
    request(socket, 'srq-q', 'clarify')

    vi.advanceTimersByTime(329_999)
    expect($serverRequests.get().map(r => r.id)).toEqual(['srq-a', 'srq-s', 'srq-k', 'srq-q'])

    vi.advanceTimersByTime(1)
    expect($serverRequests.get().map(r => r.id)).toEqual(['srq-q'])

    vi.advanceTimersByTime(3_299_999)
    expect($serverRequests.get().map(r => r.id)).toEqual(['srq-q'])
    vi.advanceTimersByTime(1)
    expect($serverRequests.get()).toEqual([])

    for (const id of ['srq-a', 'srq-s', 'srq-k', 'srq-q']) {
      expect(socket.responses(id)).toEqual([])
    }
  })

  it('puts an undelivered answer back with its original deadline re-armed', async () => {
    const { connect, gateway, socket } = await setup()
    vi.useFakeTimers()
    request(socket, 'srq-p', 'secret')
    vi.advanceTimersByTime(100_000)

    gateway.close()
    await expect(answerServerRequest('srq-p', { value: 'pw' })).rejects.toThrow('gateway not connected')
    expect($serverRequests.get().map(r => r.id)).toEqual(['srq-p'])

    vi.advanceTimersByTime(229_999)
    expect($serverRequests.get().map(r => r.id)).toEqual(['srq-p'])
    vi.advanceTimersByTime(1)
    expect($serverRequests.get()).toEqual([])

    vi.useRealTimers()
    await connect()
  })

  it('does not put back an undelivered answer the runtime withdrew meanwhile', async () => {
    const { socket } = await setup('legacy')
    socket.event('sudo.request', { request_id: 'legacy-w' })

    socket.send = function (data: string) {
      const frame = JSON.parse(data) as Frame
      this.sent.push(frame)
      queueMicrotask(() => {
        this.event('sudo.expire', { request_id: 'legacy-w' })
        this.frame({ jsonrpc: '2.0', id: frame.id, error: { code: 4009, message: 'no pending sudo request' } })
      })
    }

    await expect(answerServerRequest('legacy-w', { value: 'pw' })).rejects.toThrow()
    expect($serverRequests.get()).toEqual([])
  })

  it('replays open_requests through the same path, deduplicated by id', async () => {
    const { gateway, socket } = await setup()
    request(socket, 'srq-r', 'secret')

    replayOpenRequests(gateway, [
      { id: 'srq-r', method: 'secret', params: { session_id: 's1' } },
      { id: 'srq-n', method: 'clarify', params: { session_id: 's1' } }
    ])
    expect($serverRequests.get().map(r => r.id)).toEqual(['srq-r', 'srq-n'])

    await declineServerRequest('srq-n')
    replayOpenRequests(gateway, [{ id: 'srq-n', method: 'clarify', params: { session_id: 's1' } }])
    expect($serverRequests.get().map(r => r.id)).toEqual(['srq-r'])
  })

  it('answers window-owned bridges through the registered handler; bystander windows decline 4404', async () => {
    const { socket } = await setup()
    registerServerRequestHandler('terminal.read', async (_params, ctx) => {
      if (!ctx.showsSession) {
        throw Object.assign(new Error('not shown'), { code: 4404 })
      }

      return { value: 'text' }
    })

    request(socket, 'srq-t1', 'terminal.read')
    await flush()
    expect(socket.responses('srq-t1')).toEqual([{ jsonrpc: '2.0', id: 'srq-t1', result: { value: 'text' } }])

    setServerRequestSessionVisibility(sessionId => sessionId === 'other')
    request(socket, 'srq-t2', 'terminal.read')
    request(socket, 'srq-w', 'window.read')
    await flush()
    expect(socket.responses('srq-t2')[0].error.code).toBe(4404)
    expect(socket.responses('srq-w')[0].error.code).toBe(4404)
    expect($serverRequests.get()).toEqual([])
  })

  it('falls back to the legacy *.request / *.respond pair only when client.capabilities is -32601', async () => {
    const { socket } = await setup('legacy')
    socket.event('clarify.request', { choices: ['red'], question: 'Colour?', request_id: 'legacy-q' })
    socket.event('sudo.request', { request_id: 'legacy-s' })

    expect($serverRequests.get()).toEqual([
      expect.objectContaining({
        id: 'legacy-q',
        method: 'clarify',
        params: expect.objectContaining({ questions: [{ choices: ['red'], question: 'Colour?' }] }),
        protocol: 'legacy'
      }),
      expect.objectContaining({ id: 'legacy-s', method: 'sudo', protocol: 'legacy' })
    ])

    await answerServerRequest('legacy-q', { answers: { 0: 'blue' } })
    await answerServerRequest('legacy-s', { value: 'pw' })
    const respond = socket.sent.filter(f => /\.respond$/.test(f.method ?? ''))
    expect(respond.map(f => [f.method, f.params])).toEqual([
      ['clarify.respond', { answer: 'blue', request_id: 'legacy-q' }],
      ['sudo.respond', { password: 'pw', request_id: 'legacy-s' }]
    ])

    socket.event('clarify.request', { question: 'Again?', request_id: 'legacy-e' })
    socket.event('clarify.expire', { request_id: 'legacy-e' })
    expect($serverRequests.get()).toEqual([])
  })

  it('answers a legacy batch clarify with one clarify.respond per qid, and cancel-all without question_id', async () => {
    const { socket } = await setup('legacy')

    const questions = [
      { choices: [], qid: 'q0', question: 'Name?' },
      { choices: ['a', 'b'], qid: 'q1', question: 'Pick?' }
    ]

    socket.event('clarify.request', { questions, request_id: 'legacy-b' })
    socket.event('clarify.request', { questions, request_id: 'legacy-x' })

    await answerServerRequest('legacy-b', { answers: { q0: 'Ada', q1: null } })
    await answerServerRequest('legacy-x', {})
    const respond = socket.sent.filter(f => f.method === 'clarify.respond')
    expect(respond.map(f => f.params)).toEqual([
      { answer: 'Ada', question_id: 'q0', request_id: 'legacy-b' },
      { answer: '', question_id: 'q1', request_id: 'legacy-b' },
      { answer: '', request_id: 'legacy-x' }
    ])
  })

  it('parks a legacy mcp.setup request and answers it with mcp.setup.respond', async () => {
    const { socket } = await setup('legacy')
    socket.event('mcp.setup.request', { action: 'install', reason: 'docs', request_id: 'legacy-m', server: 'context7' })

    expect($serverRequests.get()).toEqual([
      expect.objectContaining({ id: 'legacy-m', method: 'mcp.setup', protocol: 'legacy' })
    ])

    const outcome = JSON.stringify({ server: 'context7', status: 'installed' })
    await answerServerRequest('legacy-m', { value: outcome })
    expect(socket.sent.filter(f => f.method === 'mcp.setup.respond').map(f => f.params)).toEqual([
      { request_id: 'legacy-m', result: outcome }
    ])
  })

  it('declines mcp.setup sent as a server request (not in the live policy)', async () => {
    const { socket } = await setup()
    request(socket, 'srq-m', 'mcp.setup')

    expect($serverRequests.get()).toEqual([])
    expect(socket.responses('srq-m')[0].error.code).toBe(-32601)
  })

  it('answers a routed (Bot Mode room) request: seam-held by frame, else request.answer or the legacy respond', async () => {
    const { socket } = await setup()
    request(socket, 'srq-h', 'clarify', { questions: [{ qid: 'q0', question: 'Name?' }] })
    const calls: Array<[string, Record<string, unknown>]> = []

    const route = async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params])

      return { status: params.id === 'srq-x' ? 'expired' : 'ok' }
    }

    const base = { method: 'clarify', protocol: 'request' as const, sessionId: 's1' }
    await expect(
      answerRoutedServerRequest({ ...base, id: 'srq-h', result: { answers: { q0: 'Ada' } } }, route)
    ).resolves.toEqual({ status: 'ok' })
    expect(socket.responses('srq-h')).toEqual([{ jsonrpc: '2.0', id: 'srq-h', result: { answers: { q0: 'Ada' } } }])

    await expect(
      answerRoutedServerRequest({ ...base, id: 'srq-h', result: { answers: { q0: 'late' } } }, route)
    ).resolves.toEqual({ status: 'expired' })
    await expect(
      answerRoutedServerRequest({ ...base, id: 'srq-o', result: { answers: { q0: 'Bob' } } }, route)
    ).resolves.toEqual({ status: 'ok' })
    await expect(
      answerRoutedServerRequest({ ...base, id: 'srq-x', result: { answers: { q0: 'gone' } } }, route)
    ).resolves.toEqual({ status: 'expired' })
    await answerRoutedServerRequest(
      { ...base, id: 'leg-b', protocol: 'legacy', result: { answers: { q0: 'x', q1: null } } },
      route
    )
    await answerRoutedServerRequest(
      { ...base, id: 'leg-a', method: 'approval', protocol: 'legacy', result: { choice: 'once' } },
      route
    )
    expect(calls).toEqual([
      ['request.answer', { id: 'srq-o', result: { answers: { q0: 'Bob' } } }],
      ['request.answer', { id: 'srq-x', result: { answers: { q0: 'gone' } } }],
      ['clarify.respond', { answer: 'x', question_id: 'q0', request_id: 'leg-b' }],
      ['clarify.respond', { answer: '', question_id: 'q1', request_id: 'leg-b' }],
      ['approval.respond', { choice: 'once', request_id: 'leg-a', session_id: 's1' }]
    ])
  })

  it('never subscribes to legacy events on a runtime that accepts the capability', async () => {
    const { socket } = await setup('ok')
    socket.event('clarify.request', { question: 'Colour?', request_id: 'legacy-q' })

    expect($serverRequests.get()).toEqual([])
  })

  it('detach stops routing to the seam', async () => {
    const { detach, socket } = await setup()
    detach()
    request(socket, 'srq-d', 'clarify')

    expect($serverRequests.get()).toEqual([])
    expect(socket.responses('srq-d')[0].error.code).toBe(-32601)
  })
})

describe('ServerRequestExpiredError', () => {
  it('carries a stable code, name, id and method a plain-JS plugin can branch on', () => {
    const err = new ServerRequestExpiredError('srq-x', 'clarify')

    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('expired')
    expect(err.name).toBe('ServerRequestExpiredError')
    expect([err.id, err.method]).toEqual(['srq-x', 'clarify'])
  })
})
