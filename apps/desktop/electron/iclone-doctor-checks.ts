/**
 * Diagnostics checks, one function per `impl` name in the pack manifests. Every check reads state only: no writes, no
 * network (network-pack checks run only when the owner turned live probes on — the runner never calls them otherwise),
 * absolute-path binaries only (`/usr/sbin` is not on the app's PATH). Facts the OS or Electron own arrive as deps.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { PUBLIC_LATEST_RELEASE_URL } from '../src/iclone-shared/public-repo'

import { isConsentRecord } from './iclone-consent'
import type { CheckStatus } from './iclone-doctor-catalog'
import { mirrorFile, ownershipFile, validateRecord } from './iclone-ownership-store'
import { sealTelemetryEnv } from './iclone-telemetry-seal'

const RELEASE_TEAM_ID = 'HJSLQL98D8'
export const RELEASES_URL = PUBLIC_LATEST_RELEASE_URL
export const DEFAULT_BUNDLE_ID = 'io.cloneframe.icloneos'
const INSTALLED_APP = '/Applications/iclone os.app'
const GIB = 1024 ** 3
const MIB = 1024 ** 2
const QUICK_CHECK_MAX_BYTES = 256 * MIB

interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  error?: string
}

export type DoctorExec = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }
) => Promise<ExecResult>

/** Never rejects; a timeout or abort kills the child with SIGKILL so no handle outlives the check. */
export const execAbsolute: DoctorExec = (file, args, options) =>
  new Promise(resolve => {
    if (!path.isAbsolute(file)) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: `not an absolute path: ${file}` })

      return
    }

    try {
      execFile(
        file,
        [...args],
        {
          encoding: 'utf8',
          env: options.env ?? process.env,
          killSignal: 'SIGKILL',
          maxBuffer: 4 * MIB,
          signal: options.signal,
          timeout: options.timeoutMs,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null
          const timedOut = Boolean(err?.killed) || err?.name === 'AbortError'

          resolve({
            code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            timedOut,
            error: err && typeof err.code !== 'number' && !timedOut ? err.message : undefined
          })
        }
      )
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: String(error) })
    }
  })

type MediaKind = 'camera' | 'microphone' | 'screen'

export interface DoctorEnv {
  platform: NodeJS.Platform
  home: string
  userData: string
  hermesHome: string
  venvDir: string
  /** `~/.iclone-os` */
  icloneHome: string
  /** The installed `.app` to verify (packaged: the running bundle; dev: the /Applications copy if any). */
  appBundle: string | null
  packaged: boolean
  mainPid: number
  bundleId: string
  crashDumpsDir: string | null
  live: boolean
  /** Who asked for the run: agent runs (the `acp doctor` door) never touch the keychain. */
  actor?: 'agent' | 'user'
  signal: AbortSignal
  exec: DoctorExec
  now(): number
  interpreters?: readonly string[]
  /** `HERMES_CUA_DRIVER_CMD` as main sees it: authoritative when set, as in tools/computer_use/cua_backend.py. */
  cuaDriverCmd?: string | null
  electron?: {
    mediaStatus?(kind: MediaKind): string
    translated?(): boolean
    inApplications?(): boolean
    /** The owner's secret-storage choice (no keychain touch). Absent = unknown, so the keychain is never probed. */
    encryptionOn?(): boolean
    /** Keychain touch (macOS can block the main thread on a login dialog): called only when encryptionOn() is true. */
    safeStorage?(): boolean
    privyCookieCount?(): Promise<number | null>
    cacheSize?(): Promise<number>
    clearCache?(): Promise<void>
    netOnline?(): boolean
    openExternal?(url: string): Promise<void>
  }
  gateway?: {
    claim?(): { port: number; pid: number } | null
    health?(): Promise<{ ok: boolean; detail: string }>
    /** Stops the gateway this app spawned and waits for it to exit. */
    stop?(): Promise<void>
    /** Starts it again (the app's own launch path). */
    start?(): Promise<void>
  }
  acp?: { wrapperSource?(): string | null; registryText?(): string | null }
  native?: { expectedAbi?: string | null; abi?: string; spawnHelper?: string | null }
  net?: { lookup(host: string): Promise<string> }
}

interface CheckOutcome {
  /** true = pass, false = the check's severity, 'skip' = not applicable here. */
  ok: boolean | 'skip'
  detail: string
  evidence?: string
  /** Overrides the severity (e.g. disk space: warn below 2 GiB, fail below 500 MiB). */
  status?: CheckStatus
  /** false = a fail that no fix of ours may touch (e.g. a port held by a foreign process). */
  fixable?: boolean
}

export type CheckImpl = (env: DoctorEnv) => Promise<CheckOutcome>

/** The identity computer use takes its macOS trust on (tools/computer_use/permissions.py), not this app's. */
export const CUA_DRIVER_BUNDLE_ID = 'com.trycua.driver'

/** The media kinds the owner denied in System Settings, in the order the doctor reports them. */
export function deniedMedia(env: DoctorEnv): ('microphone' | 'screen')[] {
  const status = env.electron?.mediaStatus

  return status
    ? (['microphone', 'screen'] as const).filter(kind => ['denied', 'restricted'].includes(status(kind)))
    : []
}

/**
 * The cua-driver binary, resolved as tools/computer_use/cua_backend.py does: an override is authoritative (a bare name
 * is looked up on PATH, m5); otherwise PATH first, then the installer's usual places.
 */
export function cuaDriverBinary(
  env: Pick<DoctorEnv, 'home' | 'cuaDriverCmd'>,
  searchPath: string = process.env.PATH ?? ''
): string | null {
  const isFile = (file: string) => {
    try {
      return path.isAbsolute(file) && fs.statSync(file).isFile()
    } catch {
      return false
    }
  }

  const onPath = (name: string) =>
    searchPath
      .split(path.delimiter)
      .filter(dir => dir && path.isAbsolute(dir))
      .map(dir => path.join(dir, name))
      .find(isFile) ?? null

  const configured = env.cuaDriverCmd?.trim()

  if (configured) {
    return configured.includes('/') ? (isFile(configured) ? configured : null) : onPath(configured)
  }

  return (
    onPath('cua-driver') ??
    [
      path.join(env.home, '.local', 'bin', 'cua-driver'),
      path.join(env.home, '.cargo', 'bin', 'cua-driver'),
      '/opt/homebrew/bin/cua-driver',
      '/usr/local/bin/cua-driver'
    ].find(isFile) ??
    null
  )
}

const pass = (detail: string, evidence?: string): CheckOutcome => ({ ok: true, detail, evidence })
const bad = (detail: string, evidence?: string): CheckOutcome => ({ ok: false, detail, evidence })
const skip = (detail: string): CheckOutcome => ({ ok: 'skip', detail })

export function lstat(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file)
  } catch {
    return null
  }
}

export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export const modeOf = (st: fs.Stats) => st.mode & 0o777
export const octal = (mode: number) => `0${mode.toString(8)}`
export const venvPythonPath = (env: DoctorEnv) => path.join(env.venvDir, 'bin', 'python')

export function realInterpreter(env: DoctorEnv): string | null {
  try {
    const real = fs.realpathSync(venvPythonPath(env))

    return fs.statSync(real).isFile() ? real : null
  } catch {
    return null
  }
}

export function pyvenvHome(env: DoctorEnv): string | null {
  const text = readText(path.join(env.venvDir, 'pyvenv.cfg'))
  const match = text?.match(/^\s*home\s*=\s*(.+?)\s*$/m)

  return match ? match[1] : null
}

/** Pure: the `updates.check` value of a Hermes config.yaml (top-level `updates:` block), or undefined when unset. */
export function updatesCheckValue(yaml: string): string | undefined {
  const lines = yaml.split(/\r?\n/)
  const start = lines.findIndex(line => /^updates:\s*(#.*)?$/.test(line))

  if (start < 0) {
    return undefined
  }

  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) {
      break
    }

    const match = line.match(/^\s+check:\s*([^#\s]+)/)

    if (match) {
      return match[1].toLowerCase()
    }
  }

  return undefined
}

/** Pure: counts the glyph rows of `hermes doctor` (upstream has no --json; never depend on wording). */
export function parseHermesDoctor(text: string): { ok: number; warn: number; fail: number; firstFail: string | null } {
  let ok = 0
  let warn = 0
  let fail = 0
  let firstFail: string | null = null

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()

    if (line.startsWith('✓')) {
      ok += 1
    } else if (line.startsWith('⚠')) {
      warn += 1
    } else if (line.startsWith('✗')) {
      fail += 1
      firstFail ??= line.slice(1).trim()
    }
  }

  return { ok, warn, fail, firstFail }
}

function lsofBin(env: DoctorEnv): string {
  return env.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof'
}

/** The pid listening on a TCP port, via lsof (local, read-only). */
async function listenerPid(env: DoctorEnv, port: number): Promise<number | null> {
  const out = await env.exec(lsofBin(env), ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
    timeoutMs: 3000,
    signal: env.signal
  })

  const match = out.stdout.match(/^p(\d+)$/m)

  return match ? Number(match[1]) : null
}

async function processInfo(env: DoctorEnv, pid: number): Promise<{ ppid: number; command: string } | null> {
  const out = await env.exec('/bin/ps', ['-o', 'ppid=', '-o', 'command=', '-p', String(pid)], {
    timeoutMs: 2000,
    signal: env.signal
  })

  const match = out.stdout.trim().match(/^(\d+)\s+(.*)$/)

  return match ? { ppid: Number(match[1]), command: match[2] } : null
}

/** A stale gateway of OURS: parent is us (or launchd after we died) and the command is the Hermes server. */
export async function staleGatewayPid(env: DoctorEnv): Promise<{ pid: number | null; foreign: number | null }> {
  const claim = env.gateway?.claim?.()

  if (!claim) {
    return { pid: null, foreign: null }
  }

  const pid = await listenerPid(env, claim.port)

  if (pid === null || pid === claim.pid) {
    return { pid: null, foreign: null }
  }

  const info = await processInfo(env, pid)
  const ours = info !== null && (info.ppid === env.mainPid || info.ppid === 1) && /hermes/.test(info.command)

  return ours ? { pid, foreign: null } : { pid: null, foreign: pid }
}

/** Pids holding any of the files open (`lsof -t`, local, read-only); error when lsof could not answer. */
export async function openHolders(
  env: DoctorEnv,
  files: readonly string[]
): Promise<{ pids: number[]; error: string | null }> {
  const present = files.filter(f => lstat(f))

  if (!present.length) {
    return { pids: [], error: null }
  }

  const out = await env.exec(lsofBin(env), ['-t', '--', ...present], { timeoutMs: 5000, signal: env.signal })

  // lsof exits 1 with no output when nobody holds the files.
  if (out.timedOut || out.error || (out.code !== 0 && out.code !== 1)) {
    return { pids: [], error: out.timedOut ? 'lsof timed out' : out.error || `lsof exited ${out.code}` }
  }

  const pids = [
    ...new Set(
      out.stdout
        .split(/\s+/)
        .filter(t => /^\d+$/.test(t))
        .map(Number)
    )
  ]

  return { pids, error: null }
}

export function stateDbFiles(env: DoctorEnv): string[] {
  const file = stateDbPath(env)

  return [file, `${file}-wal`, `${file}-shm`]
}

export function stateDbPath(env: DoctorEnv): string {
  return path.join(env.hermesHome, 'state.db')
}

/** `state.db.*.bak` files, newest first, with their mtime. */
export function stateBackups(env: DoctorEnv): { file: string; mtimeMs: number }[] {
  try {
    return fs
      .readdirSync(env.hermesHome)
      .filter(n => /^state\.db\..+\.bak$/.test(n))
      .map(n => ({ file: path.join(env.hermesHome, n), mtimeMs: lstat(path.join(env.hermesHome, n))?.mtimeMs ?? 0 }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return []
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    // EPERM = alive but owned by someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** `X.Y` of the interpreter the venv was built for (`version` / `version_info` in pyvenv.cfg), or null. */
export function pyvenvVersion(env: DoctorEnv): string | null {
  const text = readText(path.join(env.venvDir, 'pyvenv.cfg'))
  const match = text?.match(/^\s*version(?:_info)?\s*=\s*(\d+)\.(\d+)/m)

  return match ? `${match[1]}.${match[2]}` : null
}

/** `X.Y` the interpreter reports about itself, or null when it does not run or answer. */
export async function interpreterVersion(env: DoctorEnv, file: string): Promise<string | null> {
  const out = await env.exec(file, ['-I', '-c', 'import sys;print("%d.%d"%sys.version_info[:2])'], {
    timeoutMs: 5_000,
    signal: env.signal
  })

  const value = out.code === 0 ? out.stdout.trim() : ''

  return /^\d+\.\d+$/.test(value) ? value : null
}

export async function quickCheck(env: DoctorEnv, file: string): Promise<{ ok: boolean; detail: string }> {
  // Never open the live DB from a second fd (POSIX advisory-lock trap): check a snapshot copy.
  // The copy is async and capped: a synchronous copy of a large DB blocks the Electron main thread (lab 2, 2026-10-17).
  const size = (lstat(file)?.size ?? 0) + (lstat(`${file}-wal`)?.size ?? 0)

  if (size > QUICK_CHECK_MAX_BYTES) {
    return { ok: true, detail: `${Math.round(size / MIB)} MiB — too large for a quick check; not checked` }
  }

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'iclone-doctor-'))

  try {
    const copy = path.join(dir, 'state.db')
    await fs.promises.copyFile(file, copy)

    if (lstat(`${file}-wal`)) {
      await fs.promises.copyFile(`${file}-wal`, `${copy}-wal`)
    }

    const python = realInterpreter(env)

    const out = lstat('/usr/bin/sqlite3')
      ? await env.exec('/usr/bin/sqlite3', ['-readonly', copy, 'PRAGMA quick_check;'], {
          timeoutMs: 12_000,
          signal: env.signal
        })
      : python
        ? await env.exec(
            python,
            [
              '-I',
              '-c',
              'import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute("pragma quick_check").fetchone()[0])',
              copy
            ],
            { timeoutMs: 12_000, signal: env.signal }
          )
        : null

    if (!out) {
      return { ok: true, detail: 'no sqlite available to check' }
    }

    const first = (out.stdout.trim() || out.stderr.trim()).split('\n')[0] ?? ''

    return out.code === 0 && first === 'ok'
      ? { ok: true, detail: 'quick_check ok' }
      : { ok: false, detail: first || 'unreadable' }
  } finally {
    await fs.promises.rm(dir, { force: true, recursive: true })
  }
}

interface RegistryRow {
  line: string
  token: string
  slug: string
  configDir: string
}

function registryRows(text: string): RegistryRow[] {
  return text
    .split(/\r?\n/)
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => {
      const [token = '', slug = '', configDir = ''] = line.split('\t')

      return { line, token, slug, configDir }
    })
    .filter(row => row.slug)
}

/**
 * The registry is shared by every icloneOS instance on the Mac (each `--user-data-dir` adds its rows), so a row is stale
 * only when its own configDir is gone, and a row is missing only when this instance renders one the file lacks.
 */
export function registryDrift(env: DoctorEnv): { stale: RegistryRow[]; missing: RegistryRow[]; rows: RegistryRow[] } {
  const rows = registryRows(readText(path.join(env.icloneHome, 'inft.tsv')) ?? '')
  const own = env.acp?.registryText?.()

  const expected = own
    ? registryRows(own)
    : acpDirs(env).map(slug => ({ line: '', token: '', slug, configDir: path.join(env.userData, 'inft', slug, 'acp') }))

  const has = (want: RegistryRow) => rows.some(r => r.slug === want.slug && r.configDir === want.configDir)

  return {
    rows,
    stale: rows.filter(r => !r.configDir || !lstat(r.configDir)?.isDirectory()),
    missing: expected.filter(want => !has(want))
  }
}

function acpDirs(env: DoctorEnv): string[] {
  try {
    return fs
      .readdirSync(path.join(env.userData, 'inft'), { withFileTypes: true })
      .filter(d => d.isDirectory() && lstat(path.join(env.userData, 'inft', d.name, 'acp'))?.isDirectory())
      .map(d => d.name)
      .sort()
  } catch {
    return []
  }
}

function ownershipSlugs(env: DoctorEnv): string[] {
  try {
    return fs
      .readdirSync(path.join(env.userData, 'inft'), { withFileTypes: true })
      .filter(d => d.isDirectory() && lstat(ownershipFile(env.userData, d.name)))
      .map(d => d.name)
      .sort()
  } catch {
    return []
  }
}

function validOwnership(file: string, slug: string): boolean {
  try {
    return validateRecord(JSON.parse(fs.readFileSync(file, 'utf8')), slug) !== null
  } catch {
    return false
  }
}

/** Ownership primaries that fail validation, and whether a valid mirror can restore each. */
export function brokenOwnership(env: DoctorEnv): { slug: string; restorable: boolean }[] {
  return ownershipSlugs(env)
    .filter(slug => !validOwnership(ownershipFile(env.userData, slug), slug))
    .map(slug => ({ slug, restorable: validOwnership(mirrorFile(env.userData, slug), slug) }))
}

export function privateDataFiles(env: DoctorEnv): string[] {
  const files = [path.join(env.userData, 'consent.json')]

  for (const slug of ownershipSlugs(env)) {
    files.push(ownershipFile(env.userData, slug), mirrorFile(env.userData, slug))
  }

  return files.filter(f => lstat(f)?.isFile())
}

const looseMode = (file: string) => {
  const st = lstat(file)

  return st !== null && (st.mode & 0o077) !== 0
}

export const acpPrivatePaths = (env: DoctorEnv) =>
  ['inft.tsv', 'signing.key'].map(n => path.join(env.icloneHome, n)).filter(f => lstat(f)?.isFile())

export const wrapperPath = (env: DoctorEnv) => path.join(env.icloneHome, 'bin', 'acp')

async function codesignFacts(
  env: DoctorEnv,
  app: string
): Promise<{ team: string | null; accepted: boolean; source: string; stapled: boolean }> {
  const opts = { timeoutMs: 15_000, signal: env.signal }

  const [sign, gate, staple] = await Promise.all([
    env.exec('/usr/bin/codesign', ['-dv', '--verbose=4', app], opts),
    env.exec('/usr/sbin/spctl', ['-a', '-vv', '-t', 'exec', app], opts),
    env.exec('/usr/bin/xcrun', ['stapler', 'validate', app], opts)
  ])

  const signText = `${sign.stdout}\n${sign.stderr}`
  const gateText = `${gate.stdout}\n${gate.stderr}`
  const team = signText.match(/^TeamIdentifier=(\S+)/m)?.[1] ?? null

  return {
    team: team && team !== 'not' && team !== 'not set' ? team : null,
    accepted: gate.code === 0 && /accepted/.test(gateText),
    source: gateText.match(/(?:source|origin)=(.+)$/m)?.[1]?.trim() ?? (gate.code === 0 ? 'accepted' : 'rejected'),
    stapled: staple.code === 0
  }
}

export const CHECKS: Record<string, CheckImpl> = {
  async venvPython(env) {
    if (!lstat(env.venvDir)) {
      return skip('no runtime venv on this machine yet')
    }

    const real = realInterpreter(env)

    if (real) {
      const want = pyvenvVersion(env)
      const have = want ? await interpreterVersion(env, real) : null

      // Only a proven mismatch fails: a venv's compiled packages do not load under another X.Y.
      return want && have && have !== want
        ? bad(`bin/python is Python ${have}, the venv was built for ${want}`, real)
        : pass('interpreter resolves', real)
    }

    let target = ''

    try {
      target = fs.readlinkSync(venvPythonPath(env))
    } catch {
      target = 'missing'
    }

    return bad(`bin/python points at a missing interpreter (${target})`)
  },

  async venvHome(env) {
    if (!lstat(env.venvDir)) {
      return skip('no runtime venv on this machine yet')
    }

    const home = pyvenvHome(env)

    if (!home) {
      return bad('pyvenv.cfg has no home line')
    }

    return lstat(home)?.isDirectory() ? pass('interpreter home exists', home) : bad(`interpreter home is gone: ${home}`)
  },

  async hermesDoctor(env) {
    // Upstream always probes every configured provider with the owner's keys (API Connectivity, npm audit, gh auth):
    // it is a live probe, never part of a local run (lab 2, 2026-10-17: 21 connections with live probes off).
    if (!env.live) {
      return skip('live probes are off (hermes doctor contacts the configured providers)')
    }

    const python = realInterpreter(env)

    if (!python) {
      return skip('runtime interpreter unavailable')
    }

    // Never --live (more network) and never --fix (upstream's own writes).
    // 5 s cold on an idle Mac, > 22 s under a full parallel run (lab 2, 2026-10-17): budget 45 s inside the pack's 50 s.
    const out = await env.exec(venvPythonPath(env), ['-m', 'hermes_cli.main', 'doctor'], {
      timeoutMs: 45_000,
      signal: env.signal,
      env: { ...process.env, HERMES_HOME: env.hermesHome, NO_COLOR: '1' }
    })

    if (out.timedOut) {
      return bad('hermes doctor did not finish in time')
    }

    const rows = parseHermesDoctor(`${out.stdout}\n${out.stderr}`)

    if (rows.ok + rows.warn + rows.fail === 0) {
      return bad('hermes doctor printed no result rows', (out.stderr || out.error || '').slice(0, 200))
    }

    return rows.fail === 0
      ? pass(`${rows.ok} ok · ${rows.warn} advisories`)
      : bad(`${rows.fail} issue${rows.fail === 1 ? '' : 's'} · first: ${rows.firstFail}`)
  },

  async tccAnchor(env) {
    const real = realInterpreter(env)

    if (!real) {
      return skip('runtime interpreter unavailable')
    }

    // Privacy grants are keyed to the resolved interpreter: a versioned path moves on every update.
    return /\/Cellar\/|\/uv\/python\//.test(real)
      ? bad('privacy grants follow a versioned interpreter path and are lost on its next update', real)
      : pass('privacy grants anchor to a stable interpreter path', real)
  },

  async updatesCheck(env) {
    const text = readText(path.join(env.hermesHome, 'config.yaml'))

    if (text === null) {
      return skip('no runtime config yet')
    }

    const value = updatesCheckValue(text)

    if (value === 'false') {
      return pass('updates.check is false — icloneOS ships the runtime')
    }

    return bad(
      value === undefined
        ? 'updates.check is not set — the runtime would check upstream for updates on its own'
        : `updates.check is ${value} — the runtime checks upstream for updates on its own`
    )
  },

  async gatewayPort(env) {
    const claim = env.gateway?.claim?.()

    if (!claim) {
      return skip('no gateway claimed by this app')
    }

    const stale = await staleGatewayPid(env)

    if (stale.pid !== null) {
      return bad(`port ${claim.port} is held by a stale gateway (pid ${stale.pid})`)
    }

    if (stale.foreign !== null) {
      return {
        ok: false,
        detail: `port ${claim.port} is held by another program (pid ${stale.foreign})`,
        fixable: false
      }
    }

    return pass(`port ${claim.port} is ours`)
  },

  async gatewayHealth(env) {
    if (!env.gateway?.health || !env.gateway.claim?.()) {
      return skip('gateway not started by this app')
    }

    const health = await env.gateway.health()

    return health.ok ? pass(health.detail) : bad(health.detail)
  },

  async stateDb(env) {
    const file = stateDbPath(env)

    if (!lstat(file)?.isFile()) {
      return skip('no sessions database yet')
    }

    const result = await quickCheck(env, file)

    return result.ok ? pass(result.detail) : bad(`quick_check failed: ${result.detail}`)
  },

  async walOrphan(env) {
    const file = stateDbPath(env)
    const orphans = lstat(file) ? [] : ['-wal', '-shm'].filter(s => lstat(`${file}${s}`))

    return orphans.length
      ? bad(`journal without its database: state.db${orphans.join(', state.db')}`)
      : pass('journal files consistent')
  },

  async acpWrapper(env) {
    const expected = env.acp?.wrapperSource?.() ?? null

    if (expected === null) {
      return skip('this build does not install the acp command')
    }

    const st = lstat(wrapperPath(env))

    if (!st) {
      return bad('~/.iclone-os/bin/acp is missing')
    }

    if (readText(wrapperPath(env)) !== expected) {
      return bad('~/.iclone-os/bin/acp differs from this app version')
    }

    return modeOf(st) === 0o755
      ? pass('installed and current')
      : bad(`~/.iclone-os/bin/acp mode is ${octal(modeOf(st))}, expected 0755`)
  },

  async acpRegistry(env) {
    const { rows, stale, missing } = registryDrift(env)

    if (rows.length === 0 && missing.length === 0) {
      return skip('no iNFT set up yet')
    }

    if (stale.length === 0 && missing.length === 0) {
      return pass(`${rows.length} iNFT${rows.length === 1 ? '' : 's'} registered`)
    }

    return bad(
      [
        stale.length ? `rows without setup: ${stale.map(r => r.slug).join(', ')}` : '',
        missing.length ? `setups without row: ${missing.map(r => r.slug).join(', ')}` : ''
      ]
        .filter(Boolean)
        .join(' · ')
    )
  },

  async acpPrivateFiles(env) {
    const loose = acpPrivatePaths(env).filter(looseMode)

    return loose.length ? bad(`readable by others: ${loose.map(f => path.basename(f)).join(', ')}`) : pass('owner-only')
  },

  async safeStorage(env) {
    const on = env.electron?.encryptionOn?.()

    if (on === undefined) {
      return skip('encryption choice not reported')
    }

    if (!on) {
      return pass('encryption off by choice — the keychain is not used')
    }

    if (env.actor === 'agent') {
      return skip('the keychain is checked only from Settings › Diagnostics')
    }

    const available = env.electron?.safeStorage?.()

    if (available === undefined) {
      return skip('not reported')
    }

    return available
      ? pass('the system keychain encrypts local secrets')
      : bad('the system keychain is not available to encrypt secrets')
  },

  async privySession(env) {
    const count = env.electron?.privyCookieCount ? await env.electron.privyCookieCount() : null

    if (count === null) {
      return skip('sign-in window not used yet')
    }

    return count > 0 ? pass('signed in') : bad('signed out — wallet actions ask you to sign in again')
  },

  async consentFile(env) {
    const text = readText(path.join(env.userData, 'consent.json'))

    if (text === null) {
      return pass('not recorded yet — asked at the next launch')
    }

    try {
      return isConsentRecord(JSON.parse(text)) ? pass('valid') : bad('consent.json is not a valid record')
    } catch {
      return bad('consent.json is unreadable')
    }
  },

  async mediaAccess(env) {
    if (!env.electron?.mediaStatus) {
      return skip('not reported')
    }

    const denied = deniedMedia(env)

    return denied.length ? bad(`denied in System Settings: ${denied.join(', ')}`) : pass('not denied')
  },

  // FX-3: computer use posts clicks as CuaDriver, so CuaDriver's Accessibility trust is the one that matters; this
  // app's own trust decides nothing.
  async accessibility(env) {
    const driver = cuaDriverBinary(env)

    if (!driver) {
      return skip('computer use is not set up (no CuaDriver)')
    }

    const out = await env.exec(driver, ['permissions', 'status', '--json'], {
      timeoutMs: 2500,
      signal: env.signal,
      // A third-party binary: only what it needs, never this process's environment (provider keys).
      // Ruling 54.4: the telemetry-off env explicitly too (cua-driver's PostHog telemetry is on by default).
      env: sealTelemetryEnv({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: env.home })
    })

    let granted: unknown

    try {
      granted = (JSON.parse(out.stdout) as { accessibility?: unknown } | null)?.accessibility
    } catch {
      granted = undefined
    }

    if (typeof granted !== 'boolean') {
      return skip('CuaDriver did not report')
    }

    return granted ? pass('granted to CuaDriver') : bad('not granted to CuaDriver — computer use cannot control apps')
  },

  async ownershipRecords(env) {
    const broken = brokenOwnership(env)

    if (broken.length === 0) {
      return pass(`${ownershipSlugs(env).length} records valid`)
    }

    const fixable = broken.every(b => b.restorable)

    return {
      ok: false,
      detail: `unreadable: ${broken.map(b => `${b.slug}${b.restorable ? ' (mirror ok)' : ' (no mirror)'}`).join(', ')}`,
      fixable
    }
  },

  async privateModes(env) {
    const loose = privateDataFiles(env).filter(looseMode)

    return loose.length
      ? bad(`readable by others: ${loose.length} file${loose.length === 1 ? '' : 's'}`)
      : pass('owner-only')
  },

  async diskSpace(env) {
    try {
      const st = fs.statfsSync(env.userData)
      const free = st.bavail * st.bsize
      const detail = `${(free / GIB).toFixed(free < 10 * GIB ? 1 : 0)} GiB free`

      if (free < 500 * MIB) {
        return { ok: false, status: 'fail', detail }
      }

      return free < 2 * GIB ? { ok: false, status: 'warn', detail } : pass(detail)
    } catch {
      return skip('not reported')
    }
  },

  async crashDumps(env) {
    if (!env.crashDumpsDir) {
      return skip('not reported')
    }

    const dumps: { t: number }[] = []

    const walk = (dir: string, depth: number) => {
      for (const d of (() => {
        try {
          return fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          return []
        }
      })()) {
        const full = path.join(dir, d.name)

        if (d.isDirectory() && depth < 2) {
          walk(full, depth + 1)
        } else if (d.name.endsWith('.dmp')) {
          dumps.push({ t: lstat(full)?.mtimeMs ?? 0 })
        }
      }
    }

    walk(env.crashDumpsDir, 0)

    if (dumps.length === 0) {
      return pass('none')
    }

    const latest = new Date(Math.max(...dumps.map(d => d.t))).toISOString().slice(0, 16).replace('T', ' ')

    return bad(`${dumps.length} crash report${dumps.length === 1 ? '' : 's'} · latest ${latest}`)
  },

  async codesign(env) {
    if (!env.appBundle || !lstat(env.appBundle)) {
      return skip('no installed app to verify')
    }

    const facts = await codesignFacts(env, env.appBundle)

    const problems = [
      facts.accepted ? '' : `Gatekeeper rejects it (${facts.source})`,
      facts.team === RELEASE_TEAM_ID
        ? ''
        : facts.team
          ? `team ${facts.team} is not ${RELEASE_TEAM_ID}`
          : 'no TeamIdentifier',
      facts.stapled ? '' : 'no stapled notarization ticket'
    ].filter(Boolean)

    return problems.length
      ? bad(`${path.basename(env.appBundle)}: ${problems.join(' · ')}`)
      : pass(`notarized Developer ID (${RELEASE_TEAM_ID})`)
  },

  async installLocation(env) {
    if (!env.packaged || !env.appBundle) {
      return skip('development build')
    }

    if (env.appBundle.includes('/AppTranslocation/')) {
      return bad('running from a translocated copy — move icloneOS to Applications')
    }

    const inApps = env.electron?.inApplications?.()

    return inApps === false ? bad('not in the Applications folder') : pass('in Applications')
  },

  async nativeAbi(env) {
    const expected = env.native?.expectedAbi ?? null
    const actual = env.native?.abi ?? process.versions.modules

    if (!expected) {
      return skip('no ABI stamp in this build')
    }

    return expected === actual
      ? pass(`ABI ${actual}`)
      : bad(`native modules built for ABI ${expected}, this app runs ${actual}`)
  },

  async spawnHelper(env) {
    const file = env.native?.spawnHelper ?? null
    const st = file ? lstat(file) : null

    if (!st) {
      return skip('terminal helper not present')
    }

    return (st.mode & 0o111) === 0o111
      ? pass(`mode ${octal(modeOf(st))}`)
      : bad(`terminal helper is not executable (mode ${octal(modeOf(st))})`)
  },

  async rosetta(env) {
    const translated = env.electron?.translated?.()

    if (translated === undefined) {
      return skip('not reported')
    }

    return translated
      ? bad('running under Rosetta translation — install the Apple silicon build')
      : pass(`native ${process.arch}`)
  },

  async rendererCache(env) {
    if (!env.electron?.cacheSize) {
      return skip('not reported')
    }

    const size = await env.electron.cacheSize()
    const detail = `${Math.round(size / MIB)} MiB`

    return size > 512 * MIB ? bad(`renderer cache is ${detail}`) : pass(detail)
  },

  async netOnline(env) {
    const online = env.electron?.netOnline?.()

    if (online === undefined) {
      return skip('not reported')
    }

    return online ? pass('online') : bad('offline')
  },

  async dnsLookup(env) {
    const lookup =
      env.net?.lookup ?? (async (host: string) => (await import('node:dns')).promises.lookup(host).then(r => r.address))

    try {
      return pass(`cloneframe.io → ${await lookup('cloneframe.io')}`)
    } catch (error) {
      return bad(`cannot resolve names: ${error instanceof Error ? error.message : String(error)}`)
    }
  },

  async timeOffset(env) {
    const out = await env.exec('/usr/bin/sntp', ['-t', '3', 'time.apple.com'], { timeoutMs: 4500, signal: env.signal })
    const offset = Number(out.stdout.match(/^([+-]\d+(?:\.\d+)?)/m)?.[1])

    if (!Number.isFinite(offset)) {
      return bad('no answer from the time server')
    }

    return Math.abs(offset) > 30
      ? bad(`clock is off by ${offset.toFixed(1)} s`)
      : pass(`clock offset ${offset.toFixed(2)} s`)
  },

  async networkQuality(env) {
    const out = await env.exec('/usr/bin/networkQuality', ['-c', '-s'], { timeoutMs: 22_000, signal: env.signal })

    try {
      const json = JSON.parse(out.stdout) as { dl_throughput?: number; ul_throughput?: number }
      const down = (json.dl_throughput ?? 0) / 1e6

      return down > 1 ? pass(`${down.toFixed(0)} Mbps down`) : bad(`${down.toFixed(1)} Mbps down`)
    } catch {
      return bad('networkQuality returned no result')
    }
  }
}

/**
 * K144 r3 (m2): the bundle id of the copy the doctor runs in, read from that bundle's own Info.plist (XML, as
 * electron-builder writes it). A non-release pack is `<release id>.dev` (K144 r2), so a TCC reset for the release id
 * would reset another app's grant and leave the running app's broken one alone. The release id when the plist cannot
 * be read or names no plausible id (no bundle: Linux, a bare binary).
 */
export function runningBundleId(
  bundle: string | null,
  read: (file: string) => string = file => fs.readFileSync(file, 'utf8')
): string {
  if (!bundle) {
    return DEFAULT_BUNDLE_ID
  }

  try {
    const plist = read(path.join(bundle, 'Contents', 'Info.plist'))
    const id = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1]?.trim() ?? ''

    return /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(id) ? id : DEFAULT_BUNDLE_ID
  } catch {
    return DEFAULT_BUNDLE_ID
  }
}

/** The `.app` the native pack verifies: the running bundle when packaged, else the installed copy (read-only). */
export function bundleUnderTest(packaged: boolean, execPath: string, platform: NodeJS.Platform): string | null {
  if (platform !== 'darwin') {
    return null
  }

  if (packaged) {
    const match = execPath.match(/^(.*?\.app)\/Contents\/MacOS\//)

    return match ? match[1] : null
  }

  return fs.existsSync(INSTALLED_APP) ? INSTALLED_APP : null
}
