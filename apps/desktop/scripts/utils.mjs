import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The file a path names, every symlink resolved; a path that does not exist (yet) is only made absolute. */
function realPath(file) {
  try {
    return realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

// True when the passed module is the one node was asked to run, not an import.
// `node -e` and REPLs have no argv[1]; those are never "main".
// Both sides are compared resolved (review r2, R2-M7): node resolves the main module's symlinks for import.meta.url but
// leaves argv[1] as typed, so a script called through a link (/tmp is one on macOS) was "not main", did nothing, and
// exited 0 — which a caller like V3RT_quit.sh read as success.
export function isMain(importMetaUrl) {
  const script = process.argv[1]

  return Boolean(script) && realPath(fileURLToPath(importMetaUrl)) === realPath(script)
}
