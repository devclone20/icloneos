import { type ChildProcess, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import dns from 'node:dns'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startAcpSocketServer } from './iclone-acp-ipc'
import { CONSENT_PERMISSION_KEYS } from './iclone-consent'
import {
  createDoctor,
  type DoctorDeps,
  doctorDoorCommand,
  parseDoctorArgv,
  redactReportText,
  setActiveDoctor
} from './iclone-doctor'
import {
  type Catalogue,
  type FixDef,
  loadCatalogue,
  NETWORK_PACK,
  type PackDef,
  validatePack
} from './iclone-doctor-catalog'
import {
  bundleUnderTest,
  CHECKS,
  type DoctorEnv,
  type DoctorExec,
  execAbsolute,
  parseHermesDoctor,
  runningBundleId,
  updatesCheckValue
} from './iclone-doctor-checks'
import { applySteps, FIXES, type FixStep } from './iclone-doctor-fixes'
import { mirrorFile, ownershipFile, validateRecord } from './iclone-ownership-store'

const CATALOGUE_DIR = path.resolve(__dirname, '..', '..', '..', 'iclone', 'diagnostics')
const catalogue = loadCatalogue(CATALOGUE_DIR)
let root = ''
const children: ChildProcess[] = []

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-')))
})

afterEach(() => {
  children.splice(0).forEach(c => c.kill('SIGKILL'))
  setActiveDoctor(null)
  fs.rmSync(root, { force: true, recursive: true })
  vi.restoreAllMocks()
})

type BaseEnv = DoctorDeps['env']

function baseEnv(extra: Partial<BaseEnv> = {}): BaseEnv {
  const dirs = ['home', 'userData', 'hermes', 'venv/bin', 'iclone/bin', 'py']
  dirs.forEach(d => fs.mkdirSync(path.join(root, d), { recursive: true }))

  return {
    platform: process.platform,
    home: path.join(root, 'home'),
    userData: path.join(root, 'userData'),
    hermesHome: path.join(root, 'hermes'),
    venvDir: path.join(root, 'venv'),
    icloneHome: path.join(root, 'iclone'),
    appBundle: null,
    packaged: false,
    mainPid: process.pid,
    bundleId: 'io.cloneframe.icloneos',
    crashDumpsDir: null,
    now: () => Date.UTC(2026, 9, 17, 4, 0, 0),
    ...extra
  }
}

function doctor(env: BaseEnv, more: Partial<DoctorDeps> = {}) {
  return createDoctor({
    catalogue,
    env,
    dataDir: path.join(env.userData, 'diagnostics'),
    app: { version: '0.0.0-test', electron: '40', node: process.versions.node, packaged: false, arch: process.arch },
    osRelease: 'test',
    consentAllows: () => false,
    ...more
  })
}

/** Hash of every path, mode and byte under the root (the dry-run gate: 0 bytes written). */
function treeHash(dir: string): string {
  const h = crypto.createHash('sha256')

  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name)
      const st = fs.lstatSync(full)
      h.update(`${full}:${st.mode}`)

      if (st.isSymbolicLink()) {
        h.update(fs.readlinkSync(full))
      } else if (st.isDirectory()) {
        walk(full)
      } else {
        h.update(fs.readFileSync(full))
      }
    }
  }

  walk(dir)

  return h.digest('hex')
}

function checkOf(report: Awaited<ReturnType<ReturnType<typeof doctor>['run']>>, id: string) {
  return report.packs.flatMap(p => p.checks).find(c => c.id === id)!
}

function realPython(env: BaseEnv): string {
  const py = path.join(root, 'py', 'python3')
  fs.writeFileSync(py, `#!/bin/sh\ncase "$*" in *version_info*) echo 3.12 ;; esac\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(env.venvDir, 'pyvenv.cfg'), `home = ${path.dirname(py)}\nversion = 3.12\n`)
  fs.rmSync(path.join(env.venvDir, 'bin', 'python'), { force: true })
  fs.symlinkSync(py, path.join(env.venvDir, 'bin', 'python'))

  return py
}

function ownershipRecord(slug: string) {
  return {
    schema: 1,
    slug,
    inft: {
      id: '1',
      chain: 'base',
      chainId: 8453,
      contract: `0x${'a'.repeat(40)}`,
      tokenId: '1',
      name: 'One',
      image: null
    },
    wallet: `0x${'b'.repeat(40)}`,
    state: 'held',
    checkedAt: null,
    pending: false,
    failures: 0,
    nextCheckAt: 0,
    lastHeldBlock: null,
    lastHeldAt: null,
    provenAt: null,
    provenChainTime: null,
    deadlineAt: null,
    verifications: [],
    transfer: null,
    agentStatus: null,
    history: [],
    choice: null,
    presale: null,
    cycle: null,
    deactivation: null
  }
}

/** Fake runtime CLI: `config set updates.check false` writes the key like the real one; everything else is real. */
function execWithFakeRuntime(env: BaseEnv): DoctorExec {
  return async (file, args, options) => {
    if (file === path.join(env.venvDir, 'bin', 'python') && args.includes('config')) {
      const cfg = path.join(env.hermesHome, 'config.yaml')
      fs.writeFileSync(cfg, `${fs.readFileSync(cfg, 'utf8').replace(/^updates:\n/m, 'updates:\n  check: false\n')}`)

      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }

    return execAbsolute(file, args, options)
  }
}

interface Scenario {
  name: string
  check: string
  fix: string
  setup(env: BaseEnv): Partial<BaseEnv> | void
  informational?: boolean
  backupHolds?: string
}

const SCENARIOS: Scenario[] = [
  {
    name: 'dangling venv bin/python',
    check: 'runtime.venv_python',
    fix: 'runtime.venv_repair',
    setup: env => {
      const py = realPython(env)
      fs.rmSync(path.join(env.venvDir, 'bin', 'python'))
      fs.symlinkSync(path.join(root, 'py', 'gone'), path.join(env.venvDir, 'bin', 'python'))

      return { interpreters: [py] }
    }
  },
  {
    name: 'pyvenv.cfg home missing',
    check: 'runtime.venv_home',
    fix: 'runtime.venv_repair',
    setup: env => {
      const py = realPython(env)
      fs.writeFileSync(path.join(env.venvDir, 'pyvenv.cfg'), `home = ${path.join(root, 'nowhere')}\n`)

      return { interpreters: [py] }
    },
    backupHolds: 'pyvenv.cfg'
  },
  {
    name: 'inft.tsv row without dir and dir without row',
    check: 'acp.registry',
    fix: 'acp.rerender_registry',
    setup: env => {
      const beta = path.join(env.userData, 'inft', 'beta', 'acp')
      fs.mkdirSync(beta, { recursive: true })
      fs.writeFileSync(path.join(env.icloneHome, 'inft.tsv'), '# header\n7\talpha\t/x\tAlpha\t\n', { mode: 0o600 })

      return { acp: { registryText: () => `# header\n9\tbeta\t${beta}\tBeta\t\n` } }
    },
    backupHolds: 'inft.tsv'
  },
  {
    name: 'acp wrapper with the wrong content and mode 0644',
    check: 'acp.wrapper',
    fix: 'acp.rewrite_wrapper',
    setup: env => {
      fs.writeFileSync(path.join(env.icloneHome, 'bin', 'acp'), '#!/bin/sh\necho old\n', { mode: 0o644 })

      return { acp: { wrapperSource: () => '#!/bin/sh\necho current\n' } }
    },
    backupHolds: 'acp'
  },
  {
    name: 'ownership.json truncated with a valid mirror',
    check: 'storage.ownership',
    fix: 'storage.restore_ownership',
    setup: env => {
      const file = ownershipFile(env.userData, 'gamma')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.mkdirSync(path.dirname(mirrorFile(env.userData, 'gamma')), { recursive: true })
      fs.writeFileSync(file, '{"schema":1,"slug":"gam', { mode: 0o600 })
      fs.writeFileSync(mirrorFile(env.userData, 'gamma'), JSON.stringify(ownershipRecord('gamma')), { mode: 0o600 })
    },
    backupHolds: 'ownership.json'
  },
  {
    name: 'consent.json invalid',
    check: 'permissions.consent_file',
    fix: 'permissions.quarantine_consent',
    setup: env => {
      fs.writeFileSync(path.join(env.userData, 'consent.json'), '{"version": 7, "broken"', { mode: 0o600 })
    },
    backupHolds: 'consent.json'
  },
  {
    name: 'state.db unreadable (with a backup to restore)',
    check: 'gateway.state_db',
    fix: 'gateway.restore_state_db',
    setup: env => {
      const db = path.join(env.hermesHome, 'state.db')
      expect(execSqlite(db, 'create table t(x); insert into t values (1);')).toBe(0)
      fs.copyFileSync(db, `${db}.pre-update-emergency-1.bak`)
      const bytes = fs.readFileSync(db)
      bytes.fill(0x5a, 0, 100)
      fs.writeFileSync(db, bytes)
    },
    backupHolds: 'state.db'
  },
  {
    name: 'orphan -wal without its database',
    check: 'gateway.wal_orphan',
    fix: 'gateway.quarantine_wal',
    setup: env => {
      fs.writeFileSync(path.join(env.hermesHome, 'state.db-wal'), 'x')
    },
    backupHolds: 'state.db-wal'
  },
  {
    name: 'config.yaml without updates.check',
    check: 'gateway.updates_check',
    fix: 'gateway.updates_check_off',
    setup: env => {
      realPython(env)
      fs.writeFileSync(path.join(env.hermesHome, 'config.yaml'), 'model: x\nupdates:\n  backup_keep: 3\n')

      return { exec: execWithFakeRuntime(env) }
    },
    backupHolds: 'config.yaml'
  },
  {
    name: 'unsigned .app (informational: install the notarized release)',
    check: 'native.codesign',
    fix: 'native.install_release',
    informational: true,
    setup: () => {
      const app = path.join(root, 'Fake.app')
      fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
      fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Fake'), '#!/bin/sh\n', { mode: 0o755 })

      return { appBundle: app }
    }
  },
  {
    name: 'native ABI mismatch (informational: reinstall)',
    check: 'native.abi',
    fix: 'native.install_release',
    informational: true,
    setup: () => ({ native: { expectedAbi: '1', abi: '143', spawnHelper: null } })
  }
]

function execSqlite(db: string, sql: string): number | null {
  const res = require('node:child_process').spawnSync('/usr/bin/sqlite3', [db, sql]) as { status: number | null }

  return res.status
}

describe('catalogue gate', () => {
  it('loads 8 valid packs whose impls, consent keys, backups and undo notes all resolve', () => {
    expect(catalogue.errors).toEqual([])
    expect(catalogue.packs.map(p => p.id)).toEqual([
      'runtime',
      'gateway',
      'acp',
      'wallet',
      'permissions',
      'storage',
      'native',
      'network'
    ])

    for (const pack of catalogue.packs) {
      for (const check of pack.checks) {
        expect(CHECKS[check.impl], check.impl).toBeTypeOf('function')
        expect(check.network).toBe(pack.id === NETWORK_PACK)
      }

      for (const fix of pack.fixes) {
        expect(FIXES[fix.impl], fix.impl).toBeTypeOf('function')
        expect(fix.backup && fix.dryRun && fix.undo.length > 0).toBe(true)
        expect(fix.consent === null || (CONSENT_PERMISSION_KEYS as readonly string[]).includes(fix.consent)).toBe(true)
      }
    }
  })

  it('refuses a network check outside the network pack, an unknown consent key and a dangling fix id', () => {
    const runtime = JSON.parse(fs.readFileSync(path.join(CATALOGUE_DIR, 'runtime', 'pack.json'), 'utf8')) as PackDef
    const withNet = { ...runtime, checks: [{ ...runtime.checks[0], network: true }] }
    const badConsent = { ...runtime, fixes: [{ ...runtime.fixes[0], consent: 'everything' }] }
    const dangling = { ...runtime, checks: [{ ...runtime.checks[0], fix: 'runtime.nope' }] }

    expect(validatePack(withNet).ok).toBe(false)
    expect(validatePack(badConsent).ok).toBe(false)
    expect(validatePack(dangling).ok).toBe(false)
  })
})

describe('broken state → fail → dry-run writes 0 bytes → fix backs up → pass → second fix is empty', () => {
  const darwinOnly = new Set(['native.codesign'])

  for (const scenario of SCENARIOS) {
    it.skipIf(darwinOnly.has(scenario.check) && process.platform !== 'darwin')(scenario.name, async () => {
      const env0 = baseEnv()
      const env = { ...env0, ...(scenario.setup(env0) ?? {}) }
      const doc = doctor(env)
      const pack = scenario.check.split('.')[0]
      const before = checkOf(await doc.run({ packs: [pack] }), scenario.check)

      expect(['fail', 'warn']).toContain(before.status)
      expect(before.fixId).toBe(scenario.fix)

      const hash = treeHash(root)
      const preview = await doc.fix(scenario.fix, { dryRun: true })

      expect(preview.ok).toBe(true)
      expect(preview.plan.length).toBeGreaterThan(0)
      expect(treeHash(root)).toBe(hash)

      const applied = await doc.fix(scenario.fix, { dryRun: false, actor: 'user' })

      expect(applied.ok, applied.error).toBe(true)

      if (scenario.informational) {
        expect(applied.applied).toBe(false)
        expect(applied.backupDir).toBeNull()
        expect(applied.after?.find(r => r.id === scenario.check)?.status).not.toBe('pass')

        return
      }

      expect(applied.applied).toBe(true)
      const backups = path.join(env.userData, 'diagnostics', 'backups')
      const [dir] = fs.readdirSync(backups)

      const manifest = JSON.parse(fs.readFileSync(path.join(backups, dir, 'manifest.json'), 'utf8')) as {
        fixId: string
        entries: { path: string; backup: string | null; link: string | null }[]
      }

      expect(manifest.fixId).toBe(scenario.fix)
      expect(manifest.entries.length).toBeGreaterThan(0)

      if (scenario.backupHolds) {
        const entry = manifest.entries.find(e => path.basename(e.path) === scenario.backupHolds)
        expect(entry?.backup && fs.existsSync(entry.backup)).toBeTruthy()
      }

      expect(checkOf(await doc.run({ packs: [pack] }), scenario.check).status).toBe('pass')

      const again = await doc.fix(scenario.fix, { dryRun: false, actor: 'user' })

      expect(again.plan).toEqual([])
      expect(again.applied).toBe(false)
    })
  }

  it.skipIf(process.platform !== 'darwin')(
    'stops a stale gateway of ours holding the claimed port, never a foreign one',
    async () => {
      const script = "require('net').createServer().listen(0,'127.0.0.1',function(){console.log(this.address().port)})"
      const child = spawn(process.execPath, ['-e', script, 'hermes-fixture'], { stdio: ['ignore', 'pipe', 'ignore'] })
      children.push(child)

      const port = await new Promise<number>(resolve =>
        child.stdout!.once('data', b => resolve(Number(String(b).trim())))
      )

      const env = baseEnv({ gateway: { claim: () => ({ port, pid: 2 ** 22 }) } })
      const doc = doctor(env)

      expect(checkOf(await doc.run({ packs: ['gateway'] }), 'gateway.port')).toMatchObject({
        status: 'fail',
        fixId: 'gateway.free_port'
      })
      expect((await doc.fix('gateway.free_port', { dryRun: true })).plan).toEqual([`stop process ${child.pid}`])

      const applied = await doc.fix('gateway.free_port', { dryRun: false, actor: 'user' })

      expect(applied.after?.[0].status).toBe('pass')
      expect((await doc.fix('gateway.free_port', { dryRun: false, actor: 'user' })).plan).toEqual([])

      const foreign = baseEnv({ gateway: { claim: () => ({ port: 1, pid: 2 }) }, mainPid: 2 ** 22 })
      expect(
        await FIXES.freePort({
          ...foreign,
          exec: execAbsolute,
          live: false,
          signal: new AbortController().signal
        } as DoctorEnv)
      ).toEqual([])
    }
  )
})

describe('zero network by default', () => {
  it('runs every pack with live probes off without one DNS, HTTP, socket or fetch call', async () => {
    const spies = [
      vi.spyOn(dns, 'lookup'),
      vi.spyOn(dns.promises, 'lookup'),
      vi.spyOn(http, 'request'),
      vi.spyOn(https, 'request'),
      vi.spyOn(net, 'connect'),
      vi.spyOn(net, 'createConnection'),
      vi.spyOn(globalThis, 'fetch')
    ]

    const lookup = vi.fn(async () => '127.0.0.1')
    const env = baseEnv({ net: { lookup }, electron: { netOnline: () => true } })
    const report = await doctor(env).run()

    spies.forEach(spy => expect(spy).not.toHaveBeenCalled())
    expect(lookup).not.toHaveBeenCalled()
    expect(report.packs.find(p => p.id === 'network')!.checks.every(c => c.status === 'skip')).toBe(true)

    // Live run with fake binaries: tests never touch the real network.
    const fakeExec: DoctorExec = async file => ({
      code: 0,
      stdout: file.endsWith('sntp') ? '+0.012 +/- 0.004 time.apple.com 17.253.0.1\n' : '{"dl_throughput": 250000000}',
      stderr: '',
      timedOut: false
    })

    const live = await doctor({ ...env, exec: fakeExec }).run({ packs: ['network'], live: true })

    expect(lookup).toHaveBeenCalledWith('cloneframe.io')
    expect(checkOf(live, 'network.dns').status).toBe('pass')
    expect(checkOf(live, 'network.time').status).toBe(process.platform === 'darwin' ? 'pass' : 'skip')
  }, 30_000)
})

describe('redaction', () => {
  it('keeps canary secrets, tokens, e-mails and home paths out of the lines, the JSON and the saved report', async () => {
    const env = baseEnv()

    const canaries = [
      'sk-canary0123456789abcdefghij',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl',
      'owner@example.com',
      '/Users/ownername'
    ]

    const checks = { ...CHECKS, venvPython: async () => ({ ok: false, detail: `${canaries.join(' ')} ${env.home}/x` }) }
    const report = await doctor(env, { checks }).run({ packs: ['runtime'] })
    const saved = fs.readFileSync(path.join(env.userData, 'diagnostics', 'last-report.txt'), 'utf8')
    const json = JSON.stringify(report)

    for (const canary of [...canaries, env.home]) {
      expect(report.lines.join('\n')).not.toContain(canary)
      expect(saved).not.toContain(canary)
      expect(json).not.toContain(canary)
    }

    expect(fs.statSync(path.join(env.userData, 'diagnostics', 'last-report.json')).mode & 0o777).toBe(0o600)
    expect(redactReportText('/home/someone/.hermes', '/x')).toBe('/home/[user]/.hermes')
  })
})

describe('risk and consent gates', () => {
  it('refuses a high-risk fix without its consent key, and medium/high applies from an agent', async () => {
    const env = baseEnv()

    expect(await doctor(env).fix('permissions.reset_accessibility', { dryRun: false, actor: 'user' })).toMatchObject({
      ok: false,
      refused: 'consent',
      needsConsent: 'automation'
    })
    expect(await doctor(env).fix('permissions.quarantine_consent', { dryRun: false, actor: 'agent' })).toMatchObject({
      ok: false,
      refused: 'risk'
    })
    expect((await doctor(env).fix('permissions.quarantine_consent', { dryRun: true, actor: 'agent' })).ok).toBe(true)
    expect(await doctor(env).fix('nope.fix')).toMatchObject({ ok: false, refused: 'unknown' })
  })

  it('door argv outside the allow-list is refused', () => {
    const bad = [
      ['exec', 'rm'],
      ['run', '--fix'],
      ['run', 'nopack'],
      ['fix', 'acp.chmod_private', '--apply', '--dry-run'],
      ['fix'],
      ['report', 'x'],
      ['run', '--live', '--yes'],
      [42]
    ]

    for (const argv of bad) {
      expect(parseDoctorArgv(argv, catalogue).kind, JSON.stringify(argv)).toBe('error')
    }

    expect(parseDoctorArgv(['run', 'acp', 'storage', '--json'], catalogue)).toEqual({
      kind: 'run',
      packs: ['acp', 'storage'],
      live: false,
      json: true
    })
    expect(parseDoctorArgv(['fix', 'acp.chmod_private', '--apply'], catalogue)).toMatchObject({
      kind: 'fix',
      apply: true
    })
  })
})

describe('timeouts and robustness', () => {
  it('a hanging check fails as a timeout within budget, a throwing one fails with its message, nothing leaks', async () => {
    const before = process.getActiveResourcesInfo().filter(r => r !== 'TTYWrap').length

    const checks = {
      ...CHECKS,
      venvPython: async (env: DoctorEnv) => {
        await env.exec('/bin/sleep', ['10'], { timeoutMs: 10_000, signal: env.signal })

        return { ok: true, detail: 'never' }
      },
      venvHome: async () => {
        throw new Error('boom')
      }
    }

    const pack = catalogue.packs.find(p => p.id === 'runtime')!

    const quick: Catalogue = {
      packs: [{ ...pack, checks: pack.checks.map(c => ({ ...c, timeoutMs: 300 })) }],
      errors: []
    }

    const started = Date.now()
    const report = await doctor(baseEnv(), { catalogue: quick, checks }).run()

    expect(Date.now() - started).toBeLessThan(300 + 400)
    expect(checkOf(report, 'runtime.venv_python')).toMatchObject({ status: 'fail', detail: 'timeout after 0.3 s' })
    expect(checkOf(report, 'runtime.venv_home')).toMatchObject({ status: 'fail', detail: 'boom' })
    await new Promise(r => setTimeout(r, 50))
    expect(process.getActiveResourcesInfo().filter(r => r !== 'TTYWrap').length).toBeLessThanOrEqual(before)
  })
})

describe('pure helpers', () => {
  it('reads updates.check, hermes doctor glyph rows and the bundle under test', () => {
    expect(updatesCheckValue('updates:\n  backup_keep: 3\n')).toBeUndefined()
    expect(updatesCheckValue('updates:\n  check: false\nother: 1\n')).toBe('false')
    expect(updatesCheckValue('other:\n  check: false\n')).toBeUndefined()
    expect(parseHermesDoctor('◆ Config\n  ✓ ok\n  ⚠ meh\n  ✗ broken thing\n')).toEqual({
      ok: 1,
      warn: 1,
      fail: 1,
      firstFail: 'broken thing'
    })
    expect(bundleUnderTest(true, '/Applications/iclone os.app/Contents/MacOS/iclone os', 'darwin')).toBe(
      '/Applications/iclone os.app'
    )
    expect(bundleUnderTest(true, '/opt/x', 'linux')).toBeNull()
    expect(validateRecord(ownershipRecord('z'), 'z')).not.toBeNull()
  })

  it('K144 r3: the TCC reset targets the running bundle id, read from its own Info.plist (a .dev pack is not the release app)', async () => {
    const bundle = path.join(root, 'iclone os.app')

    const plist = (id: string) =>
      `<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n  <key>CFBundleExecutable</key>\n  <string>iclone os</string>\n  <key>CFBundleIdentifier</key>\n  <string>${id}</string>\n</dict>\n</plist>\n`

    fs.mkdirSync(path.join(bundle, 'Contents'), { recursive: true })
    fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), plist('io.cloneframe.icloneos.dev'))

    expect(runningBundleId(bundle)).toBe('io.cloneframe.icloneos.dev')
    const steps = await FIXES.resetAccessibility({ ...baseEnv(), bundleId: runningBundleId(bundle) } as never)
    expect(steps[0]).toMatchObject({
      file: '/usr/bin/tccutil',
      args: ['reset', 'Accessibility', 'io.cloneframe.icloneos.dev']
    })

    fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), plist('io.cloneframe.icloneos'))
    expect(runningBundleId(bundle)).toBe('io.cloneframe.icloneos')
    // Unreadable, empty, an implausible id, or no bundle at all: the release id.
    expect(runningBundleId(path.join(root, 'missing.app'))).toBe('io.cloneframe.icloneos')
    expect(runningBundleId(bundle, () => plist(''))).toBe('io.cloneframe.icloneos')
    expect(runningBundleId(bundle, () => plist('x; rm -rf ~'))).toBe('io.cloneframe.icloneos')
    expect(runningBundleId(null)).toBe('io.cloneframe.icloneos')

    // The doctor's env takes the id from the bundle it runs in, never the release constant.
    const main = fs.readFileSync(path.join(__dirname, 'iclone-doctor-main.ts'), 'utf8')

    expect(main).toMatch(/bundleId: runningBundleId\(appBundle\)/)
    expect(main).not.toMatch(/DEFAULT_BUNDLE_ID/)
  })

  it('calls hermes doctor without --live or --fix', async () => {
    const env = baseEnv()
    realPython(env)
    const calls: string[][] = []

    const exec: DoctorExec = async (_file, args) => {
      calls.push([...args])

      return { code: 0, stdout: '  ✓ a\n  ✓ b\n', stderr: '', timedOut: false }
    }

    const report = await doctor({ ...env, exec }).run({ packs: ['network'], live: true })

    expect(checkOf(report, 'network.hermes_doctor')).toMatchObject({ status: 'pass', detail: '2 ok · 0 advisories' })
    expect(calls.flat()).not.toContain('--live')
    expect(calls.flat()).not.toContain('--fix')
  })
})

describe('the door through the agent socket', () => {
  it('round-trips list, run and a refused medium apply over a real unix socket', async () => {
    const env = baseEnv()
    setActiveDoctor(doctor(env))
    const dir = fs.mkdtempSync(path.join('/tmp', 'dd-'))

    const server = await startAcpSocketServer({
      admitStreaming: () => true,
      dir,
      resolveInft: () => ({ ok: true, slug: 't1' }),
      run: async () => ({ code: 0 }),
      log: () => {}
    })

    const token = fs.readFileSync(path.join(dir, 'acp.token'), 'utf8').trim()

    const call = (argv: string[]) =>
      new Promise<{ out: string; err: string; code: number }>(resolve => {
        const socket = net.createConnection(server.socketPath)
        let buffer = ''
        const result = { out: '', err: '', code: -1 }
        socket.on('data', chunk => (buffer += String(chunk)))
        socket.on('close', () => {
          for (const line of buffer.split('\n').filter(Boolean)) {
            const frame = JSON.parse(line) as { t: string; d?: string; c?: number }

            if (frame.t === 'o') {
              result.out += frame.d
            }

            if (frame.t === 'e') {
              result.err += frame.d
            }

            if (frame.t === 'x') {
              result.code = frame.c!
            }
          }

          resolve(result)
        })
        socket.write(`${JSON.stringify({ v: 1, token, inft: null, argv })}\n`)
      })

    try {
      const list = await call(['doctor', 'list', '--json'])
      expect(list.code).toBe(0)
      expect((JSON.parse(list.out) as { packs: unknown[] }).packs).toHaveLength(8)

      const run = await call(['doctor', 'run', 'storage', '--json'])
      expect((JSON.parse(run.out) as { packs: { id: string }[] }).packs.map(p => p.id)).toEqual(['storage'])

      fs.writeFileSync(path.join(env.userData, 'consent.json'), '{bad')
      const refused = await call(['doctor', 'fix', 'permissions.quarantine_consent', '--apply', '--json'])
      expect(refused.code).toBe(1)
      expect(JSON.parse(refused.out)).toMatchObject({ refused: 'risk' })
      expect(fs.existsSync(path.join(env.userData, 'consent.json'))).toBe(true)

      expect((await call(['doctor', 'exec', 'rm'])).code).toBe(64)
      expect((await doctorDoorCommand('t1', ['report'])).code).toBe(0)
    } finally {
      server.close()
      fs.rmSync(dir, { force: true, recursive: true })
    }
  })
})

// ── round 2 (critic r1 tickets) ────────────────────────────────────────────────────────────────────────────────────

const fixEnv = (env: BaseEnv, extra: Partial<DoctorEnv> = {}): DoctorEnv => ({
  ...env,
  exec: execAbsolute,
  live: false,
  signal: new AbortController().signal,
  ...extra
})

describe('round 2 hardening', () => {
  it('redacts prefixed env keys, quoted JSON passwords and 0x private keys', () => {
    const key = `0x${'ab'.repeat(32)}`

    const out = redactReportText(
      `GEMINI_API_KEY=AIzaSyA1234567890abcdefghijklmnopqrst {"password": "hunter2hunter2xyz"} key ${key} loaded`,
      '/Users/canary'
    )

    expect(out).not.toContain('AIzaSyA1234567890abcdefghijklmnopqrst')
    expect(out).not.toContain('hunter2hunter2xyz')
    expect(out).not.toContain(key)
    expect(out).toContain('GEMINI_API_KEY=[redacted]')
  })

  it('restore_state_db never moves state.db while the gateway claim pid is alive and cannot be stopped', async () => {
    const env = baseEnv()
    const db = path.join(env.hermesHome, 'state.db')
    expect(execSqlite(db, 'create table t(x);')).toBe(0)
    fs.copyFileSync(db, `${db}.pre-update-emergency-1.bak`)
    fs.writeFileSync(`${db}-wal`, 'x')

    const claimed = fixEnv(env, { gateway: { claim: () => ({ port: 1, pid: process.pid }) } })
    const steps = await FIXES.restoreStateDb(claimed)

    // Round 3: the plan stops the gateway first; a build without the stop dep fails before moving anything.
    expect(steps.map(s => s.kind)).toEqual(['advice', 'gateway', 'copy', 'gateway'])
    const outcome = await applySteps(claimed, 'gateway.restore_state_db', steps, path.join(root, 'backups'))
    expect(outcome.error).toContain('cannot stop')
    expect(fs.existsSync(`${db}-wal`)).toBe(true)
  })

  it('restore_state_db skips an unsound newer backup and dates the one it restores', async () => {
    const env = baseEnv()
    const db = path.join(env.hermesHome, 'state.db')
    expect(execSqlite(db, 'create table t(x);')).toBe(0)
    const good = `${db}.pre-update-emergency-1.bak`
    const junk = `${db}.pre-update-emergency-2.bak`
    fs.copyFileSync(db, good)
    fs.writeFileSync(junk, 'not a database')
    fs.utimesSync(good, new Date(Date.UTC(2026, 8, 20, 14, 3)), new Date(Date.UTC(2026, 8, 20, 14, 3)))

    const steps = await FIXES.restoreStateDb(fixEnv(env))

    expect(steps.find(s => s.kind === 'copy')).toMatchObject({ from: good })
    expect(steps[0]).toMatchObject({ kind: 'advice', text: expect.stringContaining('saved 2026-09-20 14:03 UTC') })

    fs.rmSync(good)
    expect((await FIXES.restoreStateDb(fixEnv(env))).map(s => s.kind)).toEqual(['advice'])
  })

  it('venv repair never links an interpreter of another X.Y, and venv_python fails on a proven mismatch', async () => {
    const env = baseEnv()
    const py = realPython(env)
    fs.writeFileSync(path.join(env.venvDir, 'pyvenv.cfg'), `home = ${path.dirname(py)}\nversion = 3.99.0\n`)

    expect(await CHECKS.venvPython(fixEnv(env))).toMatchObject({ ok: false, detail: expect.stringContaining('3.12') })

    const steps = await FIXES.venvRepair(fixEnv(env, { interpreters: [py] }))
    expect(steps.filter(s => s.kind === 'symlink')).toEqual([])
    expect(steps[0]).toMatchObject({ kind: 'advice', text: expect.stringContaining('3.99') })

    fs.writeFileSync(path.join(env.venvDir, 'pyvenv.cfg'), `home = ${path.dirname(py)}\nversion = 3.12.4\n`)
    expect(await CHECKS.venvPython(fixEnv(env))).toMatchObject({ ok: true })
  })

  it('the door refuses --live, and an agent may not apply a plan that opens a page', async () => {
    expect(parseDoctorArgv(['run', '--live'], catalogue)).toMatchObject({
      kind: 'error',
      error: expect.stringMatching(/owner/)
    })
    expect(parseDoctorArgv(['run', 'native', '--json'], catalogue)).toMatchObject({ kind: 'run', live: false })

    const d = doctor(baseEnv(), {
      checks: { ...CHECKS, codesign: async () => ({ ok: false, detail: 'local-signed' }) }
    })

    const agent = await d.fix('native.install_release', { dryRun: false, actor: 'agent' })
    expect(agent).toMatchObject({ ok: false, refused: 'risk', applied: false })
    expect(agent.plan.join(' ')).toMatch(/open/i)

    const preview = await d.fix('native.install_release', { dryRun: true, actor: 'agent' })
    expect(preview).toMatchObject({ ok: true, applied: false })
  })

  it('lastReport refuses a persisted report with junk packs', async () => {
    const env = baseEnv()
    const d = doctor(env)
    const dataDir = path.join(env.userData, 'diagnostics')
    fs.mkdirSync(dataDir, { recursive: true })
    const real = await d.run({ packs: ['storage'] })

    fs.writeFileSync(
      path.join(dataDir, 'last-report.json'),
      JSON.stringify({ ...real, packs: [null, { id: 'x', checks: 'junk' }], lines: 7 })
    )
    expect(doctor(env).lastReport()).toBeNull()

    fs.writeFileSync(path.join(dataDir, 'last-report.json'), JSON.stringify(real))
    expect(
      doctor(env)
        .lastReport()
        ?.packs.map(p => p.id)
    ).toEqual(['storage'])
  })

  it('acp.registry keeps other instances rows: stale only when a row configDir is gone', async () => {
    const env = baseEnv()
    const slug = `0x${'a'.repeat(40)}-1`
    const mine = path.join(env.userData, 'inft', slug, 'acp')
    const other = path.join(root, 'other', 'inft', 'x', 'acp')
    fs.mkdirSync(mine, { recursive: true })
    fs.mkdirSync(other, { recursive: true })
    const header = '# token\tslug\tconfigDir\tname\tprofile'
    const own = `${header}\n1\t${slug}\t${mine}\t#1\tinft-aaaaaa-1\n`
    const shared = `${header}\n6\tother-6\t${other}\tSix\tp6\n7\tgone-7\t${path.join(root, 'gone')}\tSeven\tp7\n`
    fs.writeFileSync(path.join(env.icloneHome, 'inft.tsv'), shared)
    const e = fixEnv(env, { acp: { registryText: () => own } })

    expect(await CHECKS.acpRegistry(e)).toMatchObject({
      ok: false,
      detail: 'rows without setup: gone-7 · setups without row: ' + slug
    })

    const [write] = await FIXES.rerenderRegistry(e)
    expect(write).toMatchObject({ kind: 'write' })
    const text = (write as { content: string }).content
    expect(text).toContain('other-6\t')
    expect(text).toContain(`${slug}\t`)
    expect(text).not.toContain('gone-7')

    fs.writeFileSync(path.join(env.icloneHome, 'inft.tsv'), text)
    expect(await CHECKS.acpRegistry(e)).toMatchObject({ ok: true })
    expect(await FIXES.rerenderRegistry(e)).toEqual([])
  })

  it('packaged builds look for the catalogue where extraResources ships it', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')) as {
      build: { extraResources: ({ from?: string; to?: string } | string)[] }
    }

    const entry = pkg.build.extraResources.find(
      (r): r is { from: string; to: string } => typeof r === 'object' && /iclone\/diagnostics$/.test(r.from ?? '')
    )

    const main = fs.readFileSync(path.join(__dirname, 'iclone-doctor-main.ts'), 'utf8')

    const candidates = [...main.matchAll(/path\.join\(process\.resourcesPath \?\? '',\s*([^)]*)\)/g)].map(m =>
      path.join(...[...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]))
    )

    expect(entry).toBeDefined()
    expect(candidates).toContain(path.normalize(entry!.to))
  })
})

describe('round 3 hardening', () => {
  const HERMES_ARGS = ['-m', 'hermes_cli.main', 'doctor']

  it('never starts hermes doctor unless the owner turned live probes on (agent door included)', async () => {
    const env = baseEnv({ electron: { netOnline: () => true } })
    realPython(env)
    const calls: string[][] = []

    const exec: DoctorExec = async (file, args) => {
      calls.push([file, ...args])

      return { code: 0, stdout: '  ✓ a\n', stderr: '', timedOut: false }
    }

    const offline = await doctor({ ...env, exec }).run()

    expect(checkOf(offline, 'network.hermes_doctor').status).toBe('skip')
    expect(catalogue.packs.find(p => p.id === 'runtime')!.checks.some(c => c.impl === 'hermesDoctor')).toBe(false)

    setActiveDoctor(doctor({ ...env, exec }))
    const door = await doctorDoorCommand('slug', ['run', '--json'])

    expect(checkOf(JSON.parse(door.stdout), 'network.hermes_doctor').status).toBe('skip')
    expect((await CHECKS.hermesDoctor({ ...env, exec, live: false, signal: new AbortController().signal })).ok).toBe(
      'skip'
    )
    expect(calls.some(c => HERMES_ARGS.every(a => c.includes(a)))).toBe(false)
  })

  it('never touches the keychain while encryption is off, nor on an agent run', async () => {
    const env = baseEnv()
    const probe = vi.fn(() => true)
    const withPolicy = (on: boolean) => ({ ...env, electron: { encryptionOn: () => on, safeStorage: probe } })

    const off = await doctor(withPolicy(false)).run({ packs: ['wallet'] })
    expect(checkOf(off, 'wallet.safe_storage')).toMatchObject({
      status: 'pass',
      detail: expect.stringContaining('off by choice')
    })

    const agent = await doctor(withPolicy(true)).run({ packs: ['wallet'], actor: 'agent' })
    expect(checkOf(agent, 'wallet.safe_storage').status).toBe('skip')

    const unknown = await doctor({ ...env, electron: { safeStorage: probe } }).run({ packs: ['wallet'] })
    expect(checkOf(unknown, 'wallet.safe_storage').status).toBe('skip')
    expect(probe).not.toHaveBeenCalled()

    const user = await doctor(withPolicy(true)).run({ packs: ['wallet'] })
    expect(checkOf(user, 'wallet.safe_storage').status).toBe('pass')
    expect(probe).toHaveBeenCalledTimes(1)
  })

  /** Real sqlite3 for quick_check; lsof -t answers from `holders` so tests never depend on the machine's processes. */
  const restoreEnv = (env: BaseEnv, holders: () => string, extra: Partial<DoctorEnv> = {}): DoctorEnv =>
    fixEnv(env, {
      exec: async (file, args, options) =>
        file.endsWith('lsof') && args[0] === '-t'
          ? { code: holders() ? 0 : 1, stdout: holders(), stderr: '', timedOut: false }
          : execAbsolute(file, args, options),
      ...extra
    })

  const brokenDb = (env: BaseEnv) => {
    const db = path.join(env.hermesHome, 'state.db')
    expect(execSqlite(db, 'create table t(x); insert into t values (1);')).toBe(0)
    fs.copyFileSync(db, `${db}.pre-update-emergency-1.bak`)
    fs.writeFileSync(db, 'damaged')
    fs.writeFileSync(`${db}-wal`, 'x')

    return db
  }

  it('restore_state_db refuses while another process holds state.db, even with no gateway claim', async () => {
    const env = baseEnv()
    const db = brokenDb(env)
    const steps = await FIXES.restoreStateDb(restoreEnv(env, () => '4242\n'))

    expect(steps.map(s => s.kind)).toEqual(['advice'])
    expect(JSON.stringify(steps)).toContain('pid 4242')
    expect(fs.readFileSync(db, 'utf8')).toBe('damaged')

    const unsure = await FIXES.restoreStateDb(
      fixEnv(env, { exec: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }) })
    )

    expect(unsure.map(s => s.kind)).toEqual(['advice'])
  })

  it('restore_state_db stops the app gateway, restores, starts it again; restarts it when a step fails', async () => {
    const env = baseEnv()
    const db = brokenDb(env)
    const gw = spawn('/bin/sleep', ['30'])
    children.push(gw)
    let up = true
    const stop = vi.fn(async () => void (up = false))
    const start = vi.fn(async () => void (up = true))

    const live = restoreEnv(env, () => (up ? `${gw.pid}\n` : ''), {
      gateway: { claim: () => ({ port: 1, pid: gw.pid! }), stop, start }
    })

    const steps = await FIXES.restoreStateDb(live)
    expect(steps.map(s => s.kind)).toEqual(['advice', 'gateway', 'copy', 'gateway'])

    const outcome = await applySteps(live, 'gateway.restore_state_db', steps, path.join(root, 'backups'))
    expect(outcome.error).toBeUndefined()
    expect([stop.mock.calls.length, start.mock.calls.length, up]).toEqual([1, 1, true])
    expect(fs.readFileSync(db)).toEqual(fs.readFileSync(`${db}.pre-update-emergency-1.bak`))
    expect(fs.readdirSync(env.hermesHome).some(n => n.startsWith('state.db.corrupt-'))).toBe(true)

    // A writer that survives the stop: nothing is moved and the gateway comes back.
    fs.writeFileSync(db, 'damaged again')

    const stubborn = restoreEnv(env, () => `${gw.pid}\n`, {
      gateway: { claim: () => ({ port: 1, pid: gw.pid! }), stop, start }
    })

    const again = await applySteps(
      stubborn,
      'gateway.restore_state_db',
      await FIXES.restoreStateDb(stubborn),
      path.join(root, 'b2')
    )

    expect(again.error).toContain('still open')
    expect(fs.readFileSync(db, 'utf8')).toBe('damaged again')
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('redacts AWS access key ids and bare Telegram bot tokens', () => {
    const aws = 'AKIAIOSFODNN7EXAMPLE'
    const sts = 'ASIAY34FZKBOKMUTVV7A'
    const bot = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ'
    const longBot = '7123456789:AAHf3kLmNoPqRsTuVwXyZ0123456789abcde'

    const out = redactReportText(`k=${aws} s ${sts} bot ${bot} ${longBot} done`, '/Users/canary')

    ;[aws, sts, bot, longBot].forEach(canary => expect(out).not.toContain(canary))
    expect(out).toContain('[aws-key]')
    expect(out).toContain('[bot-token]')
  })

  it('runs one flight for overlapping runs and merges a partial run into the last full report', async () => {
    const env = baseEnv()
    let executions = 0

    const counted = createDoctor({
      catalogue,
      env,
      dataDir: path.join(env.userData, 'diagnostics'),
      app: { version: '0', electron: '40', node: process.versions.node, packaged: false, arch: process.arch },
      osRelease: 'test',
      consentAllows: () => false,
      checks: {
        ...CHECKS,
        diskSpace: async () => {
          executions += 1
          await new Promise(resolve => setTimeout(resolve, 50))

          return { ok: true, detail: 'plenty' }
        }
      }
    })

    const [a, b] = await Promise.all([counted.run(), counted.run({ packs: ['storage'] })])

    expect(executions).toBe(1)
    expect(b).toBe(a)

    const partial = await counted.run({ packs: ['wallet'] })

    expect(partial.packs.map(p => p.id)).toEqual(catalogue.packs.map(p => p.id))
    expect(partial.packs.find(p => p.id === 'storage')).toEqual(a.packs.find(p => p.id === 'storage'))
    expect(executions).toBe(1)
    expect(Object.values(partial.counts).reduce((x, y) => x + y, 0)).toBe(partial.packs.flatMap(p => p.checks).length)
  })

  it('restore_state_db puts state.db back before restarting the gateway when the copy fails', async () => {
    const env = baseEnv()
    const db = brokenDb(env)
    const gw = spawn('/bin/sleep', ['30'])
    children.push(gw)
    let up = true
    const seen: string[] = []
    const stop = vi.fn(async () => void (up = false))

    const start = vi.fn(async () => {
      seen.push(fs.existsSync(db) ? fs.readFileSync(db, 'utf8') : 'MISSING')
      up = true
    })

    const live = restoreEnv(env, () => (up ? `${gw.pid}\n` : ''), {
      gateway: { claim: () => ({ port: 1, pid: gw.pid! }), stop, start }
    })

    const steps = await FIXES.restoreStateDb(live)
    expect(steps.map(s => s.kind)).toEqual(['advice', 'gateway', 'copy', 'gateway'])
    // The backup vanishes between plan and apply (prune, disk error): the copy throws after the move-aside.
    fs.rmSync(`${db}.pre-update-emergency-1.bak`)

    const outcome = await applySteps(live, 'gateway.restore_state_db', steps, path.join(root, 'backups'))

    expect(outcome.error).toContain('nothing changed')
    expect(outcome.backupDir).toBeNull()
    expect([stop.mock.calls.length, start.mock.calls.length, up]).toEqual([1, 1, true])
    expect(seen).toEqual(['damaged'])
    expect(fs.readFileSync(db, 'utf8')).toBe('damaged')
    expect(fs.readFileSync(`${db}-wal`, 'utf8')).toBe('x')
    expect(fs.readdirSync(env.hermesHome).filter(n => n.includes('.corrupt-') || n.includes('.tmp-'))).toEqual([])
  })

  it('applies one fix at a time: the same fix joins, another waits, a run never interleaves with an apply', async () => {
    const env = baseEnv()
    const flag = (name: string) => path.join(env.userData, name)
    const timeline: string[] = []
    let plans = 0

    const planner = (name: string) => async (): Promise<FixStep[]> => {
      plans += 1
      timeline.push(`${name}+`)
      await new Promise(resolve => setTimeout(resolve, 60))
      timeline.push(`${name}-`)

      return [{ kind: 'write', path: flag(name), content: 'ok\n', mode: 0o600 }]
    }

    const check = (name: string) => async () => {
      timeline.push('check')
      await new Promise(resolve => setTimeout(resolve, 20))

      return { ok: fs.existsSync(flag(name)), detail: name }
    }

    const fixDef = (id: string): FixDef => ({
      id,
      title: id,
      risk: 'low',
      consent: null,
      dryRun: true,
      backup: true,
      undo: 'u',
      impl: id
    })

    const flights = createDoctor({
      catalogue: {
        errors: [],
        packs: [
          {
            ...catalogue.packs[0]!,
            id: 'storage',
            checks: ['f1', 'f2'].map(id => ({
              id: `c.${id}`,
              title: id,
              severity: 'fail' as const,
              network: false,
              timeoutMs: 2000,
              impl: id,
              fix: id
            })),
            fixes: [fixDef('f1'), fixDef('f2')]
          }
        ]
      },
      env,
      dataDir: path.join(env.userData, 'diagnostics'),
      app: { version: '0', electron: '40', node: process.versions.node, packaged: false, arch: process.arch },
      osRelease: 'test',
      consentAllows: () => false,
      checks: { f1: check('f1'), f2: check('f2') },
      fixes: { f1: planner('f1'), f2: planner('f2') }
    })

    const [a, b, c] = await Promise.all([
      flights.fix('f1', { dryRun: false }),
      flights.fix('f1', { dryRun: false }),
      flights.fix('f2', { dryRun: false })
    ])

    expect(plans).toBe(2)
    expect(b).toBe(a)
    expect([a.ok, a.applied, c.ok, c.applied]).toEqual([true, true, true, true])
    expect(timeline.filter(e => e !== 'check')).toEqual(['f1+', 'f1-', 'f2+', 'f2-'])

    // r4: a DIFFERENT actor never joins — an owner's click must not be answered with an agent's result (nor the
    // reverse); it waits for the apply in flight and runs its own attempt.
    fs.rmSync(flag('f1'))
    timeline.length = 0

    const [agentRun, ownerRun] = await Promise.all([
      flights.fix('f1', { dryRun: false, actor: 'agent' }),
      flights.fix('f1', { dryRun: false })
    ])

    // The owner's attempt ran its OWN before-checks after the agent's apply and found nothing left to fix: one plan.
    expect(plans).toBe(3)
    expect(ownerRun).not.toBe(agentRun)
    expect([agentRun.ok, agentRun.applied, ownerRun.ok, ownerRun.applied]).toEqual([true, true, true, false])
    expect(timeline.filter(e => e !== 'check')).toEqual(['f1+', 'f1-'])

    fs.rmSync(flag('f1'))
    fs.rmSync(flag('f2'))
    timeline.length = 0

    const [report, fixed] = await Promise.all([flights.run(), flights.fix('f2', { dryRun: false })])

    expect(fixed.ok).toBe(true)
    expect(report.packs.flatMap(p => p.checks).length).toBe(2)
    // The run's checks all come before the apply or all after it: never between its plan and its write.
    const begin = timeline.indexOf('f2+')
    expect(timeline[begin + 1]).toBe('f2-')
  })
})
