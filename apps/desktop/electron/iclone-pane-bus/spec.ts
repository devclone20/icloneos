/**
 * `it spawn --spec <file>`: the spec is untrusted input (an agent writes it).
 * Every field is checked here, in main, before a single pane exists; the
 * renderer only lays out what this returns.
 */
import fs from 'node:fs'
import path from 'node:path'

import { isPaneName } from './envelope'

export const SPAWN_MAX_PANES = 16
const SPEC_MAX_BYTES = 64 * 1024
const CMD_MAX = 4 * 1024
const ENV_MAX_KEYS = 32
const ENV_VALUE_MAX = 1024
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

// A spec's `cmd` is what V3-F reviews; an env key that a shell, loader or
// runtime turns into code would run around that review. The set of such keys
// is open-ended (PROMPT_COMMAND, PS4, BASH_ENV, NODE_OPTIONS, LESSOPEN,
// GIT_SSH_COMMAND, JAVA_TOOL_OPTIONS…), so env is an ALLOW-list: a few
// well-known inert names, LC_*, and the spec's own PANE_* namespace.
const ENV_ALLOWED = new Set([
  'CI',
  'DEBUG',
  'FORCE_COLOR',
  'HOST',
  'LANG',
  'LOG_LEVEL',
  'NODE_ENV',
  'NO_COLOR',
  'PORT',
  'RUST_BACKTRACE',
  'RUST_LOG',
  'TZ'
])

const ENV_ALLOWED_PREFIX_RE = /^(PANE_[A-Z0-9_]+|LC_[A-Z]+)$/

// Named so the refusal can say why; every one of these is refused by the allow-list anyway.
const ENV_RUNS_CODE_RE =
  /^(ZDOTDIR|BASH_ENV|ENV|PROMPT_COMMAND|PS[0-4]|PROMPT|RPROMPT|SHELL|PATH|HOME|IFS|CDPATH|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|NODE_PATH|CLASSPATH|EDITOR|VISUAL|PAGER|MANPAGER|LESSOPEN|LESSCLOSE|BROWSER|GIT_[A-Z_]+|SSH_[A-Z_]+|DYLD_[A-Z_]*|LD_[A-Z_]*|[A-Z0-9_]*_OPTIONS|[A-Z0-9_]*_OPTS|npm_config_[A-Za-z_]+)$/

const ROLE_MAX = 64

const SPEC_KEYS = new Set(['panes', 'layout'])
const PANE_KEYS = new Set(['name', 'role', 'cwd', 'cmd', 'env', 'group'])

interface SpawnPane {
  name: string
  role?: string
  cwd: string
  cmd?: string
  env?: Record<string, string>
  group?: string
}

interface SpawnPlan {
  layout: 'tabs' | 'tiled'
  panes: SpawnPane[]
}

type SpawnPlanResult = { ok: false; errors: string[] } | { ok: true; plan: SpawnPlan }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function checkPane(raw: unknown, index: number, baseDir: string, errors: string[]): SpawnPane | null {
  const at = `panes[${index}]`

  if (!isRecord(raw)) {
    errors.push(`${at}: must be an object`)

    return null
  }

  for (const key of Object.keys(raw)) {
    if (!PANE_KEYS.has(key)) {
      errors.push(`${at}: unknown field "${key}"`)
    }
  }

  const name = typeof raw.name === 'string' ? raw.name : ''

  if (!isPaneName(name)) {
    errors.push(`${at}: name must match ^[a-z0-9][a-z0-9_-]{0,31}$`)
  }

  const pane: SpawnPane = { name, cwd: baseDir }

  if (raw.role !== undefined) {
    if (typeof raw.role !== 'string' || raw.role.length > ROLE_MAX || /[\r\n\0]/.test(raw.role)) {
      errors.push(`${at}: role must be one line of at most ${ROLE_MAX} characters`)
    } else {
      pane.role = raw.role
    }
  }

  if (raw.group !== undefined) {
    if (typeof raw.group !== 'string' || !isPaneName(raw.group)) {
      errors.push(`${at}: group must match ^[a-z0-9][a-z0-9_-]{0,31}$`)
    } else {
      pane.group = raw.group
    }
  }

  if (raw.cwd !== undefined) {
    const cwd = typeof raw.cwd === 'string' ? raw.cwd : ''
    const climbs = cwd.split(/[\\/]+/).includes('..')
    const resolved = path.resolve(baseDir, cwd)

    if (!cwd || climbs || /\0/.test(cwd)) {
      errors.push(`${at}: cwd must be a directory path without ".."`)
    } else if (!isDirectory(resolved)) {
      errors.push(`${at}: cwd ${resolved} is not a directory`)
    } else {
      pane.cwd = resolved
    }
  }

  if (raw.cmd !== undefined) {
    if (typeof raw.cmd !== 'string' || raw.cmd.length > CMD_MAX || /\0/.test(raw.cmd)) {
      errors.push(`${at}: cmd must be text of at most ${CMD_MAX} characters`)
    } else if (raw.cmd.trim()) {
      pane.cmd = raw.cmd
    }
  }

  if (raw.env !== undefined) {
    const env = checkEnv(raw.env, at, errors)

    if (env) {
      pane.env = env
    }
  }

  return pane
}

export function checkEnv(raw: unknown, at: string, errors: string[]): null | Record<string, string> {
  if (!isRecord(raw) || Object.keys(raw).length > ENV_MAX_KEYS) {
    errors.push(`${at}: env must be an object of at most ${ENV_MAX_KEYS} strings`)

    return null
  }

  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(raw)) {
    if (!ENV_KEY_RE.test(key) || key.toUpperCase().startsWith('ICLONE_')) {
      errors.push(`${at}: env key "${key}" is not allowed`)
    } else if (ENV_RUNS_CODE_RE.test(key)) {
      errors.push(`${at}: env key "${key}" can run code; put it in cmd`)
    } else if (!ENV_ALLOWED.has(key) && !ENV_ALLOWED_PREFIX_RE.test(key)) {
      errors.push(
        `${at}: env key "${key}" is not allowed; use PANE_${key.toUpperCase()} (the program then reads $PANE_${key.toUpperCase()}, not $${key}) or one of ${[...ENV_ALLOWED].join(', ')}, LC_*`
      )
    } else if (typeof value !== 'string' || value.length > ENV_VALUE_MAX || /\0/.test(value)) {
      errors.push(`${at}: env ${key} must be text of at most ${ENV_VALUE_MAX} characters`)
    } else {
      env[key] = value
    }
  }

  return env
}

/** Validate a spawn spec given as JSON text; relative cwds resolve against `baseDir`. */
export function planSpawn(text: string, baseDir: string): SpawnPlanResult {
  if (Buffer.byteLength(text, 'utf8') > SPEC_MAX_BYTES) {
    return { ok: false, errors: [`the spec is over ${SPEC_MAX_BYTES} bytes`] }
  }

  if (!path.isAbsolute(baseDir) || !isDirectory(baseDir)) {
    return { ok: false, errors: ['the spec directory is not an absolute directory'] }
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, errors: [`the spec is not JSON: ${error instanceof Error ? error.message : 'parse error'}`] }
  }

  if (!isRecord(parsed)) {
    return { ok: false, errors: ['the spec must be an object with "panes"'] }
  }

  const errors: string[] = []

  for (const key of Object.keys(parsed)) {
    if (!SPEC_KEYS.has(key)) {
      errors.push(`unknown field "${key}"`)
    }
  }

  const rawLayout = parsed.layout ?? 'tiled'
  const layout: SpawnPlan['layout'] = rawLayout === 'tabs' ? 'tabs' : 'tiled'

  if (rawLayout !== 'tiled' && rawLayout !== 'tabs') {
    errors.push('layout must be "tiled" or "tabs"')
  }

  if (!Array.isArray(parsed.panes) || parsed.panes.length === 0) {
    return { ok: false, errors: [...errors, '"panes" must be a non-empty array'] }
  }

  if (parsed.panes.length > SPAWN_MAX_PANES) {
    return { ok: false, errors: [...errors, `${parsed.panes.length} panes; a spec holds at most ${SPAWN_MAX_PANES}`] }
  }

  const panes = parsed.panes
    .map((raw: unknown, index) => checkPane(raw, index, baseDir, errors))
    .filter((pane): pane is SpawnPane => pane !== null)

  const seen = new Set<string>()

  for (const pane of panes) {
    if (seen.has(pane.name)) {
      errors.push(`name "${pane.name}" is used twice`)
    }

    seen.add(pane.name)
  }

  return errors.length ? { ok: false, errors } : { ok: true, plan: { layout, panes } }
}

/** Read a spec file the CLI named; the file must be a regular file under the cap. */
export function readSpawnSpec(file: string): SpawnPlanResult {
  if (!path.isAbsolute(file)) {
    return { ok: false, errors: ['the spec path must be absolute'] }
  }

  try {
    const stat = fs.statSync(file)

    if (!stat.isFile() || stat.size > SPEC_MAX_BYTES) {
      return { ok: false, errors: [`${file} is not a spec file under ${SPEC_MAX_BYTES} bytes`] }
    }

    return planSpawn(fs.readFileSync(file, 'utf8'), path.dirname(file))
  } catch {
    return { ok: false, errors: [`cannot read ${file}`] }
  }
}
