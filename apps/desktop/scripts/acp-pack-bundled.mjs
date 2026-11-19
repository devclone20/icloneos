#!/usr/bin/env node
// acp-pack-bundled.mjs — v0.0.9 (owner decision 17 Nov, replaces ruling 26): a packed app SHIPS the Virtuals ACP CLI,
// exactly once, exactly as built. Reads the packed tree, never launches it:
//
//   - Resources/acp-pin is the committed pin, byte for byte: package.json, package-lock.json, the lock's NOTICES.md
//     (acp-cli-lock/) and our launcher (scripts/acp-launch.cjs) — nothing else;
//   - Resources/acp-tools/MANIFEST.json is a bundle manifest (`origin: "app-bundle"`, no MAC) for THAT lockfile, the
//     pinned CLI version (scripts/acp-cli-version.mjs) and this pack's target; its tree digest adds up;
//   - the tree is EXACTLY the manifest's files (none missing, none extra, no link or other type), each with its sha256,
//     size and mode; NOTICES.md is one of them and opens with the lock's NOTICES.md; the Go signer is there, 0755;
//   - on macOS, every add-on the manifest marks `source: app` is the copy Resources/acp-native/<target>/ADDONS.json
//     lists (the same bytes, ruling 33), and the manifest's `addons` is that list's digest;
//   - `--signed --team <TEAMID>`: the Go signer, every `.node` and any other Mach-O in the tree verify under codesign
//     with that TeamIdentifier (they are notarized with the app);
//   - nowhere else in the pack: no other acp-cli tree, no package of the CLI's closure, no Go signer binary
//     (acp-pack-absent.mjs's scan, with the bundled tree as its one exception).
//
//   node scripts/acp-pack-bundled.mjs <app.app | unpacked dir> [--signed --team <TEAMID>]
//
// Exit 0/1, one JSON line. The manifest digest below is electron/iclone-acp-tools/manifest.ts `treeDigest` byte for
// byte (as scripts/acp-launch.cjs's is); acp-pack-bundled.test.mjs proves the three agree.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ACP_CLI_VERSION } from './acp-cli-version.mjs'
import { PIN_DIR, resourcesOf, scanPack } from './acp-pack-absent.mjs'
import { machoFileType } from './sign-hook.mjs'
import { isMain } from './utils.mjs'

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const BUNDLE_DIR = 'acp-tools'
export const BUNDLE_ORIGIN = 'app-bundle'
export const MANIFEST_FILE = 'MANIFEST.json'
export const NOTICES_FILE = 'NOTICES.md'
export const CLI_DIR = 'runtime/node_modules/@virtuals-protocol/acp-cli'
const SIGNER_FOR = { darwin: 'acp-cli-signer-macos', win32: 'acp-cli-signer-windows.exe' }

/** The pin as v0.0.9 ships it in Resources/acp-pin: the lock project, its NOTICES.md, our launcher. */
export const PIN_FILES = {
  'package.json': path.join(DESKTOP, 'acp-cli-lock', 'package.json'),
  'package-lock.json': path.join(DESKTOP, 'acp-cli-lock', 'package-lock.json'),
  'NOTICES.md': path.join(DESKTOP, 'acp-cli-lock', 'NOTICES.md'),
  'launch.cjs': path.join(DESKTOP, 'scripts', 'acp-launch.cjs')
}

const sha256 = data => createHash('sha256').update(data).digest('hex')

/** electron/iclone-acp-tools/manifest.ts `treeDigest`, byte for byte. */
export function treeDigest(files) {
  const hash = createHash('sha256')

  for (const key of Object.keys(files).sort()) {
    const entry = files[key]

    hash.update(
      `${key}\0${entry.sha256}\0${entry.size}\0${entry.mode.toString(8)}${entry.source ? `\0${entry.source}` : ''}\n`
    )
  }

  return hash.digest('hex')
}

export function signerFor(platform) {
  return SIGNER_FOR[platform] ?? 'acp-cli-signer-linux'
}

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })

  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Every file under `dir` (relative, `/`-separated); links and other types are reported, never followed. */
function walk(dir, rel = '', out = { files: [], odd: [] }) {
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const at = rel ? `${rel}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      walk(dir, at, out)
    } else if (entry.isFile()) {
      out.files.push(at)
    } else {
      out.odd.push(at)
    }
  }

  return out
}

/** The bundled tree against its own manifest and the pin it ships with. Pure reads; `problems` lists every finding. */
export function checkBundleTree(bundle, { lockText, platform, expectVersion = ACP_CLI_VERSION, lockNotices = null }) {
  const problems = []
  let manifest = null

  try {
    manifest = JSON.parse(readFileSync(path.join(bundle, MANIFEST_FILE), 'utf8'))
  } catch {
    problems.push(`${BUNDLE_DIR}/${MANIFEST_FILE} is missing or not JSON`)

    return { problems, manifest: null }
  }

  if (!manifest || manifest.origin !== BUNDLE_ORIGIN || 'mac' in manifest || manifest.v !== 1) {
    problems.push(`${BUNDLE_DIR}/${MANIFEST_FILE} is not a bundle manifest (origin ${manifest?.origin})`)

    return { problems, manifest: null }
  }

  if (!manifest.files || typeof manifest.files !== 'object' || treeDigest(manifest.files) !== manifest.treeSha256) {
    problems.push('the manifest’s tree digest does not add up')

    return { problems, manifest: null }
  }

  if (lockText !== null && manifest.lockSha256 !== sha256(lockText)) {
    problems.push('the bundle was built from another lockfile than the pin the app ships')
  }

  if (manifest.cliVersion !== expectVersion) {
    problems.push(`the bundle carries ${manifest.cliVersion}, the pin is ${expectVersion}`)
  }

  if (!String(manifest.target).startsWith(`${platform}-`)) {
    problems.push(`the bundle is for ${manifest.target}, this pack is ${platform}`)
  }

  const { files, odd } = walk(bundle)
  const listed = new Set(Object.keys(manifest.files))
  const onDisk = new Set(files.filter(rel => rel !== MANIFEST_FILE))

  for (const rel of odd) {
    problems.push(`not a plain file in the bundle: ${rel}`)
  }

  const extra = [...onDisk].filter(rel => !listed.has(rel))
  const missing = [...listed].filter(rel => !onDisk.has(rel))

  if (extra.length > 0) problems.push(`${extra.length} file(s) not in the manifest, e.g. ${extra[0]}`)
  if (missing.length > 0) problems.push(`${missing.length} manifest file(s) missing, e.g. ${missing[0]}`)

  let changed = 0

  for (const rel of [...listed].filter(name => onDisk.has(name))) {
    const entry = manifest.files[rel]
    const file = path.join(bundle, ...rel.split('/'))
    const data = readFileSync(file)
    const mode = lstatSync(file).mode & 0o777

    if (data.length !== entry.size || sha256(data) !== entry.sha256 || mode !== entry.mode) {
      changed += 1

      if (changed === 1) problems.push(`a file is not the manifest's: ${rel}`)
    }
  }

  if (changed > 1) problems.push(`${changed} files differ from the manifest in all`)

  const signer = `${CLI_DIR}/bin/${signerFor(platform)}`

  if (!manifest.files[signer]) {
    problems.push(`the Go signer ${signer} is not in the bundle`)
  } else if (manifest.files[signer].mode !== 0o755) {
    problems.push('the Go signer is not executable (0755)')
  }

  if (!manifest.files[`${CLI_DIR}/dist/bin/acp.js`]) {
    problems.push('the CLI entry dist/bin/acp.js is not in the bundle')
  }

  if (!manifest.files[NOTICES_FILE]) {
    problems.push(`${NOTICES_FILE} is not in the bundle`)
  } else if (lockNotices !== null && onDisk.has(NOTICES_FILE)) {
    const text = readFileSync(path.join(bundle, NOTICES_FILE), 'utf8')

    if (!text.includes(lockNotices.trimEnd())) {
      problems.push(`the bundle's ${NOTICES_FILE} does not carry acp-cli-lock/NOTICES.md`)
    }
  }

  return { problems, manifest, signer, files: listed.size }
}

/** The packed app (or an unpacked linux/win tree): the pin, the bundled tree, its add-ons, its signatures, no other copy. */
export function checkAcpBundled(
  target,
  { pinFiles = PIN_FILES, signed = false, team = null, run = defaultRun, platform = null } = {}
) {
  const resources = resourcesOf(target)
  const isMac = existsSync(path.join(target, 'Contents', 'Info.plist'))
  const os = platform ?? (isMac ? 'darwin' : process.platform)
  const problems = []
  const pinDir = path.join(resources, PIN_DIR)

  for (const [name, source] of Object.entries(pinFiles)) {
    const shipped = path.join(pinDir, name)

    if (!existsSync(shipped)) {
      problems.push(`${PIN_DIR}/${name} is missing`)
    } else if (sha256(readFileSync(shipped)) !== sha256(readFileSync(source))) {
      problems.push(`${PIN_DIR}/${name} differs from ${path.relative(DESKTOP, source)}`)
    }
  }

  if (existsSync(pinDir)) {
    const extra = readdirSync(pinDir).filter(name => !(name in pinFiles))

    if (extra.length > 0) {
      problems.push(`${PIN_DIR} holds more than the pin: ${extra.join(', ')}`)
    }
  }

  const bundle = path.join(resources, BUNDLE_DIR)
  const lockFile = path.join(pinDir, 'package-lock.json')
  const noticesFile = path.join(pinDir, 'NOTICES.md')
  let tree = { problems: [], manifest: null, files: 0 }

  if (!existsSync(bundle)) {
    problems.push(`no Resources/${BUNDLE_DIR}: the app must ship the ACP CLI (v0.0.9)`)
  } else {
    tree = checkBundleTree(bundle, {
      lockText: existsSync(lockFile) ? readFileSync(lockFile, 'utf8') : null,
      lockNotices: existsSync(noticesFile) ? readFileSync(noticesFile, 'utf8') : null,
      platform: os
    })
    problems.push(...tree.problems)
  }

  // Ruling 33: on macOS the add-ons the bundle marks as the app's are the listed (Team-signed) copies.
  if (tree.manifest && os === 'darwin') {
    const listFile = path.join(resources, 'acp-native', tree.manifest.target, 'ADDONS.json')

    try {
      const listBytes = readFileSync(listFile)
      const list = JSON.parse(listBytes.toString('utf8'))
      const appFiles = Object.entries(tree.manifest.files).filter(([, entry]) => entry.source === 'app')

      if (tree.manifest.addons !== sha256(listBytes)) {
        problems.push('the bundle was built with another add-on list than Resources/acp-native ships')
      }

      if (appFiles.length !== list.addons.length) {
        problems.push(`the bundle marks ${appFiles.length} add-on(s) as the app's, the list names ${list.addons.length}`)
      }

      for (const addon of list.addons) {
        if (tree.manifest.files[`runtime/${addon.file}`]?.sha256 !== addon.sha256) {
          problems.push(`the bundled ${addon.file} is not the listed copy of ${addon.package}@${addon.version}`)
        }
      }
    } catch {
      problems.push(`Resources/acp-native/${tree.manifest?.target}/ADDONS.json is missing or malformed`)
    }
  }

  // Release: the native code of the tree carries the Developer ID (and is notarized with the app).
  let signedFiles = 0

  if (signed && tree.manifest) {
    for (const rel of Object.keys(tree.manifest.files).sort()) {
      const file = path.join(bundle, ...rel.split('/'))

      if (rel !== tree.signer && !rel.endsWith('.node') && machoFileType(file) === null) {
        continue
      }

      signedFiles += 1

      const shown = run('codesign', ['-dvv', file])

      if (
        run('codesign', ['--verify', '--strict', file]).status !== 0 ||
        !new RegExp(`^TeamIdentifier=${team}$`, 'm').test(`${shown.stdout}\n${shown.stderr}`)
      ) {
        problems.push(`not signed by team ${team}: ${BUNDLE_DIR}/${rel}`)
      }
    }
  }

  const scan = scanPack(target, {
    pinRel: path.relative(target, pinDir),
    skipRel: path.relative(target, bundle).split(path.sep).join('/')
  })
  const { counts } = scan

  if (counts.acpCliDirs > 0) problems.push(`${counts.acpCliDirs} acp-cli dir(s) outside Resources/${BUNDLE_DIR}`)
  if (counts.alchemyPaths > 0) problems.push(`${counts.alchemyPaths} node_modules/@alchemy dir(s) outside the bundle`)
  if (counts.rpcWebsocketsPaths > 0) problems.push(`${counts.rpcWebsocketsPaths} rpc-websockets outside the bundle`)
  if (counts.virtualsPaths > 0) problems.push(`${counts.virtualsPaths} @virtuals-protocol dir(s) outside the bundle`)
  if (counts.signerBinaries > 0) problems.push(`${counts.signerBinaries} Go signer binary(ies) outside the bundle`)

  return {
    ok: problems.length === 0,
    problems,
    version: tree.manifest?.cliVersion ?? null,
    target: tree.manifest?.target ?? null,
    treeSha256: tree.manifest?.treeSha256 ?? null,
    files: tree.files ?? 0,
    signedFiles,
    counts,
    hits: scan.hits
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const teamAt = args.indexOf('--team')
  const team = teamAt >= 0 ? (args[teamAt + 1] ?? null) : null
  const target = args.find((arg, index) => !arg.startsWith('--') && !(teamAt >= 0 && index === teamAt + 1))

  if (!target) {
    console.error('usage: node scripts/acp-pack-bundled.mjs <app.app | unpacked dir> [--signed --team <TEAMID>]')
    process.exit(64)
  }

  const signed = args.includes('--signed')

  if (signed && !/^[A-Z0-9]{10}$/.test(team ?? '')) {
    console.error('--signed needs --team <TEAMID>')
    process.exit(64)
  }

  const verdict = checkAcpBundled(path.resolve(target), { signed, team })

  console.log(JSON.stringify(verdict))
  process.exit(verdict.ok ? 0 : 1)
}
