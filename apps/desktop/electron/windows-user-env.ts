// windows-user-env.ts
//
// Read a User-scoped environment variable straight from the Windows registry
// (HKCU\Environment).
//
// A GUI app launched from Explorer inherits the environment block captured at
// login, so a variable set via `setx` AFTER login is invisible in process.env
// even though a fresh shell — and the Hermes CLI — sees it immediately. The
// desktop's HERMES_HOME resolution relies on process.env, so that stale-snapshot
// gap silently sends the backend to the default %LOCALAPPDATA%\hermes. Reading
// the live registry value closes the gap. See #45471.

import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'

/** The text-mode `execFileSync` call this module makes (tests inject a fake). */
type ExecFileText = (file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string

// Parse the output of `reg query HKCU\Environment /v <name>`, which looks like:
//
//   HKEY_CURRENT_USER\Environment
//       HERMES_HOME    REG_SZ    F:\Hermes\data
//
// Returns the raw value string (spaces inside the value preserved), or null when
// the requested value line isn't present.
function parseRegQueryValue(stdout: string, name: string) {
  if (!stdout || !name) {
    return null
  }

  const typePattern = /^(\S+)\s+(?:REG_SZ|REG_EXPAND_SZ|REG_MULTI_SZ|REG_DWORD|REG_QWORD|REG_BINARY|REG_NONE)\s+(.*)$/

  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trim()
    const match = line.match(typePattern)

    if (match && match[1].toLowerCase() === name.toLowerCase()) {
      return match[2]
    }
  }

  return null
}

// Expand %VAR% references against an env map. REG_EXPAND_SZ values store
// unexpanded references; plain REG_SZ paths have none, so this is a no-op for
// the common F:\... case. Unknown references are left verbatim.
function expandWindowsEnvRefs(value: string, env = process.env) {
  if (!value) {
    return value
  }

  return value.replace(/%([^%]+)%/g, (whole: string, name: string) => {
    const key = Object.keys(env).find(k => k.toUpperCase() === String(name).toUpperCase())

    return key != null && env[key] != null ? env[key] : whole
  })
}

// Read a User-scoped env var from HKCU\Environment. Windows-only: returns null
// off-Windows (without spawning), on any spawn error, when `reg` exits non-zero
// (the value doesn't exist), or when the value is empty.
function readWindowsUserEnvVar(
  name: string,
  {
    platform = process.platform,
    env = process.env,
    exec = execFileSync
  }: {
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
    exec?: ExecFileText
  } = {}
) {
  if (platform !== 'win32' || !name) {
    return null
  }

  let stdout

  try {
    stdout = exec('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    })
  } catch {
    // `reg` missing, or value absent (reg exits 1) — caller falls back.
    return null
  }

  const raw = parseRegQueryValue(stdout, name)

  if (raw == null) {
    return null
  }

  const expanded = expandWindowsEnvRefs(raw, env).trim()

  return expanded || null
}

export { expandWindowsEnvRefs, parseRegQueryValue, readWindowsUserEnvVar }
