/**
 * iCLONE OS — Claude Code as an optional engine (front R12).
 *
 * Installs the `claude-code` Hermes model-provider plugin (single source:
 * `iclone/hermes-plugins/claude-code`) into `<HERMES_HOME>/plugins/model-providers/`,
 * finds the USER's own `claude` binary (a packaged app has launchd's PATH),
 * and reports its login state with the zero-turn `claude auth status --json`.
 * The app never runs the login and never reads a credential: the CLI owns auth.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { app, ipcMain } from 'electron'

import { isRecord } from '../src/iclone-shared/guards'

import { replaceDirAtomicSync } from './lib/atomic-write'
import { readJsonFileSync, writeJsonAtomicSync } from './lib/fs-json'

/** Plugin-side JSON: compact, no trailing newline, owner-only (the format the plugin has always read). */
const PLUGIN_JSON = { mode: 0o600, space: 0, trailingNewline: false } as const

const ENGINE_PROVIDER = 'claude-code-cli'
const PLUGIN_NAME = 'claude-code'
const MARKER = '.iclone-plugin.json'
// Files the plugin or the app write next to the code; a sync never touches them.
const RUNTIME_FILES = new Set(['status.json', 'binary.json', 'fallback.json', 'work', '__pycache__', MARKER])
// The runtime files a sync carries across; fallback.json is the only record of the user's previous engine.
const CARRIED_FILES = ['status.json', 'binary.json', 'fallback.json', 'work']
const AUTH_TTL_MS = 60_000

interface ClaudeCodeWindow {
  fiveHour: { resetsAt: number | null; utilization: number | null } | null
  isUsingOverage: boolean
  sevenDay: { resetsAt: number | null; utilization: number | null } | null
  status: string
}

/** A custom/local endpoint is carried by its URL only (never a key): Hermes clears it while on Claude Code. */
interface EngineTarget {
  baseUrl?: string
  model: string
  provider: string
}

interface ClaudeCodeStatus {
  authMethod: string | null
  /** The engine a failed Claude Code turn is answered with, and the one leaving Claude Code returns to. */
  fallbackTarget: EngineTarget | null
  installed: boolean
  lastFallback: { at: number; reason: string; text: string } | null
  loggedIn: boolean
  path: string | null
  pluginInstalled: boolean
  subscriptionType: string | null
  version: string | null
  window: ClaudeCodeWindow | null
}

type Exec = (file: string, args: string[]) => Promise<string>

const defaultExec: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000 }, (error, stdout) => {
      // `auth status` exits 1 when logged out but still prints its JSON.
      if (error && !stdout) {
        reject(error)
      } else {
        resolve(String(stdout))
      }
    })
  })

function hashTree(dir: string): string {
  const parts: string[] = []

  const walk = (rel: string) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      if (!rel && RUNTIME_FILES.has(name)) {
        continue
      }

      const relPath = path.join(rel, name)
      const full = path.join(dir, relPath)

      if (fs.statSync(full).isDirectory()) {
        if (name !== '__pycache__') {
          walk(relPath)
        }
      } else {
        parts.push(`${relPath}\0${fs.readFileSync(full, 'utf8')}`)
      }
    }
  }

  walk('')

  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function mtimeOf(dir: string): number {
  try {
    return fs.statSync(dir).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Hermes imports every non-dot folder under model-providers/, so a `<name>.old-*` copy left by an
 * interrupted sync (any pid) would load old code as a second plugin. Stage folders are dot-named and
 * tagged with their pid; only one whose sync is still running in another live process is kept.
 * An interrupted sync may hold the only copy of a runtime file in a leftover, so before a leftover is
 * deleted the target is restored from an `.old-*` copy if it is missing, and every runtime file the
 * target lacks is moved into it (newest leftover first).
 */
function sweepLeftovers(parent: string, target: string): void {
  let names: string[]

  try {
    names = fs.readdirSync(parent)
  } catch {
    return
  }

  const stagePrefix = `.${PLUGIN_NAME}-stage-`

  const junk = names
    .filter(name => {
      if (name.startsWith(`${PLUGIN_NAME}.old-`)) {
        return true
      }

      if (!name.startsWith(stagePrefix)) {
        return false
      }

      const pid = Number(/^(\d+)-/.exec(name.slice(stagePrefix.length))?.[1])

      return !pid || pid === process.pid || !processAlive(pid)
    })
    .map(name => path.join(parent, name))
    .sort((a, b) => mtimeOf(b) - mtimeOf(a))

  if (junk.length === 0) {
    return
  }

  if (!fs.existsSync(target)) {
    const restorable = junk.find(dir => path.basename(dir).startsWith(`${PLUGIN_NAME}.old-`))

    try {
      if (restorable) {
        fs.renameSync(restorable, target)
        junk.splice(junk.indexOf(restorable), 1)
      } else {
        fs.mkdirSync(target, { recursive: true })
      }
    } catch {
      // Without a target nothing can be rescued; keep every leftover for the next sync.
      return
    }
  }

  for (const dir of junk) {
    let kept = false

    for (const name of CARRIED_FILES) {
      const from = path.join(dir, name)
      const to = path.join(target, name)

      if (fs.existsSync(from) && !fs.existsSync(to)) {
        try {
          fs.renameSync(from, to)
        } catch {
          kept = true
        }
      }
    }

    if (kept) {
      // A runtime file could not be rescued: the leftover stays until a later sync manages it.
      continue
    }

    try {
      fs.rmSync(dir, { force: true, recursive: true })
    } catch {
      // The next sync retries.
    }
  }
}

/**
 * Atomic, versioned copy: staged next to the target, then renamed in. Runtime files survive: they are
 * copied into the stage and the originals stay in the target until the swap has succeeded.
 * A damaged marker (empty, unparsable, not an object) or a missing __init__.py counts as stale.
 * Leftovers of earlier syncs are swept on every call, a no-op one included.
 */
export function syncClaudeCodePlugin(options: { hermesHome: string; sourceDir: string }): {
  error?: string
  written: boolean
} {
  const { hermesHome, sourceDir } = options
  const parent = path.join(hermesHome, 'plugins', 'model-providers')
  const target = path.join(parent, PLUGIN_NAME)
  let stage = ''

  try {
    const version = hashTree(sourceDir)
    const marker = path.join(target, MARKER)

    sweepLeftovers(parent, target)

    if (
      (readJsonFileSync(marker, { validate: isRecord }) ?? {}).version === version &&
      fs.existsSync(path.join(target, '__init__.py'))
    ) {
      return { written: false }
    }

    fs.mkdirSync(parent, { recursive: true })
    stage = fs.mkdtempSync(path.join(parent, `.${PLUGIN_NAME}-stage-${process.pid}-`))

    for (const name of fs.readdirSync(sourceDir)) {
      // The fake CLI under tests/ is for our own test runs; it never ships into a user's HERMES_HOME.
      if (!RUNTIME_FILES.has(name) && name !== 'tests') {
        fs.cpSync(path.join(sourceDir, name), path.join(stage, name), {
          filter: src => !src.includes(`${path.sep}__pycache__`),
          recursive: true
        })
      }
    }

    if (fs.existsSync(target)) {
      for (const name of fs.readdirSync(target)) {
        if (CARRIED_FILES.includes(name)) {
          fs.cpSync(path.join(target, name), path.join(stage, name), { recursive: true })
        }
      }
    }

    writeJsonAtomicSync(path.join(stage, MARKER), { version, at: Date.now() }, { space: 0, trailingNewline: false })
    replaceDirAtomicSync(stage, target)

    return { written: true }
  } catch (error) {
    try {
      // The swap puts the old tree back itself; the stage holds only copies.
      if (stage && fs.existsSync(target)) {
        fs.rmSync(stage, { force: true, recursive: true })
      }
    } catch {
      // The next sync's sweep rescues what is left.
    }

    return { error: error instanceof Error ? error.message : String(error), written: false }
  }
}

/** S1 §4 order: env override → native → legacy local → Homebrew/npm → bun/volta/nvm/npm-global. */
export function claudeBinaryCandidates(env: NodeJS.ProcessEnv, home: string, nvmVersions: string[] = []): string[] {
  const list: string[] = []

  if (env.ICLONE_CLAUDE_BIN?.trim()) {
    list.push(env.ICLONE_CLAUDE_BIN.trim())
  }

  list.push(
    path.join(home, '.local/bin/claude'),
    path.join(home, '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.bun/bin/claude'),
    path.join(home, '.volta/bin/claude'),
    ...nvmVersions.map(v => path.join(home, '.nvm/versions/node', v, 'bin/claude')),
    path.join(home, '.npm-global/bin/claude')
  )

  return list
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)

    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

export async function discoverClaudeBinary(deps: {
  env: NodeJS.ProcessEnv
  exec: Exec
  home: string
  isExec?: (file: string) => boolean
}): Promise<string | null> {
  const check = deps.isExec ?? isExecutable
  let nvm: string[] = []

  try {
    nvm = fs.readdirSync(path.join(deps.home, '.nvm/versions/node'))
  } catch {
    nvm = []
  }

  const hit = claudeBinaryCandidates(deps.env, deps.home, nvm).find(check)

  if (hit) {
    return hit
  }

  try {
    const found = (await deps.exec('/bin/zsh', ['-lic', 'command -v claude'])).trim().split('\n').pop() ?? ''

    return found.startsWith('/') && check(found) ? found : null
  } catch {
    return null
  }
}

export function parseAuthStatus(
  stdout: string
): Pick<ClaudeCodeStatus, 'authMethod' | 'loggedIn' | 'subscriptionType'> {
  try {
    const data = JSON.parse(stdout) as Record<string, unknown>

    if (data.type === 'result' && data.is_error) {
      return { authMethod: 'none', loggedIn: false, subscriptionType: null }
    }

    return {
      authMethod: typeof data.authMethod === 'string' ? data.authMethod : null,
      loggedIn: data.loggedIn === true,
      subscriptionType:
        typeof data.subscriptionType === 'string' && data.subscriptionType ? data.subscriptionType : null
    }
  } catch {
    return { authMethod: null, loggedIn: false, subscriptionType: null }
  }
}

const isString = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const isNumberOrNull = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value))

function asSlot(value: unknown): { resetsAt: number | null; utilization: number | null } | null | undefined {
  if (value === null || value === undefined) {
    return null
  }

  const v = value as Record<string, unknown>

  return typeof value === 'object' && isNumberOrNull(v.resetsAt ?? null) && isNumberOrNull(v.utilization ?? null)
    ? { resetsAt: (v.resetsAt as null | number) ?? null, utilization: (v.utilization as null | number) ?? null }
    : undefined
}

/** status.json is written by another process: only well-formed shapes reach the renderer. */
export function asWindow(value: unknown): ClaudeCodeWindow | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const v = value as Record<string, unknown>
  const fiveHour = asSlot(v.fiveHour)
  const sevenDay = asSlot(v.sevenDay)

  if (!isString(v.status, 40) || fiveHour === undefined || sevenDay === undefined) {
    return null
  }

  return { fiveHour, isUsingOverage: v.isUsingOverage === true, sevenDay, status: v.status }
}

export function asLastFallback(value: unknown): ClaudeCodeStatus['lastFallback'] {
  const v = (value ?? {}) as Record<string, unknown>

  return typeof v.at === 'number' && Number.isFinite(v.at) && isString(v.reason, 64) && isString(v.text, 300)
    ? { at: v.at, reason: v.reason, text: v.text }
    : null
}

/** An http(s) endpoint URL without credentials in it, else ''. */
export function asEndpoint(value: unknown): string {
  if (!isString(value, 300) || !value) {
    return ''
  }

  try {
    const url = new URL(value)

    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? value : ''
  } catch {
    return ''
  }
}

export function asTarget(value: unknown): ClaudeCodeStatus['fallbackTarget'] {
  const v = (value ?? {}) as Record<string, unknown>

  if (!(isString(v.provider, 80) && v.provider && v.provider !== ENGINE_PROVIDER && isString(v.model ?? '', 200))) {
    return null
  }

  const baseUrl = asEndpoint(v.base_url)

  return { model: (v.model as string | undefined) ?? '', provider: v.provider, ...(baseUrl ? { baseUrl } : {}) }
}

/** The banner's poll: two small files, never the `claude` binary. */
export function readFallbackState(hermesHome: string): Pick<ClaudeCodeStatus, 'fallbackTarget' | 'lastFallback'> {
  const dir = path.join(hermesHome, 'plugins', 'model-providers', PLUGIN_NAME)

  return {
    fallbackTarget: asTarget(readJsonFileSync(path.join(dir, 'fallback.json'), { validate: isRecord }) ?? {}),
    lastFallback: asLastFallback(
      (readJsonFileSync(path.join(dir, 'status.json'), { validate: isRecord }) ?? {}).lastFallback
    )
  }
}

export function createClaudeCodeStatus(deps: { env: NodeJS.ProcessEnv; exec: Exec; hermesHome: string; home: string }) {
  const pluginDir = path.join(deps.hermesHome, 'plugins', 'model-providers', PLUGIN_NAME)
  let binary: { path: string | null; version: string | null } | null = null
  let auth: { at: number; value: Pick<ClaudeCodeStatus, 'authMethod' | 'loggedIn' | 'subscriptionType'> } | null = null

  return async (options: { refresh?: boolean } = {}): Promise<ClaudeCodeStatus> => {
    if (!binary || options.refresh) {
      const found = await discoverClaudeBinary(deps)
      let version: string | null = null

      if (found) {
        version = (await deps.exec(found, ['--version']).catch(() => '')).trim().split(/\s/)[0] || null

        if (fs.existsSync(pluginDir)) {
          writeJsonAtomicSync(path.join(pluginDir, 'binary.json'), { path: found, version }, PLUGIN_JSON)
        }
      }

      binary = { path: found, version }
      auth = null
    }

    if (binary.path && (!auth || options.refresh || Date.now() - auth.at > AUTH_TTL_MS)) {
      const out = await deps.exec(binary.path, ['auth', 'status', '--json']).catch(() => '')
      auth = { at: Date.now(), value: parseAuthStatus(out) }
    }

    const status = readJsonFileSync(path.join(pluginDir, 'status.json'), { validate: isRecord }) ?? {}

    return {
      authMethod: auth?.value.authMethod ?? null,
      ...readFallbackState(deps.hermesHome),
      installed: Boolean(binary.path),
      loggedIn: Boolean(binary.path && auth?.value.loggedIn),
      path: binary.path,
      pluginInstalled: fs.existsSync(path.join(pluginDir, '__init__.py')),
      subscriptionType: auth?.value.subscriptionType ?? null,
      version: binary.version,
      window: asWindow(status.window)
    }
  }
}

/** The engine the plugin falls back to (and pins auxiliary tasks to): the one in use before Claude Code. */
export function writeFallbackTarget(hermesHome: string, target: EngineTarget) {
  const dir = path.join(hermesHome, 'plugins', 'model-providers', PLUGIN_NAME)
  const provider = target.provider === ENGINE_PROVIDER || !target.provider ? 'nous' : target.provider
  const baseUrl = provider === 'nous' ? '' : asEndpoint(target.baseUrl)
  fs.mkdirSync(dir, { recursive: true })
  writeJsonAtomicSync(
    path.join(dir, 'fallback.json'),
    {
      model: target.model || '',
      provider,
      ...(baseUrl ? { base_url: baseUrl } : {})
    },
    PLUGIN_JSON
  )

  return { ok: true as const }
}

function bundledPluginDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'hermes-plugins', PLUGIN_NAME)
    : path.resolve(app.getAppPath(), '..', '..', 'iclone', 'hermes-plugins', PLUGIN_NAME)
}

let initialized = false

export function initIcloneClaudeCode(options: { hermesHome: string }) {
  if (initialized) {
    return
  }

  initialized = true
  const sync = syncClaudeCodePlugin({ hermesHome: options.hermesHome, sourceDir: bundledPluginDir() })

  if (sync.error) {
    console.warn('[iclone] claude-code plugin sync failed:', sync.error)
  }

  const status = createClaudeCodeStatus({
    env: process.env,
    exec: defaultExec,
    hermesHome: options.hermesHome,
    home: os.homedir()
  })

  ipcMain.handle('iclone:claude-code-status', (_event, refresh?: unknown) => status({ refresh: refresh === true }))
  ipcMain.handle('iclone:claude-code-fallback-state', () => readFallbackState(options.hermesHome))
  ipcMain.handle('iclone:claude-code-fallback', (_event, target: unknown) => {
    const t = (target ?? {}) as { baseUrl?: unknown; model?: unknown; provider?: unknown }

    return writeFallbackTarget(options.hermesHome, {
      baseUrl: asEndpoint(t.baseUrl),
      model: typeof t.model === 'string' ? t.model.slice(0, 200) : '',
      provider: typeof t.provider === 'string' ? t.provider.slice(0, 80) : 'nous'
    })
  })
}
