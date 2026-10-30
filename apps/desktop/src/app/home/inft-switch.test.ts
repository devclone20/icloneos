import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $gateway } from '@/store/gateway'
import { $activeSessionId, $gatewayState, $selectedStoredSessionId, $sessions } from '@/store/session'

import type { INftCardData } from './collections'

const ensurePersona = vi.fn<(...args: unknown[]) => Promise<string>>()

vi.mock('./inft-profile', () => ({
  ensurePersona: (...args: unknown[]) => ensurePersona(...args),
  holdSweep: () => () => undefined,
  sourceFromCard: (id: string, name: string, bootstrap: unknown) => {
    const [, contract, tokenId] = id.split(':')

    return { contract, tokenId, name, bootstrap }
  }
}))

// openSession lands the reopened chat on screen, as the router does; the
// runtime session binds at once (warm cache) unless a test delays it.
const binding = vi.hoisted(() => ({ delayMs: -1 }))

vi.mock('@/app/open-session', () => ({
  openSession: (storedId: string) => {
    $selectedStoredSessionId.set(storedId)

    if (binding.delayMs < 0) {
      $activeSessionId.set(`rt-${storedId}`)
    } else {
      $activeSessionId.set(null)
      setTimeout(() => $activeSessionId.set(`rt-${storedId}`), binding.delayMs)
    }
  }
}))

vi.mock('./stage-store', () => ({ clearInftChoice: vi.fn(), dismissInft: vi.fn(), summonInft: vi.fn() }))

const {
  $inftSwitch,
  APPLY_TIMEOUT_MS,
  friendlySelectError,
  RECONNECT_WAIT_MS,
  redactSwitchReason,
  resetInftSwitchForTests,
  safeErrorMessage,
  switchInft
} = await import('./inft-switch')

function card(token: string): INftCardData {
  return {
    id: `46630:0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631:${token}`,
    name: `iNFT #${token}`,
    bootstrap: { soul: 'x' }
  } as unknown as INftCardData
}

type Req = (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>

function fakeGateway(request: Req) {
  $gateway.set({ request } as never)
}

beforeEach(() => {
  resetInftSwitchForTests()
  ensurePersona.mockReset()
  ensurePersona.mockResolvedValue('soul')
  $gatewayState.set('open')
  $activeSessionId.set('rt-1')
  $selectedStoredSessionId.set(null)
  binding.delayMs = -1
  window.localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  $gateway.set(null as never)
  $sessions.set([])
})

const A6 = 'iclone.inft.lastSession.v2.inft-4dfb27-6'
const B7 = 'iclone.inft.lastSession.v2.inft-4dfb27-7'

describe('switchInft', () => {
  it('fails with a timeout reason when config.set never answers (bounded by the RPC timeout)', async () => {
    const seen: Array<number | undefined> = []

    fakeGateway((_m, _p, timeoutMs) => {
      seen.push(timeoutMs)

      return Promise.reject(new Error('Request timed out: config.set'))
    })

    const result = await switchInft(card('6'), { origin: 'pill' })

    expect(seen).toEqual([APPLY_TIMEOUT_MS])
    expect(result.personaApplied).toBe(false)
    expect(result.error).toMatch(/did not answer in time/)
    expect($inftSwitch.get().phase).toBe('failed')
  })

  it('latest wins: an earlier switch still resolving is dropped', async () => {
    const values: unknown[] = []
    let releaseFirst: (soul: string) => void = () => undefined

    ensurePersona.mockImplementationOnce(() => new Promise<string>(resolve => (releaseFirst = resolve)))
    fakeGateway((_m, params) => {
      values.push(params.value)

      return Promise.resolve({})
    })

    const first = switchInft(card('6'), { origin: 'pill' })
    const second = switchInft(card('7'), { origin: 'pill' })

    releaseFirst('soul')

    expect((await first).stale).toBe(true)
    expect((await second).personaApplied).toBe(true)
    expect(values).toEqual(['inft-4dfb27-7'])
  })

  it('a repeat click on the iNFT already switching joins it (one write)', async () => {
    const calls = vi.fn(() => Promise.resolve({}))

    fakeGateway(calls)

    const a = switchInft(card('6'), { origin: 'pill' })
    const b = switchInft(card('6'), { origin: 'pill' })

    expect(b).toBe(a)
    await a
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('no gateway → failed "still starting" immediately', async () => {
    const result = await switchInft(card('6'), { origin: 'pill' })

    expect(result.error).toMatch(/still starting/)
  })

  it('no active session → done with scope next-chat and no session_id on the wire', async () => {
    const params: Array<Record<string, unknown>> = []

    $activeSessionId.set(null)
    fakeGateway((_m, p) => {
      params.push(p)

      return Promise.resolve({})
    })

    const result = await switchInft(card('6'), { origin: 'pill' })

    expect(result.scope).toBe('next-chat')
    expect(params[0]).toEqual({ key: 'personality', value: 'inft-4dfb27-6' })
  })

  it('never writes the atoms that gate the composer', async () => {
    fakeGateway(() => Promise.resolve({}))

    const writes = vi.fn()
    const off = $gatewayState.listen(writes)

    await switchInft(card('6'), { origin: 'pill' })
    off()
    expect(writes).not.toHaveBeenCalled()
  })

  it('gateway reconnecting → waits and finishes by itself when it is open again', async () => {
    const calls = vi.fn(() => Promise.resolve({}))

    fakeGateway(calls)
    $gatewayState.set('connecting')

    const pending = switchInft(card('6'), { origin: 'pill' })

    await Promise.resolve()
    await Promise.resolve()
    expect($inftSwitch.get().phase).toBe('waiting')
    expect(calls).not.toHaveBeenCalled()
    $gatewayState.set('open')

    expect((await pending).personaApplied).toBe(true)
  })

  it('the sign-in restore never steals the stage from a manual pick', async () => {
    fakeGateway(() => Promise.resolve({}))
    await switchInft(card('6'), { origin: 'pill' })

    const restored = await switchInft(card('7'), { origin: 'restore' })

    expect(restored.stale).toBe(true)
  })

  it('remembers a chat born while the persona speaks, never an older one opened meanwhile', async () => {
    fakeGateway(() => Promise.resolve({}))
    $sessions.set([
      { id: 'old', started_at: 1 },
      { id: 'born', started_at: Date.now() / 1000 + 5 }
    ] as never)
    await switchInft(card('6'), { origin: 'pill' })
    $selectedStoredSessionId.set('old')

    expect(window.localStorage.getItem(A6)).toBeNull()

    $selectedStoredSessionId.set('born')

    expect(window.localStorage.getItem(A6)).toBe('born')
  })

  it('never sends a session_id: no pivot marker can reach a transcript, however fast the clicks', async () => {
    const calls: Array<Record<string, unknown>> = []

    fakeGateway((_method, params) => {
      calls.push(params)

      return Promise.resolve({})
    })
    $sessions.set([{ id: 'sA', started_at: 1 }] as never)
    $selectedStoredSessionId.set('sA')
    const navigate = vi.fn()

    const first = switchInft(card('7'), { origin: 'restore' })
    const second = switchInft(card('6'), { origin: 'pill', navigate })

    await Promise.all([first, second])

    expect(calls).toEqual([{ key: 'personality', value: 'inft-4dfb27-6' }])
    expect(calls.every(params => !('session_id' in params))).toBe(true)
  })

  it("a chat on screen that is not the target persona's is never adopted: a fresh draft opens", async () => {
    const navigate = vi.fn()

    fakeGateway(() => Promise.resolve({}))
    $sessions.set([{ id: 'sA', started_at: 1 }] as never)
    $selectedStoredSessionId.set('sA')

    const result = await switchInft(card('6'), { origin: 'pill', navigate })

    expect(result.scope).toBe('next-chat')
    expect(navigate).toHaveBeenCalledWith('/')
    expect(window.localStorage.getItem(A6)).toBeNull()
  })

  it("the target persona's own chat on screen stays: scope session, no navigation", async () => {
    const navigate = vi.fn()

    fakeGateway(() => Promise.resolve({}))
    $sessions.set([{ id: 'sB', started_at: 1 }] as never)
    window.localStorage.setItem(B7, 'sB')
    $selectedStoredSessionId.set('sB')

    const result = await switchInft(card('7'), { origin: 'pill', navigate })

    expect(result.scope).toBe('session')
    expect(navigate).not.toHaveBeenCalled()
  })

  it("reopens the persona's last chat only AFTER the personality is persisted (a cold resume reads it)", async () => {
    const selectedAtWrite: Array<string | null> = []

    fakeGateway((_method, params) => {
      selectedAtWrite.push($selectedStoredSessionId.get())
      expect(params).toEqual({ key: 'personality', value: 'inft-4dfb27-7' })

      return Promise.resolve({})
    })
    $sessions.set([
      { id: 'sA', started_at: 1 },
      { id: 'sB', started_at: 1 }
    ] as never)
    window.localStorage.setItem(B7, 'sB')
    $selectedStoredSessionId.set('sA')

    const result = await switchInft(card('7'), { origin: 'pill', navigate: vi.fn() })

    expect(result.scope).toBe('reopened')
    expect(selectedAtWrite).toEqual(['sA'])
    expect($selectedStoredSessionId.get()).toBe('sB')
    expect(window.localStorage.getItem(A6)).toBeNull()
  })

  it('a failed switch never reopens a chat and never records one', async () => {
    vi.useFakeTimers()
    const navigate = vi.fn()

    fakeGateway(() => Promise.resolve({}))
    $sessions.set([
      { id: 'sA', started_at: 1 },
      { id: 'sB', started_at: 1 }
    ] as never)
    window.localStorage.setItem(B7, 'sB')
    $selectedStoredSessionId.set('sA')
    $gatewayState.set('connecting')

    const pending = switchInft(card('7'), { origin: 'pill', navigate })

    await vi.advanceTimersByTimeAsync(RECONNECT_WAIT_MS + 10)
    const result = await pending

    expect(result.personaApplied).toBe(false)
    expect($selectedStoredSessionId.get()).toBe('sA')
    expect(navigate).not.toHaveBeenCalled()
    expect({ A: window.localStorage.getItem(A6), B: window.localStorage.getItem(B7) }).toEqual({ A: null, B: 'sB' })
  })

  it('maps "gateway is not connected" to a reconnecting message', () => {
    expect(friendlySelectError(new Error('Hermes gateway is not connected'))).toMatch(/reconnecting/)
  })

  it('an unmapped error never reaches the pill raw: fixed copy', () => {
    const err = new Error(`Error invoking remote method 'hermes:api-request': Error: HTTP 500 {"detail":"boom"}`)

    expect(friendlySelectError(err)).toBe('Switching failed — retry.')
    expect(friendlySelectError('weird')).toBe('Switching failed — retry.')
  })

  it('the switch log keeps the cause but strips the IPC wrapper and masks secrets, capped', () => {
    const secret = 'sk-ant-api03-SECRETSECRET0000'

    const reason = redactSwitchReason(
      new Error(
        `Error invoking remote method 'hermes:api-request': Error: HTTP 401 x-api-key: ${secret} Authorization: Bearer abc.def key=hunter2 ${'x'.repeat(400)}`
      )
    )

    expect(reason.startsWith('HTTP 401')).toBe(true)
    expect(reason).not.toMatch(/invoking remote method/i)
    expect(reason).not.toContain(secret)
    expect(reason).not.toContain('abc.def')
    expect(reason).not.toContain('hunter2')
    expect(reason.length).toBeLessThanOrEqual(161)
  })

  it('the switch log masks unlabelled secrets by shape and labels that end a longer name', () => {
    const secrets = [
      'ghp_A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvWx',
      'gho_Z9y8X7w6V5u4T3s2R1q0',
      'github_pat_11ABCDEFG0123456789_abcdefXYZ',
      'AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStU',
      'xoxb-1234567890-abcdefghij',
      'fw_3ZaBcDeFgHiJkLmNoPq',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123',
      'Q7rT2vX9kL4mN8pZ3sW6yB1cD5fG0hJq',
      'refreshvalue42',
      'clientvalue42'
    ]

    const corpus = [
      `Error: Incorrect API key provided: ${secrets[0]}. You can find your API key at https://example`,
      `GitHub said ${secrets[1]} and ${secrets[2]} are revoked`,
      `upstream said: API key not valid: ${secrets[3]}`,
      `slack ${secrets[4]} fireworks (${secrets[5]})`,
      `{"access_token":"${secrets[6]}"}`,
      `opaque ${secrets[7]} rejected`,
      `refresh_token=${secrets[8]}&client_secret: ${secrets[9]}`
    ]

    const lines = corpus.map(raw => redactSwitchReason(new Error(raw)))

    for (const secret of secrets) {
      for (const line of lines) {
        expect(line).not.toContain(secret.slice(4, 14))
      }
    }

    expect(lines[0]).toMatch(/^Incorrect API key provided: \*\*\*/)
    expect(lines[4]).toContain('access_token')
  })

  it('redaction leaves ordinary diagnostics readable', () => {
    expect(redactSwitchReason(new Error('HTTP 500 Unknown personality inft-6 (token #6)'))).toBe(
      'HTTP 500 Unknown personality inft-6 (token #6)'
    )
    expect(redactSwitchReason(new Error('gateway unavailable: still_starting_up_please_wait'))).toBe(
      'gateway unavailable: still_starting_up_please_wait'
    )
  })

  it('redaction masks Basic credentials, URL userinfo and base64 secrets with slashes (corpus 2)', () => {
    const corpus: [string, string][] = [
      ['Request failed: Authorization: Basic dXNlcjpodW50ZXIy', 'dXNlcjpodW50ZXIy'],
      ['proxy sent Basic dXNlcjpodW50ZXIy back', 'dXNlcjpodW50ZXIy'],
      ['fetch https://owner:hunter2pass@relay.example.com/v1 failed', 'hunter2pass'],
      ['AWS rejected secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
      ['upload signed with c2VjcmV0OnBhc3N3b3JkMTIzNDU2Nzg5MA== failed', 'c2VjcmV0OnBhc3N3b3JkMTIzNDU2Nzg5MA=='],
      ['groq said 401 for gsk_8fJ2kLq9ZxW3nV7mP1rT5yB6cD0eH4gA', 'gsk_8fJ2kLq9ZxW3nV7mP1rT5yB6cD0eH4gA']
    ]

    const lines = corpus.map(([raw]) => redactSwitchReason(new Error(raw)))

    corpus.forEach(([, secret], i) => expect(lines[i]).not.toContain(secret))
    expect(lines[0]).toBe('Request failed: Authorization: ***')
    expect(lines[1]).toBe('proxy sent Basic *** back')
    expect(lines[2]).toBe('fetch https://***@relay.example.com/v1 failed')
  })

  it('redaction masks escaped and percent-encoded labels, the token scheme and base64 led by a slash (corpus 3)', () => {
    const corpus: [string, string][] = [
      ['upstream 401: {"detail":"{\\"api_key\\":\\"Zq9w8e7r6t5y4u3\\"}"}', 'Zq9w8e7r6t5y4u3'],
      ['GET /v1/models?api_key%3DQm7xT2pL9vR4wK1s failed', 'Qm7xT2pL9vR4wK1s'], // gitleaks:allow
      ['GET /v1/models?%22token%22%3A%22Hn4kW8pR2tY6uI0o%22 failed', 'Hn4kW8pR2tY6uI0o'], // gitleaks:allow
      ['secret /xK7mDENG2bPxRfiCYq9Zw3Lm/TpQ8rS1vU4wYz== rejected', 'TpQ8rS1vU4wYz'],
      ['proxy echoed /K9mX2pL7vR4wT1sQ8nB3cZ6y/Hd5Fg2Jk rejected', 'Hd5Fg2Jk'],
      ['Authorization: token a1b2c3d4e5f6g7h8i9j0 rejected', 'a1b2c3d4e5f6g7h8i9j0']
    ]

    const lines = corpus.map(([raw]) => redactSwitchReason(new Error(raw)))

    corpus.forEach(([, secret], i) => expect(lines[i]).not.toContain(secret))
    expect(lines[0]).toBe('upstream 401: {"detail":"{"api_key":"***"}"}')
    expect(lines[1]).toBe('GET /v1/models?api_key=*** failed')
    expect(lines[3]).toBe('secret *** rejected')
    expect(lines[5]).toBe('Authorization: *** rejected')
  })

  it('redaction keeps short words, slash paths and URLs readable next to the corpus 3 rules', () => {
    const readable = [
      'GET /v1/agents/4dfb27/profile 404',
      'ENOENT: /Users/x/Library/Application Support/hermes/profiles/inft-4dfb27-12/soul.md',
      'GET https://relay.example.com/v1/agents/4dfb27/profile 404',
      'the token expired, sign in again',
      'monkey business in /usr/include/c2/bits/stdlib2'
    ]

    readable.forEach(line => expect(redactSwitchReason(new Error(line))).toBe(line))
    expect(redactSwitchReason(new Error('cache /var/aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW/blob'))).toBe('cache /var/***/blob')
  })

  it('redaction keeps ordinary paths and URLs readable', () => {
    const readable = [
      'ENOENT: no such file /Users/owner/.hermes/profiles/inft-6/config.yaml',
      'cannot read profiles/inft-12/personality/SOUL.md',
      'GET https://relay.example.com/v1/chat/completions returned 502',
      'basic configuration is missing for inft-6'
    ]

    readable.forEach(line => expect(redactSwitchReason(new Error(line))).toBe(line))
    expect(redactSwitchReason(new Error('read /tmp/aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW/x.json'))).toBe('read /tmp/***/x.json')
  })

  it('redaction masks nested escapes and encodings, mixed-case path segments and base64 with "+" (corpus 4)', () => {
    const corpus: [string, string][] = [
      [String.raw`relay 401: {"e":"{\\\"api_key\\\":\\\"Zq9w8e7r6t5y4u3\\\"}"}`, 'Zq9w8e7r6t5y4u3'],
      ['GET /v1/keys/Zq9W8e7R6t5Y4u3K/revoke 401', 'Zq9W8e7R6t5Y4u3K'],
      ['GET /k/Zq9W8e7R6t5Y4u3K 401', 'Zq9W8e7R6t5Y4u3K'],
      ['GET /v1/keys/Zq9W_8e7R6t5Y4u3K.json 401', 'Zq9W_8e7R6t5Y4u3K'],
      ['secret /xKmQwErTyUi/Tp8Q8rS1vU4wYzAbCdEfGh2jK3mN rejected', 'xKmQwErTyUi'],
      ['secret /AbCdEfGhIj/+Kl8Mn9Op0Qr1St2Uv3Wx4Yz5 rejected', 'AbCdEfGhIj'],
      ['GET /v1/models?api_key%253DQm7xT2pL9vR4wK1s failed', 'Qm7xT2pL9vR4wK1s'], // gitleaks:allow
      ['q=%252522token%252522%25253A%252522Hn4kW8pR2tY6uI0o%252522', 'Hn4kW8pR2tY6uI0o'], // gitleaks:allow
      ['Authorization: Token a1b2c3d4e5f6g7h8i9j0 rejected', 'a1b2c3d4e5f6g7h8i9j0']
    ]

    const lines = corpus.map(([raw]) => redactSwitchReason(new Error(raw)))

    corpus.forEach(([, secret], i) => expect(lines[i]).not.toContain(secret))
    expect(lines[1]).toBe('GET /v1/keys/***/revoke 401')
    expect(lines[4]).toBe('secret *** rejected')
    expect(lines[5]).toBe('secret *** rejected')
    expect(lines[6]).toBe('GET /v1/models?api_key=*** failed')
  })

  it('redaction keeps port-led and relative paths readable, lowercase ids and short standalone keys included', () => {
    const readable = [
      'POST http://localhost:9119/api/v1/sessions/abc123def456/messages 500',
      'GET http://127.0.0.1:9119/api/profiles/inft4dfb27x7/soul 404',
      'cannot read apps/desktop/src/app/home/v2/soul',
      'session 20261016_abc123def456 for inft-4dfb27-12 not found',
      'GET /v1/sessions/20261016_abc123def456/messages 404',
      'opaque id Zq9W8e7R6t5Y4u3K stays below the floor'
    ]

    readable.forEach(line => expect(redactSwitchReason(new Error(line))).toBe(line))
  })

  it('redaction decodes entities, unicode escapes and percent-encoding before masking, any auth scheme included (corpus 5)', () => {
    const corpus: [string, string][] = [
      ['Authorization: ApiKey Zq9W8e7R6t5Y4u3K rejected', 'Zq9W8e7R6t5Y4u3K'],
      ['Authorization: Key Zq9W8e7R6t5Y4u3K rejected', 'Zq9W8e7R6t5Y4u3K'],
      ['Proxy-Authorization: Digest Zq9W8e7R6t5Y4u3K rejected', 'Zq9W8e7R6t5Y4u3K'],
      ['relay 401: {&quot;api_key&quot;:&quot;Zq9w8e7r6t5y4u3&quot;}', 'Zq9w8e7r6t5y4u3'],
      ['relay 401: {&#34;token&#34;:&#x22;Hn4kW8pR2tY6uI0o&#34;}', 'Hn4kW8pR2tY6uI0o'],
      ['config {"api_key" => "Zq9w8e7r6t5y4u3"}', 'Zq9w8e7r6t5y4u3'], // gitleaks:allow
      ['GET /v1/models?api_key%20%3D%20Qm7xT2pL9vR4wK1s failed', 'Qm7xT2pL9vR4wK1s'], // gitleaks:allow
      [String.raw`{\\u0022api_key\\u0022:\\u0022Zq9w8e7r6t5y4u3\\u0022}`, 'Zq9w8e7r6t5y4u3'], // gitleaks:allow
      [String.raw`{\u0022api_key\u0022:\u0022Zq9w8e7r6t5y4u3\u0022}`, 'Zq9w8e7r6t5y4u3'], // gitleaks:allow
      ['signature Zq9W8e7R6t5Y%2F4u3K2j1H0g%2Bk9f8 rejected', 'Zq9W8e7R6t5Y'],
      ['secret /Kl8Mn9Op0Q/abcd/r1St2Uv3Wx4Yz5Ab rejected', 'Kl8Mn9Op0Q'],
      ['q=%25252522token%25252522%2525253A%25252522Hn4kW8pR2tY6uI0o%25252522', 'Hn4kW8pR2tY6uI0o'] // gitleaks:allow
    ]

    const lines = corpus.map(([raw]) => redactSwitchReason(new Error(raw)))

    corpus.forEach(([, secret], i) => expect(lines[i]).not.toContain(secret))
    expect(lines[0]).toBe('Authorization: *** rejected')
    expect(lines[3]).toBe('relay 401: {"api_key":"***"}')
    expect(lines[5]).toBe('config {"api_key" => "***"}')
    expect(lines[10]).toBe('secret /***/abcd/*** rejected')
    expect(redactSwitchReason(new Error('bad byte %07 and \\u0000 kept encoded'))).toBe(
      'bad byte %07 and \\u0000 kept encoded'
    )
  })

  it('redaction keeps model ids with sub-tokens, "+" and c++ paths readable (over-mask 5)', () => {
    const readable = [
      'model NousResearch/Hermes-4-405B not found',
      'model meta-llama/Llama-3.3-70B-Instruct not found',
      'GET /v1/models/Qwen/Qwen2.5-7B-Instruct 404',
      'cannot open /usr/include/c++/v1/vector',
      'unknown model claude-sonnet-4-5+thinking-20250929',
      'deadline 2026-10-16T06:37:24.123+00:00 passed',
      "ENOENT open '/Users/owner/.hermes/profiles/inft-4dfb27-12/SOUL.md'"
    ]

    readable.forEach(line => expect(redactSwitchReason(new Error(line))).toBe(line))
    expect(redactSwitchReason(new Error('id 550e8400-e29b-41d4-a716-446655440000 gone'))).toBe('id *** gone')
  })

  it('redaction is bounded on long hostile input and never shows a value cut by the cap', () => {
    for (const raw of ['a-'.repeat(50_000), 'Ab3-'.repeat(25_000), `key${'_k'.repeat(50_000)}`, 'x'.repeat(100_000)]) {
      const t0 = performance.now()
      const line = redactSwitchReason(new Error(raw))

      expect(performance.now() - t0).toBeLessThan(100)
      expect(line.length).toBeLessThanOrEqual(161)
    }

    const padded = `${' '.repeat(4090)}Zq9W8e7R6t5Y4u3KxLm2`

    expect(redactSwitchReason(new Error(padded))).not.toContain('Zq9W8e')

    // No whitespace at all: ten opaque runs shrink to '***', so the 8 characters
    // of the key left by the cap would land inside the 160-character line.
    const filler = `${Array.from({ length: 10 }, () => `${'Ab3'.repeat(133)}9`).join(',')},${'.'.repeat(77)},`
    const unspaced = redactSwitchReason(new Error(`${filler}Zq9W8e7R6t5Y4u3K2j1H0g9f8e7d6c`))

    expect(filler.length).toBe(4088)
    expect(unspaced).not.toContain('Zq9W8e')
    expect(unspaced.endsWith(',')).toBe(true)
  })

  it('describing a hostile error never throws: the pill copy and the log stay fixed', () => {
    const bare = Object.create(null) as object

    const hostile = {
      toString() {
        throw new Error('toString exploded')
      }
    }

    expect(safeErrorMessage(bare)).toBe('unknown error')
    expect(safeErrorMessage(hostile)).toBe('unknown error')
    expect(safeErrorMessage(new Error('plain'))).toBe('plain')

    for (const err of [bare, hostile, null, undefined, { message: 'weird object' }]) {
      expect(friendlySelectError(err)).toBe('Switching failed — retry.')
      expect(() => redactSwitchReason(err)).not.toThrow()
    }
  })

  it('friendlySelectError is total: a Proxy whose traps throw and a throwing message getter get the fixed copy', () => {
    const trap = () => {
      throw new Error('trap')
    }

    const proxy = new Proxy({}, { getPrototypeOf: trap, get: trap })
    const getter = Object.defineProperty(new Error('x'), 'message', { get: trap })

    for (const err of [proxy, getter, Symbol('s'), 10n, { toString: () => 42 }]) {
      expect(friendlySelectError(err)).toBe('Switching failed — retry.')
      expect(typeof redactSwitchReason(err)).toBe('string')
    }
  })

  it('a switch that rejects with a hostile Proxy still ends in failed with the fixed copy', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const trap = () => {
      throw new Error('trap')
    }

    ensurePersona.mockRejectedValue(new Proxy({}, { getPrototypeOf: trap, get: trap }))

    const result = await switchInft(card('6'), { origin: 'pill' })

    expect(result.personaApplied).toBe(false)
    expect($inftSwitch.get()).toMatchObject({ phase: 'failed', reason: 'Switching failed — retry.' })
    spy.mockRestore()
  })

  it('a switch that rejects with a non-stringifiable error still fails and leaves resolving', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    ensurePersona.mockRejectedValue(Object.create(null))

    const result = await switchInft(card('6'), { origin: 'pill' })

    expect(result.personaApplied).toBe(false)
    expect($inftSwitch.get()).toMatchObject({ phase: 'failed', reason: 'Switching failed — retry.' })
    spy.mockRestore()
  })

  it('a failed switch logs the redacted cause and shows only the fixed copy', async () => {
    const secret = 'sk-ant-api03-LOGPROBE00000000'
    const lines: string[] = []

    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')))

    ensurePersona.mockRejectedValue(
      new Error(`Error invoking remote method 'hermes:api-request': Error: HTTP 500 {"detail":"x-api-key: ${secret}"}`)
    )

    await switchInft(card('6'), { origin: 'pill' })

    expect($inftSwitch.get()).toMatchObject({ phase: 'failed', reason: 'Switching failed — retry.' })
    expect(lines.join('\n')).toMatch(/\[inft-switch\] .* failed \d+ HTTP 500/)
    expect(lines.join('\n')).not.toContain(secret)
    expect(lines.join('\n')).not.toMatch(/invoking remote method/i)
    spy.mockRestore()
  })
})
