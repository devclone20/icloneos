import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type * as NodeOs from 'node:os'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterAll, describe, expect, it, vi } from 'vitest'

// @ts-expect-error -- a plain .mjs test fixture without types
import { confinedTree } from '../scripts/acp-launch-fixture.mjs'

import {
  type AcpRunResult,
  acpWrapperSource,
  type InftAcpStatus,
  launchArgv,
  parseJsonLoose,
  probeAgentFacets,
  redactCardOutput,
  registryRowFor,
  renderInftRegistry,
  resolveInftKey,
  slugForInft,
  timeoutReason,
  validateArgv,
  writeAcpWrapper
} from './iclone-acp'
import { startAcpSocketServer } from './iclone-acp-ipc'

// Only the readStatus test below drives main-process state: a throwaway HOME and userData, IPC handlers captured.
const lab = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? '/tmp').replace(/\/$/, '')
  const root = `${tmp}/iclone-acp-status-${process.pid}-${Date.now()}`

  return { handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(), root }
})

vi.mock('node:os', async importOriginal => {
  const real = await importOriginal<typeof NodeOs>()
  const homedir = () => `${lab.root}/home`

  return { ...real, default: { ...real, homedir }, homedir }
})

vi.mock('electron', () => ({
  app: {
    getAppPath: () => `${lab.root}/app`,
    getPath: () => `${lab.root}/userData`,
    isPackaged: false,
    on: () => undefined,
    once: () => undefined
  },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => lab.handlers.set(channel, fn)
  },
  utilityProcess: {}
}))

describe('validateArgv — the ACP command gate', () => {
  it('admits the wizard and the read surface exactly as the renderer sends them', () => {
    expect(validateArgv(['configure', 'start', '--json'])).toEqual(['configure', 'start', '--json'])
    expect(validateArgv(['agent', 'whoami', '--json'])).toEqual(['agent', 'whoami', '--json'])
    expect(validateArgv(['email', 'inbox', '--json', '--limit', '50'])).toEqual([
      'email',
      'inbox',
      '--limit',
      '50',
      '--json'
    ])
    expect(validateArgv(['email', 'thread', '--thread-id', '6664ef39-c41f-4747-b7b9-57aa465d7b7e', '--json'])).toEqual([
      'email',
      'thread',
      '--thread-id',
      '6664ef39-c41f-4747-b7b9-57aa465d7b7e',
      '--json'
    ])
    expect(validateArgv(['wallet', 'sol', 'address'])).toEqual(['wallet', 'sol', 'address'])
    expect(validateArgv(['trade', 'stock-list', 'AAPL', '--json'])).toEqual(['trade', 'stock-list', 'AAPL', '--json'])
    expect(validateArgv(['browse', 'trading signals', '--top-k', '24', '--mode', 'mixed', '--json'])).toEqual([
      'browse',
      'trading signals',
      '--top-k',
      '24',
      '--mode',
      'mixed',
      '--json'
    ])
    expect(validateArgv(['job', 'list', '--all', '--json'])).toEqual(['job', 'list', '--all', '--json'])
    expect(validateArgv(['agent', 'signer-policy', '--json'])).toEqual(['agent', 'signer-policy', '--json'])
    expect(validateArgv(['card', 'limit', 'set', '--amount', '10000', '--json'])).toEqual([
      'card',
      'limit',
      'set',
      '--amount',
      '10000',
      '--json'
    ])
    expect(validateArgv(['card', 'limit', 'set', '--amount', '50', '--json'])).toBeNull()
    expect(validateArgv(['agent', 'register-erc8004', '--agent-id', 'a1', '--chain-id', '8453', '--json'])).toEqual([
      'agent',
      'register-erc8004',
      '--agent-id',
      'a1',
      '--chain-id',
      '8453',
      '--json'
    ])
    expect(validateArgv(['compute', 'status', '--json'])).toEqual(['compute', 'status', '--json'])
    // The Setup wizard's card profile step, flag for flag.
    expect(
      validateArgv([
        'card',
        'profile',
        'set',
        '--first-name',
        'Pat',
        '--last-name',
        'Example',
        '--phone-number',
        '+351912345678',
        '--json'
      ])
    ).toEqual([
      'card',
      'profile',
      'set',
      '--first-name',
      'Pat',
      '--last-name',
      'Example',
      '--phone-number',
      '+351912345678',
      '--json'
    ])
    expect(validateArgv(['card', 'profile', 'set', '--phone-number', '912345678'])).toBeNull()
  })

  it('admits the catalogue writes only when every prompt the CLI would open is answered by a flag', () => {
    const full = [
      'offering',
      'create',
      '--name',
      'Token report',
      '--description',
      'A one-page research note on any token.',
      '--price-type',
      'fixed',
      '--price-value',
      '0.5',
      '--sla-minutes',
      '60',
      '--requirements',
      '{"type":"object","required":["token"],"properties":{"token":{"type":"string"}}}',
      '--deliverable',
      'Markdown report',
      '--no-required-funds',
      '--no-hidden',
      '--json'
    ]

    expect(validateArgv(full)).toEqual(full)
    // Missing `--hidden|--no-hidden` → the CLI would prompt → refused.
    expect(validateArgv(full.filter(token => token !== '--no-hidden'))).toBeNull()
    expect(validateArgv(['offering', 'create', '--name', 'x', '--json'])).toBeNull()
    expect(
      validateArgv([
        'offering',
        'create',
        ...full.slice(2, -3),
        '--price-value',
        'free',
        '--no-required-funds',
        '--no-hidden'
      ])
    ).toBeNull()
    expect(validateArgv(['offering', 'update', '--offering-id', 'abc', '--price-value', '1.25', '--json'])).toEqual([
      'offering',
      'update',
      '--offering-id',
      'abc',
      '--price-value',
      '1.25',
      '--json'
    ])
    expect(validateArgv(['offering', 'update', '--price-value', '1.25'])).toBeNull()
    expect(validateArgv(['offering', 'delete', '--offering-id', 'abc', '--force', '--json'])).toEqual([
      'offering',
      'delete',
      '--offering-id',
      'abc',
      '--force',
      '--json'
    ])
    expect(validateArgv(['offering', 'delete', '--offering-id', 'abc'])).toBeNull()
    expect(
      validateArgv([
        'resource',
        'create',
        '--name',
        'get_prices',
        '--description',
        'Live prices',
        '--url',
        'https://api.example.com/prices',
        '--params',
        '{"type":"object","properties":{}}',
        '--no-hidden',
        '--json'
      ])
    ).toHaveLength(12)
    expect(
      validateArgv([
        'resource',
        'create',
        '--name',
        'x',
        '--description',
        'y',
        '--url',
        'http://insecure',
        '--params',
        '{}',
        '--no-hidden'
      ])
    ).toBeNull()
    expect(
      validateArgv(['subscription', 'create', '--name', 'Pro', '--price', '50', '--duration-days', '30', '--json'])
    ).toHaveLength(9)
    expect(
      validateArgv(['subscription', 'create', '--name', 'Pro', '--price', '50', '--duration-days', '31'])
    ).toBeNull()
    expect(validateArgv(['resource', 'delete'])).toBeNull()
  })

  it('refuses card issue in every position — the global --json used to hide it', () => {
    expect(validateArgv(['card', 'issue', '--amount', '7500'])).toBeNull()
    expect(validateArgv(['card', '--json', 'issue', '--amount', '7500'])).toBeNull()
    expect(validateArgv(['card', 'list', 'issue'])).toBeNull()
  })

  it('refuses everything that moves value or signs', () => {
    expect(validateArgv(['wallet', 'send-transaction', '--to', '0xabc'])).toBeNull()
    expect(validateArgv(['wallet', 'sign-typed-data', '--data', '{}'])).toBeNull()
    expect(validateArgv(['wallet', 'sol', 'transfer', '--to', 'x'])).toBeNull()
    expect(validateArgv(['wallet', 'topup', '--amount', '50'])).toBeNull()
    expect(validateArgv(['trade', '--side', 'long', '--token', 'BTC', '--size', '1'])).toBeNull()
    expect(validateArgv(['trade', 'withdraw-from-hl', '--amount', '25'])).toBeNull()
    expect(validateArgv(['client', 'fund', '--job-id', '1'])).toBeNull()
    expect(validateArgv(['provider', 'submit'])).toBeNull()
    expect(validateArgv(['email', 'attachment', '--message-id', 'x', '--output', '/tmp'])).toBeNull()
    // A spend cap is setup, not a spend — admitted at the CLI floor, refused below it.
    expect(validateArgv(['card', 'limit', 'set', '--amount', '100'])).toEqual([
      'card',
      'limit',
      'set',
      '--amount',
      '100'
    ])
    expect(validateArgv(['card', 'limit', 'set', '--amount', '99'])).toBeNull()
    expect(validateArgv(['agent', 'set-signer-policy'])).toBeNull()
    expect(validateArgv(['policy', 'create'])).toBeNull()
  })

  it('pins the signer policy to restricted whatever the renderer asked for', () => {
    expect(
      validateArgv(['agent', 'add-signer', '--agent-id', 'a1', '--policy', 'unrestricted', '--no-wait', '--json'])
    ).toBeNull()
    expect(validateArgv(['agent', 'add-signer', '--agent-id', 'a1', '--no-wait', '--json'])).toEqual([
      'agent',
      'add-signer',
      '--agent-id',
      'a1',
      '--no-wait',
      '--policy',
      'restricted',
      '--json'
    ])
  })

  it('refuses unknown flags, bad values and stray positionals', () => {
    expect(validateArgv(['email', 'inbox', '--output', '/tmp/x'])).toBeNull()
    expect(validateArgv(['email', 'inbox', '--limit', '1000'])).toBeNull()
    expect(validateArgv(['email', 'compose', '--to', 'not-an-email', '--subject', 'hi', '--body', 'x'])).toBeNull()
    expect(validateArgv(['agent', 'whoami', 'extra'])).toBeNull()
    expect(validateArgv(['browse', 'a', 'b'])).toBeNull()
    expect(validateArgv(['email', 'inbox', '--folder', '../etc'])).toBeNull()
    expect(validateArgv(['email', 'search', '--query'])).toBeNull()
    expect(validateArgv([])).toBeNull()
    expect(validateArgv('agent whoami')).toBeNull()
  })

  it('refuses control characters in any token', () => {
    expect(validateArgv(['email', 'search', '--query', 'a\r\nb'])).toBeNull()
    expect(validateArgv(['email', 'search', '--query', 'a\0b'])).toBeNull()
  })
})

describe('redactCardOutput', () => {
  it('strips card numbers wherever they sit and keeps the rest', () => {
    const raw = JSON.stringify({
      requests: [
        {
          id: 'r1',
          merchant: 'Apple',
          amount: 12.5,
          pan: '4111111111111111',
          cvv: '123',
          expiryMonth: 12,
          expiryYear: 2030,
          last4: '1111'
        }
      ]
    })

    const out = JSON.parse(redactCardOutput(raw).stdout) as { requests: Array<Record<string, unknown>> }

    expect(out.requests[0]).toEqual({ id: 'r1', merchant: 'Apple', amount: 12.5, last4: '1111' })
  })

  it('never lets an unparseable answer through raw', () => {
    const result = redactCardOutput('Card 4111 1111 1111 1111 CVV 123')

    expect(result.stdout).toBe('')
    expect(result.error).toMatch(/not readable/)
  })
})

describe('parseJsonLoose', () => {
  it('reads objects, bare arrays, and a payload after a human line', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonLoose('[]')).toEqual([])
    expect(parseJsonLoose('Fetching…\n{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonLoose('nothing here')).toBeUndefined()
  })
})

describe('slugForInft', () => {
  it('is filesystem-safe and cannot leave its directory', () => {
    expect(slugForInft('robinhood:0x4DFB27E4e6ade6afc8a21ab14751ee8b7ac75631:6')).toBe(
      'robinhood-0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631-6'
    )
    expect(slugForInft('../../etc')).toBe('etc')
    expect(slugForInft('')).toBe('default')
  })
})

describe('launchArgv — the one launch shape', () => {
  it('runs a bundled entry through the launcher in a utility process, a system binary directly', () => {
    const entry = '/R/acp-cli/runtime/node_modules/@virtuals-protocol/acp-cli/dist/bin/acp.js'

    const bundled = {
      isBinary: false as const,
      entry,
      launcher: '/R/acp-cli/launch.cjs',
      nodeModules: '/R/acp-cli/runtime/node_modules',
      pkg: '/R/acp-cli/runtime/node_modules/@virtuals-protocol/acp-cli/package.json',
      treeDir: '/R/acp-cli',
      treeSha256: 'a'.repeat(64)
    }

    expect(launchArgv(bundled, ['chain', 'list', '--json'])).toEqual({
      kind: 'utility',
      modulePath: '/R/acp-cli/launch.cjs',
      args: [entry, 'chain', 'list', '--json']
    })
    expect(launchArgv({ isBinary: true, entry: '/usr/local/bin/acp' }, ['agent', 'whoami'])).toEqual({
      kind: 'spawn',
      command: '/usr/local/bin/acp',
      args: ['agent', 'whoami']
    })
  })
})

describe('launch.cjs — the launcher the bundle ships', () => {
  const launcher = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'acp-launch.cjs')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acp-launch-'))

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  // REL-6 round 2: the launcher runs only inside a confined, manifest-checked tree (scripts/acp-launch-fixture.mjs).
  it('hands the CLI a node-shaped argv with defaultApp set, and a true import.meta.url', () => {
    const tree = confinedTree(path.join(dir, 'argv'), {
      'probe/probe.mjs':
        'console.log(JSON.stringify({ argv: process.argv.slice(1), defaultApp: process.defaultApp === true, url: import.meta.url }))\n'
    })

    const probe = path.join(tree.nodeModules, 'probe', 'probe.mjs')

    const result = spawnSync(process.execPath, [launcher, probe, 'chain', 'list', '--json'], {
      encoding: 'utf8',
      env: tree.env
    })

    expect(result.status).toBe(0)

    const out = JSON.parse(result.stdout) as { argv: string[]; defaultApp: boolean; url: string }

    expect(out.argv).toEqual([probe, 'chain', 'list', '--json'])
    expect(out.defaultApp).toBe(true)
    // ESM resolves the real path (/var → /private/var on macOS).
    expect(out.url).toBe(pathToFileURL(realpathSync(probe)).href)
  })

  it('fails loud without an entry, and surfaces the entry’s own failure', () => {
    const tree = confinedTree(path.join(dir, 'fail'), { 'probe/ok.mjs': '' })

    expect(spawnSync(process.execPath, [launcher], { encoding: 'utf8', env: tree.env }).status).toBe(64)

    const broken = spawnSync(process.execPath, [launcher, path.join(tree.nodeModules, 'probe', 'missing.mjs')], {
      encoding: 'utf8',
      env: tree.env
    })

    expect(broken.status).toBe(1)
    expect(broken.stderr).toMatch(/^acp-launch: /)
  })
})

describe('the agent’s acp — registry + wrapper', () => {
  const dirs: string[] = []

  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('derives token, profile and a safe name from the config slug', () => {
    const row = registryRowFor('robinhood-0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631-6', '/cfg/6', '#6\tevil\nline')

    expect(row).toEqual({
      token: '6',
      slug: 'robinhood-0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631-6',
      configDir: '/cfg/6',
      name: '#6 evil line',
      profile: 'inft-4dfb27-6'
    })
    expect(registryRowFor('default', '/cfg/x')).toBeNull()
    expect(registryRowFor('base-0x3d9f35e08c41a80155353862f883f2b70119809f-12', '/cfg/12')?.profile).toBe(
      'inft-3d9f35-12'
    )
  })

  it('renders a commented TSV sorted by token', () => {
    const text = renderInftRegistry([
      registryRowFor('robinhood-0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631-7', '/c/7')!,
      registryRowFor('robinhood-0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631-1', '/c/1', 'one')!
    ])

    expect(text.split('\n')[0]).toMatch(/^# token\tslug/)
    expect(text.split('\n')[1]).toBe(
      '1\trobinhood-0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631-1\t/c/1\tone\tinft-4dfb27-1'
    )
    expect(text.split('\n')[2]).toBe(
      '7\trobinhood-0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631-7\t/c/7\t#7\tinft-4dfb27-7'
    )
  })

  it('resolves --inft / the stage by token, slug, name or profile — never a guess', () => {
    const rows = [
      registryRowFor(`robinhood-0x${'4dfb'.padEnd(40, '0')}-6`, '/U/a', 'Vegeta'),
      registryRowFor(`robinhood-0x${'abcd'.padEnd(40, '0')}-7`, '/U/b', 'Goku'),
      registryRowFor(`base-0x${'abcd'.padEnd(40, '1')}-7`, '/U/c', 'Goku')
    ].filter(row => row !== null)

    expect(resolveInftKey(rows, '6', null)).toEqual({ ok: true, slug: rows[0].slug })
    expect(resolveInftKey(rows, 'VEGETA', null)).toEqual({ ok: true, slug: rows[0].slug })
    expect(resolveInftKey(rows, null, rows[1].slug)).toEqual({ ok: true, slug: rows[1].slug })
    expect(resolveInftKey(rows, '7', null)).toMatchObject({ ok: false, error: expect.stringMatching(/several/) })
    expect(resolveInftKey(rows, 'nobody', null)).toMatchObject({ ok: false, error: expect.stringMatching(/no iNFT/) })
    expect(resolveInftKey(rows, null, null)).toMatchObject({ ok: false, error: expect.stringMatching(/which iNFT/) })
  })

  it('is a socket client: argv, the iNFT key and the exit code cross; the app decides the rest', async () => {
    const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'iclone-acp-home-')))

    dirs.push(home)

    const seen: { slug: string; argv: string[] }[] = []

    const server = await startAcpSocketServer({
      admitStreaming: () => true,
      dir: path.join(home, 'run'),
      resolveInft: key => (key === '6' ? { ok: true, slug: 'inft-6' } : { ok: false, error: `unknown ${key}` }),
      run: (slug, argv, _streaming, sink) => {
        seen.push({ slug, argv })
        sink.stdout('{"agentName":"Vegeta","accessToken":"abc.def.ghi-secret"}\n')
        sink.stderr('warn\n')

        return Promise.resolve({ code: argv[0] === 'job' ? 4 : 0 })
      },
      log: () => undefined
    })

    const wrapper = path.join(home, 'acp')

    writeFileSync(wrapper, acpWrapperSource(server.socketPath, path.join(home, 'run', 'acp.token')))
    chmodSync(wrapper, 0o755)

    const run = (args: string[], env: Record<string, string> = {}) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
        const child = spawn(wrapper, args, { env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } })
        let stdout = ''
        let stderr = ''

        child.stdout.on('data', chunk => (stdout += String(chunk)))
        child.stderr.on('data', chunk => (stderr += String(chunk)))
        child.on('close', status => resolve({ status, stdout, stderr }))
      })

    try {
      const ok = await run(['--inft', '6', 'agent', 'whoami', '--json'])

      expect(ok.status).toBe(0)
      expect(ok.stdout).toBe('{"agentName":"Vegeta","accessToken":"[redacted]"}\n')
      expect(ok.stderr).toBe('warn\n')
      expect(seen).toEqual([{ slug: 'inft-6', argv: ['agent', 'whoami', '--json'] }])

      expect((await run(['job', 'list'], { ICLONE_INFT: '6' })).status).toBe(4)

      const issue = await run(['--inft', '6', 'card', '--json', 'issue', '--amount', '500'])

      expect(issue.status).toBe(3)
      expect(issue.stderr).toMatch(/card issue/)

      const unknown = await run(['--inft', '9', 'agent', 'whoami'])

      expect(unknown.status).toBe(2)
      expect(unknown.stderr).toMatch(/unknown 9/)
      expect(seen).toHaveLength(2)
    } finally {
      server.close()
    }

    const closed = await run(['--inft', '6', 'agent', 'whoami'])

    expect(closed.status).toBe(3)
    expect(closed.stderr).toMatch(/not running/)
  })
})

describe('timeoutReason — a keychain dialog is an answer, not a network problem', () => {
  it('names the macOS keychain prompt when one is on screen', () => {
    expect(timeoutReason(60_000, false)).toBe('timed out after 60s')
    expect(timeoutReason(60_000, true)).toMatch(/^timed out after 60s — macOS is asking permission .* "Always Allow"/)
  })
})

describe('readStatus — an expired Virtuals session on agent whoami', () => {
  afterAll(() => {
    delete process.env.ICLONE_ACP_BIN
    rmSync(lab.root, { force: true, recursive: true })
  })

  it('R16.c1.main_expired_session_keeps_configured: keeps the configured status and card, flagged expired', async () => {
    const slug = slugForInft('6')
    const statusFile = path.join(lab.root, 'userData', 'inft', slug, 'status.json')
    const calls = path.join(lab.root, 'calls.log')
    const bin = path.join(lab.root, 'acp')

    const saved = {
      cli: true,
      version: '1.0.0',
      authenticated: true,
      agentId: 'agent-6',
      agentName: 'six',
      walletAddress: '0x0000000000000000000000000000000000000006',
      email: 'agent@example.test',
      cardState: 'ready',
      cardReady: true,
      cardCheckedAt: 1,
      configured: true,
      checkedAt: 1,
      slug
    }

    mkdirSync(path.dirname(statusFile), { recursive: true })
    mkdirSync(path.join(lab.root, 'home'), { recursive: true })
    writeFileSync(statusFile, JSON.stringify(saved))
    // A fake CLI: healthy self-test, and "Not authenticated" (exit 1, JSON on stdout) for every iNFT command.
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        `echo "$*" >> '${calls}'`,
        'case "$*" in',
        '  "chain list --json") echo \'{"chains":[{"id":8453}]}\' ;;',
        '  "--version") echo 1.0.1 ;;',
        '  *) echo \'{"error":"Not authenticated.","code":"NOT_AUTHENTICATED","recovery":"Run acp configure."}\'; exit 1 ;;',
        'esac',
        ''
      ].join('\n')
    )
    chmodSync(bin, 0o755)
    process.env.ICLONE_ACP_BIN = bin

    const { initIcloneAcp } = await import('./iclone-acp')

    initIcloneAcp({ isTrustedSender: () => true }) // sender guard covered in iclone-acp.sender.test.ts

    const status = (await lab.handlers.get('iclone:acp-status')?.({}, '6', {})) as Record<string, unknown>

    expect(status).toMatchObject({
      agentId: 'agent-6',
      authenticated: false,
      cardReady: true,
      cardState: 'ready',
      configured: true,
      email: 'agent@example.test',
      sessionExpired: true,
      stale: true,
      walletAddress: saved.walletAddress
    })

    // status.json still says configured with the card; the card service was never asked.
    expect(JSON.parse(readFileSync(statusFile, 'utf8'))).toMatchObject({
      cardReady: true,
      cardState: 'ready',
      configured: true,
      sessionExpired: true
    })
    expect(readFileSync(calls, 'utf8')).toContain('agent whoami --json')
    expect(readFileSync(calls, 'utf8')).not.toContain('card ')
  })
})

describe("probeAgentFacets — the known card survives the card service's own answers", () => {
  const REAUTH =
    '{"error":"HTTP 401: {\\"message\\":\\"REAUTH:1b2c3d4e-0000-4000-8000-000000000000:agent-6@example.com\\"}"}'

  const NONE = '{"error":"HTTP 400: Agent not set up. Call card signup first."}'
  const answers: Record<string, () => AcpRunResult> = {}
  const out = (stdout: string, ok = false): AcpRunResult => ({ code: ok ? 0 : 1, ok, stderr: '', stdout })

  answers['email whoami --json'] = () => out('{"emailAddress":"agent-6@example.com"}', true)
  answers['agent signer-policy --json'] = () => out('{"error":"NO_SIGNER"}')

  const run = async (argv: string[]) => (answers[argv.join(' ')] ?? (() => out('{"error":"unexpected"}')))()

  function status(): InftAcpStatus {
    return {
      agentId: 'agent-6',
      authenticated: true,
      cardReady: false,
      checkedAt: 1,
      cli: true,
      configured: true,
      slug: 'r16-r3-probe-6'
    } as InftAcpStatus
  }

  async function probe(last: InftAcpStatus | null, card: () => AcpRunResult): Promise<InftAcpStatus> {
    answers['card whoami --json'] = card
    const next = status()

    await probeAgentFacets(run, next, last, { force: true })

    return JSON.parse(JSON.stringify(next)) as InftAcpStatus
  }

  it('R16.c2.card_known_survives_reauth: ready -> REAUTH 401 -> timeout keeps cardKnown on status.json', async () => {
    const ready = await probe(null, () => out('{"email":"agent-6@example.com","verified":true}', true))

    expect(ready).toMatchObject({ cardKnown: true, cardReady: true, cardState: 'ready' })

    const pending = await probe(ready, () => out(REAUTH))

    expect(pending).toMatchObject({ cardKnown: true, cardKnownAt: ready.cardKnownAt, cardState: 'signin-pending' })
    expect(pending.cardReauthState).toBe('1b2c3d4e-0000-4000-8000-000000000000')

    const timedOut = await probe(pending, () => ({
      code: null,
      error: 'acp timed out',
      ok: false,
      stderr: '',
      stdout: ''
    }))

    expect(timedOut).toMatchObject({ cardKnown: true, cardStale: true, cardState: 'signin-pending' })
  })

  it("#6's legacy {cardReady:true} becomes a sticky cardKnown through a REAUTH and a cached re-read", async () => {
    const legacy = { ...status(), cardReady: true }
    const pending = await probe(legacy, () => out(REAUTH))

    expect(pending).toMatchObject({ cardKnown: true, cardReady: false, cardState: 'signin-pending' })

    const cached = status()

    await probeAgentFacets(run, cached, pending)
    expect(cached).toMatchObject({ cardKnown: true, cardState: 'signin-pending' })
  })

  it('R16.c2.card_known_cleared_only_by_none: only the authoritative "not set up" forgets the card', async () => {
    const ready = await probe(null, () => out('{"email":"agent-6@example.com","verified":true}', true))
    const blocked = await probe(ready, () => out('{"error":"HTTP 429: Too Many Requests"}'))

    expect(blocked).toMatchObject({ cardKnown: true, cardState: 'blocked' })

    const none = await probe(blocked, () => out(NONE))

    expect(none).toMatchObject({ cardReady: false, cardState: 'none' })
    expect(none.cardKnown).toBeUndefined()
    expect(none.cardKnownAt).toBeUndefined()
  })

  it("another agent behind the iNFT does not inherit this agent's card", async () => {
    const ready = await probe(null, () => out('{"email":"agent-6@example.com","verified":true}', true))
    const other = await probe({ ...ready, agentId: 'agent-7' }, () => out(REAUTH))

    expect(other.cardKnown).toBeUndefined()
  })

  it('R16.r4.hold_after_resignin_keeps_known_card: a signup hold after re-signing in carries the card fields', async () => {
    // The expired session wrote authenticated:false; the same agent signs back in inside a 429 hold of its sign-in link.
    const last = {
      ...status(),
      authenticated: false,
      cardCheckedAt: 1,
      cardKnown: true,
      cardKnownAt: 1,
      cardState: 'signin-pending',
      sessionExpired: true
    } as InftAcpStatus

    answers['card whoami --json'] = () => out(REAUTH)
    const held = status()

    await probeAgentFacets(run, held, last, { cardHeld: true })
    expect(held).toMatchObject({ cardKnown: true, cardKnownAt: 1, cardState: 'signin-pending', cardStale: true })

    // Another agent behind the iNFT inside a hold still starts with no card.
    const other = { ...status(), agentId: 'agent-7' } as InftAcpStatus

    await probeAgentFacets(run, other, last, { cardHeld: true })
    expect(other.cardKnown).toBeUndefined()
    expect(other.cardState).toBeUndefined()
  })
})

describe('writeAcpWrapper', () => {
  it('replaces the wrapper whole with the same bytes, mode 0755 even over an owner-only file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acp-wrapper-'))
    const file = path.join(dir, 'acp')
    const source = '#!/bin/sh\nexec node launch.cjs "$@"\n'

    try {
      writeFileSync(file, 'old', { mode: 0o600 })
      writeAcpWrapper(file, source)

      expect(readFileSync(file, 'utf8')).toBe(source)
      expect(statSync(file).mode & 0o777).toBe(0o755)
      expect(readdirSync(dir)).toEqual(['acp'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
