import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildAllProfileSpecs } from '../iclone-confinement/profiles'
import { globToSbplRegex, renderSbpl } from '../iclone-confinement/sbpl'

import type { PaymentAuditEntry, PayResult, X402Client } from './client'
import {
  parsePayRequest,
  type PaySocketServer,
  paySpawn,
  payTokenFile,
  type ProfileBinding,
  setActivePaySocket,
  startPaySocketServer
} from './ipc'

interface Answer {
  code: number | null
  stdout: string
  stderr: string
}

function ask(socketPath: string, line: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    let buffered = ''

    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('data', chunk => (buffered += chunk))
    socket.on('close', () => {
      const answer: Answer = { code: null, stdout: '', stderr: '' }

      for (const raw of buffered.split('\n').filter(Boolean)) {
        const frame = JSON.parse(raw) as { t: string; d?: string; c?: number }

        if (frame.t === 'o') {
          answer.stdout += frame.d ?? ''
        } else if (frame.t === 'e') {
          answer.stderr += frame.d ?? ''
        } else if (frame.t === 'x') {
          answer.code = frame.c ?? null
        }
      }

      resolve(answer)
    })
    socket.write(line)
  })
}

// The folder every profile of these rigs runs in (a `dev:ino`): the x402-pay client sends its own with each request.
const HOME = '16777220:4242'
const OTHER_HOME = '16777220:4343'

const request = (token: string, argv: unknown[], extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ v: 1, token, home: HOME, argv, ...extra })}\n`

const tokenOf = (env: Record<string, string>) => fs.readFileSync(env.ICLONE_PAY_TOKEN_FILE, 'utf8').trim()

interface Rig {
  dir: string
  server: PaySocketServer
  audit: PaymentAuditEntry[]
  calls: { agent: string; url: string }[]
  release: () => void
}

const rigs: Rig[] = []

async function rig(
  options: { hang?: boolean; client?: boolean; bindProfile?: (slug: string) => ProfileBinding } = {}
): Promise<Rig> {
  // A short base: macOS sun_path is 104 bytes.
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v3jw-')), 'run')
  const audit: PaymentAuditEntry[] = []
  const calls: { agent: string; url: string }[] = []
  const waiting: (() => void)[] = []

  const client: X402Client = {
    pay: async req => {
      calls.push({ agent: req.agent, url: req.url })

      if (options.hang) {
        await new Promise<void>(resolve => waiting.push(resolve))
      }

      return { kind: 'refused', reason: 'no_mandate', detail: 'test' } satisfies PayResult
    },
    send: async () => ({ kind: 'refused', reason: 'no_mandate', detail: 'test' }) satisfies PayResult
  }

  const server = await startPaySocketServer({
    dir,
    verb: () => ({
      client: options.client === false ? null : client,
      audit: { record: entry => audit.push(entry) },
      stop: () => true
    }),
    audit: { record: entry => audit.push(entry) },
    log: () => undefined,
    bindProfile: options.bindProfile ?? (() => ({ home: HOME }))
  })

  const made: Rig = { dir, server, audit, calls, release: () => waiting.splice(0).forEach(resolve => resolve()) }

  rigs.push(made)

  return made
}

afterEach(() => {
  for (const made of rigs.splice(0)) {
    made.release()
    made.server.close()
    fs.rmSync(path.dirname(made.dir), { recursive: true, force: true })
  }

  setActivePaySocket(null)
})

describe('wire-socket: the pay socket, a token per spawn', () => {
  it('wire-socket: the dir is 0700, the socket and each token file 0600; env names the file, never the token', async () => {
    const { dir, server } = await rig()
    const minted = server.mint('agent-a')
    const token = tokenOf(minted.env)

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(server.socketPath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(minted.env.ICLONE_PAY_TOKEN_FILE).mode & 0o777).toBe(0o600)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.keys(minted.env).sort()).toEqual(['ICLONE_PAY_HOME', 'ICLONE_PAY_SOCKET', 'ICLONE_PAY_TOKEN_FILE'])
    expect(minted.env.ICLONE_PAY_HOME).toBe(HOME)
    expect(JSON.stringify(minted.env)).not.toContain(token)
    expect(minted.env.ICLONE_PAY_SOCKET).toBe(server.socketPath)
  })

  it('wire-socket: the verb runs as the slug the token was minted for; a request cannot name another agent', async () => {
    const { server, calls, audit } = await rig()
    const a = tokenOf(server.mint('agent-a').env)
    const b = tokenOf(server.mint('agent-b').env)

    const first = await ask(server.socketPath, request(a, ['pay', 'http://127.0.0.1:9/paid'], { agent: 'agent-b' }))
    const second = await ask(server.socketPath, request(b, ['pay', 'http://127.0.0.1:9/paid']))
    const flag = await ask(server.socketPath, request(a, ['pay', 'http://127.0.0.1:9/paid', '--agent', 'agent-b']))

    expect(first.code).toBe(1)
    expect(JSON.parse(first.stdout)).toMatchObject({ kind: 'refused', reason: 'no_mandate' })
    expect(second.code).toBe(1)
    expect(flag.code).toBe(64)
    expect(calls.map(call => call.agent)).toEqual(['agent-a', 'agent-b'])
    expect(audit).toContainEqual({ kind: 'refuse', reason: 'usage', agent: 'agent-a' })
  })

  it('wire-socket: no token, a stale token or a malformed line is refused before the verb, and audited', async () => {
    const { server, calls, audit } = await rig()

    server.mint('agent-a')

    const stranger = await ask(server.socketPath, request('f'.repeat(64), ['pay', 'http://127.0.0.1:9/x']))
    const none = await ask(server.socketPath, `${JSON.stringify({ v: 1, argv: ['pay', 'http://127.0.0.1:9/x'] })}\n`)
    const junk = await ask(server.socketPath, 'not json\n')

    expect([stranger.code, none.code, junk.code]).toEqual([3, 64, 64])
    expect(calls).toEqual([])
    expect(audit).toEqual([
      { kind: 'refuse', reason: 'socket token', agent: '' },
      { kind: 'refuse', reason: 'socket malformed', agent: '' },
      { kind: 'refuse', reason: 'socket malformed', agent: '' }
    ])
  })

  it('wire-socket: the token dies with its spawn (exit ⇒ refused, file removed) and with the server', async () => {
    const { server, calls } = await rig()
    const minted = server.mint('agent-a')
    const token = tokenOf(minted.env)
    const child = new EventEmitter()

    minted.attach(child as unknown as Parameters<typeof minted.attach>[0])

    expect((await ask(server.socketPath, request(token, ['pay', 'http://127.0.0.1:9/x']))).code).toBe(1)

    child.emit('exit')

    expect(fs.existsSync(minted.env.ICLONE_PAY_TOKEN_FILE)).toBe(false)
    expect(server.liveTokens()).toBe(0)
    expect((await ask(server.socketPath, request(token, ['pay', 'http://127.0.0.1:9/x']))).code).toBe(3)
    expect(calls).toHaveLength(1)

    const other = server.mint('agent-b')

    server.close()
    expect(fs.existsSync(other.env.ICLONE_PAY_TOKEN_FILE)).toBe(false)
    expect(fs.existsSync(server.socketPath)).toBe(false)
  })

  it('wire-socket: one token holds at most 4 requests in flight; the fifth is refused busy and audited', async () => {
    const { server, audit, calls, release } = await rig({ hang: true })
    const token = tokenOf(server.mint('agent-a').env)
    const pending = Array.from({ length: 4 }, () => ask(server.socketPath, request(token, ['pay', 'http://h/x'])))

    await expect.poll(() => calls.length).toBe(4)

    const fifth = await ask(server.socketPath, request(token, ['pay', 'http://h/x']))

    expect(fifth.code).toBe(75)
    expect(audit).toContainEqual({ kind: 'refuse', reason: 'socket busy', agent: 'agent-a' })
    release()
    expect((await Promise.all(pending)).map(answer => answer.code)).toEqual([1, 1, 1, 1])
  })

  it('wire-socket: payments not started answers 3 through the verb; stop is served', async () => {
    const { server } = await rig({ client: false })
    const token = tokenOf(server.mint('agent-a').env)

    expect((await ask(server.socketPath, request(token, ['pay', 'http://h/x']))).code).toBe(3)
    expect(JSON.parse((await ask(server.socketPath, request(token, ['stop']))).stdout)).toEqual({ kind: 'stopped' })
  })

  it('wire-socket: paySpawn gives no env before the socket is up, and a per-spawn token once it is', async () => {
    expect(paySpawn('agent-a').env).toEqual({})

    const { server } = await rig()

    setActivePaySocket(server)

    const one = paySpawn('agent-a')
    const two = paySpawn('agent-a')

    expect(one.env.ICLONE_PAY_SOCKET).toBe(server.socketPath)
    expect(one.env.ICLONE_PAY_TOKEN_FILE).not.toBe(two.env.ICLONE_PAY_TOKEN_FILE)
    expect(tokenOf(one.env)).not.toBe(tokenOf(two.env))
    expect(server.liveTokens()).toBe(2)
  })

  it('wire-socket: parsePayRequest takes only v1, a 64-hex token, a dev:ino home and 1..8 string args', () => {
    const token = 'a'.repeat(64)

    expect(parsePayRequest(JSON.stringify({ v: 1, token, home: HOME, argv: ['stop'] }))).toEqual({
      token,
      home: HOME,
      argv: ['stop']
    })
    // An older client names no folder: parsed, then refused as unbound by the socket.
    expect(parsePayRequest(JSON.stringify({ v: 1, token, argv: ['stop'] }))).toEqual({
      token,
      home: null,
      argv: ['stop']
    })

    for (const bad of [
      { v: 2, token, argv: ['stop'] },
      { v: 1, token: token.toUpperCase(), argv: ['stop'] },
      { v: 1, token, argv: [] },
      { v: 1, token, argv: Array.from({ length: 9 }, () => 'x') },
      { v: 1, token, argv: ['pay', 7] },
      { v: 1, token, home: 'profiles/agent-a', argv: ['stop'] },
      { v: 1, token, home: 4242, argv: ['stop'] },
      [1, token]
    ]) {
      expect(parsePayRequest(JSON.stringify(bad))).toBeNull()
    }
  })
})

describe('Jm2: one token file per spawn, named by its spawn id, in the 0700 run dir; confinement denies them all', () => {
  it('Jm2: each spawn gets pay-<spawn id>.token (0600, exclusive), distinct ids; revoke removes exactly that file', async () => {
    const { dir, server } = await rig()
    const a = server.mint('agent-a')
    const b = server.mint('agent-a')

    expect(a.spawnId).toMatch(/^[0-9a-f]{16}$/)
    expect(a.spawnId).not.toBe(b.spawnId)
    expect(a.env.ICLONE_PAY_TOKEN_FILE).toBe(path.join(dir, `pay-${a.spawnId}.token`))
    expect(fs.statSync(a.env.ICLONE_PAY_TOKEN_FILE).mode & 0o777).toBe(0o600)
    expect(
      fs
        .readdirSync(dir)
        .filter(name => name.endsWith('.token'))
        .sort()
    ).toEqual([`pay-${a.spawnId}.token`, `pay-${b.spawnId}.token`].sort())

    a.revoke()
    expect(fs.existsSync(a.env.ICLONE_PAY_TOKEN_FILE)).toBe(false)
    expect(fs.existsSync(b.env.ICLONE_PAY_TOKEN_FILE)).toBe(true)
    expect(server.liveTokens()).toBe(1)
  })

  it('Jm2: the run dir is put back to 0700 before a mint; token files a crash left are swept at start, nothing else', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v3jw-'))
    const dir = path.join(base, 'run')

    fs.mkdirSync(dir, { mode: 0o700 })

    const stale = path.join(dir, `pay-${'0'.repeat(16)}.token`)

    const kept = [
      path.join(dir, 'pay-notes.token'),
      path.join(dir, 'acp.token'),
      path.join(dir, `pay-${'1'.repeat(16)}.token.bak`)
    ]

    fs.writeFileSync(stale, `${'f'.repeat(64)}\n`, { mode: 0o600 })

    for (const file of kept) {
      fs.writeFileSync(file, 'x', { mode: 0o600 })
    }

    const logs: string[] = []

    const server = await startPaySocketServer({
      dir,
      verb: () => ({ client: null, audit: null, stop: () => true }),
      audit: null,
      log: line => logs.push(line),
      bindProfile: () => ({ home: HOME })
    })

    try {
      expect(fs.existsSync(stale)).toBe(false)
      expect(kept.every(file => fs.existsSync(file))).toBe(true)
      expect(logs.some(line => line.includes('removed 1 pay token file'))).toBe(true)

      fs.chmodSync(dir, 0o755)

      const minted = server.mint('agent-a')

      expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
      expect(fs.statSync(minted.env.ICLONE_PAY_TOKEN_FILE).mode & 0o777).toBe(0o600)
    } finally {
      server.close()
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('Jm2: every confined profile (V3-G) denies reading a spawn token — userData whole and run/pay-*.token by name', () => {
    const userDataDir = '/Users/u/Library/Application Support/icloneOS'

    const specs = buildAllProfileSpecs({
      home: '/Users/u',
      hermesHome: '/Users/u/.hermes',
      userDataDir,
      hermesRoot: null,
      profilesDir: path.join(userDataDir, 'confinement', 'profiles'),
      scratchRoot: '/Users/u/Library/Caches/iclone-os-confinement/scratch',
      membersDir: '/Users/u/Library/Caches/iclone-os-confinement/members'
    })

    const token = payTokenFile(path.join(userDataDir, 'run'), 'ab'.repeat(8))
    const glob = path.join(userDataDir, 'run', 'pay-*.token')

    expect(specs.length).toBeGreaterThan(0)

    for (const spec of specs) {
      expect(
        spec.denied.some(entry => token.startsWith(`${entry}/`)),
        spec.cls
      ).toBe(true)
      expect(spec.deniedGlobs, spec.cls).toContain(glob)

      const deny = renderSbpl(spec)
        .split('\n')
        .find(line => line.startsWith('(deny file-read* file-write*'))

      expect(deny, spec.cls).toContain(globToSbplRegex(glob))
      expect(deny, spec.cls).toContain(`(subpath "${userDataDir}")`)
    }
  })
})

describe('m-r2-2: a profile outside the Hermes home cannot pay', () => {
  it('m-r2-2: a spawn of an unprotected profile gets no token and no pay env; others do; both audited by id', async () => {
    const unprotected = new Set(['inft-out-6'])

    const { server, audit } = await rig({
      bindProfile: slug =>
        unprotected.has(slug) ? { refused: `profile ${slug} lives outside the Hermes home` } : { home: HOME }
    })

    setActivePaySocket(server)

    expect(() => server.mint('inft-out-6')).toThrow(/outside the Hermes home/)
    expect(paySpawn('inft-out-6').env).toEqual({})
    expect(server.liveTokens()).toBe(0)
    expect(paySpawn('default').env.ICLONE_PAY_SOCKET).toBe(server.socketPath)
    expect(server.liveTokens()).toBe(1)
    expect(audit.filter(entry => entry.reason === 'spawn unprotected_profile')).toEqual([
      { kind: 'refuse', reason: 'spawn unprotected_profile', agent: 'inft-out-6' },
      { kind: 'refuse', reason: 'spawn unprotected_profile', agent: 'inft-out-6' }
    ])
  })

  it('m-r2-2: a live token whose profile became unprotected is refused before the verb (77), and audited', async () => {
    const unprotected = new Set<string>()

    const { server, calls, audit } = await rig({
      bindProfile: slug =>
        unprotected.has(slug) ? { refused: `profile ${slug} lives outside the Hermes home` } : { home: HOME }
    })

    const token = tokenOf(server.mint('inft-moved-7').env)

    expect((await ask(server.socketPath, request(token, ['pay', 'http://127.0.0.1:9/paid']))).code).toBe(1)

    unprotected.add('inft-moved-7')

    const refused = await ask(server.socketPath, request(token, ['pay', 'http://127.0.0.1:9/paid']))

    expect(refused.code).toBe(77)
    expect(refused.stderr).toMatch(/outside the Hermes home/)
    expect(calls.map(call => call.agent)).toEqual(['inft-moved-7'])
    expect(audit).toContainEqual({ kind: 'refuse', reason: 'socket unprotected_profile', agent: 'inft-moved-7' })
  })
})

describe('m-r4-1: a pay token works only from the folder of the profile it was minted for', () => {
  it('m-r4-1: a request from another profile’s folder (an inherited env) is refused before the verb (77), and audited', async () => {
    const { server, calls, audit } = await rig()
    const token = tokenOf(server.mint('agent-a').env)

    const foreign = await ask(
      server.socketPath,
      request(token, ['pay', 'http://127.0.0.1:9/paid'], { home: OTHER_HOME })
    )

    const unnamed = await ask(
      server.socketPath,
      `${JSON.stringify({ v: 1, token, argv: ['pay', 'http://127.0.0.1:9/paid'] })}\n`
    )

    expect([foreign.code, unnamed.code]).toEqual([77, 77])
    expect(foreign.stderr).toMatch(/minted for profile agent-a/)
    expect(calls).toEqual([])
    expect(audit.filter(entry => entry.reason === 'socket profile_mismatch')).toEqual([
      { kind: 'refuse', reason: 'socket profile_mismatch', agent: 'agent-a' },
      { kind: 'refuse', reason: 'socket profile_mismatch', agent: 'agent-a' }
    ])

    expect((await ask(server.socketPath, request(token, ['pay', 'http://127.0.0.1:9/paid']))).code).toBe(1)
    expect(calls.map(call => call.agent)).toEqual(['agent-a'])
  })

  it('m-r4-1: a profile whose verified folder changed after the mint (deleted and made again) is refused (77)', async () => {
    let home = HOME
    const { server, calls, audit } = await rig({ bindProfile: () => ({ home }) })
    const token = tokenOf(server.mint('agent-a').env)

    home = OTHER_HOME

    const moved = await ask(server.socketPath, request(token, ['pay', 'http://127.0.0.1:9/paid'], { home: OTHER_HOME }))

    expect(moved.code).toBe(77)
    expect(calls).toEqual([])
    expect(audit).toContainEqual({ kind: 'refuse', reason: 'socket profile_moved', agent: 'agent-a' })
  })

  it('J4-1: a spawn whose profile is unknown (null) gets no pay env, even from a socket that would bind any slug', async () => {
    const { server } = await rig({ bindProfile: () => ({ home: HOME }) })

    setActivePaySocket(server)

    expect(paySpawn(null).env).toEqual({})
    expect(server.liveTokens()).toBe(0)
  })

  it('m-r4-1: the child env carries the folder the token was minted for, per profile', async () => {
    const homes: Record<string, string> = { 'agent-a': HOME, 'agent-b': OTHER_HOME }
    const { server } = await rig({ bindProfile: slug => ({ home: homes[slug] }) })

    expect(server.mint('agent-a').env.ICLONE_PAY_HOME).toBe(HOME)
    expect(server.mint('agent-b').env.ICLONE_PAY_HOME).toBe(OTHER_HOME)
  })
})
