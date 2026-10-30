import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import {
  type AgentcardAnswer,
  type AgentcardRun,
  agentcardScratchCwd,
  agentcardStateFrom,
  agentcardStatus,
  createAgentcardRun,
  probeAgentcardAccount,
  resetAgentcardStatus,
  resolveOnPath
} from './iclone-agentcard-status'

/**
 * Recorded answers of `agentcard` 0.4.0, redacted (e-mails, wallet, session token replaced).
 * SIGNED_OUT is the real answer on this Mac, 2026-10-21 (whoami 1.19 s, identity 0.82 s, limit 0.81 s, each exit 1).
 * The signed-in shapes are the CLI's own print statements (dist/src/commands/{whoami,identity,limit}.js and
 * lib/api.js): this front never signs in, so they cannot be recorded live.
 */
const EMAIL = 'owner@example.invalid'
const TOKEN = 'eyJREDACTEDSESSIONTOKEN0123456789'

const exit1 = (stderr: string): AgentcardAnswer => ({ code: 1, stdout: '', stderr })
const exit0 = (stdout: string, stderr = ''): AgentcardAnswer => ({ code: 0, stdout, stderr })

const SESSION_EXPIRED = exit1('Session expired. Run `agentcard signup` to log in again.\n')

const LIMIT_SESSION_EXPIRED = exit1(
  '- Fetching spend limits...\nSession expired. Run `agentcard signup` to log in again.\n'
)

const NOT_LOGGED_IN = exit0('Not logged in. Run `agentcard signup` to get started.\n')

const WHOAMI_SIGNED_IN = exit0(
  `  \u001b[1mHuman email:\u001b[22m ${EMAIL}\n  Agent email: agent@example.invalid\n  Wallet:      0x0000000000000000000000000000000000000000 (Base, 0.00 USDC)\n`
)

const identity = (status: unknown): AgentcardAnswer =>
  exit0(JSON.stringify({ ok: true, url: `https://agentcard.ai/identity#identity_token=${TOKEN}`, status }, null, 2))

const IDENTITY_REQUIRED = identity({ identityVerificationStatus: 'requires_input', identityVerificationRequired: true })
const IDENTITY_VERIFIED = identity({ identityVerificationStatus: 'verified', identityVerificationRequired: true })
const IDENTITY_EXEMPT = identity({ identityVerificationStatus: 'exempt' })
const IDENTITY_PROCESSING = identity({ identityVerificationStatus: 'processing', identityVerificationRequired: true })
const IDENTITY_UNREAD = identity(null)

const LIMIT_READ = exit0(
  '\n  Spend Limit (issued cards + wallet)\n  ────────────────────────────\n  Limit:      $200.00\n  Used:       $0.00\n  Remaining:  $200.00\n'
)

// A refused `limit` prints only the server's own `error`/`message` (lib/api.js), never the HTTP status.
const LIMIT_FORBIDDEN = exit1('- Fetching spend limits...\n✖ Failed to fetch limit: Forbidden\n')
const LIMIT_REFUSED_BY_SERVER = exit1('- Fetching spend limits...\n✖ Failed to fetch limit: This account is blocked\n')

// Any non-401 failure of /api/me (403, 5xx, network) — whoami.js catches it and exits 0.
const WHOAMI_FAILED = exit0('', 'Failed to verify session. Try `agentcard signup` again.\n')

describe('V3-L M3 — the agentcard answer maps to one of three states, or unknown', () => {
  it('signed out: the real "Session expired" answer, and "Not logged in"', () => {
    expect(agentcardStateFrom({ whoami: SESSION_EXPIRED })).toBe('signed-out')
    expect(agentcardStateFrom({ whoami: NOT_LOGGED_IN })).toBe('signed-out')
    expect(
      agentcardStateFrom({ whoami: WHOAMI_SIGNED_IN, identity: SESSION_EXPIRED, limit: LIMIT_SESSION_EXPIRED })
    ).toBe('signed-out')
  })

  it('KYC required: signed in, identity not verified — every status the CLI itself treats as unverified', () => {
    for (const status of [
      IDENTITY_REQUIRED,
      identity({ identityVerificationStatus: 'canceled', identityVerificationRequired: true }),
      identity({ identityVerificationRequired: true })
    ]) {
      expect(agentcardStateFrom({ whoami: WHOAMI_SIGNED_IN, identity: status, limit: LIMIT_READ })).toBe('kyc-required')
    }
  })

  it('m3: a KYC-pending account whose limit read is refused still reads as needing KYC, never as blocked', () => {
    for (const limit of [LIMIT_FORBIDDEN, LIMIT_REFUSED_BY_SERVER]) {
      expect(agentcardStateFrom({ whoami: WHOAMI_SIGNED_IN, identity: IDENTITY_REQUIRED, limit })).toBe('kyc-required')
    }
  })

  it('m3: CLI 0.4.0 prints no blocked answer, so a refused read is unknown (null), never a guessed state', () => {
    // A 403 on /api/me: whoami swallows it into "Failed to verify session" with exit 0.
    expect(agentcardStateFrom({ whoami: WHOAMI_FAILED, identity: IDENTITY_UNREAD, limit: LIMIT_FORBIDDEN })).toBeNull()

    // A verified account whose limit read is refused: the server's own words, whatever they are, decide nothing.
    for (const limit of [LIMIT_FORBIDDEN, LIMIT_REFUSED_BY_SERVER]) {
      expect(agentcardStateFrom({ whoami: WHOAMI_SIGNED_IN, identity: IDENTITY_VERIFIED, limit })).toBeNull()
    }
  })

  it('m3: KYC submitted and in review (processing) is unknown, not "needs KYC" — there is nothing to do', () => {
    expect(
      agentcardStateFrom({ whoami: WHOAMI_SIGNED_IN, identity: IDENTITY_PROCESSING, limit: LIMIT_READ })
    ).toBeNull()
  })

  it('ready: signed in, KYC verified or exempt or not required, limit read', () => {
    expect(agentcardStateFrom({ whoami: WHOAMI_SIGNED_IN, identity: IDENTITY_VERIFIED, limit: LIMIT_READ })).toBe(
      'ready'
    )
    expect(agentcardStateFrom({ whoami: WHOAMI_SIGNED_IN, identity: IDENTITY_EXEMPT, limit: LIMIT_READ })).toBe('ready')
    expect(
      agentcardStateFrom({
        whoami: WHOAMI_SIGNED_IN,
        identity: identity({ identityVerificationStatus: 'unverified', identityVerificationRequired: false }),
        limit: LIMIT_READ
      })
    ).toBe('ready')
  })

  it('no state from what does not say: a missing CLI, a timeout, an unread identity, a failed session check', () => {
    expect(agentcardStateFrom({ whoami: { code: null, stdout: '', stderr: '' } })).toBeNull()
    expect(agentcardStateFrom({ whoami: WHOAMI_SIGNED_IN, identity: IDENTITY_UNREAD, limit: LIMIT_READ })).toBeNull()
    expect(
      agentcardStateFrom({
        whoami: WHOAMI_FAILED,
        identity: IDENTITY_VERIFIED,
        limit: LIMIT_READ
      })
    ).toBeNull()
  })
})

describe('V3-L M3 — the probe is read-only, never interactive, and keeps no secret', () => {
  const scripted = (answers: Record<string, AgentcardAnswer>) => {
    const calls: string[][] = []

    const run: AgentcardRun = async args => {
      calls.push([...args])

      return answers[args[0] ?? ''] ?? { code: null, stdout: '', stderr: '' }
    }

    return { run, calls }
  }

  it('signed out: one whoami and nothing else', async () => {
    const { run, calls } = scripted({ whoami: SESSION_EXPIRED })

    expect(await probeAgentcardAccount(run)).toBe('signed-out')
    expect(calls).toEqual([['whoami']])
  })

  it('signed in: only the three reads — identity with --json --no-open, a bare limit (never --amount)', async () => {
    const { run, calls } = scripted({ whoami: WHOAMI_SIGNED_IN, identity: IDENTITY_REQUIRED, limit: LIMIT_READ })

    expect(await probeAgentcardAccount(run)).toBe('kyc-required')
    expect(calls).toEqual([['whoami'], ['identity', '--json', '--no-open'], ['limit']])

    for (const argv of calls) {
      expect(['whoami', 'identity', 'limit']).toContain(argv[0])
      expect(argv).not.toContain('--amount')
      expect(argv.some(arg => /signup|login|setup|request|support/.test(arg))).toBe(false)
    }
  })

  it('what leaves the module is a state and a time: no e-mail, token or identity URL', async () => {
    resetAgentcardStatus()
    const { run } = scripted({ whoami: WHOAMI_SIGNED_IN, identity: IDENTITY_VERIFIED, limit: LIMIT_READ })
    const log = vi.spyOn(console, 'log')
    const error = vi.spyOn(console, 'error')
    const warn = vi.spyOn(console, 'warn')

    const status = await agentcardStatus(run, () => 1_000)
    const wire = JSON.stringify(status)

    expect(status).toEqual({ state: 'ready', checkedAt: 1_000 })
    expect(wire).not.toContain(EMAIL)
    expect(wire).not.toContain(TOKEN)
    expect(wire).not.toMatch(/identity_token|https?:|@/)
    expect([...log.mock.calls, ...error.mock.calls, ...warn.mock.calls]).toEqual([])
    vi.restoreAllMocks()
  })

  it('one probe at a time, its answer kept five minutes; a throwing run is no state, never a crash', async () => {
    resetAgentcardStatus()
    let clock = 10_000
    const { run, calls } = scripted({ whoami: SESSION_EXPIRED })

    const [a, b] = await Promise.all([agentcardStatus(run, () => clock), agentcardStatus(run, () => clock)])

    expect(a).toBe(b)
    expect(calls).toHaveLength(1)
    clock += 5 * 60_000 - 1
    await agentcardStatus(run, () => clock)
    expect(calls).toHaveLength(1)
    clock += 1
    await agentcardStatus(run, () => clock)
    expect(calls).toHaveLength(2)

    resetAgentcardStatus()
    await expect(
      agentcardStatus(
        () => Promise.reject(new Error('spawn agentcard ENOENT')),
        () => 1
      )
    ).resolves.toEqual({ state: null, checkedAt: 1 })
  })
})

describe('K66 — the CLI runs as an absolute binary, in a scratch cwd, with a bare environment', () => {
  // A stub `agentcard` (never the real CLI): it prints where it ran, how it was called and every env key it got.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'k66-')))
  const bin = path.join(root, 'bin')
  const decoyDir = path.join(root, 'decoy')
  const stub = path.join(bin, 'agentcard')
  const SECRET = 'K66_APP_SECRET_PROBE'

  mkdirSync(bin)
  mkdirSync(decoyDir)

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  function writeStub(file: string, body: string) {
    writeFileSync(file, `#!/bin/sh\n${body}\n`)
    chmodSync(file, 0o755)
  }

  it('the child sees only HOME, PATH, LANG, TMPDIR, USER and the quiet switches; cwd is the scratch dir', async () => {
    writeStub(stub, 'echo "cwd=$(pwd -P)"; echo "argv0=$0"; env | cut -d= -f1 | sort')
    // A relative PATH entry holding a decoy must never be used, and the scratch dir's planted .env is removed.
    writeStub(path.join(decoyDir, 'agentcard'), 'echo decoy')

    const scratch = path.join(root, 'tmp')
    const planted = path.join(scratch, 'iclone-agentcard', '.env')

    mkdirSync(path.dirname(planted), { recursive: true })
    writeFileSync(planted, 'SECRET=1\n')

    const ensurePath = vi.fn(() => Promise.resolve())

    const run = createAgentcardRun({
      ensurePath,
      env: () => ({
        ...process.env,
        [SECRET]: 'must-not-leak',
        PRIVY_APP_SECRET: 'must-not-leak',
        PATH: `${path.relative(process.cwd(), decoyDir)}:${bin}:/usr/bin:/bin`
      }),
      cwd: () => agentcardScratchCwd(scratch)
    })

    const answer = await run(['whoami'])
    const lines = answer.stdout.trim().split('\n')
    const keys = lines.filter(line => !line.includes('=') && line !== '')

    expect(ensurePath).toHaveBeenCalledTimes(1)
    expect(answer.code).toBe(0)
    expect(lines[0]).toBe(`cwd=${path.join(scratch, 'iclone-agentcard')}`)
    expect(lines[1]).toBe(`argv0=${stub}`)
    expect(existsSync(planted)).toBe(false)
    expect(answer.stdout).not.toContain('decoy')
    expect(answer.stdout).not.toContain(SECRET)
    expect(answer.stdout).not.toContain('PRIVY_APP_SECRET')
    // `sh` itself adds PWD/SHLVL/_ (and OLDPWD on some shells); everything else came from the parent.
    const shellOwn = new Set(['OLDPWD', 'PWD', 'SHLVL', '_'])

    expect(keys.filter(key => !shellOwn.has(key)).sort()).toEqual(
      ['AGENTCARD_SKIP_UPDATE', 'CI', 'FORCE_COLOR', 'HOME', 'LANG', 'NO_COLOR', 'PATH', 'TMPDIR', 'USER']
        .filter(key => key !== 'USER' || Boolean(process.env.USER))
        .sort()
    )
  })

  it('resolveOnPath takes the first absolute executable and skips relative entries', () => {
    expect(resolveOnPath('agentcard', `${path.relative(process.cwd(), decoyDir)}:${bin}`)).toBe(stub)
    expect(resolveOnPath('agentcard', `${decoyDir}:${bin}`)).toBe(path.join(decoyDir, 'agentcard'))
    expect(resolveOnPath('agentcard', '/nonexistent-k66')).toBeNull()
    expect(resolveOnPath('agentcard', undefined)).toBeNull()
  })

  it('no CLI on PATH: the run says missing and the status is not kept (installing it shows on the next open)', async () => {
    const missing = createAgentcardRun({
      ensurePath: () => Promise.resolve(),
      env: () => ({ PATH: '/nonexistent-k66' }),
      cwd: () => agentcardScratchCwd(path.join(root, 'tmp'))
    })

    await expect(missing(['whoami'])).resolves.toEqual({ code: null, stdout: '', stderr: '', missing: true })

    resetAgentcardStatus()
    const run = vi.fn(missing)

    await expect(agentcardStatus(run, () => 1)).resolves.toEqual({ state: null, checkedAt: 1 })
    await agentcardStatus(run, () => 2)
    expect(run).toHaveBeenCalledTimes(2)
    resetAgentcardStatus()
  })
})

describe('n2 (V3-K critic r1): the fixed-name scratch dir is checked before use', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'n2-')))

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('a symlink planted at the scratch name is refused, never followed', () => {
    const elsewhere = path.join(root, 'elsewhere')

    mkdirSync(elsewhere)
    writeFileSync(path.join(elsewhere, '.env'), 'AGENTCARD_TOKEN=planted\n')
    symlinkSync(elsewhere, path.join(root, 'iclone-agentcard'))

    expect(() => agentcardScratchCwd(root)).toThrow(/not a directory owned by this user/)
    // Not followed: the target's files are untouched.
    expect(existsSync(path.join(elsewhere, '.env'))).toBe(true)
  })

  it('a dir of ours left open to others is closed to 0700 before use', () => {
    const other = path.join(root, 'open')
    const dir = path.join(other, 'iclone-agentcard')

    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o777)

    expect(agentcardScratchCwd(other)).toBe(dir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })
})
