// Machine context for a run: machine CLASS only. Hostname, user name and home path never leave this module.
import { execFileSync } from 'node:child_process'
import os from 'node:os'

const LOAD_CLEAN_MAX = 4.0

function quiet(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'unknown'
  }
}

export function load() {
  const [one, five, fifteen] = os.loadavg()
  return { one: +one.toFixed(2), five: +five.toFixed(2), fifteen: +fifteen.toFixed(2) }
}

export function loadIsClean(sample) {
  // Strictly under the threshold, as the cool-down waits for it: 4.0 itself is not clean.
  return sample.one < LOAD_CLEAN_MAX
}

export { LOAD_CLEAN_MAX }

export function captureEnv(app, python) {
  const gb = Math.round(os.totalmem() / 2 ** 30)
  const macos = process.platform === 'darwin' ? quiet('sw_vers', ['-productVersion']) : os.release()
  return {
    machine_class: `${os.arch()} / ${os.cpus().length} cores / ${gb} GB`,
    cpu_model: os.cpus()[0]?.model ?? 'unknown',
    os: `${process.platform} ${macos}`,
    node: process.version,
    python: python ? quiet(python, ['-c', 'import sys; print(sys.version.split()[0])']) : 'none',
    git_sha: quiet('git', ['rev-parse', 'HEAD'], app),
    git_dirty: quiet('git', ['status', '--porcelain', '--untracked-files=no'], app) !== '',
    load: { before: load(), after: null, clean_max_one_minute: LOAD_CLEAN_MAX }
  }
}

/** The identity strings that must never appear in a written result. */
export function identityStrings() {
  const out = [os.homedir()]
  const host = os.hostname()
  const user = os.userInfo().username
  for (const s of [host, host.replace(/\.local$/, ''), user]) {
    if (s && s.length >= 4) {
      out.push(s)
    }
  }
  return [...new Set(out)].filter(Boolean)
}

/** Deep-copy `value`, replacing the home directory with `~` in every string. */
export function redact(value, home = os.homedir()) {
  if (typeof value === 'string') {
    return value.split(home).join('~')
  }
  if (Array.isArray(value)) {
    return value.map(v => redact(v, home))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, home)]))
  }
  return value
}
