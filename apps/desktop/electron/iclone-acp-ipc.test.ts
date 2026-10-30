import { mkdtempSync, rmSync, statSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { agentPolicy, lineRedactor, parseAgentRequest, redactSecrets, startAcpSocketServer } from './iclone-acp-ipc'

describe('agentPolicy — what the agent may run', () => {
  it('admits the commands the skills teach, as given', () => {
    for (const argv of [
      ['job', 'list', '--json'],
      ['agent', 'whoami', '--json'],
      ['browse', 'pizza', '--top-k', '5'],
      ['configure'],
      ['email', 'search', '--query', 'otp\nline two'],
      ['--version']
    ]) {
      expect(agentPolicy(argv)).toMatchObject({ ok: true, argv, redactCard: false, streaming: false })
    }

    expect(agentPolicy(['events', 'listen'])).toMatchObject({ ok: true, streaming: true })
  })

  it('admits the provider root, the trade root with flags and register-erc8004 (R15a door finding)', () => {
    for (const argv of [
      ['provider', 'set-budget', '--job-id', '1', '--amount', '5'],
      ['provider', 'set-budget-with-fund-request', '--job-id', '1', '--amount', '5'],
      ['provider', 'submit', '--job-id', '1', '--deliverable', 'x'],
      ['trade', '--swap', '--from', 'USDC', '--to', 'ETH', '--amount', '1'],
      ['trade', '--hl-deposit', '--amount', '10'],
      ['trade', 'stock-list', 'AAPL'],
      ['agent', 'register-erc8004', '--json']
    ]) {
      expect(agentPolicy(argv)).toMatchObject({ ok: true, argv })
    }

    // The provider subcommands no longer hide under client.
    expect(agentPolicy(['client', 'provider']).ok).toBe(false)
    expect(agentPolicy(['client', 'set-budget']).ok).toBe(false)
    expect(agentPolicy(['agent', 'register-erc']).ok).toBe(false)
  })

  it('refuses the `sol` root: the pinned CLI has no such command (its Solana verbs live under `wallet`)', () => {
    for (const sub of ['address', 'balance', 'sign-message', 'transfer', 'send-instructions']) {
      expect(agentPolicy(['sol', sub])).toMatchObject({ ok: false })
    }
  })

  it('marks value-moving commands and lets --dry-run and reads through', () => {
    const moving = [
      ['trade', '--swap', '--from', 'USDC', '--to', 'ETH', '--amount', '1'],
      ['trade', 'withdraw-from-hl', '--amount', '1'],
      ['client', 'fund', '--job-id', '1'],
      ['client', 'create-job', '--offering', 'o1'],
      ['provider', 'set-budget-with-fund-request', '--job-id', '1', '--amount', '5'],
      ['wallet', 'send-transaction', '--to', '0x1', '--value', '1'],
      ['wallet', 'topup', '--method', 'card']
    ]

    for (const argv of moving) {
      expect(agentPolicy(argv)).toMatchObject({ ok: true, valueMoving: true })
    }

    for (const argv of [
      ['trade', '--swap', '--from', 'USDC', '--to', 'ETH', '--amount', '1', '--dry-run'],
      ['trade', 'stock-list'],
      ['trade', 'hl-status'],
      ['trade', 'hl-orders'],
      ['provider', 'set-budget', '--job-id', '1', '--amount', '5'],
      ['provider', 'submit', '--job-id', '1', '--deliverable', 'x'],
      ['client', 'complete', '--job-id', '1'],
      ['wallet', 'balance'],
      ['job', 'list']
    ]) {
      expect(agentPolicy(argv)).toMatchObject({ ok: true, valueMoving: false })
    }
  })

  it('V3-I F2 (A): every money-moving form is spend — by verb, by name and by flag, with or without =value', () => {
    for (const argv of [
      [
        'provider',
        'submit',
        '--job-id',
        'X',
        '--deliverable',
        'y',
        '--transfer-amount',
        '500',
        '--transfer-token',
        'USDC'
      ],
      ['provider', 'submit', '--job-id', 'X', '--transfer-amount=500'],
      ['provider', 'submit', '--job-id', 'X', '--transfer-token=0xUSDC'],
      ['provider', 'set-budget-with-fund-request', '--job-id', '1', '--amount', '5'],
      ['client', 'fund', '--job-id', '1'],
      ['client', 'create-job', '--offering', 'o1'],
      ['client', 'create-custom-job', '--provider', 'p'],
      ['client', 'complete', '--job-id', '1', '--pay', '5'],
      ['client', 'review', '--job-id', '1', '--hire-amount', '5'],
      ['compute', 'top-up', '--amount', '5'],
      ['wallet', 'topup', '--method', 'card'],
      ['wallet', 'send-transaction', '--to', '0x1', '--value', '1'],
      ['wallet', 'sign-typed-data', '--value=1'],
      ['trade', 'withdraw-from-hl', '--amount', '1'],
      ['trade', 'hl-status', '--transfer-amount', '1']
    ]) {
      expect(agentPolicy(argv), argv.join(' ')).toMatchObject({ ok: true, valueMoving: true })
    }
  })

  it('V3-I F2 (B): --dry-run counts only as the unambiguous last flag; the critic’s placements all run the money check', () => {
    for (const argv of [
      ['client', 'fund', '--job-id', '1', '--memo', '--dry-run'],
      ['client', 'create-job', '--offering', 'o1', '--requirements', '--dry-run'],
      ['client', 'fund', '--dry-run', '--job-id', '1'],
      ['client', 'fund', '--job-id', '1', '--dry-run=true'],
      ['provider', 'submit', '--transfer-amount', '500', '--dry-run', '--job-id', 'X'],
      ['wallet', 'send-transaction', '--to', '0x1', '--value', '--dry-run']
    ]) {
      expect(agentPolicy(argv), argv.join(' ')).toMatchObject({ ok: true, valueMoving: true })
    }

    expect(agentPolicy(['client', 'fund', '--job-id', '1', '--', '--dry-run'])).toMatchObject({ ok: false })
    expect(agentPolicy(['job', 'list', '--', 'x'])).toMatchObject({ ok: false })
    expect(agentPolicy(['client', 'fund', '--job-id', '1', '--dry-run'])).toMatchObject({
      ok: true,
      valueMoving: false
    })
    expect(agentPolicy(['client', 'fund', '--job-id', '1', '--json', '--dry-run'])).toMatchObject({
      valueMoving: false
    })
  })

  it('refuses card issue in every position and forces card answers through redacted JSON', () => {
    for (const argv of [
      ['card', 'issue'],
      ['card', '--json', 'issue'],
      ['card', 'list', 'issue']
    ]) {
      expect(agentPolicy(argv)).toMatchObject({ ok: false, error: expect.stringMatching(/card issue/) })
    }

    expect(agentPolicy(['card', 'get', 'c1'])).toMatchObject({
      ok: true,
      argv: ['card', 'get', 'c1', '--json'],
      redactCard: true,
      streaming: false
    })
  })

  it('refuses unknown commands, flags before the subcommand and malformed argv', () => {
    for (const argv of [
      [],
      ['node'],
      ['agent', '--json', 'whoami'],
      ['wallet', 'export'],
      [7],
      ['job', 'list\0'],
      'job'
    ]) {
      expect(agentPolicy(argv).ok).toBe(false)
    }
  })
})

describe('redaction', () => {
  it('scrubs JWTs, bearer tokens, PEM keys and secret-named fields, keeps hashes and addresses', () => {
    // A fake JWT ({"alg":"HS256"}.{"sub":"12345"}."signature-sig"), assembled so secret scanners do not flag it.
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NSJ9', 'c2lnbmF0dXJlLXNpZw'].join('.')
    const hash = `0x${'ab'.repeat(32)}`

    const text = [
      `token ${jwt}`,
      'Authorization: Bearer abcdefghijklmnop1234',
      '{"privateKey":"0xdead","walletAddress":"0x1234","txHash":"' + hash + '"}',
      'access_token=supersecretvalue1',
      '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----'
    ].join('\n')

    const out = redactSecrets(text)

    expect(out).not.toContain(jwt)
    expect(out).not.toContain('abcdefghijklmnop1234')
    expect(out).not.toContain('0xdead')
    expect(out).not.toContain('supersecretvalue1')
    expect(out).not.toContain('MIIB')
    expect(out).toContain('"walletAddress":"0x1234"')
    expect(out).toContain(hash)
  })

  it('scrubs a secret split across stream chunks', () => {
    let written = ''
    const stream = lineRedactor(text => (written += text))

    stream.push('{"apiKey":"abc')
    stream.push('def"}\nnext')
    stream.end()

    expect(written).toBe('{"apiKey":"[redacted]"}\nnext')
  })
})

describe('parseAgentRequest', () => {
  const token = 'a'.repeat(64)

  it('reads a well-formed request and rejects anything else', () => {
    expect(parseAgentRequest(JSON.stringify({ v: 1, token, inft: ' 6 ', argv: ['job', 'list'] }))).toEqual({
      token,
      inft: '6',
      argv: ['job', 'list']
    })
    expect(parseAgentRequest(JSON.stringify({ v: 2, token, argv: [] }))).toBeNull()
    expect(parseAgentRequest(JSON.stringify({ v: 1, token: 'short', argv: [] }))).toBeNull()
    expect(parseAgentRequest('not json')).toBeNull()
  })
})

describe('startAcpSocketServer', () => {
  const dirs: string[] = []

  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const ask = (socketPath: string, request: unknown) =>
    new Promise<{ frames: { t: string; d?: string; c?: number }[] }>((resolve, reject) => {
      const socket = net.createConnection(socketPath)
      let data = ''

      socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
      socket.on('data', chunk => (data += String(chunk)))
      socket.on('error', reject)
      socket.on('close', () =>
        resolve({
          frames: data
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line) as { t: string })
        })
      )
    })

  it('is private, demands the launch token, and redacts card answers', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'iclone-ipc-'))

    dirs.push(home)

    const runs: string[][] = []
    const dir = path.join(home, 'run')

    const server = await startAcpSocketServer({
      admitStreaming: () => true,
      dir,
      resolveInft: () => ({ ok: true, slug: 'inft-6' }),
      run: (_slug, argv, _streaming, sink) => {
        runs.push(argv)
        sink.stdout('{"cards":[{"id":"c1","pan":"4111111111111111","cvv":"123"}]}')

        return Promise.resolve({ code: 0 })
      },
      log: () => undefined
    })

    try {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(server.socketPath).mode & 0o777).toBe(0o600)
      expect(statSync(path.join(dir, 'acp.token')).mode & 0o777).toBe(0o600)

      const stale = await ask(server.socketPath, { v: 1, token: 'f'.repeat(64), inft: '6', argv: ['card', 'list'] })

      expect(stale.frames.at(-1)).toEqual({ t: 'x', c: 3 })
      expect(runs).toHaveLength(0)

      const { readFileSync } = await import('node:fs')
      const token = readFileSync(path.join(dir, 'acp.token'), 'utf8').trim()
      const ok = await ask(server.socketPath, { v: 1, token, inft: '6', argv: ['card', 'list'] })

      const stdout = ok.frames
        .filter(frame => frame.t === 'o')
        .map(frame => frame.d)
        .join('')

      expect(runs).toEqual([['card', 'list', '--json']])
      expect(stdout).toBe('{"cards":[{"id":"c1"}]}\n')
      expect(ok.frames.at(-1)).toEqual({ t: 'x', c: 0 })
    } finally {
      server.close()
    }
  })

  it('K29: a streaming reader starts only when WORK admits it; a one-shot read is not gated', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'iclone-ipc-k29-'))

    dirs.push(home)

    const runs: string[][] = []
    const asked: string[] = []
    let admit = false
    const dir = path.join(home, 'run')

    const server = await startAcpSocketServer({
      dir,
      resolveInft: () => ({ ok: true, slug: 'inft-6' }),
      admitStreaming: slug => {
        asked.push(slug)

        return admit
      },
      run: (_slug, argv) => {
        runs.push(argv)

        return Promise.resolve({ code: 0 })
      },
      log: () => undefined
    })

    try {
      const { readFileSync } = await import('node:fs')
      const token = readFileSync(path.join(dir, 'acp.token'), 'utf8').trim()

      const held = await ask(server.socketPath, { v: 1, token, inft: '6', argv: ['events', 'listen'] })

      expect(held.frames.at(-1)).toEqual({ t: 'x', c: 75 })
      expect(held.frames.some(frame => frame.d?.includes('WORK tab holds'))).toBe(true)
      expect(runs).toEqual([])
      expect(asked).toEqual(['inft-6'])

      const read = await ask(server.socketPath, { v: 1, token, inft: '6', argv: ['job', 'list'] })

      expect(read.frames.at(-1)).toEqual({ t: 'x', c: 0 })
      expect(asked).toEqual(['inft-6'])

      admit = true

      const free = await ask(server.socketPath, { v: 1, token, inft: '6', argv: ['events', 'listen'] })

      expect(free.frames.at(-1)).toEqual({ t: 'x', c: 0 })
      expect(runs.map(argv => argv.slice(0, 2))).toEqual([
        ['job', 'list'],
        ['events', 'listen']
      ])
    } finally {
      server.close()
    }
  })
})
