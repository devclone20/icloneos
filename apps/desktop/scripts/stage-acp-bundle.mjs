#!/usr/bin/env node
/**
 * stage-acp-bundle.mjs — v0.0.9 (owner decision 17 Nov, replaces ruling 26): the app SHIPS the Virtuals ACP CLI.
 *
 *   node scripts/stage-acp-bundle.mjs [--target darwin-arm64] [--out build/acp-tools] [--no-smoke]
 *
 * Materialises the pinned tree (acp-cli-lock/package-lock.json) into `build/acp-tools/`, which electron-builder seals
 * into the app as `Resources/acp-tools/` (package.json `extraResources`), with the SAME checks the v0.0.3–v0.0.8
 * first-use installer ran — the same code, electron/iclone-acp-tools/materialise.ts, loaded through esbuild:
 *   - only https://registry.npmjs.org/ tarballs of each row's own name and version, no redirect followed, size and time
 *     caps (net-core.ts over this Node's fetch);
 *   - sha512 of every tarball against the lockfile before a byte is read; no install script ever runs;
 *   - only the CLI's runtime closure for the target, pruned per file like the installer pruned it;
 *   - the app's own native add-ons (build/acp-native/<target>, stage-acp-native.mjs) swapped in over npm's;
 *   - NOTICES.md = acp-cli-lock/NOTICES.md + every package's own licence texts; MANIFEST.json written and the tree
 *     proven against it.
 * Then a smoke run: `acp chain list --json` through our own launcher (scripts/acp-launch.cjs), confined to the staged
 * tree exactly as the app confines it (ICLONE_ACP_TREE + ICLONE_ACP_TREE_SHA256), under the dev Electron as Node — a
 * tree that cannot answer a real command never reaches a bundle.
 *
 * Idempotent: a staged tree for this lock, target and add-on list that still verifies is kept (no download).
 * A release then signs the Go signer and the add-ons inside it and reseals the manifest (sign-acp-bundle.mjs).
 * SOURCE_DATE_EPOCH, when set, is the manifest's `createdAt`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { judgeChainList } from './acp-selftest.mjs'
import { DESKTOP_ROOT, importAcpTools } from './lib/import-ts.mjs'
import { isMain } from './utils.mjs'
import { treeRunner } from './verify-packaged-acp-tree.mjs'

export const DEFAULT_OUT = path.join(DESKTOP_ROOT, 'build', 'acp-tools')
export const LOCK_DIR = path.join(DESKTOP_ROOT, 'acp-cli-lock')
export const NATIVE_ROOT = path.join(DESKTOP_ROOT, 'build', 'acp-native')
export const LAUNCHER = path.join(DESKTOP_ROOT, 'scripts', 'acp-launch.cjs')

/** `darwin-arm64` → { platform, arch, libc }. */
export function parseTarget(name) {
  const [platform, arch, libc] = String(name).split('-')

  if (!platform || !arch) {
    throw new Error(`--target ${name}: expected <platform>-<arch>[-<libc>]`)
  }

  return { platform, arch, libc: libc === 'glibc' || libc === 'musl' ? libc : null }
}

/** This machine's target (the build host builds its own platform's bundle; before-pack refuses another). */
export function hostTarget() {
  if (process.platform !== 'linux') {
    return { platform: process.platform, arch: process.arch, libc: null }
  }

  const header = process.report?.getReport()?.header

  return { platform: 'linux', arch: process.arch, libc: header?.glibcVersionRuntime ? 'glibc' : 'musl' }
}

/** Ruling 33: the add-ons this target ships (macOS must have them; other targets keep npm's). */
export function nativeFor(target, targetName, nativeRoot = NATIVE_ROOT) {
  const dir = path.join(nativeRoot, targetName)

  return { dir: existsSync(path.join(dir, 'ADDONS.json')) ? dir : null, required: target.platform === 'darwin' }
}

/** Node's fetch in the shape net-core.ts expects (`cache` dropped: undici does not take every mode Chromium does). */
export function nodeFetch(url, init) {
  return fetch(url, { signal: init.signal, redirect: init.redirect, headers: init.headers })
}

/** Is `out` already this lock's, target's and add-on list's tree, and does it still verify? */
export async function stagedUpToDate(tools, out, { lockSha256, target, native }) {
  const read = tools.readBundleManifest(out)

  if (!read.ok) {
    return false
  }

  const { manifest } = read

  if (
    manifest.lockSha256 !== lockSha256 ||
    manifest.target !== tools.targetName(target) ||
    manifest.addons !== tools.addonsDigest(native)
  ) {
    return false
  }

  return (await tools.verifyTree(out, manifest)).ok
}

/** `acp chain list --json` through our launcher, confined to the staged tree like the app's utility process. */
export function smokeRun({ out, manifest, launcher = LAUNCHER, runner = treeRunner(DESKTOP_ROOT), spawn = spawnSync }) {
  const entry = path.join(out, 'runtime', 'node_modules', '@virtuals-protocol', 'acp-cli', 'dist', 'bin', 'acp.js')
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'iclone-acp-bundle-smoke-'))

  try {
    const result = spawn(runner.exec, [launcher, entry, 'chain', 'list', '--json'], {
      cwd: configDir,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...runner.env,
        HOME: configDir,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
        TMPDIR: os.tmpdir(),
        ACP_CONFIG_DIR: configDir,
        DOTENV_CONFIG_PATH: path.join(configDir, 'no-dotenv'),
        DOTENV_CONFIG_QUIET: 'true',
        ICLONE_ACP_TREE: out,
        ICLONE_ACP_TREE_SHA256: manifest.treeSha256
      }
    })

    if (result.error) {
      return { ok: false, error: result.error.message }
    }

    return judgeChainList(result)
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}

export async function stageAcpBundle({
  target = hostTarget(),
  out = DEFAULT_OUT,
  lockDir = LOCK_DIR,
  nativeRoot = NATIVE_ROOT,
  smoke = true,
  log = console.log
} = {}) {
  const tools = await importAcpTools()
  const name = tools.targetName(target)
  const native = nativeFor(target, name, nativeRoot)
  const pin = tools.loadPin(lockDir, target)

  if (native.required && !native.dir) {
    throw new Error(`no app add-ons for ${name} in ${path.relative(DESKTOP_ROOT, nativeRoot)}: run stage-acp-native.mjs first`)
  }

  if (await stagedUpToDate(tools, out, { lockSha256: pin.lockSha256, target, native })) {
    log(`[stage-acp-bundle] up to date — ${path.relative(DESKTOP_ROOT, out)} is this pin's ${name} tree and verifies`)

    return { kept: true, manifest: tools.readBundleManifest(out).manifest }
  }

  rmSync(out, { recursive: true, force: true })

  const epoch = Number(process.env.SOURCE_DATE_EPOCH)
  const fetchRegistry = tools.createRegistryFetch({ fetch: nodeFetch })

  log(`[stage-acp-bundle] materialising ${tools.ACP_CLI_NAME}@${pin.pin.cliVersion} for ${name}: ${pin.rows.length} packages from registry.npmjs.org`)

  const manifest = await tools.materialiseBundle({
    pinDir: lockDir,
    outDir: out,
    target,
    fetch: fetchRegistry,
    native,
    lockNotices: readFileSync(path.join(lockDir, 'NOTICES.md'), 'utf8'),
    now: () => (Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date()),
    log
  })

  if (smoke) {
    const verdict = smokeRun({ out, manifest })

    if (!verdict.ok) {
      rmSync(out, { recursive: true, force: true })
      throw new Error(`the staged CLI does not answer \`acp chain list --json\` through the launcher: ${verdict.error}`)
    }

    log(`[stage-acp-bundle] smoke: acp chain list answered ${verdict.chains} chains through the confined launcher`)
  }

  log(
    `[stage-acp-bundle] ok — ${path.relative(DESKTOP_ROOT, out)}: ${tools.ACP_CLI_NAME}@${manifest.cliVersion}, ` +
      `${Object.keys(manifest.files).length} files, tree ${manifest.treeSha256.slice(0, 12)}, add-ons ${manifest.addons.slice(0, 12)}`
  )

  return { kept: false, manifest }
}

/**
 * before-pack.mjs: the bundle for the PACK's target (electron-builder's platform and arch). The build host's own target
 * keeps its smoke run; another target is staged without one (its binaries cannot run here). Linux takes the host's C
 * library on a Linux host, else glibc.
 */
export function ensureAcpBundleFor({ platform, arch, out = DEFAULT_OUT, stage = stageAcpBundle, log = console.log }) {
  const host = hostTarget()
  const libc = platform === 'linux' ? (host.platform === 'linux' ? host.libc : 'glibc') : null
  const sameAsHost = host.platform === platform && host.arch === arch

  return stage({ target: { platform, arch, libc }, out, smoke: sameAsHost, log })
}

export function parseArgs(argv) {
  const opts = { target: hostTarget(), out: DEFAULT_OUT, smoke: true }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--target') {
      opts.target = parseTarget(argv[(i += 1)])
    } else if (arg === '--out') {
      opts.out = path.resolve(argv[(i += 1)] ?? '')
    } else if (arg === '--no-smoke') {
      opts.smoke = false
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }

  return opts
}

if (isMain(import.meta.url)) {
  try {
    await stageAcpBundle(parseArgs(process.argv.slice(2)))
  } catch (error) {
    console.error(`[stage-acp-bundle] ${error instanceof Error ? error.message : error}`)
    console.error('[stage-acp-bundle] the app cannot ship without its ACP CLI: nothing staged')
    process.exit(1)
  }
}
