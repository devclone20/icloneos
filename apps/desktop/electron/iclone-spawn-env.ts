/**
 * V3-S r3 (m-b, m-f), r4 (m-b′), r5 (m-b″) — the environment and interpreter flags of every Python the gate holds: the
 * armed probe and each gated spawn. Pure functions, no electron.
 *
 * Inherited configuration is code. "Armed" proves REGISTRATION, not dispatch, so whatever runs in the spawn after the
 * probe saw the hooks registered can still patch dispatch — unless it never reaches the spawn. Round 4 dropped families
 * (PYTHON*, PYVENV*, DYLD_*, LD_*, foreign HERMES_*) and let everything else pass; the critic then loaded native code
 * through `OPENSSL_CONF` (a provider module runs when the agent touches TLS), and `OPENSSL_MODULES`, `GCONV_PATH`,
 * `NODE_OPTIONS` are the same kind. A denylist leaks the next such variable, so the seal and the probe now keep ONLY
 * these (`interpreterEnvAllows`), whatever else the parent process or a call site carries:
 * - `PATH` — where the agent's own tools are found (backend-env puts the runtime's venv first);
 * - `HOME` — the user's home (Hermes' own state is under HERMES_HOME);
 * - `TMPDIR` — where temp files go;
 * - `LANG` and `LC_*` — the locale, so text is decoded as the user's;
 * - `TERM` — the terminal type for the agent's shell commands;
 * - `TERMINAL_CWD` — set by the app on every gated spawn: the cwd of the agent's tool calls;
 * - identity/session, cannot load code (`SESSION_ENV_ALLOW`, lead ruling after r5): `USER`, `LOGNAME`, `SHELL`,
 *   `SSH_AUTH_SOCK`, `TZ`, `COLORTERM`, `TERM_PROGRAM`, `XDG_RUNTIME_DIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
 *   `XDG_CACHE_HOME` — who the user is, their login shell and ssh agent socket, time zone, terminal colours and the
 *   per-user data folders: none of them is read by Python, OpenSSL or the dynamic loader to find code or trust roots
 *   (user site-packages are off with `-s`, so XDG/HOME paths cannot add code either);
 * - the 9 `HERMES_*` the app sets on a gated spawn (`HERMES_APP_ENV`): home, dashboard token, desktop flag and ready
 *   file, web dist, parent-watchdog identity;
 * - `PYTHONIOENCODING`, `PYTHONUNBUFFERED` and `PYTHONUTF8` (`PYTHON_INHERIT_ALLOW`): text encoding and output buffering
 *   only (backend-env itself sets PYTHONUTF8);
 * - `PYTHONPATH`, cut to the runtime's own entries (the runtime root and what lies inside it — its venv site-packages);
 * - `ICLONE_CONSENT_*` and `ICLONE_PAY_*`, which the app composes itself (the seal keeps pay for the primary only, and
 *   the probe carries no `ICLONE_*` at all);
 * - on Windows only, the variables a process cannot start without (`WINDOWS_ENV_ALLOW`: SystemRoot, TEMP, …);
 * - `HERMES_LANGUAGE` on a gated spawn, never inherited: always the app's own `RUNTIME_LANGUAGE` (ruling 69).
 * Nothing else: no `PYVENV*` / `__PYVENV_LAUNCHER__`, no `DYLD_*` / `LD_*`, no `OPENSSL_*`, no `GCONV_PATH`, no
 * `NODE_OPTIONS`, no foreign `HERMES_*` (`HERMES_BUNDLED_PLUGINS` replaces the plugin folder), no `SSL_CERT_*`, no
 * `PYTHON*` beyond the three, no provider keys from the GUI environment (Hermes reads its keys from HERMES_HOME/.env). The gate's own env (lock,
 * confinement, bytecode prefix, an unmanaged dev runtime's plugin folder) is applied LAST.
 * The interpreter also runs with `-s` (no user site-packages) and `-P` (neither the cwd nor a script's directory is put
 * on sys.path, so a workspace holding a `hermes_cli/` cannot shadow the runtime) — flags, so the agent's own shell
 * commands (a user's `python script.py`) keep their normal behaviour.
 *
 * `sealHermesSpawnEnv` composes a spawn's env in one place, so nothing inherited, nothing from backend.env and nothing
 * from consentEnv() can override the gate: the gate's env is applied LAST. A pool backend gets no payment env.
 */
import path from 'node:path'

import { allowDestinationEnv, userProxyEnv } from './iclone-telemetry-seal'

/** `PYTHON*` variables a gated Python may inherit: text encoding and output buffering only. */
export const PYTHON_INHERIT_ALLOW: ReadonlySet<string> = new Set(['PYTHONIOENCODING', 'PYTHONUNBUFFERED', 'PYTHONUTF8'])

/** Before `-m` / `-c`: no user site-packages, no cwd or script directory on sys.path. The runtime needs Python >= 3.11. */
export const PYTHON_ISOLATION_FLAGS: readonly string[] = ['-s', '-P']

/**
 * The `HERMES_*` variables the app itself puts on a gated spawn (start-hermes, managed-ssh-update: home, dashboard token,
 * the desktop flag and ready file, the web dist, the parent-watchdog identity). Any other `HERMES_*` reaching the seal
 * or the probe is inherited and dropped.
 */
export const HERMES_APP_ENV: ReadonlySet<string> = new Set([
  'HERMES_DASHBOARD_SESSION_TOKEN',
  'HERMES_DESKTOP',
  'HERMES_DESKTOP_READY_FILE',
  'HERMES_HOME',
  'HERMES_PARENT_NONCE',
  'HERMES_PARENT_PID',
  'HERMES_PARENT_START_MARKER',
  'HERMES_SPAWN',
  'HERMES_WEB_DIST'
])

/** The plain variables a gated Python keeps (see the module comment for each). */
export const INTERPRETER_ENV_ALLOW: ReadonlySet<string> = new Set([
  'HOME',
  'LANG',
  'PATH',
  'TERM',
  'TERMINAL_CWD',
  'TMPDIR'
])

/** Identity/session, cannot load code: who the user is, their shell and ssh agent, time zone, terminal, XDG folders. */
export const SESSION_ENV_ALLOW: ReadonlySet<string> = new Set([
  'COLORTERM',
  'LOGNAME',
  'SHELL',
  'SSH_AUTH_SOCK',
  'TERM_PROGRAM',
  'TZ',
  'USER',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR'
])

/** Windows only: what any process needs to start there (Windows is outside v0.0.3, but a spawn must not break). */
export const WINDOWS_ENV_ALLOW: ReadonlySet<string> = new Set([
  'APPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERNAME',
  'USERPROFILE',
  'WINDIR'
])

/** Whether a gated Python may keep `key` (PYTHONPATH is handled apart: it is cut, not kept). */
export function interpreterEnvAllows(key: string, platform: NodeJS.Platform = process.platform): boolean {
  const upper = key.toUpperCase()

  return (
    INTERPRETER_ENV_ALLOW.has(upper) ||
    SESSION_ENV_ALLOW.has(upper) ||
    upper.startsWith('LC_') ||
    HERMES_APP_ENV.has(upper) ||
    PYTHON_INHERIT_ALLOW.has(upper) ||
    upper.startsWith('ICLONE_CONSENT_') ||
    upper.startsWith('ICLONE_PAY_') ||
    (platform === 'win32' && WINDOWS_ENV_ALLOW.has(upper))
  )
}

function within(entry: string, root: string, pathModule: typeof path): boolean {
  const relative = pathModule.relative(pathModule.resolve(root), pathModule.resolve(entry))

  return relative === '' || (!relative.startsWith('..') && !pathModule.isAbsolute(relative))
}

/** The runtime's own PYTHONPATH entries: the root and anything inside it, in order; undefined when none is left. */
export function runtimePythonPath(
  value: string | undefined,
  runtimeRoot: string,
  pathModule: typeof path = path
): string | undefined {
  const kept = (value ?? '')
    .split(pathModule.delimiter)
    .filter(entry => entry && pathModule.isAbsolute(entry) && within(entry, runtimeRoot, pathModule))

  return kept.length ? [...new Set(kept)].join(pathModule.delimiter) : undefined
}

/**
 * Ruling 69 (owner): the app ships in English only. Hermes picks its words from `HERMES_LANGUAGE` before
 * `display.language` in config.yaml (agent/i18n.py), and earlier builds saved `pt-PT` there, so every runtime the app
 * starts is told English explicitly by `sealHermesSpawnEnv`, after the allowlist, so no inherited env value can win.
 * Limits (review s4 r2, lens 8): a HERMES_LANGUAGE the user writes into a profile's .env is loaded with override and
 * wins (not closed: the user's own .env); a ROUTED profile reads `display.language` from its own config. Main sets a
 * non-English `display.language` to 'en' in every LOCAL profile's config, at launch, before every spawn and when a
 * profile appears (iclone-display-language.ts, review r2 R2-M5), which closes the second for local profiles; a remote
 * gateway's config is not the app's to rewrite.
 */
export const RUNTIME_LANGUAGE = 'en'

/** `env` cut to the allowlist (`interpreterEnvAllows`), with PYTHONPATH cut to the runtime's own entries. */
export function isolatePythonEnv(
  env: Record<string, string | undefined>,
  runtimeRoot: string,
  pathModule: typeof path = path,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const out: Record<string, string> = {}
  let pythonPath: string | undefined

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue
    }

    if (key.toUpperCase() === 'PYTHONPATH') {
      pythonPath = value
    } else if (interpreterEnvAllows(key, platform)) {
      out[key] = value
    }
  }

  const kept = runtimePythonPath(pythonPath, runtimeRoot, pathModule)

  if (kept) {
    out.PYTHONPATH = kept
  }

  return out
}

export type SealRole = 'pool' | 'primary'

/**
 * A gated spawn's final env. Drops every `ICLONE_*` that is not the gate's own except the consent mirror (and, for the
 * primary only, its payment socket), isolates Python, fixes `HERMES_LANGUAGE` to English, then applies the gate's env
 * LAST — nothing inherited, nothing in backend.env and nothing in consentEnv() can set a lock key or the bytecode prefix.
 */
export function sealHermesSpawnEnv(
  composed: Record<string, string | undefined>,
  options: { gateEnv: Readonly<Record<string, string>>; role: SealRole; runtimeRoot: string }
): Record<string, string> {
  const kept: Record<string, string | undefined> = {}

  for (const [key, value] of Object.entries(composed)) {
    const upper = key.toUpperCase()

    if (
      !upper.startsWith('ICLONE_') ||
      upper.startsWith('ICLONE_CONSENT_') ||
      (options.role === 'primary' && upper.startsWith('ICLONE_PAY_'))
    ) {
      kept[key] = value
    }
  }

  const sealed = {
    ...isolatePythonEnv(kept, options.runtimeRoot),
    HERMES_LANGUAGE: RUNTIME_LANGUAGE,
    ...options.gateEnv
  }

  // Ruling 57.4, lead correction r6: the user's own proxy (main's env at app start, exactly as captured) reaches
  // Hermes for its model provider — a listed non-telemetry reason; a proxy from anywhere else never does.
  const proxy = userProxyEnv()

  // r7: passed EXPLICITLY on one channel too (hermes_cli/iclone_sinks.py USER_PROXY_CHANNEL); Hermes never infers the
  // user's proxy from its current env, which a child can forge.
  return Object.keys(proxy).length
    ? allowDestinationEnv('hermes-user-proxy', { ...sealed, ...proxy, ICLONE_USER_NETWORK: JSON.stringify(proxy) })
    : sealed
}
