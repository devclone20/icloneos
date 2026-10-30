#!/usr/bin/env node
// verify-packaged-acp.mjs — REL-6 (ruling 26): the bundle carries NO ACP CLI. Two proofs, in order:
//   1. static, never launching the app (scripts/acp-pack-absent.mjs): no acp-cli tree, no Go signer, no package
//      of the CLI's closure anywhere in the bundle, and Resources/acp-pin byte-equal to the committed pin;
//   2. the SHIPPED app's own self-test, headless (`<app> --iclone-selftest=all` → one JSON line, exit 0/1): its
//      acp check reports `bundled: false` and the pin's CLI version, and node-pty spawns.
//
//   node scripts/verify-packaged-acp.mjs [--static] [<app.app>]   # default: the app under release/
//
// `--static` runs proof 1 only (a locally signed build cannot launch on this Mac: RESUME/scout/R7_pack_hang_macos26.md).
//
// Why this exists: the dock apps were verified for weeks against a dev run
// that resolved a system `acp` binary, while the packaged app ran the bundled
// CLI through Electron-as-Node — a path nobody had exercised end to end. The
// only timing test on that path measured seconds and never read the output,
// so a CLI that failed every command in 0.5 s looked fast. This script reads
// the output. `pack` and `install:mac` refuse to continue when it fails. The
// app is fused (no RunAsNode), so its binary is never driven as Node from
// here; ELECTRON_RUN_AS_NODE is dropped from the child's environment.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ACP_CLI_VERSION } from './acp-cli-version.mjs'
import { checkAcpAbsent } from './acp-pack-absent.mjs'
import { judgePackagedSelftest } from './acp-selftest.mjs'
import { findBuiltApp } from './built-app.mjs'
import { isMain } from './utils.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function verifyPackagedAcp(appPath, { staticOnly = false } = {}) {
  const absent = checkAcpAbsent(appPath)

  if (!absent.ok) {
    return { ok: false, error: `the bundle is not ACP-free: ${absent.problems.join('; ')}`, absent }
  }

  if (staticOnly) {
    return { ok: true, static: true, absent }
  }

  if (process.platform !== 'darwin') {
    return { ok: true, skipped: `packaged-CLI verification runs on macOS bundles only (this is ${process.platform})` }
  }

  const plist = join(appPath, 'Contents', 'Info.plist')

  if (!existsSync(plist)) {
    return { ok: false, error: `not an app bundle: ${appPath}` }
  }

  const executable = spawnSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', plist], {
    encoding: 'utf8'
  }).stdout.trim()

  if (!executable) {
    return { ok: false, error: `cannot read CFBundleExecutable from ${plist}` }
  }

  const env = { ...process.env }

  delete env.ELECTRON_RUN_AS_NODE

  const result = spawnSync(join(appPath, 'Contents', 'MacOS', executable), ['--iclone-selftest=all'], {
    env,
    encoding: 'utf8',
    timeout: 180_000,
    // Electron's browser process ignores SIGTERM while its startup handshake is stuck; only SIGKILL ends it.
    killSignal: 'SIGKILL'
  })

  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT' || result.signal === 'SIGKILL'

    return {
      ok: false,
      error: timedOut
        ? 'the packaged app did not finish its self-test in 180 s (child processes never connected — see RESUME/scout/R7_pack_hang_macos26.md)'
        : result.error.message
    }
  }

  return { ...judgePackagedSelftest(result, ACP_CLI_VERSION), absent }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const staticOnly = args.includes('--static')
  const target = args.find(arg => !arg.startsWith('--'))
  const appPath = target ? resolve(target) : findBuiltApp(projectRoot)

  if (!appPath) {
    if (process.platform !== 'darwin') {
      console.log('[verify-packaged-acp] no macOS bundle on this platform — skipped')
      process.exit(0)
    }

    console.error('[verify-packaged-acp] no built app under release/ — run `npm run pack` first')
    process.exit(1)
  }

  const result = verifyPackagedAcp(appPath, { staticOnly })

  if (result.skipped) {
    console.log(`[verify-packaged-acp] ${result.skipped}`)
  } else if (result.ok) {
    const { counts } = result.absent

    console.log(
      `[verify-packaged-acp] ok — ${appPath}: no ACP CLI in the bundle (${counts.files} files scanned: ` +
        `${counts.acpCliDirs} acp-cli dirs, ${counts.alchemyPaths} @alchemy, ${counts.rpcWebsocketsPaths} rpc-websockets, ` +
        `${counts.signerBinaries} Go signer)` +
        (result.static ? '; static proof only' : `; the app's self-test reports pin ${result.version} and node-pty`)
    )
  } else {
    console.error(`[verify-packaged-acp] FAILED — ${appPath}: ${result.error}`)
    console.error('[verify-packaged-acp] nothing should ship from this build')
    process.exit(1)
  }
}
