/**
 * About's "what is installed" answer, kept per app version and runtime sha (V3-0b). `hermes_cli uninstall
 * --gui-summary` boots Python and takes seconds; the answer only changes when the app or the runtime changes, so a
 * matching cached answer is returned at once and a fresh probe runs behind it. Only real probe answers are kept: a
 * fallback (venv gone, probe failed or timed out) is served but never cached, so the next open asks again.
 */

import fs from 'node:fs'
import path from 'node:path'

import { writeFileAtomicSync } from './lib/atomic-write'

export interface UninstallSummaryCacheDeps<T> {
  /** `<appVersion>|<runtimeSha>|<agentRoot>`: an answer is reused only under the same key. */
  key: () => string
  probe: () => Promise<T>
  isFallback: (value: T) => boolean
  /** Shape check for what is read back from disk. */
  isValue: (value: unknown) => value is T
  /** Where the last real answer survives a relaunch (userData); read lazily, after the app set its paths. */
  file: () => string
  log?: (message: string) => void
  /** K87: a cached answer is re-confirmed at most this often per key (default 10 minutes). */
  refreshAfterMs?: number
  now?: () => number
}

const REFRESH_AFTER_MS = 10 * 60_000

export interface UninstallSummaryCache<T> {
  get: () => Promise<T>
  /** The in-flight background probe, for tests; null when none runs. */
  pending: () => null | Promise<T>
}

interface StoredSummary<T> {
  key: string
  value: T
}

function readStored<T>(file: string, isValue: (value: unknown) => value is T): null | StoredSummary<T> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))

    if (parsed && typeof parsed === 'object' && 'key' in parsed && 'value' in parsed) {
      const { key, value } = parsed

      if (typeof key === 'string' && isValue(value)) {
        return { key, value }
      }
    }
  } catch {
    // Missing or unreadable: no cached answer.
  }

  return null
}

export function createUninstallSummaryCache<T>(deps: UninstallSummaryCacheDeps<T>): UninstallSummaryCache<T> {
  let memory: null | StoredSummary<T> = null
  let inflight: null | Promise<T> = null
  // When a probe last started, per key: a cached answer is not re-probed on every About open (K87).
  let lastProbe: null | { key: string; at: number } = null
  const now = deps.now ?? Date.now
  const refreshAfterMs = deps.refreshAfterMs ?? REFRESH_AFTER_MS

  const refresh = (key: string): Promise<T> => {
    if (!inflight) {
      lastProbe = { key, at: now() }
    }

    inflight ??= deps
      .probe()
      .then(value => {
        if (!deps.isFallback(value)) {
          memory = { key, value }

          try {
            writeFileAtomicSync(deps.file(), JSON.stringify(memory))
          } catch (error) {
            deps.log?.(`[uninstall-summary] cache write failed: ${String(error)}`)
          }
        } else if (memory) {
          // K37 m1: the probe that was meant to confirm a cached answer fell back (venv gone, probe failed): the
          // cached answer may no longer be true, so it is dropped, in memory and on disk. The next open asks again.
          memory = null

          try {
            fs.rmSync(deps.file(), { force: true })
          } catch (error) {
            deps.log?.(`[uninstall-summary] cache clear failed: ${String(error)}`)
          }
        }

        return value
      })
      .finally(() => {
        inflight = null
      })

    return inflight
  }

  return {
    get: async () => {
      const key = deps.key()

      if (memory?.key !== key) {
        const stored = readStored(deps.file(), deps.isValue)

        memory = stored?.key === key ? stored : null
      }

      if (memory) {
        const cached = memory.value
        const fresh = lastProbe?.key === key && now() - lastProbe.at < refreshAfterMs

        if (!fresh) {
          void refresh(key).catch(() => undefined)
        }

        return cached
      }

      return refresh(key)
    },
    pending: () => inflight
  }
}

/**
 * The runtime's HEAD sha from `.git` on disk, without spawning git: a detached HEAD, a loose ref or a packed ref.
 * Null when the root is not a checkout or the ref is unreadable.
 */
export function readGitHeadSha(root: string): null | string {
  const gitDir = path.join(root, '.git')
  const isSha = (value: string) => /^[0-9a-f]{40}$/.test(value)

  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()

    if (isSha(head)) {
      return head
    }

    const ref = /^ref: (refs\/[\w./-]+)$/.exec(head)?.[1]

    if (!ref || ref.includes('..')) {
      return null
    }

    try {
      const loose = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim()

      if (isSha(loose)) {
        return loose
      }
    } catch {
      // Not loose; look in packed-refs.
    }

    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8')

    for (const line of packed.split('\n')) {
      const [sha, name] = line.trim().split(' ')

      if (name === ref && sha && isSha(sha)) {
        return sha
      }
    }
  } catch {
    // Not a checkout, or a worktree `.git` file: no sha, the key still carries the version.
  }

  return null
}

/**
 * K37 m3: what `hermes uninstall --gui-summary` (hermes_cli/gui_uninstall.py) and the JS fallback both answer at
 * least: the two install flags and the home path. Anything else read back from disk (`{}`, an array, a stray
 * object) is no answer, so About never renders options from a summary that says nothing.
 */
export function isUninstallSummaryValue(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const { agent_installed: agent, gui_installed: gui, hermes_home: home } = value as Record<string, unknown>

  return typeof agent === 'boolean' && typeof gui === 'boolean' && typeof home === 'string' && home.length > 0
}
