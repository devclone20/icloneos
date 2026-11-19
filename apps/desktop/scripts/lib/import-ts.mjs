// import-ts.mjs — load an electron/ TypeScript module from a build script. The main-process sources use extensionless
// relative imports (resolved by esbuild and vitest, not by Node's own type stripping), so the module is bundled for
// Node with the same esbuild the main bundle uses (scripts/bundle-electron-main.mjs), into a private temp folder,
// imported, and the temp folder removed. `electron` stays external: a module that needs it is not for a build script.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The ACP tools' build surface (electron/iclone-acp-tools/build-entry.ts). */
export const ACP_TOOLS_ENTRY = join(DESKTOP_ROOT, 'electron', 'iclone-acp-tools', 'build-entry.ts')

export async function importTs(entry, { root = DESKTOP_ROOT } = {}) {
  const { build } = await import('esbuild')
  const out = mkdtempSync(join(tmpdir(), 'iclone-import-ts-'))
  const outfile = join(out, 'module.mjs')

  try {
    await build({
      absWorkingDir: root,
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external: ['electron'],
      preserveSymlinks: true,
      logLevel: 'error',
      outfile
    })

    return await import(pathToFileURL(outfile).href)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

/** The ACP tools' build surface, loaded once per process. */
let acpTools = null

export function importAcpTools() {
  acpTools ??= importTs(ACP_TOOLS_ENTRY)

  return acpTools
}
