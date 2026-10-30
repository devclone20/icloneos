/**
 * Packaged builds ignore code-path environment overrides.
 *
 * A notarized app launched through LaunchServices (`open --env NAME=value -a
 * "iclone os"`) runs under its own TCC identity, so any environment variable
 * that changes which code runs, where config and secrets come from, or which
 * binary is exec'd turns the shipped app into a loader for someone else's
 * code: `HERMES_DESKTOP_DEV_SERVER` loads remote HTML with the full preload
 * bridge (the terminal IPC is a shell), `HERMES_HOME` / `…_USER_DATA_DIR` /
 * `…_PYTHON` do the same through config and binaries. The fuses cover none of
 * these, so every such read goes through this module, which answers
 * `undefined` for all of them when the app is packaged (the same rule as
 * `dev-cdp.ts`). Tuning knobs (`…_POOL_*`, `…_SKIP_QUIT_CONFIRM`, `…_APP_NAME`,
 * `…_CWD`, `…_BOOT_FAKE_STEP_MS`) and `…_CDP_PORT` stay outside the list.
 *
 * Child processes must not inherit the raw values either, so a packaged run
 * also seals `process.env`: the code-path names are deleted and only the
 * values the app resolved itself (`HERMES_HOME`, the login `SHELL`) are put
 * back.
 */

import os from 'node:os'

import { app } from 'electron'

export const CODE_PATH_ENV = [
  'HERMES_DESKTOP_DEV_SERVER',
  'HERMES_DESKTOP_WEB_DIST',
  'HERMES_DESKTOP_IS_PACKAGED',
  'HERMES_DESKTOP_BOOT_FAKE',
  'HERMES_DESKTOP_BOOT_FAKE_ERROR',
  'HERMES_DESKTOP_HERMES',
  'HERMES_DESKTOP_HERMES_ROOT',
  'HERMES_DESKTOP_PYTHON',
  'HERMES_DESKTOP_IGNORE_EXISTING',
  'HERMES_DESKTOP_USER_DATA_DIR',
  'HERMES_DESKTOP_REMOTE_URL',
  'HERMES_DESKTOP_REMOTE_TOKEN',
  'HERMES_DESKTOP_SHELL',
  'HERMES_HOME',
  'SHELL'
] as const

type CodePathEnvName = (typeof CODE_PATH_ENV)[number]

type Env = Record<string, string | undefined>

export const ENV_POLICY_TAG = '[iclone-env-policy]'

/** Pure: the value a code-path variable may contribute, given the build. */
export function resolveCodePathEnv(name: CodePathEnvName, env: Env, isPackaged: boolean): string | undefined {
  return isPackaged ? undefined : env[name]
}

/** Pure: the shell the embedded terminal starts when nobody may override it. */
export function resolveLoginShell(env: Env, isPackaged: boolean, userShell: () => string): string | undefined {
  const fromEnv = resolveCodePathEnv('SHELL', env, isPackaged)

  if (fromEnv) {
    return fromEnv
  }

  try {
    return userShell() || undefined
  } catch {
    return undefined
  }
}

/**
 * Pure: drop every code-path variable from `env` (in place) when packaged and
 * put back only the values the app resolved. Returns the names whose raw value
 * was discarded, for the policy log line.
 */
export function sealChildEnv(
  env: Env,
  isPackaged: boolean,
  resolved: Partial<Record<CodePathEnvName, string | undefined>>
): string[] {
  if (!isPackaged) {
    return []
  }

  const discarded: string[] = []

  for (const name of CODE_PATH_ENV) {
    if (env[name] !== undefined && env[name] !== resolved[name]) {
      discarded.push(name)
    }

    delete env[name]
  }

  for (const name of CODE_PATH_ENV) {
    const value = resolved[name]

    if (value) {
      env[name] = value
    }
  }

  return discarded
}

// `app` is undefined outside the Electron main process (plain vitest runs);
// there is no packaged build to protect there.
function isPackagedBuild(): boolean {
  return app?.isPackaged === true
}

let policyLogged = false

function logPolicyOnce(detail: string) {
  if (policyLogged) {
    return
  }

  policyLogged = true
  console.log(`${ENV_POLICY_TAG} ${detail}`)
}

/** Runtime read of a code-path variable through the policy. */
export function codePathEnv(name: CodePathEnvName): string | undefined {
  const isPackaged = isPackagedBuild()

  logPolicyOnce(
    isPackaged ? 'packaged: code-path env overrides ignored' : 'unpackaged: code-path env overrides honoured'
  )

  return resolveCodePathEnv(name, process.env, isPackaged)
}

/** Runtime login shell: `$SHELL` in dev, the account's shell when packaged. */
export function loginShell(): string | undefined {
  return resolveLoginShell(process.env, isPackagedBuild(), () => os.userInfo().shell ?? '')
}

const MEDIA_POLICY_TAG = '[iclone-media-policy]'

// Electron passes a union of permission-request shapes; only the media one
// carries `mediaTypes`.
function mediaTypesOf(details: unknown): unknown {
  return typeof details === 'object' && details !== null && 'mediaTypes' in details ? details.mediaTypes : undefined
}

/**
 * Media capture is audio-only: no code path uses the camera, and the signed
 * app carries no camera entitlement, so a renderer that asks for video (a
 * loaded page, a plugin) is refused here before macOS is ever asked.
 * Chromium on Windows often sends a `media` request with empty `mediaTypes`;
 * that stays allowed and is audio by construction.
 */
export function isAllowedMediaRequest(permission: string, details?: unknown): boolean {
  if (permission === 'audioCapture') {
    return true
  }

  if (permission !== 'media') {
    return false
  }

  const mediaTypes = mediaTypesOf(details)

  if (!Array.isArray(mediaTypes) || mediaTypes.length === 0) {
    return true
  }

  return mediaTypes.every(type => type === 'audio')
}

/** Synchronous check handler counterpart of {@link isAllowedMediaRequest}. */
export function isAllowedMediaCheck(permission: string): boolean {
  return permission === 'media' || permission === 'audioCapture'
}

/** Request-handler decision with the policy log tag on every video refusal. */
export function decideMediaRequest(permission: string, details?: unknown): boolean {
  const allowed = isAllowedMediaRequest(permission, details)
  const types = mediaTypesOf(details)
  const wantsVideo = permission === 'videoCapture' || (Array.isArray(types) && types.includes('video'))

  if (!allowed && wantsVideo) {
    console.log(`${MEDIA_POLICY_TAG} videoCapture denied`)
  }

  return allowed
}

/**
 * Seal `process.env` for child processes once the app has resolved its own
 * values. No-op unless packaged.
 */
export function sealPackagedProcessEnv(resolved: { HERMES_HOME: string }): string[] {
  const isPackaged = isPackagedBuild()
  const discarded = sealChildEnv(process.env, isPackaged, { HERMES_HOME: resolved.HERMES_HOME, SHELL: loginShell() })

  if (isPackaged) {
    console.log(`${ENV_POLICY_TAG} child env sealed; discarded: ${discarded.length ? discarded.join(', ') : 'none'}`)
  }

  return discarded
}
