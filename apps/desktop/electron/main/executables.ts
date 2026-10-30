// Locating executables on this machine: Python, git, gh, Git Bash, venvs, the serve-capable Hermes CLI.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

import { dashboardFallbackArgs, sourceDeclaresServe } from '../backend-command'
import { buildDesktopBackendEnv } from '../backend-env'
import { canImportHermesCli, execProbeSync, PROBE_TIMEOUT_MS } from '../backend-probes'
import { isWindowsBinaryPathInWsl } from '../bootstrap-platform'
import { findGitBash as _findGitBash } from '../find-git-bash'
import { NO_BYTECODE_PREFIX, pycacheEnv } from '../iclone-pycache'
import { isolatePythonEnv, PYTHON_ISOLATION_FLAGS } from '../iclone-spawn-env'
import { runGit, type RunGitOptions, type RunGitResult } from '../lib/git'
import { codePathEnv } from '../packaged-env'
import { hiddenWindowsChildOptions } from '../windows-child-options'
import { buildPathExtCandidates, getVenvSitePackagesEntries, resolveVenvHermesCommand } from '../windows-hermes-path'

import { directoryExists, fileExists, HERMES_HOME, IS_WINDOWS, IS_WSL } from './env'
import { rememberLog } from './log'

export function findOnPath(command: string) {
  if (!command) {
    return null
  }

  if (path.isAbsolute(command) || command.includes(path.sep) || (IS_WINDOWS && command.includes('/'))) {
    if (!fileExists(command)) {
      return null
    }

    if (isWindowsBinaryPathInWsl(command, { isWsl: IS_WSL })) {
      return null
    }

    return command
  }

  const pathEntries = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)

  // On Windows, try PATHEXT extensions BEFORE the bare (empty-extension) name.
  // A real command must resolve via its .exe/.cmd (Windows command-resolution
  // semantics consult PATHEXT); an extensionless file — e.g. a Git-Bash
  // shell-script shim named `hermes` — must not shadow `hermes.cmd`/`hermes.exe`.
  // The empty entry is kept LAST so callers that already include the extension
  // (py.exe, pwsh.exe, powershell.exe) still resolve.
  const extensions = buildPathExtCandidates(process.env.PATHEXT, IS_WINDOWS)

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, `${command}${extension}`)

      if (fileExists(candidate)) {
        return candidate
      }
    }
  }

  return null
}

export function isCommandScript(command: string) {
  return IS_WINDOWS && /\.(cmd|bat)$/i.test(command || '')
}

export function unwrapWindowsVenvHermesCommand(command: string, backendArgs: string[]) {
  return resolveVenvHermesCommand(command, backendArgs, {
    isWindows: IS_WINDOWS,
    isCommandScript,
    fileExists,
    directoryExists,
    canImportHermesCli,
    getVenvPython,
    getVenvSitePackagesEntries,
    buildDesktopBackendEnv,
    hermesHome: HERMES_HOME,
    resolvePath: (...segments) => path.resolve(...segments),
    dirname: p => path.dirname(p),
    basename: p => path.basename(p),
    rememberLog
  })
}

// Does the resolved runtime understand the `serve` subcommand? The desktop
// spawns `hermes serve`; runtimes older than serve only have `dashboard`. We
// detect support so getBackendArgsForRuntime() can route old runtimes through
// the legacy `dashboard --no-open` form instead of crashing on an unknown
// subcommand (would brick every user mid-upgrade — #54568 follow-up).
//
// Fast path: read the runtime's own dashboard.py (instant, covers managed
// installs, dev checkouts, and the Windows venv). Fallback: probe the CLI once
// (covers a bare `hermes` resolved from PATH with no known source root). Result
// is cached per resolved runtime so we probe at most once per backend.
const _serveSupportCache = new Map()

interface ServeProbeBackend {
  command?: string | null
  root?: string | null
  args?: readonly string[]
  env?: NodeJS.ProcessEnv
  shell?: boolean
  label?: string
}

function backendSupportsServe(backend: ServeProbeBackend | null | undefined) {
  if (!backend || !backend.command) {
    return true
  }

  const key = `${backend.command}::${backend.root || ''}`

  if (_serveSupportCache.has(key)) {
    return _serveSupportCache.get(key)
  }

  let supported = null

  if (backend.root) {
    try {
      const src = fs.readFileSync(path.join(backend.root, 'hermes_cli', 'subcommands', 'dashboard.py'), 'utf8')
      supported = sourceDeclaresServe(src)
    } catch {
      supported = null // source unreadable — fall through to the probe
    }
  }

  if (supported === null) {
    try {
      const prefix = backend.args && backend.args[0] === '-m' ? backend.args.slice(0, 2) : []
      // V3-S r5b (K-RT11): a Python backend is probed with the gated spawn's sealed interpreter — `-s -P`, the env
      // allowlist, no bytecode read or written — so `serve --help` never writes a pyc into the runtime tree.
      const isolation = prefix.length ? PYTHON_ISOLATION_FLAGS : []
      // Same cold-Windows Python-startup class as the runtime probes
      // (#61764/#72632/#72707): `serve --help` imports at least as much as
      // `hermes --version` (~10.5s measured cold), and a false negative here
      // is cached for the process lifetime, silently routing a modern
      // runtime through the legacy `dashboard` form. Share the probe budget
      // and its timeout-only retry instead of a thinner local bound.
      execProbeSync(backend.command, [...isolation, ...prefix, 'serve', '--help'], {
        cwd: backend.root || undefined,
        env: {
          ...isolatePythonEnv({ ...process.env, HERMES_HOME, ...(backend.env || {}) }, backend.root || path.sep),
          ...pycacheEnv(NO_BYTECODE_PREFIX)
        },
        timeout: PROBE_TIMEOUT_MS,
        stdio: 'ignore',
        // `.cmd`/`.bat` shim backends carry shell: true in their descriptor
        // (see resolveHermesBackend step 4); execFileSync of a .cmd without
        // shell throws EINVAL on modern Node, which the catch below would
        // mis-cache as "serve unsupported" for the process lifetime.
        shell: Boolean(backend.shell),
        windowsHide: true
      })
      supported = true
    } catch {
      supported = false
    }
  }

  _serveSupportCache.set(key, supported)
  rememberLog(
    `[backend] \`serve\` ${supported ? 'supported' : 'unsupported → routing via legacy `dashboard`'} for ${backend.label || key}`
  )

  return supported
}

// Given a resolved backend whose args target `serve`, return the args the
// runtime actually understands: unchanged when `serve` is supported, or
// rewritten to `dashboard --no-open` for older runtimes.
export function getBackendArgsForRuntime(backend: ServeProbeBackend & { args: string[] }) {
  return backendSupportsServe(backend) ? backend.args : dashboardFallbackArgs(backend.args)
}

function normalizeExecutablePathForCompare(commandPath: string) {
  if (!commandPath) {
    return null
  }

  let resolved = path.resolve(String(commandPath))

  try {
    resolved = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved)
  } catch {
    // Fallback to path.resolve() above.
  }

  return IS_WINDOWS ? resolved.toLowerCase() : resolved
}

export function looksLikeDesktopAppBinary(commandPath: string) {
  if (!IS_WINDOWS || !commandPath) {
    return false
  }

  const normalizedCandidate = normalizeExecutablePathForCompare(commandPath)
  const normalizedCurrentExec = normalizeExecutablePathForCompare(process.execPath)

  if (normalizedCandidate && normalizedCurrentExec && normalizedCandidate === normalizedCurrentExec) {
    return true
  }

  let resolved = path.resolve(String(commandPath))

  try {
    resolved = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved)
  } catch {
    // Keep resolved path fallback.
  }

  const resourcesDir = path.join(path.dirname(resolved), 'resources')

  return (
    fileExists(path.join(resourcesDir, 'app.asar')) || directoryExists(path.join(resourcesDir, 'app.asar.unpacked'))
  )
}

export function findPythonForRoot(root: string) {
  const override = codePathEnv('HERMES_DESKTOP_PYTHON') // iclone-seam: p7-env

  if (override && fileExists(override)) {
    return override
  }

  const relativePaths = IS_WINDOWS
    ? [path.join('.venv', 'Scripts', 'python.exe'), path.join('venv', 'Scripts', 'python.exe')]
    : [path.join('.venv', 'bin', 'python'), path.join('venv', 'bin', 'python')]

  for (const relativePath of relativePaths) {
    const candidate = path.join(root, relativePath)

    if (fileExists(candidate)) {
      return candidate
    }
  }

  return findSystemPython()
}

export function findSystemPython() {
  if (!IS_WINDOWS) {
    // POSIX systems: PATH lookup is safe.
    for (const command of ['python3', 'python']) {
      const candidate = findOnPath(command)

      if (candidate) {
        return candidate
      }
    }

    return null
  }

  // Windows: PATH-based detection has TWO landmines we have to dodge.
  //
  //  (1) The Microsoft Store "Python stub" lives at
  //      %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe and is on PATH
  //      by default on modern Windows. It's a redirector that opens the
  //      Store window if no Store Python is installed. Running it for
  //      `-m venv` would either succeed (real Store install — fine) or
  //      pop the Store dialog (bad UX during boot).
  //  (2) `py.exe` (Python launcher) is missing from per-user installs
  //      that didn't check the launcher option, so PATH-only checks
  //      miss real Python 3.13 installs (user-reported case).
  //
  // We also restrict ourselves to Python 3.11–3.13. 3.14 is the latest
  // CPython but several Hermes deps (notably pywinpty's Rust-built
  // windows_x86_64_msvc crate) don't yet publish 3.14 wheels, and
  // `pip install -e .` falls back to source-build, which fails without
  // a Rust toolchain. install.ps1 sidesteps this by pinning to 3.11
  // via uv; until we add the same uv-managed Python pathway here, the
  // simplest fix is to refuse 3.14 detection and let the NSIS prereq
  // page offer to install 3.11 alongside.
  //
  // Strategy: probe in three passes, in order from most-precise to
  // least-precise, and ONLY use PATH lookup as a last resort after
  // confirming the candidate isn't the WindowsApps redirector.
  //
  //  Pass 1: PEP 514 registry — every standards-compliant Python
  //          installer registers itself at SOFTWARE\Python\PythonCore.
  //          The MS Store stub does NOT register here, so a hit means
  //          a real Python install. Versions are explicit so we
  //          inherently filter 3.14 out.
  //  Pass 2: Filesystem probe of standard install locations
  //          (Program Files, LocalAppData\Programs\Python). Same
  //          version filtering by directory name.
  //  Pass 3: PATH lookup of `py.exe` (the launcher itself never
  //          triggers the Store) — but call it with a version flag so
  //          we resolve to a SPECIFIC supported version, not whatever
  //          py.exe's default is (which on a 3.14-only box would be
  //          3.14).

  const SUPPORTED_VERSIONS = ['3.11', '3.12', '3.13']
  const SUPPORTED_VERSIONS_NO_DOT = ['311', '312', '313']

  // Pass 1: registry. Use `reg query` since main process doesn't have
  // a reliable in-process registry API across all electron versions.
  for (const hive of ['HKLM', 'HKCU']) {
    for (const version of SUPPORTED_VERSIONS) {
      try {
        const out = execFileSync(
          'reg',
          ['query', `${hive}\\SOFTWARE\\Python\\PythonCore\\${version}\\InstallPath`, '/ve', '/reg:64'],
          // Registry reads are near-instant; the bound only exists so a
          // pathologically wedged reg.exe can't hang the synchronous boot
          // resolver forever (this ran unbounded before).
          hiddenWindowsChildOptions({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 })
        )

        // Output format: "    (Default)    REG_SZ    C:\Path\To\Python\"
        const match = out.match(/REG_SZ\s+(.+?)\s*$/m)

        if (match) {
          const installPath = match[1].trim()
          const pythonExe = path.join(installPath, 'python.exe')

          if (fileExists(pythonExe)) {
            return pythonExe
          }
        }
      } catch {
        // Key not present — try next.
      }
    }
  }

  // Pass 2: filesystem probe of standard locations.
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
  const localAppData = process.env.LOCALAPPDATA || ''

  for (const versionDir of SUPPORTED_VERSIONS_NO_DOT) {
    const systemWide = path.join(programFiles, `Python${versionDir}`, 'python.exe')

    if (fileExists(systemWide)) {
      return systemWide
    }

    if (localAppData) {
      const perUser = path.join(localAppData, 'Programs', 'Python', `Python${versionDir}`, 'python.exe')

      if (fileExists(perUser)) {
        return perUser
      }
    }
  }

  // Pass 3: py.exe with explicit version flag. The launcher itself is
  // safe to invoke (no Store popup) and `py -3.13 -c "import sys;
  // print(sys.executable)"` resolves to the actual python.exe path of
  // the requested version. We try in version-priority order so the
  // first hit wins.
  const pyExe = findOnPath('py.exe')

  if (pyExe) {
    for (const version of SUPPORTED_VERSIONS) {
      try {
        const out = execFileSync(
          pyExe,
          [`-${version}`, '-c', 'import sys; print(sys.executable)'],
          hiddenWindowsChildOptions({
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            // Bare interpreter startup — much lighter than the hermes-import
            // probes, but still python.exe under cold cache / AV scan, so
            // share the probe budget rather than running unbounded (this
            // synchronous exec previously had no timeout at all).
            timeout: PROBE_TIMEOUT_MS
          })
        )

        const candidate = out.trim()

        if (candidate && fileExists(candidate)) {
          return candidate
        }
      } catch {
        // py couldn't find that version — try next.
      }
    }
  }

  // We deliberately do NOT fall back to plain `python.exe` on PATH.
  // Without a way to verify the version safely (running `python -V`
  // risks the Microsoft Store popup), accepting whatever's there
  // could land us on 3.14 and trigger the Rust-build-from-source
  // failure. Better to return null and let the NSIS prereq page
  // offer to install a known-good 3.11 via winget.
  return null
}

// findGitBash — locate bash.exe on Windows. Resolves HERMES_GIT_BASH_PATH
// first (mirrors tools/environments/local.py:_find_bash), then PortableGit,
// standard install locations, and finally PATH.
export function findGitBash() {
  return _findGitBash({
    isWindows: IS_WINDOWS,
    env: process.env,
    fileExists,
    findOnPath
  })
}

export function getVenvPython(venvRoot: string) {
  return path.join(venvRoot, IS_WINDOWS ? path.join('Scripts', 'python.exe') : path.join('bin', 'python'))
}

// Map a selected interpreter back to the venv that OWNS it (the directory
// above bin/ or Scripts/), but only when that venv lives inside `root`.
// Returns null for system pythons — they own no site-packages we should mount.
//
// This exists because findPythonForRoot() probes `.venv` before `venv`, and a
// checkout can legitimately have BOTH (dev tooling venv + the CLI install
// venv, possibly on different Python versions). The interpreter and the
// site-packages placed on PYTHONPATH must come from the SAME venv: pairing a
// .venv 3.12 python with venv/lib/python3.11/site-packages makes the backend
// die on its first native import (pydantic_core) before the gateway binds —
// the renderer then reports "Gateway offline" on every profile.
export function venvRootForPython(python: string, root: string) {
  const parent = path.dirname(python)
  const binName = path.basename(parent).toLowerCase()

  if (binName !== 'bin' && binName !== 'scripts') {
    return null
  }

  const candidate = path.dirname(parent)
  const relative = path.relative(root, candidate)

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null
  }

  return candidate
}

// resolveGitBinary — locate git.exe on Windows. A fresh installer-driven
// install only has PortableGit under %LOCALAPPDATA%\hermes\git (never on
// PATH), so a bare spawn('git') ENOENTs and self-update checks fail with
// "Couldn't check for updates". Mirror findGitBash: PortableGit first, then
// standard Git-for-Windows locations, then PATH. Cached after first probe.
let _gitBinaryCache: string | null = null

export function resolveGitBinary() {
  if (_gitBinaryCache) {
    return _gitBinaryCache
  }

  if (!IS_WINDOWS) {
    _gitBinaryCache = findOnPath('git') || 'git'

    return _gitBinaryCache
  }

  const localAppData = process.env.LOCALAPPDATA || ''
  const candidates = []

  if (localAppData) {
    candidates.push(path.join(localAppData, 'hermes', 'git', 'cmd', 'git.exe'))
    candidates.push(path.join(localAppData, 'hermes', 'git', 'bin', 'git.exe'))
  }

  candidates.push(path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'))
  candidates.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'))

  if (localAppData) {
    candidates.push(path.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'))
  }

  _gitBinaryCache = candidates.find(fileExists) || findOnPath('git') || 'git'

  return _gitBinaryCache
}

/** Runs git through the resolved binary (the bundled MinGit on Windows); electron/lib/git owns the process contract. */
export function runResolvedGit(
  args: readonly string[],
  options: Omit<RunGitOptions, 'bin'> = {}
): Promise<RunGitResult> {
  return runGit(args, { ...options, bin: resolveGitBinary() })
}

// resolveGhBinary — locate the GitHub CLI. GUI-launched apps get a minimal PATH
// that omits Homebrew (/opt/homebrew/bin, /usr/local/bin) where `gh` usually
// lives, so a bare spawn('gh') ENOENTs even though `gh` works in the user's
// terminal. Check the common install locations first, then PATH. Cached.
let _ghBinaryCache: string | null = null

export function resolveGhBinary() {
  if (_ghBinaryCache) {
    return _ghBinaryCache
  }

  const candidates = []

  if (IS_WINDOWS) {
    candidates.push(path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'))

    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'gh.exe'))
    }
  } else {
    const home = app.getPath('home')
    candidates.push('/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', path.join(home, '.local', 'bin', 'gh'))
  }

  _ghBinaryCache = candidates.find(fileExists) || findOnPath('gh') || 'gh'

  return _ghBinaryCache
}
