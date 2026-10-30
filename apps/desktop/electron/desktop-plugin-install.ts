/**
 * Probe and install desktop runtime plugins from Git repositories.
 * Pure helpers are exported for unit tests; IPC handlers in main.ts call the
 * async entry points with a resolved git binary.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolvePluginGitUrl } from '../src/iclone-shared/plugin-git-url'

import { runGit } from './lib/git'

/** main.ts and the tests import the resolver from here (front L1 owns main.ts). */
export { resolvePluginGitUrl } from '../src/iclone-shared/plugin-git-url'

interface PluginComponentDetection {
  agent: boolean
  desktop: boolean
  agentName: string | null
  desktopName: string | null
  desktopSourceSubdir: string | null
}

interface PluginProbeResult {
  ok: boolean
  agent: boolean
  desktop: boolean
  agentName?: string | null
  desktopName?: string | null
  warnings: string[]
  insecure: boolean
  error?: string
}

interface DesktopPluginInstallResult {
  ok: boolean
  pluginName?: string
  path?: string
  error?: string
}

/** git through electron/lib/git: resolves the exit code and stderr; a hung clone rejects after 60 s. */
async function gitExit(gitBin: string, args: string[], cwd?: string): Promise<{ code: number; stderr: string }> {
  const result = await runGit(args, { bin: gitBin, cwd, timeoutMs: 60_000 })

  if (result.timedOut) {
    throw new Error('Git clone timed out after 60 seconds.')
  }

  return { code: result.code ?? 1, stderr: result.stderr }
}

export function repoNameFromUrl(url: string): string {
  let name = url.replace(/\/+$/, '')

  if (name.endsWith('.git')) {
    name = name.slice(0, -4)
  }

  name = name.split('/').pop() || name

  if (name.includes(':')) {
    name = name.split(':').pop() || name
    name = name.split('/').pop() || name
  }

  return name
}

/** Stable on-disk folder for a desktop plugin. Never the clone temp dir or a generic `desktop/` folder. */
export function desktopPluginFolderName(gitUrl: string, subdir: string | null): string {
  if (subdir) {
    const last = subdir
      .split(/[/\\]/)
      .filter(part => part && part !== '.' && part !== 'desktop')
      .pop()

    if (last) {
      return last
    }
  }

  return repoNameFromUrl(gitUrl)
}

export function resolveSubdirWithin(cloneRoot: string, subdir: string): string {
  const root = path.resolve(cloneRoot)
  const candidate = path.resolve(root, subdir)

  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new Error(`Plugin subdirectory '${subdir}' escapes the repository.`)
  }

  return candidate
}

function pathExistsSync(filePath: string): boolean {
  try {
    fs.accessSync(filePath)

    return true
  } catch {
    return false
  }
}

async function pathIsDirectory(filePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath)

    return stat.isDirectory()
  } catch {
    return false
  }
}

async function pathIsFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath)

    return stat.isFile()
  } catch {
    return false
  }
}

export function findDesktopEntry(pluginRoot: string): { entryFile: string; sourceSubdir: string } | null {
  const rootPlugin = path.join(pluginRoot, 'plugin.js')

  if (pathExistsSync(rootPlugin)) {
    return { entryFile: rootPlugin, sourceSubdir: '.' }
  }

  const nestedPlugin = path.join(pluginRoot, 'desktop', 'plugin.js')

  if (pathExistsSync(nestedPlugin)) {
    return { entryFile: nestedPlugin, sourceSubdir: 'desktop' }
  }

  return null
}

export async function detectPluginComponents(pluginRoot: string): Promise<PluginComponentDetection> {
  const hasYaml =
    pathExistsSync(path.join(pluginRoot, 'plugin.yaml')) || pathExistsSync(path.join(pluginRoot, 'plugin.yml'))

  const hasInit = pathExistsSync(path.join(pluginRoot, '__init__.py'))
  const hasPortable = pathExistsSync(path.join(pluginRoot, 'plugin.json'))
  const agent = (hasYaml && hasInit) || hasPortable

  const desktopEntry = findDesktopEntry(pluginRoot)
  const desktop = desktopEntry !== null

  let agentName: string | null = null

  if (agent) {
    agentName = path.basename(pluginRoot)

    if (hasYaml) {
      try {
        const yamlPath = pathExistsSync(path.join(pluginRoot, 'plugin.yaml'))
          ? path.join(pluginRoot, 'plugin.yaml')
          : path.join(pluginRoot, 'plugin.yml')

        const text = await fsp.readFile(yamlPath, 'utf8')
        const match = text.match(/^name:\s*['"]?([^'"\n]+)['"]?\s*$/m)

        if (match?.[1]) {
          agentName = match[1].trim()
        }
      } catch {
        // Fall back to directory name.
      }
    } else if (hasPortable) {
      try {
        const raw = await fsp.readFile(path.join(pluginRoot, 'plugin.json'), 'utf8')
        const parsed = JSON.parse(raw) as { name?: string }

        if (parsed.name) {
          agentName = parsed.name
        }
      } catch {
        // Fall back to directory name.
      }
    }
  }

  const desktopName = desktop
    ? desktopEntry!.sourceSubdir === '.'
      ? path.basename(pluginRoot)
      : path.basename(path.dirname(desktopEntry!.entryFile))
    : null

  return {
    agent,
    desktop,
    agentName,
    desktopName,
    desktopSourceSubdir: desktopEntry?.sourceSubdir ?? null
  }
}

async function cloneToTemp(gitBin: string, gitUrl: string): Promise<string> {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-plugin-'))

  try {
    const { code, stderr } = await gitExit(gitBin, ['clone', '--depth', '1', gitUrl, tmpRoot])

    if (code !== 0) {
      throw new Error(`Git clone failed:\n${stderr.trim()}`)
    }

    return tmpRoot
  } catch (err) {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

async function resolvePluginRoot(cloneRoot: string, subdir: string | null): Promise<string> {
  if (!subdir) {
    return cloneRoot
  }

  const resolved = resolveSubdirWithin(cloneRoot, subdir)

  if (!(await pathIsDirectory(resolved))) {
    throw new Error(`Plugin subdirectory '${subdir}' does not exist in the repository.`)
  }

  return resolved
}

function insecureSchemeWarnings(gitUrl: string): { warnings: string[]; insecure: boolean } {
  if (gitUrl.startsWith('http://') || gitUrl.startsWith('file://')) {
    return {
      warnings: ['This URL uses an insecure or local scheme. Prefer https:// or git@ for production installs.'],
      insecure: true
    }
  }

  return { warnings: [], insecure: false }
}

export async function probePluginRepo(gitBin: string, identifier: string): Promise<PluginProbeResult> {
  try {
    const { gitUrl, subdir } = resolvePluginGitUrl(identifier)
    const { warnings, insecure } = insecureSchemeWarnings(gitUrl)
    const cloneRoot = await cloneToTemp(gitBin, gitUrl)

    try {
      const pluginRoot = await resolvePluginRoot(cloneRoot, subdir)
      const detected = await detectPluginComponents(pluginRoot)
      const repoFallback = repoNameFromUrl(gitUrl)

      if (!detected.agent && !detected.desktop) {
        return {
          ok: false,
          agent: false,
          desktop: false,
          warnings,
          insecure,
          error: 'No agent or desktop plugin artifacts found in this repository.'
        }
      }

      return {
        ok: true,
        agent: detected.agent,
        desktop: detected.desktop,
        agentName: detected.agentName ?? (detected.agent ? repoFallback : null),
        desktopName: detected.desktop ? desktopPluginFolderName(gitUrl, subdir) : null,
        warnings,
        insecure
      }
    } finally {
      await fsp.rm(cloneRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  } catch (err) {
    return {
      ok: false,
      agent: false,
      desktop: false,
      warnings: [],
      insecure: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

async function copyDesktopTree(sourceDir: string, targetDir: string): Promise<void> {
  await fsp.mkdir(path.dirname(targetDir), { recursive: true })
  await fsp.cp(sourceDir, targetDir, { recursive: true, force: true })
}

export async function installDesktopPluginFromGit(
  gitBin: string,
  identifier: string,
  desktopPluginsRoot: string,
  force = false
): Promise<DesktopPluginInstallResult> {
  try {
    const { gitUrl, subdir } = resolvePluginGitUrl(identifier)
    const cloneRoot = await cloneToTemp(gitBin, gitUrl)

    try {
      const pluginRoot = await resolvePluginRoot(cloneRoot, subdir)
      const detected = await detectPluginComponents(pluginRoot)

      if (!detected.desktop || !detected.desktopSourceSubdir) {
        return { ok: false, error: 'No desktop plugin.js found in this repository.' }
      }

      const sourceDir =
        detected.desktopSourceSubdir === '.' ? pluginRoot : path.join(pluginRoot, detected.desktopSourceSubdir)

      const pluginName = desktopPluginFolderName(gitUrl, subdir)
      const targetDir = path.join(desktopPluginsRoot, pluginName)
      const targetPlugin = path.join(targetDir, 'plugin.js')

      if ((await pathIsDirectory(targetDir)) || (await pathIsFile(targetPlugin))) {
        if (!force) {
          return {
            ok: false,
            error: `Desktop plugin '${pluginName}' already exists. Enable force reinstall to replace it.`
          }
        }

        await fsp.rm(targetDir, { recursive: true, force: true })
      }

      await copyDesktopTree(sourceDir, targetDir)

      if (!(await pathIsFile(targetPlugin))) {
        return { ok: false, error: `Install completed but ${targetPlugin} is missing.` }
      }

      return { ok: true, pluginName, path: targetDir }
    } finally {
      await fsp.rm(cloneRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
