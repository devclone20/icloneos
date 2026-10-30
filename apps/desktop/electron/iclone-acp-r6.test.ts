import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

const childProcess = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn(), execFile: vi.fn() }))
vi.mock('node:child_process', () => ({ ...childProcess, default: childProcess }))

import { redactDeep, redactSecrets } from '../src/iclone-shared/redact'

import { type AcpRunResult, type InftAcpStatus, probeAgentFacets } from './iclone-acp'
import { validateArgv } from './iclone-acp-argv'
import { CARD_BLOCKED_TTL_MS, CARD_PENDING_TTL_MS, CARD_TTL_MS, cardProbeDue, cardStateFrom } from './iclone-acp-card'
import { AGENT_COMMANDS, redactSecrets as reexported } from './iclone-acp-ipc'
import {
  CARD_RATE_HOLD_MS,
  CARD_RESEND_WAIT_MS,
  cardDueSince,
  cardResendAt,
  cardSignupHeldUntil,
  cardSignupHold,
  cardSignupRunning,
  HELD_UNTIL_MARK,
  isCardSignup,
  RESEND_AT_MARK,
  settleCardDue,
  SIGNUP_RUNNING,
  signupHeldReason,
  signupHoldMs,
  withCardSignupSlot
} from './iclone-acp-signup'
import {
  deleteInftKv,
  DETACH_QUIET_MS,
  isPersistedStatus,
  KV_MAX_BYTES,
  readInftKv,
  readJsonValidated,
  removeInftDirs,
  writeFileAtomic,
  writeInftKv
} from './iclone-acp-store'

// Both helpers are the SAME contract, so withCardSignupSlot<T> infers one T and its `refused` matches `task`.
// Without the annotation TS infers two incompatible literal shapes (code: number vs null, error: string vs
// string | undefined) and the slot's refusal argument is rejected under strict.
const run = (stdout: string, ok = true, error?: string): AcpRunResult => ({
  ok,
  code: ok ? 0 : 1,
  stdout,
  stderr: '',
  error
})

const SLUG = 'robinhood-0x4dfb000000000000000000000000000000000000-6'
const BEARER = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789'

describe('cardStateFrom — what card whoami says', () => {
  it('reads a verified profile as ready and a 200 verified:false as a waiting link', () => {
    expect(cardStateFrom(run('{"id":"c1","verified":true}'))).toEqual({ answered: true, state: 'ready' })
    expect(cardStateFrom(run('{"verified":false,"nextStep":{"hint":"Magic link sent but not clicked"}}'))).toEqual({
      answered: true,
      state: 'signin-pending',
      hint: 'Magic link sent but not clicked'
    })
  })

  it('parses the REAUTH state and e-mail the service hands back', () => {
    const probe = cardStateFrom(
      run('{"error":"HTTP 401: {\\"message\\":\\"REAUTH:3f2a-91bc-77:agent@agentcard.ai\\"}"}')
    )

    expect(probe).toMatchObject({
      answered: true,
      state: 'signin-pending',
      reauthState: '3f2a-91bc-77',
      reauthEmail: 'agent@agentcard.ai',
      httpStatus: 401
    })
  })

  it('reads 403, 429 and "blocked" as blocked — never as never-signed-up', () => {
    expect(cardStateFrom(run('{"error":"HTTP 403: forbidden"}', false))).toMatchObject({
      state: 'blocked',
      httpStatus: 403
    })
    expect(cardStateFrom(run('{"error":"HTTP 429: slow down"}', false))).toMatchObject({
      state: 'blocked',
      httpStatus: 429
    })
    expect(cardStateFrom(run('{"error":"account blocked"}'))).toMatchObject({ state: 'blocked' })
  })

  it('reads "not set up" as none, and a probe that could not run as no answer', () => {
    expect(cardStateFrom(run('{"error":"HTTP 400: Card not set up. Call card signup first."}'))).toMatchObject({
      answered: true,
      state: 'none'
    })
    expect(cardStateFrom(run('', false, 'timed out after 60s'))).toEqual({ answered: false, httpStatus: undefined })
    expect(cardStateFrom(run('{"error":"Session expired","code":"NOT_AUTHENTICATED"}', false)).answered).toBe(false)
    expect(cardStateFrom(run('{"error":"HTTP 503: down"}', false)).answered).toBe(false)
    // "already" and "inactive" are not answers either.
    expect(cardStateFrom(run('{"error":"email already registered"}', false)).answered).toBe(false)
  })
})

describe('cardProbeDue — the 10-min card TTL', () => {
  const now = 1_000_000_000
  const fresh = { cardState: 'ready' as const, cardCheckedAt: now - 60_000 }

  it('caches a fresh answer and re-probes after the TTL', () => {
    expect(cardProbeDue(fresh, now)).toBe(false)
    expect(cardProbeDue({ ...fresh, cardCheckedAt: now - CARD_TTL_MS - 1 }, now)).toBe(true)
  })

  it('forces on the manual re-probe and on card-step completion', () => {
    expect(cardProbeDue(fresh, now, CARD_TTL_MS, { force: true })).toBe(true)
    expect(cardProbeDue(fresh, now, CARD_TTL_MS, { card: true })).toBe(true)
  })

  it('never trusts stale, undated, future-dated or pending answers', () => {
    expect(cardProbeDue(null, now)).toBe(true)
    expect(cardProbeDue({ ...fresh, stale: true }, now)).toBe(true)
    expect(cardProbeDue({ ...fresh, cardStale: true }, now)).toBe(true)
    expect(cardProbeDue({ cardState: 'ready' }, now)).toBe(true)
    expect(cardProbeDue({ ...fresh, cardCheckedAt: now + 5 }, now)).toBe(true)
    expect(cardProbeDue({ ...fresh, cardState: 'blocked' }, now)).toBe(false)
  })

  it('caches a pending link for the shorter pending TTL only', () => {
    const pending = { cardState: 'signin-pending' as const, cardCheckedAt: now - 60_000 }

    expect(cardProbeDue(pending, now)).toBe(false)
    expect(cardProbeDue({ ...pending, cardCheckedAt: now - CARD_PENDING_TTL_MS - 1 }, now)).toBe(true)
    expect(cardProbeDue(pending, now, CARD_TTL_MS, { card: true })).toBe(true)
  })

  it('G3: 8 unforced wizard refreshes a minute apart spawn card whoami at most 3 times while pending', () => {
    let persisted: { cardState: 'signin-pending'; cardCheckedAt: number } | null = null
    let spawns = 0

    for (let i = 0; i < 8; i++) {
      const at = now + i * 60_000

      if (cardProbeDue(persisted, at)) {
        spawns += 1
        persisted = { cardState: 'signin-pending', cardCheckedAt: at }
      }
    }

    expect(spawns).toBeLessThanOrEqual(3)
  })
})

describe('probeAgentFacets — email whoami and signer-policy behind the TTL', () => {
  const answers: Record<string, string> = {
    'email whoami': '{"emailAddress":"agent@mail.acp.virtuals.io"}',
    'card whoami': '{"verified":true}',
    'agent signer-policy': '{"signerId":"s1","policy":"restricted"}'
  }

  function harness() {
    const calls: string[] = []

    const fake = async (argv: string[]) => {
      const key = argv.slice(0, 2).join(' ')

      calls.push(key)

      return run(answers[key] ?? '{}')
    }

    const count = (key: string) => calls.filter(call => call === key).length

    return { calls, count, fake }
  }

  const base = (agentId = 'a1'): InftAcpStatus => ({
    cli: true,
    authenticated: true,
    agentId,
    cardReady: false,
    configured: true,
    checkedAt: Date.now(),
    slug: SLUG
  })

  it('3 unforced reads run email whoami and signer-policy once, and carry the answers', async () => {
    const { count, fake } = harness()
    let last: InftAcpStatus | null = null

    for (let i = 0; i < 3; i++) {
      const status = base()

      await probeAgentFacets(fake, status, last)
      last = status
    }

    expect(count('email whoami')).toBe(1)
    expect(count('agent signer-policy')).toBe(1)
    expect(count('card whoami')).toBe(1)
    expect(last).toMatchObject({ email: 'agent@mail.acp.virtuals.io', signerReady: true, signerPolicy: 'restricted' })
  })

  it('an agent step, a manual re-probe or another agent re-runs them inside the TTL', async () => {
    const { count, fake } = harness()
    const first = base()

    await probeAgentFacets(fake, first, null)
    await probeAgentFacets(fake, base(), first, { agent: true })
    await probeAgentFacets(fake, base(), first, { force: true })
    await probeAgentFacets(fake, base('a2'), first)

    expect(count('email whoami')).toBe(4)
    expect(count('agent signer-policy')).toBe(4)
  })

  it('a probe that could not run is not stamped, so the next read retries it', async () => {
    const calls: string[] = []

    const failing = async (argv: string[]) => {
      calls.push(argv.slice(0, 2).join(' '))

      return run('', false, 'timed out after 60s')
    }

    const first = base()

    await probeAgentFacets(failing, first, null)
    expect(first.emailCheckedAt).toBeUndefined()
    expect(first.signerCheckedAt).toBeUndefined()
    await probeAgentFacets(failing, base(), first)
    expect(calls.filter(call => call === 'email whoami')).toHaveLength(2)
  })
})

describe('R6 r3 — facets never persist a non-answer', () => {
  const OLD = Date.now() - 11 * 60_000

  const last = (): InftAcpStatus => ({
    cli: true,
    authenticated: true,
    agentId: 'a1',
    cardReady: true,
    cardState: 'ready',
    cardCheckedAt: Date.now(),
    configured: true,
    checkedAt: OLD,
    slug: SLUG,
    email: 'agent@mail.acp.virtuals.io',
    emailCheckedAt: OLD,
    signerReady: true,
    signerPolicy: 'p',
    signerCheckedAt: OLD
  })

  async function facets(email: ReturnType<typeof run>, signer: ReturnType<typeof run>) {
    const status: InftAcpStatus = { ...last(), email: undefined, signerReady: undefined, signerPolicy: undefined }

    delete status.emailCheckedAt
    delete status.signerCheckedAt
    await probeAgentFacets(
      async argv => (argv[0] === 'email' ? email : argv[1] === 'signer-policy' ? signer : run('{"verified":true}')),
      status,
      last()
    )

    return status
  }

  it('a timeout or a 502 keeps the last email and signer, marked stale and unstamped', async () => {
    for (const fail of [run('', false, 'timed out after 60s'), run('{"error":"HTTP 502: Bad Gateway"}', false)]) {
      const t = await facets(fail, fail)

      expect(t).toMatchObject({
        email: 'agent@mail.acp.virtuals.io',
        emailStale: true,
        signerReady: true,
        signerStale: true
      })
      expect(t.emailCheckedAt).toBeUndefined()
      expect(t.signerCheckedAt).toBeUndefined()
    }
  })

  it('"no signer" and a clean email answer are real answers: stamped, not stale', async () => {
    const t = await facets(
      run('{"emailAddress":"new@mail.acp.virtuals.io"}'),
      run('{"error":"NO_SIGNER: none"}', false)
    )

    expect(t).toMatchObject({ email: 'new@mail.acp.virtuals.io', signerReady: false })
    expect(t.emailStale).toBeUndefined()
    expect(t.signerStale).toBeUndefined()
    expect(typeof t.emailCheckedAt).toBe('number')
    expect(typeof t.signerCheckedAt).toBe('number')
  })
})

describe('R6 r3 — one-time URL credentials are redacted', () => {
  it('masks magic-link / OAuth params and Stripe checkout sessions, keeps the rest of the URL', () => {
    const magic = 'https://agentcard.ai/auth/verify?token=Zq81mKx7Lr02PpaaW4tYb9cN3e&next=/home'

    const checkout =
      'https://checkout.stripe.com/c/pay/cs_live_a1B2c3D4e5F6g7H8i9J0kLmNoPqRsT#fidkdWxOYHwnPyd1blpxYHZxWjA0'

    const oauth = 'https://x.io/cb?code=abc123def456&state=st-998877&sessionId=s-1'
    const out = redactSecrets(`${magic} ${checkout} ${oauth}`)

    for (const secret of ['Zq81mKx7Lr02', 'a1B2c3D4e5', 'fidkdWxO', 'abc123def456', 'st-998877', 's-1']) {
      expect(out).not.toContain(secret)
    }

    expect(out).toContain('https://agentcard.ai/auth/verify?token=[redacted]&next=/home')
    expect(out).toContain('https://checkout.stripe.com/c/pay/cs_live_[redacted]')
    expect(redactSecrets(out)).toBe(out)
    expect(redactSecrets('https://agentcard.ai/docs?page=2')).toBe('https://agentcard.ai/docs?page=2')
  })
})

describe('R6 allowlist', () => {
  it('admits extract-links by message id and the cardholder profile reset', () => {
    expect(validateArgv(['email', 'extract-links', '--message-id', 'm1', '--json'])).toEqual([
      'email',
      'extract-links',
      '--message-id',
      'm1',
      '--json'
    ])
    expect(validateArgv(['card', 'profile', 'reset', '--json'])).toEqual(['card', 'profile', 'reset', '--json'])
  })

  it('refuses extract-links without an id, card issue and agent delete', () => {
    expect(validateArgv(['email', 'extract-links', '--json'])).toBeNull()
    expect(validateArgv(['card', 'issue', '--json'])).toBeNull()
    expect(validateArgv(['agent', 'delete', '--json'])).toBeNull()
  })

  it('the agent door has no delete verb (the CLI has none)', () => {
    const verbs = AGENT_COMMANDS.agent ?? []

    expect(verbs.filter(verb => /delete|deactivate|deregister/.test(verb))).toEqual([])
    expect(reexported).toBe(redactSecrets)
  })
})

describe('per-iNFT store — atomic, validated, redacted', () => {
  const root = () => mkdtempSync(path.join(os.tmpdir(), 'r6-store-'))

  it('writes atomically (no tmp file left) and reads back only valid shapes', () => {
    const dir = root()
    const file = path.join(dir, SLUG, 'status.json')

    writeFileAtomic(
      file,
      JSON.stringify({ slug: SLUG, checkedAt: 1, cli: true, authenticated: true, cardReady: false, configured: true })
    )
    expect(readdirSync(path.dirname(file))).toEqual(['status.json'])
    expect(readJsonValidated(file, isPersistedStatus)?.slug).toBe(SLUG)
    writeFileSync(file, '{"slug":')
    expect(readJsonValidated(file, isPersistedStatus)).toBeNull()
    writeFileSync(file, '{"slug":"x"}')
    expect(readJsonValidated(file, isPersistedStatus)).toBeNull()
  })

  it('kv: key allowlist, slug check, 64 KB cap, shape check', () => {
    const dir = root()

    expect(writeInftKv(dir, SLUG, 'status', {}).ok).toBe(false)
    expect(writeInftKv(dir, '../etc', 'notes', {}).ok).toBe(false)
    expect(writeInftKv(dir, SLUG, 'card-signup', { nophase: true }).ok).toBe(false)
    expect(
      writeInftKv(dir, SLUG, 'card-signup', { phase: 'sent', state: 's1', pad: 'x'.repeat(KV_MAX_BYTES) })
    ).toMatchObject({ ok: false })
    expect(writeInftKv(dir, SLUG, 'notes', { card: { text: 'x'.repeat(9000), updatedAt: 1 } }).ok).toBe(false)
    expect(writeInftKv(dir, SLUG, 'card-signup', { phase: 'sent', state: 's1' })).toMatchObject({
      ok: true,
      masked: false
    })
    expect(readInftKv(dir, SLUG, 'card-signup')).toEqual({ ok: true, value: { phase: 'sent', state: 's1' } })
    expect(deleteInftKv(dir, SLUG, 'card-signup').ok).toBe(true)
    expect(readInftKv(dir, SLUG, 'card-signup')).toEqual({ ok: true, value: null })
  })

  it('G7: a seeded bearer token never reaches the disk', () => {
    const dir = root()
    const result = writeInftKv(dir, SLUG, 'notes', { card: { text: `my key ${BEARER}`, updatedAt: 1 } })
    const bytes = readFileSync(path.join(dir, SLUG, 'notes.json'), 'utf8')

    expect(result).toMatchObject({ ok: true, masked: true })
    expect(bytes).not.toContain('abcdefghijklmnop')
    expect(redactSecrets(bytes)).toBe(bytes)
  })

  it('G6: detach removes the whole iNFT dir and its scratch dir, and never spawns (keychain untouched)', () => {
    const dir = root()
    const tmp = root()

    writeFileAtomic(path.join(dir, SLUG, 'acp', 'config.json'), '{}')
    writeFileAtomic(path.join(dir, SLUG, 'notes.json'), '{}')
    writeFileAtomic(path.join(tmp, SLUG, 'x'), '')
    writeFileAtomic(path.join(dir, 'other-1', 'status.json'), '{}')

    const result = removeInftDirs(dir, tmp, SLUG)

    expect(result).toEqual({ ok: true, removed: [path.join(dir, SLUG), path.join(tmp, SLUG)] })
    expect(readdirSync(dir)).toEqual(['other-1'])
    expect(readdirSync(tmp)).toEqual([])
    expect(removeInftDirs(dir, tmp, '..').ok).toBe(false)
    expect(childProcess.spawn).not.toHaveBeenCalled()
    expect(childProcess.spawnSync).not.toHaveBeenCalled()
  })
})

describe('R6 r4 — labelled seed phrases, card numbers, whoami shapes, the blocked TTL', () => {
  const words = 'abandon ability able about above absent absorb abstract absurd abuse access accident'

  it('masks a labelled seed phrase or mnemonic whole, through the end of the line', () => {
    for (const label of [
      'seed phrase: ',
      'mnemonic = ',
      'my seed-phrase:',
      'Recovery phrase: ',
      'secret recovery phrase = '
    ]) {
      const out = redactSecrets(`${label}${words}\nnext line stays`)

      expect(out).toContain('[redacted]\nnext line stays')

      for (const w of words.split(' ')) {
        expect(out).not.toMatch(new RegExp(`\\b${w}\\b`))
      }
    }

    expect(redactSecrets('mnemonic: a b c')).toBe('mnemonic: [redacted]')
    expect(redactSecrets(redactSecrets(`seed phrase: ${words}`))).toBe('seed phrase: [redacted]')
    expect(redactSecrets('the seeds were planted')).toBe('the seeds were planted')
  })

  it('masks a Luhn-valid card number typed in a note, never timestamps, amounts or ids', () => {
    expect(redactSecrets('card 4242 4242 4242 4242 exp 12/30')).toBe('card [redacted card number] exp 12/30')
    expect(redactSecrets('pan 4242-4242-4242-4242 or 378282246310005')).toBe(
      'pan [redacted card number] or [redacted card number]'
    )

    const plain = 'checkedAt 1760000000000 amount 10000 id 4242424242424241 token 6'

    expect(redactSecrets(plain)).toBe(plain)
  })

  it('reads an empty whoami object as no answer and a nested or string verified:false as a waiting link', () => {
    expect(cardStateFrom(run('{}'))).toEqual({ answered: false })
    expect(cardStateFrom(run('{"verified":"false"}'))).toMatchObject({ answered: true, state: 'signin-pending' })
    expect(cardStateFrom(run('{"data":{"verified":false}}'))).toMatchObject({ answered: true, state: 'signin-pending' })
    expect(cardStateFrom(run('{"id":"c1","verified":true}'))).toEqual({ answered: true, state: 'ready' })
  })

  it('a blocked account is not re-read inside the 15-min hold', () => {
    const now = 10 * CARD_BLOCKED_TTL_MS
    const blocked = { cardState: 'blocked' as const, cardCheckedAt: now - CARD_TTL_MS - 60_000 }

    expect(cardProbeDue(blocked, now)).toBe(false)
    expect(cardProbeDue({ ...blocked, cardCheckedAt: now - CARD_BLOCKED_TTL_MS - 1 }, now)).toBe(true)
    expect(cardProbeDue(blocked, now, CARD_TTL_MS, { card: true })).toBe(true)
  })
})

describe('R6 r4 — cardCheckedAt is the START of the card read', () => {
  it('a whoami that began before a signup and answered after it is stamped with its start', async () => {
    vi.useFakeTimers()

    try {
      const started = Date.now()

      const status: InftAcpStatus = {
        cli: true,
        authenticated: true,
        agentId: 'a1',
        cardReady: false,
        configured: true,
        checkedAt: started,
        slug: SLUG
      }

      const fake = async (argv: string[]) => {
        if (argv[0] === 'card') {
          await vi.advanceTimersByTimeAsync(30_000)
        }

        return run(argv[0] === 'card' ? '{"verified":true}' : '{}')
      }

      await probeAgentFacets(fake, status, null, { card: true })

      expect(status.cardState).toBe('ready')
      expect(status.cardCheckedAt).toBe(started)
      expect(Date.now() - started).toBeGreaterThanOrEqual(30_000)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('R6 r5 — structured seed phrases; a detached iNFT takes no late kv write', () => {
  const w = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ')
  const leaks = (text: string) => w.filter(x => new RegExp(`\\b${x}\\b`).test(text)).length

  it('masks a JSON array, camelCase keys and a numbered list under a label — idempotently', () => {
    const samples = [
      `{"mnemonic":[${w.map(x => `"${x}"`).join(',')}],"n":[1,2]}`,
      `{"recoveryPhrase":"${w.join(' ')}"}`,
      `{"secretRecoveryPhrase": "${w.join(' ')}", "mnemonicPhrase":"${w.join(' ')}", "seedWords": [ "${w[0]}" , "${w[1]}" ]}`,
      `Seed phrase:\n${w.map((x, i) => `${i + 1}. ${x}`).join('\n')}\nNext: open the app`,
      `recovery phrase\n${w.map(x => ` - ${x}`).join('\r\n')}`,
      `seed words: ${w.map((x, i) => `${i + 1}) ${x}`).join(' ')}`
    ]

    for (const sample of samples) {
      const out = redactSecrets(sample)

      expect(leaks(out)).toBe(0)
      expect(redactSecrets(out)).toBe(out)
    }

    expect(redactSecrets(samples[0])).toBe('{"mnemonic":["[redacted]"],"n":[1,2]}')
    expect(redactSecrets(samples[3])).toBe('Seed phrase: [redacted]\nNext: open the app')
  })

  it("a label's separator never swallows an unrelated next line", () => {
    expect(redactSecrets('seed:\nunrelated text stays')).toBe('seed:\nunrelated text stays')
    expect(redactSecrets('mnemonic =\nthe next step')).toBe('mnemonic =\nthe next step')
    expect(redactSecrets('seed: abandon ability\nnext line')).toBe('seed: [redacted]\nnext line')
  })

  it('redactDeep masks every leaf under a seed-phrase key, keeping the shape', () => {
    expect(redactDeep({ wallet: { mnemonic: w.slice(0, 2), recoveryPhrase: w.join(' ') }, note: 'hi' })).toEqual({
      value: { wallet: { mnemonic: ['[redacted]', '[redacted]'], recoveryPhrase: '[redacted]' }, note: 'hi' },
      masked: true
    })
  })

  it('refuses a kv write for an iNFT detached in the last two minutes (no dir re-created)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'r6r5-'))
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'r6r5t-'))
    const slug = 'robinhood-0x4dfb000000000000000000000000000000000000-77'
    const t = 5_000_000

    expect(writeInftKv(dir, slug, 'card-signup', { phase: 'polling', state: 's1' }, t).ok).toBe(true)
    expect(removeInftDirs(dir, tmp, slug, t).ok).toBe(true)
    expect(writeInftKv(dir, slug, 'card-signup', { phase: 'cooldown', cooldownUntil: t + 1 }, t + 90_000)).toEqual({
      ok: false,
      error: 'this iNFT was just detached'
    })
    expect(readdirSync(dir)).toEqual([])
    expect(writeInftKv(dir, slug, 'card-signup', { phase: 'polling', state: 's2' }, t + DETACH_QUIET_MS).ok).toBe(true)
  })
})

describe('R6 r6 — main owns the one card signup per iNFT', () => {
  const refused = (reason: string) => `refused: ${reason}`

  it('refuses a second signup while the first runs, and frees the slot when it exits', async () => {
    let finish: (v: string) => void = () => undefined

    const first = withCardSignupSlot(
      'slot-a',
      ['card', 'signup', '--email', 'a@x.io', '--json'],
      () => new Promise<string>(r => (finish = r)),
      refused
    )

    expect(cardSignupRunning('slot-a')).toBe(true)
    await expect(
      withCardSignupSlot('slot-a', ['card', 'signup', '--json'], async () => 'two', refused)
    ).resolves.toEqual(`refused: ${SIGNUP_RUNNING}`)
    // Another iNFT, or any other command for this one, is untouched.
    await expect(withCardSignupSlot('slot-b', ['card', 'signup'], async () => 'b', refused)).resolves.toBe('b')
    await expect(withCardSignupSlot('slot-a', ['card', 'signup-poll'], async () => 'poll', refused)).resolves.toBe(
      'poll'
    )
    finish('one')
    await expect(first).resolves.toBe('one')
    expect(cardSignupRunning('slot-a')).toBe(false)

    // Free again once the one-minute resend wait after its answer is over.
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      vi.setSystemTime(Date.now() + CARD_RESEND_WAIT_MS)
      await expect(withCardSignupSlot('slot-a', ['card', 'signup'], async () => 'again', refused)).resolves.toBe(
        'again'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('V3-L M2: one sign-in link a minute per iNFT — refused inside the minute with its end, sent after it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      const t0 = Date.parse('2026-10-21T10:00:00.000Z')
      let sent = 0

      const send = () =>
        withCardSignupSlot('wait-a', ['card', 'signup', '--json'], async () => `sent ${++sent}`, refused)

      vi.setSystemTime(t0)
      await expect(send()).resolves.toBe('sent 1')
      expect(cardResendAt('wait-a')).toBe(t0 + CARD_RESEND_WAIT_MS)

      vi.setSystemTime(t0 + CARD_RESEND_WAIT_MS - 1)
      const inside = await send()

      expect(sent).toBe(1)
      expect(inside).toContain(`[${RESEND_AT_MARK}${t0 + CARD_RESEND_WAIT_MS}]`)
      // Another iNFT and every other card call are untouched by the wait.
      await expect(withCardSignupSlot('wait-b', ['card', 'signup'], async () => 'b', refused)).resolves.toBe('b')
      await expect(withCardSignupSlot('wait-a', ['card', 'whoami'], async () => 'read', refused)).resolves.toBe('read')

      vi.setSystemTime(t0 + CARD_RESEND_WAIT_MS)
      await expect(send()).resolves.toBe('sent 2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('V3-L M2: the minute counts from the answer of a slow send, not from its start', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      const t0 = Date.parse('2026-10-21T11:00:00.000Z')

      vi.setSystemTime(t0)
      await withCardSignupSlot(
        'wait-slow',
        ['card', 'signup'],
        async () => {
          vi.setSystemTime(t0 + 40_000)

          return 'answered'
        },
        refused
      )
      expect(cardResendAt('wait-slow')).toBe(t0 + 40_000 + CARD_RESEND_WAIT_MS)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a timed-out or failed signup frees the slot too', async () => {
    await expect(
      withCardSignupSlot('slot-c', ['card', 'signup'], () => Promise.reject(new Error('timed out')), refused)
    ).rejects.toThrow('timed out')
    expect(cardSignupRunning('slot-c')).toBe(false)
  })

  it('after any signup the card probe is due until a read that started after it answers', async () => {
    expect(cardDueSince('slot-d')).toBeUndefined()

    const before = Date.now()

    await withCardSignupSlot('slot-d', ['card', 'signup'], async () => 'failed', refused)

    const due = cardDueSince('slot-d') as number

    expect(due).toBeGreaterThanOrEqual(before)
    settleCardDue('slot-d', undefined)
    settleCardDue('slot-d', due - 1)
    expect(cardDueSince('slot-d')).toBe(due)
    settleCardDue('slot-d', due)
    expect(cardDueSince('slot-d')).toBeUndefined()
  })

  it('recognises card signup only (never signup-poll, whoami or a word elsewhere)', () => {
    expect(isCardSignup(['card', 'signup', '--json'])).toBe(true)
    expect(isCardSignup(['card', 'signup-poll', '--state', 's'])).toBe(false)
    expect(isCardSignup(['card', 'whoami'])).toBe(false)
    expect(isCardSignup(['email', 'search', '--query', 'signup'])).toBe(false)
  })
})

describe('R6 r6 — a bare BIP39 mnemonic (no label, no key) is masked whole', () => {
  const twelve = 'abandon ability able about above absent absorb abstract absurd abuse access accident'

  it('masks 12 and 24 list words in a row, across spaces, newlines and commas', () => {
    expect(redactSecrets(`here: ${twelve} ok`)).toBe('here: [redacted seed phrase] ok')
    expect(redactSecrets(`${twelve}\n${twelve}`)).toBe('[redacted seed phrase]')
    expect(redactSecrets(twelve.toUpperCase().split(' ').join(', '))).toBe('[redacted seed phrase]')
    expect(redactSecrets(redactSecrets(`x ${twelve}`))).toBe('x [redacted seed phrase]')
  })

  it('leaves 11 words and ordinary prose alone', () => {
    const eleven = twelve.split(' ').slice(0, 11).join(' ')

    expect(redactSecrets(eleven)).toBe(eleven)
    expect(redactSecrets(`${eleven} xylophonic ${eleven}`)).toBe(`${eleven} xylophonic ${eleven}`)

    const prose =
      'The card service answered with a sign-in link; open it in the agent inbox and wait for the next step.'

    expect(redactSecrets(prose)).toBe(prose)
  })
})

describe("R6 r6b — a signup that answered 403/429 holds main's card re-read", () => {
  const refused = (reason: string) => run('', false, reason)
  const signup = ['card', 'signup', '--email', 'a@mail.acp.virtuals.io', '--json']

  async function signupAnswering(slug: string, answer: ReturnType<typeof run>) {
    const before = Date.now()

    await withCardSignupSlot(slug, signup, async () => answer, refused)

    return { before, after: Date.now() }
  }

  it('a 429 holds 60 s, a 403 or "blocked" 15 min; the due mark survives and is due right after', async () => {
    const { before, after } = await signupAnswering('hold-429', run('{"error":"HTTP 429: Too Many Requests"}', false))
    const until = cardSignupHeldUntil('hold-429') as number

    expect(until).toBeGreaterThanOrEqual(before + CARD_RATE_HOLD_MS)
    expect(until).toBeLessThanOrEqual(after + CARD_RATE_HOLD_MS)
    expect(cardDueSince('hold-429')).toBeUndefined()
    expect(cardDueSince('hold-429', until - 1)).toBeUndefined()
    expect(cardDueSince('hold-429', until)).toBe(until - CARD_RATE_HOLD_MS)
    expect(cardSignupHeldUntil('hold-429')).toBeUndefined()

    await signupAnswering('hold-403', run('{"error":"HTTP 403: Forbidden"}', false))
    expect((cardSignupHeldUntil('hold-403') as number) - (cardDueSince('hold-403', Infinity) ?? 0)).toBe(
      CARD_BLOCKED_TTL_MS
    )

    await signupAnswering('hold-blocked', { ...run('', false), stderr: 'Error: this account is blocked' })
    expect(cardSignupHeldUntil('hold-blocked')).toBeGreaterThan(Date.now() + CARD_RATE_HOLD_MS)
  })

  it('any other answer keeps the immediate re-read (sent, 400, 5xx, timeout, refusal, throw, non-CLI result)', async () => {
    expect(signupHoldMs(run('{"ok":true,"state":"s1"}'))).toBe(0)
    expect(signupHoldMs(run('{"error":"HTTP 400: bad email"}', false))).toBe(0)
    expect(signupHoldMs(run('{"error":"HTTP 502: Bad Gateway"}', false))).toBe(0)
    expect(signupHoldMs(run('', false, 'TIMEOUT'))).toBe(0)
    expect(signupHoldMs(undefined)).toBe(0)

    await signupAnswering('hold-none', run('{"error":"HTTP 500"}', false))
    expect(cardSignupHeldUntil('hold-none')).toBeUndefined()
    expect(cardDueSince('hold-none')).toBeDefined()

    await expect(
      withCardSignupSlot('hold-throw', signup, () => Promise.reject(new Error('boom')), refused)
    ).rejects.toThrow('boom')
    expect(cardSignupHeldUntil('hold-throw')).toBeUndefined()
    expect(cardDueSince('hold-throw')).toBeDefined()

    await withCardSignupSlot(
      'hold-shape',
      signup,
      async () => 'HTTP 429',
      () => 'refused'
    )
    expect(cardSignupHeldUntil('hold-shape')).toBeUndefined()
  })

  it('inside the hold a signup is refused with its end; an answerless signup never shortens a hold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      const t0 = Date.parse('2026-10-16T10:00:00.000Z')
      let sent = 0

      const answering = (answer: ReturnType<typeof run>) =>
        withCardSignupSlot('hold-enforced', signup, async () => (sent++, answer), refused)

      vi.setSystemTime(t0)
      await answering(run('{"error":"HTTP 429: Too Many Requests"}', false))
      vi.setSystemTime(t0 + CARD_RATE_HOLD_MS - 1)
      const inside = await answering(run('{"ok":true}'))

      expect(sent).toBe(1)
      expect(inside.error).toContain(`[${HELD_UNTIL_MARK}${t0 + CARD_RATE_HOLD_MS}]`)
      expect(inside.error).toContain('HTTP 429')
      expect(inside.error).toContain(new Date(t0 + CARD_RATE_HOLD_MS).toISOString())

      // The 429 ran out: the next signup goes, and its 403 holds 15 min.
      vi.setSystemTime(t0 + CARD_RATE_HOLD_MS)
      await answering(run('{"error":"HTTP 403: Forbidden"}', false))
      const until = t0 + CARD_RATE_HOLD_MS + CARD_BLOCKED_TTL_MS

      expect(sent).toBe(2)
      expect(cardSignupHold('hold-enforced')).toEqual({ until, rateLimited: false, httpStatus: 403 })

      vi.setSystemTime(until - 1)
      await answering(run('', false, 'TIMEOUT after 120 s'))
      expect(sent).toBe(2)
      expect(cardSignupHeldUntil('hold-enforced')).toBe(until)
      expect(signupHeldReason({ until, rateLimited: false, httpStatus: 403 })).toContain('HTTP 403 (blocked)')

      vi.setSystemTime(until)
      await answering(run('', false, 'TIMEOUT after 120 s'))
      expect(sent).toBe(3)
      expect(cardSignupHeldUntil('hold-enforced')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the agent door judges the hold by its captured output', async () => {
    const said = { stdout: '{"error":"HTTP 429: Too Many Requests"}', stderr: '' }

    await withCardSignupSlot(
      'hold-agent',
      signup,
      async () => ({ code: 1 as number | null, error: undefined as string | undefined }),
      reason => ({ code: null, error: reason }),
      result => ({ ok: result.code === 0 && !result.error, code: result.code, ...said, error: result.error })
    )
    expect(cardSignupHold('hold-agent')?.rateLimited).toBe(true)
  })

  it('status inside the hold: a 403 reads blocked with its end, a 429 stale with its end', async () => {
    const now = Date.now()
    const fake = async (argv: string[]) => (argv[0] === 'card' ? run('{"state":"none"}') : run('{}'))
    const base = { cli: true, authenticated: true, agentId: 'a1', cardReady: false, configured: true, checkedAt: now }
    const last = { ...base, slug: 'x', cardState: 'none', cardCheckedAt: now - 1_000 } as InftAcpStatus

    await signupAnswering('status-403', run('{"error":"HTTP 403: Forbidden"}', false))
    const blocked = { ...base, slug: 'status-403' } as InftAcpStatus

    await probeAgentFacets(fake, blocked, last, { card: false, cardHeld: true })
    expect(blocked.cardState).toBe('blocked')
    expect(blocked.cardReady).toBe(false)
    expect(blocked.cardHttpStatus).toBe(403)
    expect(blocked.cardHeldUntil).toBe(cardSignupHeldUntil('status-403'))
    expect(blocked.cardCheckedAt).toBe(last.cardCheckedAt)

    await signupAnswering('status-429', run('{"error":"HTTP 429: Too Many Requests"}', false))
    const limited = { ...base, slug: 'status-429' } as InftAcpStatus

    await probeAgentFacets(fake, limited, last, { force: true, cardHeld: true })
    expect(limited.cardState).toBe('none')
    expect(limited.cardStale).toBe(true)
    expect(limited.cardHeldUntil).toBe(cardSignupHeldUntil('status-429'))

    const free = { ...base, slug: 'status-free' } as InftAcpStatus

    await probeAgentFacets(fake, free, last, { force: true })
    expect(free.cardHeldUntil).toBeUndefined()
  })

  it('inside the hold no card whoami runs, even forced or past the TTL; email and signer still do', async () => {
    const now = Date.now()
    const calls: string[] = []

    const fake = async (argv: string[]) => {
      calls.push(argv.slice(0, 2).join(' '))

      return run('{"error":"HTTP 429: Too Many Requests"}', false)
    }

    const status = {
      cli: true,
      authenticated: true,
      agentId: 'a1',
      cardReady: false,
      configured: true,
      checkedAt: now,
      slug: SLUG
    } as InftAcpStatus

    const last = {
      ...status,
      cardState: 'none',
      cardCheckedAt: now - 2 * CARD_TTL_MS,
      emailCheckedAt: now,
      signerCheckedAt: now
    } as InftAcpStatus

    await probeAgentFacets(fake, status, last, { force: true, card: false, cardHeld: true })
    expect(calls.filter(call => call === 'card whoami')).toHaveLength(0)
    expect(calls).toEqual(expect.arrayContaining(['email whoami', 'agent signer-policy']))
    expect(status.cardState).toBe('none')
    expect(status.cardCheckedAt).toBe(last.cardCheckedAt)

    const other = { ...status, agentId: 'a2' } as InftAcpStatus

    await probeAgentFacets(fake, other, last, { cardHeld: true })
    expect(calls.filter(call => call === 'card whoami')).toHaveLength(0)
    expect(other.cardState).toBeUndefined()
    expect(other.cardStale).toBe(true)
  })

  it('recognises card signup only as the first two words', () => {
    expect(isCardSignup(['--json', 'card', 'signup'])).toBe(false)
    expect(isCardSignup(['email', 'send', '--subject', 'card', 'signup'])).toBe(false)
    expect(isCardSignup(['card', 'signup'])).toBe(true)
  })
})

describe("R6 r8 — main's signup hold survives an app restart", () => {
  const signup = ['card', 'signup', '--email', 'a@mail.acp.virtuals.io', '--json']
  const forbidden = () => run('{"error":"HTTP 403: Forbidden"}', false)
  const refused = (reason: string) => run('', false, reason)

  /** A fresh main process: new module state, the same userData on disk. */
  async function restart(root: string) {
    vi.resetModules()
    const signupModule = await import('./iclone-acp-signup')
    const acp = await import('./iclone-acp')

    signupModule.persistCardHoldsUnder(() => root)

    return { ...signupModule, probeAgentFacets: acp.probeAgentFacets }
  }

  function heldStatus(slug: string, extra: Partial<InftAcpStatus> = {}): InftAcpStatus {
    const now = Date.now()

    return {
      cli: true,
      authenticated: true,
      agentId: 'a1',
      cardReady: false,
      configured: true,
      checkedAt: now,
      slug,
      emailCheckedAt: now,
      signerCheckedAt: now,
      signerReady: true,
      ...extra
    }
  }

  it('a 403 hold is recorded under the iNFT dir and refuses a signup after a restart, then the re-read is due', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'r6r8-hold-'))
    const before = await restart(root)

    await before.withCardSignupSlot('r8-403', signup, async () => forbidden(), refused)
    const until = before.cardSignupHeldUntil('r8-403') as number
    const file = path.join(root, 'r8-403', 'card-hold.json')

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      until,
      rateLimited: false,
      httpStatus: 403,
      endedAt: until - CARD_BLOCKED_TTL_MS
    })

    const after = await restart(root)
    const task = vi.fn(async () => forbidden())

    expect(after.cardSignupHold('r8-403')).toEqual({ until, rateLimited: false, httpStatus: 403 })
    expect((await after.withCardSignupSlot('r8-403', signup, task, refused)).error).toContain(
      `${HELD_UNTIL_MARK}${until}`
    )
    expect(task).not.toHaveBeenCalled()
    expect(after.cardDueSince('r8-403', until - 1)).toBeUndefined()

    // A third process after the hold: the due mark comes back from the record, which is then dropped.
    const third = await restart(root)

    expect(third.cardDueSince('r8-403', until)).toBe(until - CARD_BLOCKED_TTL_MS)
    // The hold record is dropped; the due mark stays recorded until a card read settles it, and the last
    // send's minute until it is over.
    expect(readdirSync(path.join(root, 'r8-403'))).toEqual(['card-due.json', 'card-sent.json'])
  })

  it('a record never shortens the hold in memory; a malformed or impossible record reads as no hold', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'r6r8-hold-'))
    const now = Date.now()
    const m = await restart(root)

    const write = (slug: string, value: unknown) => {
      writeFileAtomic(path.join(root, slug, 'card-hold.json'), JSON.stringify(value))
    }

    m.adoptCardSignupHold('r8-grow', { until: now + 600_000, rateLimited: false, httpStatus: 403 }, now)
    m.adoptCardSignupHold('r8-grow', { until: now + 30_000, rateLimited: true, httpStatus: 429 }, now)
    expect(m.cardSignupHeldUntil('r8-grow', now)).toBe(now + 600_000)
    expect(JSON.parse(readFileSync(path.join(root, 'r8-grow', 'card-hold.json'), 'utf8')).until).toBe(now + 600_000)

    write('r8-bad-1', { until: 'soon', rateLimited: false, endedAt: now })
    write('r8-bad-2', { until: now + CARD_BLOCKED_TTL_MS * 4, rateLimited: false, endedAt: now })
    write('r8-bad-3', { until: now + 1000, rateLimited: false, endedAt: now + 2000 })
    write('r8-bad-4', { until: now + 1000, rateLimited: false, httpStatus: 200, endedAt: now })
    writeFileSync(path.join(root, 'r8-bad-1', 'card-hold.json.junk'), '{')

    const after = await restart(root)

    for (const slug of ['r8-bad-1', 'r8-bad-2', 'r8-bad-3', 'r8-bad-4', '../escape']) {
      expect(after.cardSignupHold(slug, now)).toBeUndefined()
    }

    expect(after.cardSignupHeldUntil('r8-grow', now)).toBe(now + 600_000)
  })

  it('detach wipes the hold: the record goes with the dir, memory forgets it, no late write re-creates it', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'r6r8-hold-'))
    const m = await restart(root)

    await m.withCardSignupSlot('r8-detach', signup, async () => forbidden(), refused)
    expect(m.cardSignupHold('r8-detach')).toBeDefined()

    const store = await import('./iclone-acp-store')

    store.removeInftDirs(root, path.join(root, 'tmp'), 'r8-detach')
    m.forgetCardSignup('r8-detach')
    expect(m.cardSignupHold('r8-detach')).toBeUndefined()
    expect(m.cardDueSince('r8-detach')).toBeUndefined()

    m.adoptCardSignupHold('r8-detach', { until: Date.now() + 60_000, rateLimited: true, httpStatus: 429 })
    expect(readdirSync(root)).not.toContain('r8-detach')
    expect((await restart(root)).cardSignupHold('r8-detach')).toBeUndefined()
  })

  it("a persisted status's cardHeldUntil is a second record: 0 card whoami, blocked, and main adopts it", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'r6r8-hold-'))
    const m = await restart(root)
    const now = Date.now()
    const until = now + 13 * 60_000

    // A pre-signup stamp whose blocked TTL ends long before the hold does.
    const last = heldStatus('r8-carried', {
      cardState: 'blocked',
      cardHttpStatus: 403,
      cardCheckedAt: now - 16 * 60_000,
      cardHeldUntil: until
    })

    const calls: string[][] = []

    const runFake = async (argv: string[]) => {
      calls.push(argv)

      return run('{"error":"HTTP 404: card not set up — call card signup"}', false)
    }

    const status = heldStatus('r8-carried')

    await m.probeAgentFacets(runFake, status, last, { force: true })
    expect(calls.filter(argv => argv[0] === 'card')).toEqual([])
    expect(status).toMatchObject({ cardState: 'blocked', cardHeldUntil: until, cardHttpStatus: 403, cardReady: false })
    expect(m.cardSignupHeldUntil('r8-carried')).toBe(until)

    const task = vi.fn(async () => forbidden())

    await m.withCardSignupSlot('r8-carried', signup, task, refused)
    expect(task).not.toHaveBeenCalled()

    // Expired, or another agent's: not a hold — the card is read.
    const other = heldStatus('r8-other')

    await m.probeAgentFacets(runFake, other, { ...last, slug: 'r8-other', cardHeldUntil: now - 1 })
    await m.probeAgentFacets(runFake, heldStatus('r8-agent', { agentId: 'a2' }), {
      ...last,
      slug: 'r8-agent',
      cardHeldUntil: until
    })
    expect(calls.filter(argv => argv[0] === 'card')).toHaveLength(2)
    expect(m.cardSignupHold('r8-agent')).toBeUndefined()
  })
})

describe("R6 r9 — main's due mark is recorded before the send and read back after a restart", () => {
  const signup = ['card', 'signup', '--email', 'a@mail.acp.virtuals.io', '--json']
  const refused = (reason: string) => run('', false, reason)

  const timedOut = (): AcpRunResult => ({
    ok: false,
    code: null,
    stdout: '',
    stderr: '',
    error: 'timed out after 120s'
  })

  const dueFile = (root: string, slug: string) => path.join(root, slug, 'card-due.json')
  const readDue = (root: string, slug: string) => JSON.parse(readFileSync(dueFile(root, slug), 'utf8')) as unknown

  async function restart(root: string) {
    vi.resetModules()
    const signupModule = await import('./iclone-acp-signup')
    const acp = await import('./iclone-acp')

    signupModule.persistCardHoldsUnder(() => root)

    return { ...signupModule, probeAgentFacets: acp.probeAgentFacets }
  }

  function signedIn(slug: string, extra: Partial<InftAcpStatus> = {}): InftAcpStatus {
    const now = Date.now()

    return {
      cli: true,
      authenticated: true,
      agentId: 'a1',
      cardReady: false,
      configured: true,
      checkedAt: now,
      slug,
      email: 'a@mail.acp.virtuals.io',
      emailCheckedAt: now,
      signerCheckedAt: now,
      signerReady: true,
      ...extra
    }
  }

  /** What readStatus does with the due mark (iclone-acp.ts): force the card read, settle on an answer. */
  async function statusRead(m: Awaited<ReturnType<typeof restart>>, slug: string, last: InftAcpStatus, answer: string) {
    const status = signedIn(slug)
    const calls: string[][] = []
    const due = m.cardDueSince(slug)

    await m.probeAgentFacets(
      async argv => {
        calls.push(argv)

        return run(argv[0] === 'card' ? answer : '{}', argv[0] !== 'card')
      },
      status,
      last,
      due === undefined ? {} : { card: true }
    )

    if (!status.cardStale) {
      m.settleCardDue(slug, status.cardCheckedAt)
    }

    return { status, cardCalls: calls.filter(argv => argv[0] === 'card').length }
  }

  it('a signup without an answer, then a restart: the cached pre-signup none is re-read, never served', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'r6r9-due-'))
    const before = await restart(root)
    const sentAt = Date.now()
    let onDisk: unknown

    await before.withCardSignupSlot(
      'r9-timeout',
      signup,
      async () => {
        onDisk = readDue(root, 'r9-timeout')

        return timedOut()
      },
      refused
    )

    // Written before the task ran, i.e. before the CLI was spawned; stamped again when it ended.
    expect((onDisk as { since: number }).since).toBeGreaterThanOrEqual(sentAt)
    expect(Object.keys(onDisk as object)).toEqual(['since'])
    expect(statSync(dueFile(root, 'r9-timeout')).mode & 0o777).toBe(0o600)
    expect(before.cardSignupHold('r9-timeout')).toBeUndefined()

    const ended = (readDue(root, 'r9-timeout') as { since: number }).since
    const after = await restart(root)

    expect(after.cardDueSince('r9-timeout')).toBe(ended)

    // The last read (60 s before the signup) said 'none', well inside the card TTL.
    const last = signedIn('r9-timeout', {
      cardState: 'none',
      cardCheckedAt: sentAt - 60_000,
      checkedAt: sentAt - 60_000
    })

    const read = await statusRead(
      after,
      'r9-timeout',
      last,
      '{"error":"REAUTH:1f2e3d4c-aaaa-bbbb-cccc-000000000000:a@mail.acp.virtuals.io"}'
    )

    expect(read.cardCalls).toBe(1)
    expect(read.status.cardState).toBe('signin-pending')
    expect(after.cardDueSince('r9-timeout')).toBeUndefined()
    expect(existsSync(dueFile(root, 'r9-timeout'))).toBe(false)

    // Settled: a third process serves the cache again.
    const third = await restart(root)

    expect(third.cardDueSince('r9-timeout')).toBeUndefined()
    expect((await statusRead(third, 'r9-timeout', read.status, '{}')).cardCalls).toBe(0)
  })

  it('a quit mid-signup: the pre-send record alone makes the re-read due; an older read never settles it', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'r6r9-due-'))
    const before = await restart(root)
    const sentAt = Date.now()

    // The CLI never answers in this process (the app quits while it runs).
    void before.withCardSignupSlot('r9-quit', signup, () => new Promise<never>(() => undefined), refused)
    await Promise.resolve()
    const since = (readDue(root, 'r9-quit') as { since: number }).since

    expect(since).toBeGreaterThanOrEqual(sentAt)

    const after = await restart(root)

    expect(after.cardSignupRunning('r9-quit')).toBe(false)
    expect(after.cardDueSince('r9-quit')).toBe(since)
    after.settleCardDue('r9-quit', since - 1)
    expect(after.cardDueSince('r9-quit')).toBe(since)
    expect(existsSync(dueFile(root, 'r9-quit'))).toBe(true)
    after.settleCardDue('r9-quit', since)
    expect(after.cardDueSince('r9-quit')).toBeUndefined()
    expect(existsSync(dueFile(root, 'r9-quit'))).toBe(false)
  })

  it("a read that answers while a signup runs settles only the older mark, never the running signup's record", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'r6r9-due-'))
    const m = await restart(root)
    let release: (value: ReturnType<typeof timedOut>) => void = () => undefined

    await m.withCardSignupSlot('r9-overlap', signup, async () => timedOut(), refused)
    const first = m.cardDueSince('r9-overlap') as number

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + m.CARD_RESEND_WAIT_MS)

    const second = m.withCardSignupSlot(
      'r9-overlap',
      signup,
      () => new Promise(resolve => (release = resolve)),
      refused
    )

    const runningSince = (readDue(root, 'r9-overlap') as { since: number }).since

    m.settleCardDue('r9-overlap', Math.max(first, runningSince))
    expect(m.cardDueSince('r9-overlap')).toBeUndefined()
    expect(readDue(root, 'r9-overlap')).toEqual({ since: runningSince })

    release(timedOut())
    await second
    vi.useRealTimers()
    expect(m.cardDueSince('r9-overlap')).toBeGreaterThanOrEqual(runningSince)
    expect(existsSync(dueFile(root, 'r9-overlap'))).toBe(true)
  })

  it('hostile due records never throw and never mean fewer card reads; detach wipes the record', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'r6r9-due-'))
    const now = Date.now()
    const write = (slug: string, text: string) => writeFileAtomic(dueFile(root, slug), text)

    write('r9-bad-1', '{')
    write('r9-bad-2', JSON.stringify({ since: 'soon' }))
    write('r9-bad-3', JSON.stringify({ since: -5 }))
    write('r9-bad-4', JSON.stringify({ since: now, extra: 1 }))
    write('r9-bad-5', JSON.stringify({ since: now, pad: 'x'.repeat(4096) }))
    write('r9-ahead', JSON.stringify({ since: now + 365 * 24 * 3_600_000 }))

    const m = await restart(root)

    for (const slug of ['r9-bad-1', 'r9-bad-2', 'r9-bad-3', 'r9-bad-4', 'r9-bad-5', '../escape']) {
      expect(m.cardDueSince(slug, now)).toBeUndefined()
    }

    // A stamp ahead of the clock counts from now: one forced read settles it.
    expect(m.cardDueSince('r9-ahead', now)).toBe(now)
    m.settleCardDue('r9-ahead', now)
    expect(m.cardDueSince('r9-ahead')).toBeUndefined()

    await m.withCardSignupSlot('r9-detach', signup, async () => timedOut(), refused)
    expect(existsSync(dueFile(root, 'r9-detach'))).toBe(true)

    const store = await import('./iclone-acp-store')

    store.removeInftDirs(root, path.join(root, 'tmp'), 'r9-detach')
    m.forgetCardSignup('r9-detach')
    // A late signup end inside the detach quiet writes nothing: the dir stays gone.
    await m.withCardSignupSlot('r9-detach', signup, async () => timedOut(), refused)
    expect(readdirSync(root)).not.toContain('r9-detach')
    expect(store.writeCardDue(root, 'r9-detach', { since: now })).toBe(false)
    expect((await restart(root)).cardDueSince('r9-detach')).toBeUndefined()
  })
})

describe("V3-L M2 — main's one-minute resend wait survives a window reopen and an app restart", () => {
  const signup = ['card', 'signup', '--email', 'a@mail.acp.virtuals.io', '--json']
  const refused = (reason: string) => run('', false, reason)
  const sentFile = (root: string, slug: string) => path.join(root, slug, 'card-sent.json')

  async function restart(root: string) {
    vi.resetModules()
    const signupModule = await import('./iclone-acp-signup')

    signupModule.persistCardHoldsUnder(() => root)

    return signupModule
  }

  it('a send, a restart inside the minute: refused with 0 sends; a restart after it: sent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      const root = mkdtempSync(path.join(os.tmpdir(), 'v3l-sent-'))
      const t0 = Date.parse('2026-10-21T12:00:00.000Z')
      const task = vi.fn(async () => run('{"state":"st-1"}'))

      vi.setSystemTime(t0)
      await (await restart(root)).withCardSignupSlot('m2-restart', signup, task, refused)
      expect(JSON.parse(readFileSync(sentFile(root, 'm2-restart'), 'utf8'))).toEqual({ at: t0 })

      vi.setSystemTime(t0 + 30_000)
      const after = await restart(root)
      const inside = await after.withCardSignupSlot('m2-restart', signup, task, refused)

      expect(task).toHaveBeenCalledTimes(1)
      expect(inside.error).toContain(`[${after.RESEND_AT_MARK}${t0 + after.CARD_RESEND_WAIT_MS}]`)

      vi.setSystemTime(t0 + after.CARD_RESEND_WAIT_MS)
      await (await restart(root)).withCardSignupSlot('m2-restart', signup, task, refused)
      expect(task).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('m2: a crash in the middle of a send — the pre-send stamp alone holds the minute after a restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      const root = mkdtempSync(path.join(os.tmpdir(), 'v3l-sent-'))
      const t0 = Date.parse('2026-10-21T13:00:00.000Z')
      const task = vi.fn(async () => run('{"state":"st-2"}'))

      vi.setSystemTime(t0)
      const before = await restart(root)

      // The CLI never answers in this process: the app crashes or quits while the link is going out.
      void before.withCardSignupSlot('m2-crash', signup, () => new Promise<never>(() => undefined), refused)
      await Promise.resolve()
      expect(JSON.parse(readFileSync(sentFile(root, 'm2-crash'), 'utf8'))).toEqual({ at: t0 })

      vi.setSystemTime(t0 + 10_000)
      const after = await restart(root)
      const inside = await after.withCardSignupSlot('m2-crash', signup, task, refused)

      expect(task).not.toHaveBeenCalled()
      expect(inside.error).toContain(`[${after.RESEND_AT_MARK}${t0 + after.CARD_RESEND_WAIT_MS}]`)

      vi.setSystemTime(t0 + after.CARD_RESEND_WAIT_MS)
      await (await restart(root)).withCardSignupSlot('m2-crash', signup, task, refused)
      expect(task).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('m4: the clock set back while the app runs — Resend waits one minute from now, never the step back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      const root = mkdtempSync(path.join(os.tmpdir(), 'v3l-sent-'))
      const t0 = Date.parse('2026-10-21T14:00:00.000Z')
      const back = t0 - 3_600_000
      const task = vi.fn(async () => run('{"state":"st-3"}'))
      const m = await restart(root)

      vi.setSystemTime(t0)
      await m.withCardSignupSlot('m4-back', signup, task, refused)

      // One hour back, no restart: the send in memory is ahead of the clock.
      vi.setSystemTime(back)
      expect(m.cardResendAt('m4-back')).toBe(back + m.CARD_RESEND_WAIT_MS)
      const inside = await m.withCardSignupSlot('m4-back', signup, task, refused)

      expect(task).toHaveBeenCalledTimes(1)
      expect(inside.error).toContain(`[${m.RESEND_AT_MARK}${back + m.CARD_RESEND_WAIT_MS}]`)

      // The minute after the step back is the whole wait.
      vi.setSystemTime(back + m.CARD_RESEND_WAIT_MS)
      expect(m.cardResendAt('m4-back')).toBeUndefined()
      await m.withCardSignupSlot('m4-back', signup, task, refused)
      expect(task).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('hostile sent records never throw and never mean an endless wait; detach wipes the record', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'v3l-sent-'))
    const now = Date.now()
    const write = (slug: string, text: string) => writeFileAtomic(sentFile(root, slug), text)

    write('m2-bad-1', '{')
    write('m2-bad-2', JSON.stringify({ at: 'soon' }))
    write('m2-bad-3', JSON.stringify({ at: now, extra: 1 }))
    write('m2-bad-4', JSON.stringify({ at: now, pad: 'x'.repeat(4096) }))
    write('m2-ahead', JSON.stringify({ at: now + 365 * 24 * 3_600_000 }))

    const m = await restart(root)

    for (const slug of ['m2-bad-1', 'm2-bad-2', 'm2-bad-3', 'm2-bad-4', '../escape']) {
      expect(m.cardResendAt(slug, now)).toBeUndefined()
    }

    // A stamp ahead of the clock counts from now: one minute, never a year.
    expect(m.cardResendAt('m2-ahead', now)).toBe(now + m.CARD_RESEND_WAIT_MS)
    // Over: the record is dropped.
    expect(m.cardResendAt('m2-ahead', now + m.CARD_RESEND_WAIT_MS)).toBeUndefined()
    expect(existsSync(sentFile(root, 'm2-ahead'))).toBe(false)

    await m.withCardSignupSlot('m2-detach', signup, async () => run('{"state":"s"}'), refused)
    expect(existsSync(sentFile(root, 'm2-detach'))).toBe(true)
    m.forgetCardSignup('m2-detach')
    expect(existsSync(sentFile(root, 'm2-detach'))).toBe(false)
    expect(m.cardResendAt('m2-detach')).toBeUndefined()
  })
})
