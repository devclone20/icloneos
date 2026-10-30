/**
 * Diagnostics fixes: each `impl` turns the CURRENT state into a declarative plan (a list of steps); the executor applies
 * the steps after copying every path it touches into `<userData>/diagnostics/backups/<ts>-<fix>/`. A healthy state
 * yields an empty plan, which is what makes every fix idempotent. Dry-run = the plan, nothing written.
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  acpPrivatePaths,
  brokenOwnership,
  CUA_DRIVER_BUNDLE_ID,
  DEFAULT_BUNDLE_ID,
  deniedMedia,
  type DoctorEnv,
  interpreterVersion,
  lstat,
  modeOf,
  octal,
  openHolders,
  pidAlive,
  privateDataFiles,
  pyvenvHome,
  pyvenvVersion,
  quickCheck,
  readText,
  realInterpreter,
  registryDrift,
  RELEASES_URL,
  staleGatewayPid,
  stateBackups,
  stateDbFiles,
  stateDbPath,
  updatesCheckValue,
  venvPythonPath,
  wrapperPath
} from './iclone-doctor-checks'
import { mirrorFile, ownershipFile } from './iclone-ownership-store'
import { writeFileAtomicSync } from './lib/atomic-write'

export type FixStep =
  | { kind: 'write'; path: string; content: string; mode: number }
  | { kind: 'chmod'; path: string; mode: number }
  | { kind: 'quarantine'; path: string }
  | { kind: 'copy'; from: string; to: string; mode: number }
  | { kind: 'symlink'; path: string; target: string }
  | { kind: 'exec'; file: string; args: string[]; backups: string[]; timeoutMs: number; env?: NodeJS.ProcessEnv }
  | { kind: 'kill'; pid: number }
  | { kind: 'call'; name: 'clearCache' }
  | { kind: 'gateway'; action: 'stop' | 'offline'; offline: string[] }
  | { kind: 'gateway'; action: 'start' }
  | { kind: 'open'; url: string }
  | { kind: 'advice'; text: string }

export type FixImpl = (env: DoctorEnv) => Promise<FixStep[]>

const PRIVACY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy'

const MEDIA_PANE = {
  microphone: { pane: 'Microphone', label: 'Microphone' },
  screen: { pane: 'ScreenCapture', label: 'Screen Recording' }
} as const

export function describeStep(step: FixStep): string {
  switch (step.kind) {
    case 'write':
      return `write ${step.path} (mode ${octal(step.mode)})`

    case 'chmod':
      return `chmod ${octal(step.mode)} ${step.path}`

    case 'quarantine':
      return `move ${step.path} aside as ${path.basename(step.path)}.corrupt-<time>`

    case 'copy':
      return `copy ${step.from} → ${step.to}`

    case 'symlink':
      return `link ${step.path} → ${step.target}`

    case 'exec':
      return `run ${[step.file, ...step.args].join(' ')}`

    case 'kill':
      return `stop process ${step.pid}`

    case 'call':
      return 'clear the renderer cache (cookies and settings are kept)'
    case 'gateway': {
      if (step.action === 'start') {
        return 'start the app’s gateway again'
      }

      const aside = `move ${step.offline.map(f => path.basename(f)).join(', ')} aside as <name>.corrupt-<time> once nobody holds them`

      return step.action === 'stop'
        ? `stop the app’s gateway (it starts again after the restore), then ${aside}`
        : aside
    }

    case 'open':
      return `open ${step.url}`

    case 'advice':
      return step.text
  }
}

/** Steps that change nothing on disk or in a process. */
export const isPassive = (step: FixStep) => step.kind === 'advice' || step.kind === 'open'

function chmodSteps(files: readonly string[], mode: number): FixStep[] {
  return files
    .filter(f => {
      const st = lstat(f)

      return st !== null && modeOf(st) !== mode
    })
    .map(f => ({ kind: 'chmod', path: f, mode }))
}

/** First existing interpreter whose X.Y equals the venv's (when pyvenv.cfg records one): another X.Y breaks its packages. */
async function interpreterFor(env: DoctorEnv): Promise<string | null> {
  const home = pyvenvHome(env)
  const want = pyvenvVersion(env)

  const candidates = [
    ...(home ? [path.join(home, 'python3'), path.join(home, 'python')] : []),
    ...(want ? [`/opt/homebrew/bin/python${want}`, `/usr/local/bin/python${want}`] : []),
    ...(env.interpreters ?? ['/opt/homebrew/bin/python3', '/usr/local/bin/python3'])
  ].filter(c => lstat(c) !== null && fs.statSync(c).isFile())

  for (const candidate of new Set(candidates)) {
    if (!want || (await interpreterVersion(env, candidate)) === want) {
      return candidate
    }
  }

  return null
}

export const FIXES: Record<string, FixImpl> = {
  async venvRepair(env) {
    if (path.resolve(env.venvDir).startsWith(path.join(path.resolve(env.hermesHome), 'hermes-agent') + path.sep)) {
      // The upstream runtime tree is never repaired in place: it is re-staged from the pinned release.
      return [
        {
          kind: 'advice',
          text: 'Reinstall the runtime from Settings › App Atualisation (re-stages it from the pinned release).'
        }
      ]
    }

    const want = pyvenvVersion(env)
    const real = realInterpreter(env)
    const mismatch = Boolean(real && want && (await interpreterVersion(env, real)) !== want)
    const interpreter = await interpreterFor(env)

    if (!interpreter) {
      return [
        {
          kind: 'advice',
          text: `No Python ${want ?? '3'} interpreter found on this Mac. Reinstall the runtime from Settings › App Atualisation.`
        }
      ]
    }

    const steps: FixStep[] = []

    if (!real || mismatch) {
      steps.push({ kind: 'symlink', path: venvPythonPath(env), target: interpreter })
    }

    const home = pyvenvHome(env)

    if (!home || !lstat(home)?.isDirectory()) {
      const cfg = path.join(env.venvDir, 'pyvenv.cfg')
      const text = readText(cfg) ?? ''
      const line = `home = ${path.dirname(interpreter)}`
      const content = /^\s*home\s*=.*$/m.test(text) ? text.replace(/^\s*home\s*=.*$/m, line) : `${line}\n${text}`

      steps.push({ kind: 'write', path: cfg, content, mode: 0o644 })
    }

    return steps
  },

  async updatesCheckOff(env) {
    const file = path.join(env.hermesHome, 'config.yaml')
    const text = readText(file)

    if (text === null || updatesCheckValue(text) === 'false') {
      return []
    }

    if (!realInterpreter(env)) {
      return [{ kind: 'advice', text: 'Run `hermes config set updates.check false` once the runtime is installed.' }]
    }

    // Written by the runtime's own CLI so its YAML layout and comments survive.
    return [
      {
        kind: 'exec',
        file: venvPythonPath(env),
        args: ['-m', 'hermes_cli.main', 'config', 'set', 'updates.check', 'false'],
        backups: [file],
        timeoutMs: 20_000,
        env: { ...process.env, HERMES_HOME: env.hermesHome }
      }
    ]
  },

  async freePort(env) {
    const stale = await staleGatewayPid(env)

    return stale.pid === null ? [] : [{ kind: 'kill', pid: stale.pid }]
  },

  async restoreStateDb(env) {
    const file = stateDbPath(env)
    const claim = env.gateway?.claim?.()
    const own = claim && pidAlive(claim.pid) ? claim.pid : null
    // Every process with state.db or its -wal/-shm open, not only the gateway we claim: a second writer corrupts it.
    const holders = await openHolders(env, stateDbFiles(env))

    if (holders.error) {
      return [{ kind: 'advice', text: `Could not tell who uses state.db (${holders.error}); nothing was moved.` }]
    }

    const foreign = holders.pids.filter(pid => pid !== own && pid !== env.mainPid)

    if (foreign.length) {
      return [
        {
          kind: 'advice',
          text: `state.db is open in another process (pid ${foreign.join(', ')}). Quit it, then run this fix again.`
        }
      ]
    }

    const stopFirst = own !== null || holders.pids.length > 0

    // The app relaunches its gateway at start, so "quit and reopen" never frees state.db: the plan stops it itself.
    let backup: { file: string; mtimeMs: number } | null = null

    for (const candidate of stateBackups(env)) {
      // A backup is restored only when it is itself a sound database.
      if ((await quickCheck(env, candidate.file)).detail === 'quick_check ok') {
        backup = candidate

        break
      }
    }

    if (!backup) {
      return [
        {
          kind: 'advice',
          text: 'No sound sessions backup on this Mac. Quit icloneOS and keep state.db for support.'
        }
      ]
    }

    const saved = new Date(backup.mtimeMs).toISOString().replace('T', ' ').slice(0, 16)

    return [
      { kind: 'advice', text: `Restores ${path.basename(backup.file)} (saved ${saved} UTC, quick_check ok).` },
      // Stop, prove nobody holds the files, and move them aside in ONE step: no event-loop turn in between in which
      // the app could relaunch its gateway on the live files.
      stopFirst
        ? ({ kind: 'gateway', action: 'stop', offline: stateDbFiles(env) } as FixStep)
        : ({ kind: 'gateway', action: 'offline', offline: stateDbFiles(env) } as FixStep),
      { kind: 'copy', from: backup.file, to: file, mode: 0o600 },
      ...(stopFirst ? [{ kind: 'gateway', action: 'start' } as FixStep] : [])
    ]
  },

  async quarantineWal(env) {
    const file = stateDbPath(env)

    return lstat(file)
      ? []
      : ['-wal', '-shm'].filter(s => lstat(`${file}${s}`)).map(s => ({ kind: 'quarantine', path: `${file}${s}` }))
  },

  async rewriteWrapper(env) {
    const expected = env.acp?.wrapperSource?.() ?? null
    const file = wrapperPath(env)

    if (expected === null) {
      return []
    }

    if (readText(file) !== expected) {
      return [{ kind: 'write', path: file, content: expected, mode: 0o755 }]
    }

    return chmodSteps([file], 0o755)
  },

  async rerenderRegistry(env) {
    const own = env.acp?.registryText?.() ?? null
    const file = path.join(env.icloneHome, 'inft.tsv')
    const { rows, stale, missing } = registryDrift(env)

    if (own === null) {
      return stale.length || missing.length
        ? [{ kind: 'advice', text: 'Restart icloneOS: it rebuilds the registry on launch.' }]
        : []
    }

    if (stale.length === 0 && missing.length === 0) {
      return []
    }

    // Other instances' rows (and their names) are kept; only rows whose setup is gone leave.
    const header = own.split('\n').find(line => line.startsWith('#')) ?? '#'

    const kept = [...rows.filter(r => !stale.includes(r)), ...missing].sort(
      (a, b) => Number(a.token) - Number(b.token) || a.slug.localeCompare(b.slug)
    )

    return [{ kind: 'write', path: file, content: `${[header, ...kept.map(r => r.line)].join('\n')}\n`, mode: 0o600 }]
  },

  async chmodPrivate(env) {
    return chmodSteps(acpPrivatePaths(env), 0o600)
  },

  async signInAgain() {
    return [{ kind: 'advice', text: 'Open the wallet and sign in again.' }]
  },

  async quarantineConsent(env) {
    return [{ kind: 'quarantine', path: path.join(env.userData, 'consent.json') }]
  },

  // FX-3: the pane of the item the check flagged (Screen opened Microphone before).
  async openPrivacy(env) {
    const [first, ...rest] = deniedMedia(env)

    if (!first) {
      return []
    }

    return [
      { kind: 'open', url: `${PRIVACY_PANE}_${MEDIA_PANE[first].pane}` },
      ...rest.map(
        kind =>
          ({
            kind: 'advice',
            text: `Then allow icloneOS under ${MEDIA_PANE[kind].label} in the same Privacy & Security list.`
          }) as FixStep
      )
    ]
  },

  async resetAccessibility(env) {
    return [
      // K144 r3 (main): the running copy's own entry (a `.dev` pack is not the release app).
      {
        kind: 'exec',
        file: '/usr/bin/tccutil',
        args: ['reset', 'Accessibility', env.bundleId || DEFAULT_BUNDLE_ID],
        backups: [],
        timeoutMs: 5000
      },
      // FX-3: computer use holds its Accessibility trust on CuaDriver, so that entry is reset too — it is the one the
      // check flagged.
      {
        kind: 'exec',
        file: '/usr/bin/tccutil',
        args: ['reset', 'Accessibility', CUA_DRIVER_BUNDLE_ID],
        backups: [],
        timeoutMs: 5000
      },
      { kind: 'open', url: `${PRIVACY_PANE}_Accessibility` }
    ]
  },

  async restoreOwnership(env) {
    return brokenOwnership(env)
      .filter(b => b.restorable)
      .flatMap(b => {
        const file = ownershipFile(env.userData, b.slug)

        return [
          { kind: 'quarantine', path: file },
          { kind: 'copy', from: mirrorFile(env.userData, b.slug), to: file, mode: 0o600 }
        ] as FixStep[]
      })
  },

  async chmodPrivateData(env) {
    return chmodSteps(privateDataFiles(env), 0o600)
  },

  async installRelease() {
    return [{ kind: 'open', url: RELEASES_URL }]
  },

  async chmodSpawnHelper(env) {
    return env.native?.spawnHelper ? chmodSteps([env.native.spawnHelper], 0o755) : []
  },

  async clearCache(env) {
    return env.electron?.clearCache ? [{ kind: 'call', name: 'clearCache' }] : []
  }
}

/** Every on-disk path a step will change (backed up before the step runs). */
function touched(step: FixStep): string[] {
  switch (step.kind) {
    case 'gateway':
      return step.action === 'start' ? [] : step.offline.filter(f => lstat(f))

    case 'quarantine':

    case 'write':

    case 'chmod':

    case 'symlink':
      return [step.path]

    case 'copy':
      return [step.to]

    case 'exec':
      return step.backups

    default:
      return []
  }
}

interface BackupEntry {
  path: string
  backup: string | null
  mode: number | null
  link: string | null
}

function backupPath(dir: string, file: string, index: number, entries: BackupEntry[]): void {
  if (entries.some(e => e.path === file)) {
    return
  }

  const st = lstat(file)

  if (!st) {
    entries.push({ path: file, backup: null, mode: null, link: null })

    return
  }

  if (st.isSymbolicLink()) {
    entries.push({ path: file, backup: null, mode: null, link: fs.readlinkSync(file) })

    return
  }

  const target = path.join(dir, 'files', `${index}-${path.basename(file)}`)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  fs.copyFileSync(file, target)
  fs.chmodSync(target, 0o600)
  entries.push({ path: file, backup: target, mode: modeOf(st), link: null })
}

function writeAtomic(file: string, content: string, mode: number): void {
  writeFileAtomicSync(file, content, { mode })
}

interface ApplyOutcome {
  backupDir: string | null
  done: string[]
  error?: string
}

/** Applies a plan; stops at the first failing step (the backup already holds every pre-image touched so far). */
export async function applySteps(
  env: DoctorEnv,
  fixId: string,
  steps: FixStep[],
  backupsRoot: string
): Promise<ApplyOutcome> {
  const stamp = new Date(env.now()).toISOString().replace(/[:.]/g, '-')
  const writes = steps.filter(s => !isPassive(s))
  const dir = writes.length ? path.join(backupsRoot, `${stamp}-${fixId}`) : null
  const entries: BackupEntry[] = []
  const done: string[] = []
  const moved: MovedAside[] = []
  let gatewayDown = false
  let startAttempted = false

  const saveManifest = (rolledBack = false) => {
    if (dir) {
      writeAtomic(
        path.join(dir, 'manifest.json'),
        `${JSON.stringify({ fixId, at: stamp, steps: steps.map(describeStep), entries, ...(rolledBack ? { rolledBack } : {}) }, null, 2)}\n`,
        0o600
      )
    }
  }

  if (dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  try {
    for (const step of steps) {
      if (dir) {
        touched(step).forEach(file => backupPath(dir, file, entries.length, entries))
      }

      if (step.kind === 'gateway' && step.action !== 'offline') {
        gatewayDown = step.action === 'stop'
        startAttempted ||= step.action === 'start'
      }

      await runStep(env, step, stamp, moved)
      done.push(describeStep(step))
    }

    saveManifest()

    return { backupDir: dir, done }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    // Nothing in this catch may throw before the gateway restart below: the owner must never be left without a
    // gateway because the ROLLBACK's own bookkeeping failed (a full disk fails the manifest write too).

    // Files moved aside go back BEFORE the gateway restarts: started on a missing state.db, hermes would create an
    // empty one (every session gone) and a later undo would overwrite what it wrote since. Once a start was
    // attempted the gateway may already hold the restored files, so they stay.
    const lost = startAttempted ? [] : putBack(moved, entries)
    const rolledBack = moved.length > 0 && !startAttempted && lost.length === 0

    let manifestNote = ''

    try {
      saveManifest(rolledBack)
    } catch {
      manifestNote = '; manifest not written'
    }

    // Never leave the owner without a gateway because a later step failed — unless its database could not be put
    // back: a gateway started now would replace it with an empty one.
    if (gatewayDown && lost.length === 0) {
      await env.gateway?.start?.().catch(() => undefined)
    }

    if (rolledBack) {
      return { backupDir: null, done: [], error: `${message}; rolled back, nothing changed${manifestNote}` }
    }

    const tail = lost.length
      ? `; could not put back ${lost.join(', ')} (pre-images in the backup)${gatewayDown ? '; the gateway stays stopped' : ''}`
      : ''

    return { backupDir: dir, done, error: `${message}${tail}${manifestNote}` }
  }
}

interface MovedAside {
  from: string
  to: string
}

/** Moves files set aside back to their names; falls back to the backup's pre-image. Returns the paths it could not restore. */
function putBack(moved: MovedAside[], entries: BackupEntry[]): string[] {
  const lost: string[] = []

  for (const m of [...moved].reverse()) {
    try {
      fs.renameSync(m.to, m.from)
    } catch {
      const pre = entries.find(e => e.path === m.from)?.backup

      try {
        if (!pre) {
          throw new Error('no pre-image')
        }

        fs.copyFileSync(pre, m.from)
        fs.chmodSync(m.from, 0o600)
      } catch {
        lost.push(path.basename(m.from))
      }
    }
  }

  return lost
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

async function runStep(env: DoctorEnv, step: FixStep, stamp: string, moved: MovedAside[]): Promise<void> {
  switch (step.kind) {
    case 'write':
      writeAtomic(step.path, step.content, step.mode)

      return

    case 'chmod':
      fs.chmodSync(step.path, step.mode)

      return

    case 'quarantine':
      fs.renameSync(step.path, `${step.path}.corrupt-${stamp}`)

      return

    case 'copy':
      writeFileAtomicSync(step.to, fs.readFileSync(step.from), { mode: step.mode })

      return

    case 'symlink':
      fs.rmSync(step.path, { force: true })
      fs.symlinkSync(step.target, step.path)

      return
    case 'exec': {
      const out = await env.exec(step.file, step.args, { timeoutMs: step.timeoutMs, signal: env.signal, env: step.env })

      if (out.code !== 0) {
        throw new Error(
          `${path.basename(step.file)} exited ${out.code ?? 'abnormally'}${out.timedOut ? ' (timeout)' : ''}`
        )
      }

      return
    }

    case 'kill':
      process.kill(step.pid, 'SIGTERM')

      for (let i = 0; i < 40 && alive(step.pid); i++) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }

      return

    case 'call':
      await env.electron?.clearCache?.()

      return
    case 'gateway': {
      if (step.action === 'start') {
        await env.gateway?.start?.()

        return
      }

      if (step.action === 'stop') {
        if (!env.gateway?.stop || !env.gateway.start) {
          throw new Error('this build cannot stop its gateway; nothing was moved')
        }

        await env.gateway.stop()
      }

      const after = await openHolders(env, step.offline)

      if (after.error || after.pids.length) {
        throw new Error(after.error ?? `state.db is still open (pid ${after.pids.join(', ')}); nothing was moved`)
      }

      // Synchronous from here to the next step: a clean exit may already have removed -wal/-shm.
      for (const f of step.offline.filter(file => lstat(file))) {
        fs.renameSync(f, `${f}.corrupt-${stamp}`)
        moved.push({ from: f, to: `${f}.corrupt-${stamp}` })
      }

      return
    }

    case 'open':
      await env.electron?.openExternal?.(step.url)

      return

    case 'advice':
      return
  }
}
