#!/usr/bin/env node
/**
 * sign-acp-bundle.mjs — v0.0.9: `release:mac` Developer-ID signs the native code inside the bundled ACP CLI tree.
 *
 *   node scripts/sign-acp-bundle.mjs --identity <sha1> --keychain <path> --team <TEAMID> [--dir build/acp-tools]
 *
 * Runs inside release:mac's signing window, AFTER sign-acp-native.mjs Team-signed build/acp-native/<target> and BEFORE
 * electron-builder packs the app (the same shape as ruling 33's add-ons, for the same reason: osx-sign must not re-sign
 * these files, sign-hook.mjs ignores Resources/acp-tools, or their bytes would stop matching the manifest):
 *   1. the Go signer `runtime/node_modules/@virtuals-protocol/acp-cli/bin/acp-cli-signer-macos` is signed with the
 *      Developer ID (hardened runtime, secure timestamp, no entitlements — sign-hook's class `none` for an executable),
 *      verified (`codesign --verify --strict`) and its TeamIdentifier checked;
 *   2. the Team-signed add-on copies replace the unsigned ones in the tree, and the manifest is RESEALED
 *      (materialise.ts `resealBundle`): only the signer and those add-ons may change, every other byte is re-proven;
 *   3. the signer, every `.node` and any other Mach-O in the resealed tree must show TeamIdentifier = --team.
 * Notarization then covers them with the app (they are Mach-O inside the submitted bundle).
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { DESKTOP_ROOT, importAcpTools } from './lib/import-ts.mjs'
import { machoFileType } from './sign-hook.mjs'
import { nativeFor, NATIVE_ROOT, parseTarget } from './stage-acp-bundle.mjs'
import { isMain } from './utils.mjs'

export const DEFAULT_DIR = path.join(DESKTOP_ROOT, 'build', 'acp-tools')

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })

  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export function parseArgs(argv) {
  const opts = { identity: null, keychain: null, team: null, dir: DEFAULT_DIR }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[(i += 1)] ?? null

    if (arg === '--identity') {
      opts.identity = next()
    } else if (arg === '--keychain') {
      opts.keychain = next()
    } else if (arg === '--team') {
      opts.team = next()
    } else if (arg === '--dir') {
      opts.dir = path.resolve(next() ?? '')
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }

  if (!/^[0-9A-F]{40}$/.test(opts.identity ?? '')) {
    throw new Error('--identity <40-hex SHA-1 of the Developer ID Application identity> is required')
  }

  if (!opts.keychain) {
    throw new Error('--keychain <path> is required')
  }

  if (!/^[A-Z0-9]{10}$/.test(opts.team ?? '')) {
    throw new Error('--team <TEAMID> is required')
  }

  return opts
}

/** TeamIdentifier = `team` per `codesign -dvv`. */
export function teamSigned(run, file, team) {
  if (run('codesign', ['--verify', '--strict', file]).status !== 0) {
    return false
  }

  const shown = run('codesign', ['-dvv', file])

  return new RegExp(`^TeamIdentifier=${team}$`, 'm').test(`${shown.stdout}\n${shown.stderr}`)
}

/**
 * The tree paths that must carry the Developer ID signature: the Go signer, every native add-on, and ANY other file of
 * the tree that is Mach-O by its header (notarization refuses an unsigned one; none is expected, and one found fails
 * the release here instead of at the notary).
 */
export function signedPaths(manifest, signerRel, dir = null, fileType = machoFileType) {
  return Object.keys(manifest.files)
    .filter(
      rel =>
        rel === signerRel ||
        rel.endsWith('.node') ||
        (dir !== null && fileType(path.join(dir, ...rel.split('/'))) !== null)
    )
    .sort()
}

export async function signAcpBundle({
  dir = DEFAULT_DIR,
  identity,
  keychain,
  team,
  nativeRoot = NATIVE_ROOT,
  run = defaultRun,
  log = () => undefined,
  tools
}) {
  const acp = tools ?? (await importAcpTools())
  const read = acp.readBundleManifest(dir)

  if (!read.ok) {
    throw new Error(`${dir}: no bundle manifest (${read.reason}) — run npm run build first`)
  }

  const target = parseTarget(read.manifest.target)

  if (target.platform !== 'darwin') {
    throw new Error(`the staged bundle is for ${read.manifest.target}; only a macOS bundle is Developer-ID signed`)
  }

  const signerRel = acp.signerPath(target.platform)
  const signer = path.join(dir, ...signerRel.split('/'))

  const sign = run('codesign', [
    '--force',
    '--sign',
    identity,
    '--keychain',
    keychain,
    '--options',
    'runtime',
    '--timestamp',
    signer
  ])

  if (sign.status !== 0) {
    throw new Error(`codesign failed for ${signerRel} (exit ${sign.status})`)
  }

  if (!teamSigned(run, signer, team)) {
    throw new Error(`${signerRel} does not verify as signed by team ${team}`)
  }

  log(`[sign-acp-bundle] ${signerRel} signed (${team})`)

  const manifest = await acp.resealBundle({
    dir,
    native: nativeFor(target, read.manifest.target, nativeRoot),
    target,
    log
  })

  const mustSign = signedPaths(manifest, signerRel, dir)
  const unsigned = mustSign.filter(rel => !teamSigned(run, path.join(dir, ...rel.split('/')), team))

  if (unsigned.length > 0) {
    throw new Error(`not signed by team ${team} in the resealed bundle: ${unsigned.join(', ')}`)
  }

  log(
    `[sign-acp-bundle] ok — ${mustSign.length} signed file(s), tree ${manifest.treeSha256.slice(0, 12)}`
  )

  return manifest
}

if (isMain(import.meta.url)) {
  try {
    if (process.platform !== 'darwin') {
      throw new Error('sign-acp-bundle only runs on macOS')
    }

    await signAcpBundle({ ...parseArgs(process.argv.slice(2)), log: line => console.log(line) })
  } catch (error) {
    console.error(`[sign-acp-bundle] ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}
