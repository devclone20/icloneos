/**
 * Ruling 54.4 (V3-FX r5): one env seal for every child the app spawns. Behaviour (real children, explicit env, every
 * sealed primitive, the ESM named import included) and structure (main.ts installs it first; every electron source
 * starts children only through sealed primitives; the list equals the runtime registry's).
 */
import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  allowDestinationEnv,
  DESTINATION_ENV_PATTERN,
  installTelemetrySeal,
  isDestinationKey,
  mainDestinationEnv,
  sealTelemetryEnv,
  TELEMETRY_OFF_ENV
} from './iclone-telemetry-seal'
import { sealBypasses } from './iclone-telemetry-seal.test-helpers'

// main's own env as a user's shell might hand it over: a proxy and a collector (ruling 57.4 strips both).
// Hermetic (critic r7 n7): the runner's own proxy variables never leak into what main "captured".
for (const key of Object.keys(process.env).filter(k => /proxy/i.test(k))) {
  delete process.env[key]
}

process.env.HTTPS_PROXY = 'http://proxy.corp.example:8080'
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector.exfil.invalid:4318'
installTelemetrySeal()

const ENV_BIN = '/usr/bin/env'
const BARE = { PATH: '/usr/bin:/bin' }

const sealedIn = (output: string) =>
  Object.entries(TELEMETRY_OFF_ENV).every(([key, value]) => output.split('\n').includes(`${key}=${value}`))

describe('ruling 54.4: the seal reaches every child, even one launched with a bare explicit env', () => {
  it('execFileSync and spawnSync (ESM named imports bound before the seal) carry every variable', () => {
    expect(sealedIn(execFileSync(ENV_BIN, [], { env: BARE, encoding: 'utf8' }))).toBe(true)
    expect(sealedIn(String(spawnSync(ENV_BIN, [], { env: BARE, encoding: 'utf8' }).stdout))).toBe(true)
  })

  it("execFile and spawn, and a child with no env (it inherits main's sealed env)", async () => {
    const viaExecFile = await new Promise<string>((resolve, reject) =>
      execFile(ENV_BIN, [], { env: BARE }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
    )

    const viaSpawn = await new Promise<string>(resolve => {
      const child = spawn(ENV_BIN, [], { env: BARE })
      let out = ''

      child.stdout.on('data', chunk => (out += String(chunk)))
      child.on('close', () => resolve(out))
    })

    expect(sealedIn(viaExecFile)).toBe(true)
    expect(sealedIn(viaSpawn)).toBe(true)
    expect(sealedIn(execFileSync(ENV_BIN, [], { encoding: 'utf8' }))).toBe(true)
  })

  it('an explicit value can never turn telemetry back on', () => {
    const out = execFileSync(ENV_BIN, [], { env: { ...BARE, CUA_DRIVER_RS_TELEMETRY_ENABLED: '1' }, encoding: 'utf8' })

    expect(out).toContain('CUA_DRIVER_RS_TELEMETRY_ENABLED=0')
    expect(sealTelemetryEnv({ DO_NOT_TRACK: '0' }).DO_NOT_TRACK).toBe('1')
  })
})

const DESTINATIONS = {
  HTTP_PROXY: 'http://proxy.exfil.invalid:8080',
  HTTPS_PROXY: 'http://proxy.exfil.invalid:8080',
  ALL_PROXY: 'socks5://proxy.exfil.invalid:1080',
  https_proxy: 'http://proxy.exfil.invalid:8080',
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector.exfil.invalid:4318',
  HERMES_NEMO_RELAY_PLUGINS_TOML: '/tmp/relay-agent.toml',
  ICLONE_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
  LANGFUSE_HOST: 'https://collector.exfil.invalid',
  POSTHOG_HOST: 'https://collector.exfil.invalid',
  SENTRY_DSN: 'https://k@o1.ingest.sentry.io/1'
}

const destinationsIn = (output: string) =>
  output
    .split('\n')
    .map(line => line.split('=')[0]!)
    .filter(key => isDestinationKey(key))

describe('ruling 57.4: destination variables never reach a child', () => {
  it("main's own env lost its proxy and collector; NO_PROXY is pinned", () => {
    expect(process.env.HTTPS_PROXY).toBeUndefined()
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined()
    expect(process.env.NO_PROXY).toBe('*')
    expect(mainDestinationEnv(['HTTPS_PROXY'])).toEqual({ HTTPS_PROXY: 'http://proxy.corp.example:8080' })
  })

  it('an explicit env carrying proxies, endpoints and SDK hosts arrives without any of them', () => {
    const out = execFileSync(ENV_BIN, [], { env: { ...BARE, ...DESTINATIONS, NO_PROXY: '' }, encoding: 'utf8' })

    expect(destinationsIn(out)).toEqual([])
    expect(out.split('\n')).toContain('NO_PROXY=*')
    expect(out.split('\n')).toContain('OTEL_SDK_DISABLED=true')
  })

  it('(file, null | undefined, {env}) is sealed too (critic r5 n2)', async () => {
    const env = { ...BARE, ...DESTINATIONS, CUA_DRIVER_RS_TELEMETRY_ENABLED: '1' }

    const viaNull = await new Promise<string>((resolve, reject) =>
      execFile(ENV_BIN, null, { env }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
    )

    const viaUndefined = await new Promise<string>((resolve, reject) =>
      execFile(ENV_BIN, undefined, { env }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
    )

    const viaSpawnSync = String(spawnSync(ENV_BIN, undefined, { env, encoding: 'utf8' }).stdout)

    for (const out of [viaNull, viaUndefined, viaSpawnSync]) {
      expect(sealedIn(out)).toBe(true)
      expect(destinationsIn(out)).toEqual([])
    }
  })

  it('exec and execSync are sealed (k12)', async () => {
    const env = { ...BARE, ...DESTINATIONS, DO_NOT_TRACK: '0' }
    const viaExecSync = execSync(ENV_BIN, { env, encoding: 'utf8' })

    const viaExec = await new Promise<string>((resolve, reject) =>
      exec(ENV_BIN, { env }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
    )

    for (const out of [viaExecSync, viaExec]) {
      expect(sealedIn(out)).toBe(true)
      expect(destinationsIn(out)).toEqual([])
    }
  })

  it('utilityProcess.fork is sealed (k9): the options after the module path, after an args array, or after null', () => {
    const calls: unknown[][] = []
    const utilityProcess = { fork: (...args: unknown[]) => calls.push(args) }

    installTelemetrySeal({ utilityProcess })
    utilityProcess.fork('/m.js', ['a'], { env: { ...DESTINATIONS, DO_NOT_TRACK: '0' } })
    utilityProcess.fork('/m.js', { env: { HTTPS_PROXY: 'http://x.invalid' } })
    utilityProcess.fork('/m.js', null, { env: {} })

    const envs = calls.map(
      args => (args.find(a => a && typeof a === 'object' && !Array.isArray(a)) as { env: Record<string, string> }).env
    )

    for (const env of envs) {
      expect(env.DO_NOT_TRACK).toBe('1')
      expect(env.CUA_DRIVER_RS_TELEMETRY_ENABLED).toBe('0')
      expect(Object.keys(env).filter(isDestinationKey)).toEqual([])
    }
  })

  it("only a listed reason gets main's OWN values back; anything else is refused", () => {
    const listed = allowDestinationEnv('runtime-git-network-read', { ...BARE, ...mainDestinationEnv(['HTTPS_PROXY']) })

    expect(sealTelemetryEnv(listed).HTTPS_PROXY).toBe('http://proxy.corp.example:8080')
    expect(() =>
      allowDestinationEnv('runtime-git-network-read', { HTTPS_PROXY: 'http://proxy.exfil.invalid' })
    ).toThrow(/not main's own value/)
    expect(() => allowDestinationEnv('telemetry' as 'runtime-git-network-read', {})).toThrow(/not a listed/)
    expect(sealTelemetryEnv({ ...mainDestinationEnv(['HTTPS_PROXY']) }).HTTPS_PROXY).toBeUndefined()
  })

  it('the pattern names destinations, not ordinary variables', () => {
    expect(
      ['PATH', 'HOME', 'OPENAI_BASE_URL', 'ICLONE_CONSENT_MICROPHONE', 'HERMES_HOME'].filter(isDestinationKey)
    ).toEqual([])
    expect(DESTINATION_ENV_PATTERN.test('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT')).toBe(true)
    // r7 (critic r6 n1): per-platform proxies are destinations too
    expect(
      ['TELEGRAM_PROXY', 'DISCORD_PROXY', 'WSS_PROXY', 'GATEWAY_PROXY_URL', 'matrix_proxy'].every(isDestinationKey)
    ).toBe(true)
    expect(isDestinationKey('ICLONE_USER_NETWORK')).toBe(false)
  })
})

describe("lead correction r6: the user's own proxy reaches Hermes, exactly as main captured it", () => {
  it("a Hermes spawn carries main's proxy; a proxy from anywhere else (.env, backend env) never does", async () => {
    const { sealHermesSpawnEnv } = await import('./iclone-spawn-env')

    const env = sealHermesSpawnEnv(
      { ...BARE, HTTPS_PROXY: 'http://proxy.exfil.invalid:8080', ALL_PROXY: 'socks5://proxy.exfil.invalid:1080' },
      { gateEnv: {}, role: 'primary', runtimeRoot: '/nowhere' }
    )

    const out = execFileSync(ENV_BIN, [], { env, encoding: 'utf8' }).split('\n')

    expect(out).toContain('HTTPS_PROXY=http://proxy.corp.example:8080')
    // r7: and explicitly, on the one channel Hermes reads it from (never inferred from its current env)
    expect(out).toContain(`ICLONE_USER_NETWORK=${JSON.stringify({ HTTPS_PROXY: 'http://proxy.corp.example:8080' })}`)
    expect(out.filter(line => /exfil/.test(line))).toEqual([])
    expect(out.filter(line => /^no_proxy=|^NO_PROXY=/i.test(line))).toEqual([]) // not pinned over the user's proxy
    expect(out).toContain('OTEL_SDK_DISABLED=true') // telemetry stays off regardless
  })

  it('with no proxy at app start, a Hermes spawn gets none and NO_PROXY is pinned', async () => {
    const saved = { ...process.env }

    vi.resetModules()

    try {
      delete process.env.HTTPS_PROXY
      const seal = await import('./iclone-telemetry-seal')
      const { sealHermesSpawnEnv } = await import('./iclone-spawn-env')

      seal.installTelemetrySeal()

      const env = sealHermesSpawnEnv(
        { ...BARE, HTTPS_PROXY: 'http://proxy.exfil.invalid:8080' },
        { gateEnv: {}, role: 'primary', runtimeRoot: '/nowhere' }
      )

      const sealed = seal.sealTelemetryEnv(env)

      expect(sealed.HTTPS_PROXY).toBeUndefined()
      expect(sealed.NO_PROXY).toBe('*')
    } finally {
      Object.assign(process.env, saved)
      vi.resetModules()
    }
  })
})

describe('ruling 54.4: structure', () => {
  const ELECTRON = __dirname

  const sources = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap(entry =>
        entry.isDirectory()
          ? entry.name === 'node_modules'
            ? []
            : sources(path.join(dir, entry.name))
          : /\.ts$/.test(entry.name) && !/\.test(-helpers)?\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')
            ? [path.join(dir, entry.name)]
            : []
      )

  it("main.ts's first import installs the seal", () => {
    const main = fs.readFileSync(path.join(ELECTRON, 'main.ts'), 'utf8')
    const firstImport = main.split('\n').find(line => line.startsWith('import '))

    expect(firstImport).toBe("import './iclone-telemetry-seal-install'")
  })

  it('no electron source starts a child outside the sealed primitives', () => {
    const problems = sources(ELECTRON).flatMap(file =>
      sealBypasses(file).map(p => `${path.relative(ELECTRON, file)}: ${p}`)
    )

    expect(problems).toEqual([])
  })

  it('the audit catches a bypass (fixture)', () => {
    expect(sealBypasses('x.ts', "import { spawn } from 'execa'")).toEqual(['imports execa'])
    expect(sealBypasses('x.ts', "import pty from 'node-pty'\npty.spawn('sh', [], { env: {} })")).toHaveLength(1)
  })

  it('the listed destination reasons are the runtime-git network read and the Hermes user proxy', () => {
    const git = fs.readFileSync(path.join(ELECTRON, 'iclone-compat', 'runtime-git.ts'), 'utf8')
    const listed = sources(ELECTRON).filter(file => fs.readFileSync(file, 'utf8').includes('allowDestinationEnv('))

    expect(git).toMatch(/allowDestinationEnv\('runtime-git-network-read', \{\n\s+\.\.\.networkEnv\(\)/)
    expect(listed.map(file => path.relative(ELECTRON, file)).sort()).toEqual([
      'iclone-compat/runtime-git.ts',
      'iclone-spawn-env.ts'
    ])
  })

  it('the variables equal the runtime registry (hermes_cli/iclone_sinks.py TELEMETRY_OFF_ENV)', () => {
    const registry = fs.readFileSync(path.join(ELECTRON, '..', '..', '..', 'hermes_cli', 'iclone_sinks.py'), 'utf8')

    const block = registry.slice(
      registry.indexOf('TELEMETRY_OFF_ENV'),
      registry.indexOf('}', registry.indexOf('TELEMETRY_OFF_ENV'))
    )

    const pairs = Object.fromEntries([...block.matchAll(/"([A-Z0-9_]+)": "([^"]*)"/g)].map(m => [m[1], m[2]]))

    expect(pairs).toEqual({ ...TELEMETRY_OFF_ENV })
  })
})

describe('ruling 54.4 / critic r4 M1: the doctor runs cua-driver with its telemetry off', () => {
  it('the accessibility check, through the real execAbsolute, hands the driver the telemetry-off env', async () => {
    const os = await import('node:os')
    const { CHECKS, execAbsolute } = await import('./iclone-doctor-checks')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx5-driver-'))
    const dump = path.join(dir, 'env.txt')
    const driver = path.join(dir, 'cua-driver')

    fs.writeFileSync(driver, `#!/bin/sh\n/usr/bin/env > "${dump}"\necho '{"accessibility": true}'\n`, { mode: 0o755 })

    try {
      const outcome = await CHECKS.accessibility!({
        platform: 'darwin',
        home: dir,
        userData: dir,
        hermesHome: dir,
        venvDir: dir,
        icloneHome: dir,
        appBundle: null,
        packaged: false,
        mainPid: process.pid,
        bundleId: 'io.cloneframe.icloneos',
        crashDumpsDir: null,
        live: false,
        signal: new AbortController().signal,
        exec: execAbsolute,
        now: () => 0,
        cuaDriverCmd: driver
      })

      expect(outcome).toMatchObject({ ok: true })

      const env = fs.readFileSync(dump, 'utf8')

      expect(env).toContain('CUA_DRIVER_RS_TELEMETRY_ENABLED=0')
      expect(env).toContain('CUA_TELEMETRY_ENABLED=0')
      // Still the doctor's minimal env otherwise: no provider keys inherited.
      expect(env).not.toMatch(/API_KEY=/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
