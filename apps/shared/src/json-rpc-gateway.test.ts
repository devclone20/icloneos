import { describe, expect, it } from 'vitest'

import { type GatewayServerRequest, JSON_RPC_METHOD_NOT_FOUND, JsonRpcGatewayClient } from './json-rpc-gateway'

class FakeWebSocket extends EventTarget {
  static OPEN = 1

  readyState = 0
  sent: Record<string, unknown>[] = []

  send(data: string): void {
    this.sent.push(JSON.parse(data))
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
}

async function connected() {
  const sockets: FakeWebSocket[] = []

  const client = new JsonRpcGatewayClient({
    connectTimeoutMs: 1000,
    heartbeatDeadlineMs: 0,
    heartbeatIntervalMs: 0,
    socketFactory: () => {
      const socket = new FakeWebSocket()
      sockets.push(socket)

      return socket as unknown as WebSocket
    }
  })

  const reconnect = async () => {
    const pending = client.connect('ws://gate')
    sockets[sockets.length - 1].open()
    await pending

    return sockets[sockets.length - 1]
  }

  return { client, reconnect, socket: await reconnect(), sockets }
}

describe('JsonRpcGatewayClient server→client requests', () => {
  it('routes a frame with method AND id to the server-request handler before the pending lookup', async () => {
    const { client, socket } = await connected()
    const seen: GatewayServerRequest[] = []
    client.onServerRequest(request => seen.push(request))

    // A pending call whose id equals the request id: the request must still win.
    const call = client.request('ping', {})
    const callId = socket.sent[0].id
    socket.frame({ jsonrpc: '2.0', id: callId, method: 'clarify', params: { session_id: 's1' } })

    expect(seen).toEqual([{ id: callId, method: 'clarify', params: { session_id: 's1' }, replayed: false }])

    socket.frame({ jsonrpc: '2.0', id: callId, result: { pong: true } })
    await expect(call).resolves.toEqual({ pong: true })
  })

  it('answers -32601 when no handler is installed (fail closed)', async () => {
    const { socket } = await connected()

    socket.frame({ jsonrpc: '2.0', id: 'srq-1', method: 'clarify', params: {} })

    // The pin's channel answers (V3-UP r3): its wording, the same code.
    expect(socket.sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 'srq-1',
        error: { code: JSON_RPC_METHOD_NOT_FOUND, message: 'no handler for server request: clarify' }
      }
    ])
  })

  it('writes a response frame with respond() and refuses when closed', async () => {
    const { client, socket } = await connected()

    expect(client.respond('srq-2', { result: { value: 'x' } })).toBe(true)
    expect(socket.sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 'srq-2', result: { value: 'x' } })

    client.close()
    expect(client.respond('srq-3', { result: {} })).toBe(false)
  })

  it('fires the open hook once per opened socket, and at once when already open', async () => {
    const { client, reconnect } = await connected()
    let opens = 0
    client.onOpen(() => opens++)
    expect(opens).toBe(1)

    client.close()
    await reconnect()
    expect(opens).toBe(2)
  })

  it('re-delivers open_requests as replayed requests and skips malformed entries', async () => {
    const { client } = await connected()
    const seen: GatewayServerRequest[] = []
    client.onServerRequest(request => seen.push(request))

    client.replayServerRequests([{ id: 'srq-9', method: 'sudo', params: { session_id: 's1' } }, { id: 'srq-10' }, null])

    expect(seen).toEqual([{ id: 'srq-9', method: 'sudo', params: { session_id: 's1' }, replayed: true }])
  })

  it('keeps event frames on the event path', async () => {
    const { client, socket } = await connected()
    const requests: GatewayServerRequest[] = []
    const events: string[] = []
    client.onServerRequest(request => requests.push(request))
    client.onEvent(event => events.push(event.type))

    socket.frame({ jsonrpc: '2.0', method: 'event', params: { type: 'request.cancel', payload: { id: 'srq-1' } } })

    expect(requests).toEqual([])
    expect(events).toEqual(['request.cancel'])
  })
})

describe('JsonRpcGatewayClient replay option (1ac3f97, V3-UP r2)', () => {
  async function reconnectedAfterSeq(replay: boolean | undefined) {
    const sockets: FakeWebSocket[] = []

    const client = new JsonRpcGatewayClient({
      connectTimeoutMs: 1000,
      heartbeatDeadlineMs: 0,
      heartbeatIntervalMs: 0,
      ...(replay === undefined ? {} : { replay }),
      socketFactory: () => {
        const socket = new FakeWebSocket()
        sockets.push(socket)

        return socket as unknown as WebSocket
      }
    })

    const open = async () => {
      const pending = client.connect('ws://gate')
      sockets[sockets.length - 1].open()
      await pending

      return sockets[sockets.length - 1]
    }

    const first = await open()
    first.frame({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: 's1', seq: 5 } })
    expect(client.getSeqWatermarks()).toEqual({ s1: 5 })
    client.invalidate('drop')
    const second = await open()
    await new Promise(resolve => setTimeout(resolve, 0))

    return second.sent.filter(frame => frame.method === 'session.events.since')
  }

  it('fetches the missed events after a reconnect by default', async () => {
    expect(await reconnectedAfterSeq(undefined)).toHaveLength(1)
  })

  it('never asks a notification-only feed to replay (replay: false)', async () => {
    expect(await reconnectedAfterSeq(false)).toHaveLength(0)
  })
})
