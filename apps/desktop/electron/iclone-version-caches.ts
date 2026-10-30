/**
 * A new app version starts with clean caches. The HTTP cache, V8 code cache, GPU shader cache and Cache Storage of
 * the previous version are rebuilt on demand, and a stale copy is only weight (and a source of "old screen after an
 * update"). User data is never touched here: settings (Local Storage), sign-ins (cookies), conversations (Hermes),
 * consent and per-iNFT state all stay. The version seen last is recorded in `<userData>/last-version.json`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const VERSION_MARKER = 'last-version.json'

interface VersionCachesSession {
  clearCache(): Promise<void>
  clearCodeCaches(options: { urls?: string[] }): Promise<void>
  clearStorageData(options: { storages: Array<'cachestorage' | 'shadercache'> }): Promise<void>
}

interface VersionCachesDeps {
  userData: string
  version: string
  session: VersionCachesSession
  log: (line: string) => void
}

export function lastSeenVersion(userData: string): string | null {
  try {
    const value = JSON.parse(readFileSync(path.join(userData, VERSION_MARKER), 'utf8')) as { version?: unknown }

    return typeof value.version === 'string' ? value.version : null
  } catch {
    return null
  }
}

/** Clears the previous version's caches once, on the first launch of a new version. */
export async function clearCachesOnVersionChange(deps: VersionCachesDeps): Promise<'same' | 'cleared' | 'failed'> {
  const previous = lastSeenVersion(deps.userData)

  if (previous === deps.version) {
    return 'same'
  }

  try {
    await deps.session.clearCache()
    await deps.session.clearCodeCaches({})
    await deps.session.clearStorageData({ storages: ['cachestorage', 'shadercache'] })
    writeFileSync(
      path.join(deps.userData, VERSION_MARKER),
      `${JSON.stringify({ version: deps.version, clearedAt: new Date().toISOString() })}\n`
    )
    deps.log(
      `[caches] ${previous ?? 'unknown'} -> ${deps.version}: cleared HTTP, code, shader and Cache Storage caches`
    )

    return 'cleared'
  } catch (error) {
    // The marker is not written, so the next launch tries again.
    deps.log(
      `[caches] could not clear the previous version's caches: ${error instanceof Error ? error.message : error}`
    )

    return 'failed'
  }
}
