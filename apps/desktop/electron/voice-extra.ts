/**
 * v0.0.9 W1b — the voice extra (local speech recognition, the runtime's `stt-whisper` extra) installed APP-SIDE, only
 * on the owner's click, into the app's private dependency home.
 *
 * Lead decision (17 Nov, R-f2-4 b): voice is not deferred, and the backend never installs it itself — lazy installs
 * stay off for the managed runtime (HERMES_DISABLE_LAZY_INSTALLS), the pinned runtime root stays read-only to the
 * sandbox, and nothing is ever written under the user's `<HERMES_HOME>/installs`. Main runs the runtime's OWN explicit
 * installer (`hermes pm install --extra stt-whisper`, pm/cli.py → `sync_venv([...], explicit=True)`) unconfined, the
 * way the bootstrap's `python-deps` stage does (bootstrap-runner.ts `placeStage`): HOME and HERMES_HOME = the runtime's
 * private dependency home (`<runtime>/.iclone-deps/{home,hermes}`, env.ts `runtimePrivateDependencies`), plus
 * HERMES_DEPENDENCY_HOME = that same root (the pin a runtime carrying runtime-patches/pm-dependency-home.patch
 * honours). The new generation lands in `<private hermes>/installs/<key>/environments/…`; the next start of the agent
 * boots on it (env.ts `activeVenvRoot` → pm-venv.ts `pmCommittedVenv`).
 *
 * Gesture: the install IPC needs the V3-F three facts (activation + a trusted click on the
 * `data-voice-extra-confirm` control + recent real input to this window), never loosened; the app sender guard first.
 * Everything with a side effect comes in through deps, so the tests drive the real logic with a throwaway HOME.
 */
import fs from 'node:fs'
import path from 'node:path'

import type { IpcMainInvokeEvent } from 'electron'

import { gestureOf, permissionGestureOk } from './iclone-permissions/gesture'
import { PYTHON_ISOLATION_FLAGS } from './iclone-spawn-env'
import { NO_LINKS_ENV } from './lib/no-follow-fs'
import { VOICE_EXTRA, type VoiceExtraInstallAnswer, type VoiceExtraStatus } from './voice-extra-types'

/** Wheels are downloaded: a slow link needs minutes, never forever. */
export const VOICE_INSTALL_TIMEOUT_MS = 15 * 60_000
const LOG_TAG = '[voice-extra]'

/** The runtime's platform gate for `stt-whisper` (pyproject.toml `[tool.hermes.platform-gates]`), mirrored. */
export function voiceExtraSupported(platform: NodeJS.Platform, arch: string): boolean {
  return !(platform === 'win32' && arch === 'arm64') && !(platform === 'darwin' && arch === 'x64')
}

/** The anchor module of the extra (pm/extras.py ANCHORS `stt-whisper` → `faster_whisper`) in a venv's site-packages. */
export function voiceExtraInVenv(venv: null | string, platform: NodeJS.Platform = process.platform): boolean {
  if (!venv) {
    return false
  }

  try {
    if (platform === 'win32') {
      return fs.statSync(path.join(venv, 'Lib', 'site-packages', 'faster_whisper')).isDirectory()
    }

    const lib = path.join(venv, 'lib')

    return fs
      .readdirSync(lib)
      .filter(name => /^python3\.\d+$/.test(name))
      .some(name => {
        try {
          return fs.statSync(path.join(lib, name, 'site-packages', 'faster_whisper')).isDirectory()
        } catch {
          return false
        }
      })
  } catch {
    return false
  }
}

export interface PrivateDependencyHome {
  /** `<runtime>/.iclone-deps/hermes`: PM's dependency root for the app's runtime. */
  hermesHome: string
  /** `<runtime>/.iclone-deps/home`: the HOME the private stages run with (uv, the pinned Python, PM's store). */
  home: string
}

/**
 * The exact command for the explicit install: the environment's Python on the verified runtime (`-s -P
 * --check-hash-based-pycs always -m hermes_cli.main pm install --extra stt-whisper`), env sealed by `sealEnv`, then
 * the private homes and the dependency pin set AFTER the seal (which would keep them anyway: HOME, HERMES_HOME and
 * HERMES_DEPENDENCY_HOME are on its allowlist), no bytecode written into the read-only runtime tree. Never
 * HERMES_DISABLE_LAZY_INSTALLS-dependent: an explicit install is not a lazy one (pm/install.py `sync_venv`).
 */
export function voiceExtraCommand(input: {
  baseEnv: NodeJS.ProcessEnv
  priv: PrivateDependencyHome
  python: string
  sealEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
}): { args: string[]; cmd: string; env: NodeJS.ProcessEnv } {
  const sealed = input.sealEnv ? input.sealEnv({ ...input.baseEnv }) : { ...input.baseEnv }

  return {
    cmd: input.python,
    args: [
      ...PYTHON_ISOLATION_FLAGS,
      '--check-hash-based-pycs',
      'always',
      '-m',
      'hermes_cli.main',
      'pm',
      'install',
      '--extra',
      VOICE_EXTRA
    ],
    env: {
      ...sealed,
      HOME: input.priv.home,
      HERMES_HOME: input.priv.hermesHome,
      HERMES_DEPENDENCY_HOME: input.priv.hermesHome,
      PYTHONDONTWRITEBYTECODE: '1',
      ...NO_LINKS_ENV
    }
  }
}

export interface VoiceExtraDeps {
  /** The runtime the app runs (ACTIVE_HERMES_ROOT); null when there is none. */
  runtimeRoot(): null | string
  /** The runtime's private dependency home; null in the dev (shared) layout. */
  privateDependencies(): null | PrivateDependencyHome
  /** The committed dependency environment of `root` under `hermesHome` (pm-venv.ts `pmCommittedVenv`). */
  committedVenv(root: string, hermesHome: string): null | string
  /** The interpreter of a venv (executables.ts `getVenvPython`). */
  venvPython(venv: string): string
  /** Packaged: the runtime's integrity check (iclone-gate.ts `checkRuntimeIntegrity`); throws when it fails. */
  verifyRuntime?(root: string): Promise<unknown>
  /** Packaged: the interpreter env seal (iclone-spawn-env.ts `isolatePythonEnv`). */
  sealEnv?(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv
  run(
    cmd: string,
    args: string[],
    opts: { env: NodeJS.ProcessEnv; timeoutMs: number }
  ): Promise<{ code: null | number }>
  baseEnv?(): NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  log(line: string): void
}

export interface VoiceExtra {
  status(): VoiceExtraStatus
  install(): Promise<VoiceExtraInstallAnswer>
}

export function createVoiceExtra(deps: VoiceExtraDeps): VoiceExtra {
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch
  let running: null | Promise<VoiceExtraInstallAnswer> = null
  let installedHere = false

  const managed = (): null | { priv: PrivateDependencyHome; root: string } => {
    const root = deps.runtimeRoot()
    const priv = deps.privateDependencies()

    return root && priv ? { priv, root } : null
  }

  const status = (): VoiceExtraStatus => {
    if (running) {
      return { state: 'installing' }
    }

    if (!voiceExtraSupported(platform, arch)) {
      return { state: 'unsupported' }
    }

    const where = managed()

    if (!where) {
      return { state: 'unmanaged' }
    }

    return voiceExtraInVenv(deps.committedVenv(where.root, where.priv.hermesHome), platform)
      ? { state: 'installed', ...(installedHere ? { restartNeeded: true } : {}) }
      : { state: 'absent' }
  }

  const runInstall = async (root: string, priv: PrivateDependencyHome): Promise<VoiceExtraInstallAnswer> => {
    if (deps.verifyRuntime) {
      try {
        await deps.verifyRuntime(root)
      } catch (error) {
        deps.log(`${LOG_TAG} install refused: the runtime did not verify (${(error as Error).message})`)

        return { ok: false, error: 'The agent runtime did not pass its integrity check. Repair it, then try again.' }
      }
    }

    const venv = deps.committedVenv(root, priv.hermesHome)

    if (!venv) {
      return { ok: false, error: 'The agent runtime is not installed yet. Start the agent once, then try again.' }
    }

    const { cmd, args, env } = voiceExtraCommand({
      baseEnv: deps.baseEnv?.() ?? process.env,
      priv,
      python: deps.venvPython(venv),
      ...(deps.sealEnv ? { sealEnv: (base: NodeJS.ProcessEnv) => deps.sealEnv!(base, root) } : {})
    })

    deps.log(`${LOG_TAG} installing ${VOICE_EXTRA} into the app's private dependency home (owner's click)`)

    const result = await deps
      .run(cmd, args, { env, timeoutMs: VOICE_INSTALL_TIMEOUT_MS })
      .catch(() => ({ code: null }))
    // The new generation is committed by PM itself: judge by what the environment now carries, not by the exit code.
    const now = deps.committedVenv(root, priv.hermesHome)

    if (result.code === 0 && voiceExtraInVenv(now, platform)) {
      installedHere = true
      deps.log(`${LOG_TAG} ${VOICE_EXTRA} installed; the agent uses it from its next start`)

      return { ok: true, status: { state: 'installed', restartNeeded: true } }
    }

    deps.log(`${LOG_TAG} ${VOICE_EXTRA} install did not finish (exit ${result.code ?? 'none'})`)

    return {
      ok: false,
      error:
        result.code === null
          ? 'The voice install stopped before it finished (time limit or no network). Try again.'
          : `The voice install did not finish (exit ${result.code}). Try again.`
    }
  }

  return {
    status,
    install: (): Promise<VoiceExtraInstallAnswer> => {
      if (running) {
        return Promise.resolve({ ok: false, refused: 'busy' } as const)
      }

      if (!voiceExtraSupported(platform, arch)) {
        return Promise.resolve({ ok: false, refused: 'unsupported' } as const)
      }

      const where = managed()

      if (!where) {
        return Promise.resolve({ ok: false, refused: 'unmanaged' } as const)
      }

      if (voiceExtraInVenv(deps.committedVenv(where.root, where.priv.hermesHome), platform)) {
        return Promise.resolve({ ok: true, status: status() } as const)
      }

      running = runInstall(where.root, where.priv).finally(() => {
        running = null
      })

      return running
    }
  }
}

export interface VoiceExtraIpcDeps {
  voice: VoiceExtra
  handle(channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown): void
  isTrustedSender(event: IpcMainInvokeEvent, channel: string): boolean
  lastInputAt(event: IpcMainInvokeEvent): number
  now?(): number
}

/** `iclone:voice-extra:{status,install}` behind the app sender guard; the install needs the owner's own click. */
export function registerVoiceExtraIpc(deps: VoiceExtraIpcDeps): void {
  const now = deps.now ?? Date.now
  const guarded = (channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) =>
    deps.handle(channel, (event, input) => (deps.isTrustedSender(event, channel) ? handler(event, input) : null))

  guarded('iclone:voice-extra:status', () => deps.voice.status())
  guarded('iclone:voice-extra:install', (event, input): Promise<VoiceExtraInstallAnswer> | VoiceExtraInstallAnswer => {
    if (!permissionGestureOk({ lastInputAt: deps.lastInputAt(event), now: now(), payload: gestureOf(input) })) {
      return { ok: false, refused: 'gesture' }
    }

    return deps.voice.install()
  })
}
