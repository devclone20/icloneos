import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readMainProcessSource } from './main/main-process-source'
import { BUNDLED_RUNTIME_PIN as PIN } from './update-policy'
import {
  checkRuntimeHealthCommit,
  ensureCuratedRuntimeConfig,
  gateUpdateApply,
  profileHermesHome,
  readJsonFile,
  sameCommit
} from './update-runtime-align'

const OLD = '10b388300a63d83857fac3ca4f8b05b64e01bc50'

// Rewritten for U1 (2026-10-19): the boot alignment dialog is gone. A runtime the user moved stays where it is; HEAD ≠ pin
// is passive copy in Settings › Updates, and only the user's click moves the runtime.
describe('no boot alignment (R1.align → U.no_auto)', () => {
  const main = () => readMainProcessSource(__dirname)

  it('no launch path asks to align or moves the runtime to the pin', () => {
    const src = main()

    expect(src).not.toMatch(/alignRuntimeAtBoot|prepareCuratedRuntime|alignDialogText/)
    // V3-J J4-1: the primary spawn turns the check off for the profile Hermes actually runs (the same slug its pay
    // token is minted for), falling back to the desktop's choice when the sticky value is one Hermes would refuse.
    expect(src).toMatch(/await ensureRuntimeUpdateCheckOff\(runsAs\.slug \?\? activeProfile\)/)
    expect(src).toMatch(/await ensureRuntimeUpdateCheckOff\(profile\)/)
  })

  it("the pre-spawn step only turns the runtime's own update check off", () => {
    const src = main()
    const start = src.indexOf('export function ensureRuntimeUpdateCheckOff(')
    const body = src.slice(start, src.indexOf('\n}\n', start))

    expect(body).toContain('ensureCuratedRuntimeConfig({')
    expect(body).not.toMatch(/runPinnedRuntimeUpdate|showMessageBox|install\.sh/)
  })

  it('the old "later" record is still read for About, and nothing writes a new one', () => {
    const src = main()

    expect(src).toContain('RUNTIME_ALIGN_FILE')
    expect(src).not.toMatch(/writeJsonFile\([^)]*RUNTIME_ALIGN_FILE/)
  })
})

describe('ensureCuratedRuntimeConfig (R1.runtime.config)', () => {
  let dir = ''

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-config-'))
  })

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  function deps(over: Partial<Parameters<typeof ensureCuratedRuntimeConfig>[0]> = {}) {
    return {
      exists: () => true,
      hermesBin: '/venv/bin/hermes',
      hermesHome: '/home/.hermes',
      log: () => {},
      markerFile: path.join(dir, 'curated-runtime-config.json'),
      policy: 'curated' as const,
      run: vi.fn(async () => ({ code: 0 })),
      runtimeSha: PIN.sha,
      ...over
    }
  }

  it('sets updates.check false once per HERMES_HOME, with a 10 s cap and HERMES_HOME in env', async () => {
    const first = deps()

    await expect(ensureCuratedRuntimeConfig(first)).resolves.toEqual({ ran: true })
    expect(first.run).toHaveBeenCalledTimes(1)

    const [cmd, args, opts] = vi.mocked(first.run).mock.calls[0] as unknown as [
      string,
      string[],
      { env: any; timeoutMs: number }
    ]

    expect([cmd, ...args]).toEqual(['/venv/bin/hermes', 'config', 'set', 'updates.check', 'false'])
    expect(opts.timeoutMs).toBe(10_000)
    expect(opts.env.HERMES_HOME).toBe('/home/.hermes')

    const second = deps()
    await expect(ensureCuratedRuntimeConfig(second)).resolves.toEqual({ ran: false, reason: 'marker' })
    expect(second.run).not.toHaveBeenCalled()

    const afterAlign = deps({ runtimeSha: 'f'.repeat(40) })
    await expect(ensureCuratedRuntimeConfig(afterAlign)).resolves.toEqual({ ran: true })
    expect(Object.keys(readJsonFile<object>(path.join(dir, 'curated-runtime-config.json')) ?? {})).toEqual([
      '/home/.hermes'
    ])
  })

  it('K-RT15 / m4: packaged, the CLI is the env Python on the verified tree, sealed, isolated, no bytecode written', async () => {
    const sealEnv = vi.fn((env: NodeJS.ProcessEnv) => ({ HERMES_HOME: String(env.HERMES_HOME), SEALED: '1' }))
    const d = deps({ sealed: { python: '/venv/bin/python', sealEnv } })

    await expect(ensureCuratedRuntimeConfig(d)).resolves.toEqual({ ran: true })

    const [cmd, args, opts] = vi.mocked(d.run).mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv }
    ]

    expect([cmd, ...args]).toEqual([
      '/venv/bin/python',
      '-s',
      '-P',
      '--check-hash-based-pycs',
      'always',
      '-m',
      'hermes_cli.main',
      'config',
      'set',
      'updates.check',
      'false'
    ])
    expect(opts.env).toEqual({ HERMES_HOME: '/home/.hermes', PYTHONDONTWRITEBYTECODE: '1', SEALED: '1' })
    expect(sealEnv).toHaveBeenCalledTimes(1)

    const src = readMainProcessSource(__dirname)
    const body = src.slice(src.indexOf('export function ensureRuntimeUpdateCheckOff('))

    // The integrity check runs before the CLI, and a refused runtime runs nothing.
    expect(body.indexOf('await checkRuntimeIntegrity(root)')).toBeGreaterThan(0)
    expect(body.indexOf('await checkRuntimeIntegrity(root)')).toBeLessThan(body.indexOf('ensureCuratedRuntimeConfig({'))
  })

  it('covers every HERMES_HOME a backend reads: the root and each --profile home, one marker key per home', async () => {
    const root = deps()
    const alpha = deps({ profile: 'alpha' })
    const beta = deps({ profile: 'beta' })

    await expect(Promise.all([root, alpha, beta].map(d => ensureCuratedRuntimeConfig(d)))).resolves.toEqual([
      { ran: true },
      { ran: true },
      { ran: true }
    ])

    const argsOf = (d: ReturnType<typeof deps>) => (vi.mocked(d.run).mock.calls[0] as unknown as [string, string[]])[1]

    expect(argsOf(alpha)).toEqual(['--profile', 'alpha', 'config', 'set', 'updates.check', 'false'])
    expect(argsOf(beta)).toEqual(['--profile', 'beta', 'config', 'set', 'updates.check', 'false'])
    expect(argsOf(root)).toEqual(['config', 'set', 'updates.check', 'false'])
    expect(Object.keys(readJsonFile<object>(path.join(dir, 'curated-runtime-config.json')) ?? {}).sort()).toEqual([
      '/home/.hermes',
      '/home/.hermes/profiles/alpha',
      '/home/.hermes/profiles/beta'
    ])

    const again = deps({ profile: 'beta' })
    await expect(ensureCuratedRuntimeConfig(again)).resolves.toEqual({ ran: false, reason: 'marker' })
    expect(again.run).not.toHaveBeenCalled()

    const gamma = deps({ profile: 'gamma' })
    await expect(ensureCuratedRuntimeConfig(gamma)).resolves.toEqual({ ran: true })
    expect(profileHermesHome('/home/.hermes', 'default')).toBe('/home/.hermes')
  })

  it('developer policy never touches config.yaml; a missing CLI or a failure fails open without a marker', async () => {
    const dev = deps({ policy: 'developer' })
    await expect(ensureCuratedRuntimeConfig(dev)).resolves.toEqual({ ran: false, reason: 'developer-policy' })
    expect(dev.run).not.toHaveBeenCalled()

    await expect(ensureCuratedRuntimeConfig(deps({ exists: () => false }))).resolves.toEqual({
      ran: false,
      reason: 'no-cli'
    })
    await expect(ensureCuratedRuntimeConfig(deps({ run: vi.fn(async () => ({ code: 1 })) }))).resolves.toEqual({
      ran: false,
      reason: 'cli-failed'
    })
    expect(fs.existsSync(path.join(dir, 'curated-runtime-config.json'))).toBe(false)
  })
})

// Rewritten for U1: a runtime ahead of the pin is the user's choice (door agent-latest), never a dialog at launch.
describe('runtime ahead of the pin (R1.probe.align_ahead → U1)', () => {
  it('ensureCuratedRuntimeConfig never moves the runtime, whatever HEAD is', async () => {
    const run = vi.fn(async () => ({ code: 0 }))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u1-ahead-'))

    await ensureCuratedRuntimeConfig({
      exists: () => true,
      hermesBin: '/x/venv/bin/hermes',
      hermesHome: dir,
      log: () => undefined,
      markerFile: path.join(dir, 'marker.json'),
      policy: 'curated',
      run,
      runtimeSha: 'f'.repeat(40)
    })

    expect(run.mock.calls.map(c => (c as unknown[])[1])).toEqual([['config', 'set', 'updates.check', 'false']])
    fs.rmSync(dir, { force: true, recursive: true })
  })
})

describe('checkRuntimeHealthCommit (R1.probe.health_commit)', () => {
  it('logs one line: match, mismatch, or unknown', async () => {
    const logs: string[] = []
    const log = (line: string) => void logs.push(line)

    await expect(
      checkRuntimeHealthCommit({ fetchCommit: async () => PIN.sha.slice(0, 12), head: PIN.sha, log })
    ).resolves.toMatchObject({
      state: 'match'
    })
    await expect(checkRuntimeHealthCommit({ fetchCommit: async () => OLD, head: PIN.sha, log })).resolves.toMatchObject(
      {
        state: 'mismatch'
      }
    )
    await expect(
      checkRuntimeHealthCommit({
        fetchCommit: async () => {
          throw new Error('down')
        },
        head: PIN.sha,
        log
      })
    ).resolves.toMatchObject({ state: 'unknown', commit: null })
    expect(logs).toHaveLength(3)
    expect(logs.every(line => line.startsWith('[iclone-runtime-pin] health commit'))).toBe(true)
    expect(logs[1]).toContain('MISMATCH')
  })
})

describe('checkRuntimeHealthCommit hardening (R1.r2.health_short_commit)', () => {
  it('never prefix-matches fewer than 7 hex digits on either side', async () => {
    const log = () => undefined

    for (const commit of ['1', '1ac', '1ac3f9', 'zzzzzzz']) {
      await expect(
        checkRuntimeHealthCommit({ fetchCommit: async () => commit, head: PIN.sha, log })
      ).resolves.toMatchObject({ state: 'unknown' })
    }

    await expect(
      checkRuntimeHealthCommit({ fetchCommit: async () => PIN.sha, head: PIN.sha.slice(0, 3), log })
    ).resolves.toMatchObject({ state: 'unknown', head: null })
    expect(sameCommit(PIN.sha.slice(0, 7), PIN.sha)).toBe(true)
    expect(sameCommit('1', PIN.sha)).toBe(false)
    expect(sameCommit(PIN.sha, '')).toBe(false)
  })

  it('compares HEAD with the bundled pin only when the align record says aligned or failed', async () => {
    const logs: string[] = []
    const log = (line: string) => void logs.push(line)

    const record = (result?: 'aligned' | 'failed') => ({
      answer: 'align' as const,
      at: '2026-10-16T00:00:00Z',
      head: OLD,
      pinSha: PIN.sha,
      ...(result ? { result } : {})
    })

    const aligned = await checkRuntimeHealthCommit({
      align: record('aligned'),
      fetchCommit: async () => OLD,
      head: OLD,
      log,
      pinSha: PIN.sha
    })

    expect(aligned).toMatchObject({ state: 'match', pin: 'mismatch' })
    expect(logs.at(-1)).toContain('is NOT the bundled pin')

    await expect(
      checkRuntimeHealthCommit({
        align: record('failed'),
        fetchCommit: async () => PIN.sha,
        head: PIN.sha,
        log,
        pinSha: PIN.sha
      })
    ).resolves.toMatchObject({ state: 'match', pin: 'match' })

    const later = await checkRuntimeHealthCommit({
      align: { ...record(), answer: 'later' },
      fetchCommit: async () => OLD,
      head: OLD,
      log,
      pinSha: PIN.sha
    })

    expect(later.pin).toBeUndefined()
    expect(logs).toHaveLength(3)
  })

  it('never calls an unreadable or non-hex HEAD a pin mismatch (R1.r3.health_pin_unknown_head)', async () => {
    const logs: string[] = []
    const log = (line: string) => void logs.push(line)

    const align = {
      answer: 'align' as const,
      at: '2026-10-16T00:00:00Z',
      head: OLD,
      pinSha: PIN.sha,
      result: 'aligned' as const
    }

    for (const head of [null, '', 'zz', 'not-a-sha', PIN.sha.slice(0, 3)]) {
      const out = await checkRuntimeHealthCommit({
        align,
        fetchCommit: async () => PIN.sha,
        head,
        log,
        pinSha: PIN.sha
      })

      expect(out.pin).toBeUndefined()
      expect(out.state).toBe('unknown')
      expect(logs.at(-1)).not.toContain('NOT the bundled pin')
      expect(logs.at(-1)).toContain('bundled pin check skipped')
    }

    // Upper-case HEAD is still evidence: it compares as the pin.
    await expect(
      checkRuntimeHealthCommit({
        align,
        fetchCommit: async () => PIN.sha,
        head: PIN.sha.toUpperCase(),
        log,
        pinSha: PIN.sha
      })
    ).resolves.toMatchObject({ pin: 'match', state: 'match' })
  })
})

describe('curated apply gate (R1.tests.electron.fail / R1-T7)', () => {
  function gateDeps(policy: 'curated' | 'developer', isWindows = false) {
    const git: string[][] = []
    const audits: Record<string, unknown>[] = []

    // the real refresh resolves the install target with `git ls-remote` of the moving ref (iclone-compat recheck)
    const refreshTarget = vi.fn(
      async () => void git.push(['ls-remote', 'https://github.com/NousResearch/hermes-agent', 'main'])
    )

    const compatGate = vi.fn((): null | { error: string } => null)

    return {
      audits,
      compatGate,
      deps: {
        audit: (entry: Record<string, unknown>) => void audits.push(entry),
        compatGate,
        isWindows,
        now: () => new Date('2026-10-16T00:00:00Z'),
        pin: PIN,
        policy,
        refreshTarget
      },
      git,
      refreshTarget
    }
  }

  it('curated reaches the pinned door with zero ls-remote calls, and audits the bundled verdict', async () => {
    const { audits, compatGate, deps, git, refreshTarget } = gateDeps('curated')
    const pinnedDoor = vi.fn(async () => ({ ok: true }))
    const gate = await gateUpdateApply(deps)

    if (gate.door === 'pinned') {
      await pinnedDoor()
    }

    expect(gate).toEqual({ door: 'pinned', refusal: null })
    expect(pinnedDoor).toHaveBeenCalledOnce()
    expect(git.filter(args => args.includes('ls-remote'))).toHaveLength(0)
    expect(refreshTarget).not.toHaveBeenCalled()
    expect(compatGate).not.toHaveBeenCalled()
    expect(audits).toEqual([
      { door: 'curated-apply', to: PIN.sha, verdict: PIN.verified, by: 'owner', at: '2026-10-16T00:00:00.000Z' }
    ])
  })

  it('developer (and Windows, unpinned in R1) refresh the target and let the compat gate refuse', async () => {
    const dev = gateDeps('developer')

    await expect(gateUpdateApply(dev.deps)).resolves.toEqual({ door: 'raw', refusal: null })
    expect(dev.git).toHaveLength(1)

    dev.compatGate.mockReturnValueOnce({ error: 'compat-gate' })
    await expect(gateUpdateApply(dev.deps)).resolves.toEqual({ door: null, refusal: { error: 'compat-gate' } })

    const win = gateDeps('curated', true)

    await expect(gateUpdateApply(win.deps)).resolves.toMatchObject({ door: 'raw' })
    expect(win.refreshTarget).toHaveBeenCalledOnce()
    expect(dev.audits).toHaveLength(0)
  })

  it('main.ts applyUpdates resolves no install target before the gate', () => {
    const main = readMainProcessSource(__dirname)
    const start = main.indexOf('async function applyUpdates(')
    const body = main.slice(start, main.indexOf('\n}\n', start))

    expect(body.indexOf('gateUpdateApply({')).toBeGreaterThan(-1)
    expect(body.match(/refreshInstallTarget\(\)/g)).toEqual(['refreshInstallTarget()'])
    expect(body).toContain('refreshTarget: () => refreshInstallTarget()')
    expect(body).toContain("if (gate.door === 'pinned')")
    expect(body).not.toMatch(/^\s*await refreshInstallTarget\(\)/m)
  })
})
