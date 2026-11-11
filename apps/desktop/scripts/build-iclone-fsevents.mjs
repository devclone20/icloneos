#!/usr/bin/env node
/**
 * build-iclone-fsevents.mjs — v0.0.7 FSEV: compiles the F7 hard-link guard's own FSEvents addon
 * (native/iclone-fsevents/iclone_fsevents.c) into native/iclone-fsevents/build/iclone_fsevents.node, and proves the
 * bytes are the pinned ones.
 *
 *   node scripts/build-iclone-fsevents.mjs            build, then refuse any output whose sha256 is not the pin
 *   node scripts/build-iclone-fsevents.mjs --repin    build, then write the pin (a reviewed change: PIN.json is committed)
 *
 * Nothing is downloaded: Xcode's clang and macOS SDK (xcrun), with N-API headers from the Node install that runs this script and nowhere
 * else (no node-gyp, no header cache, no CFLAGS/SDKROOT/CPATH from the caller's environment). Flags are fixed and the
 * output is reproducible byte for byte (no debug info, no paths embedded), so the pin is also a statement that this
 * source, this compiler and these flags make exactly these bytes.
 *
 * The pin (PIN.json) carries two hashes: `sha256`, the file as built (linker ad-hoc signed), checked when it is staged
 * into dist/ and when the app is packed; and `sha256Unsigned`, the same file with its signature removed, which is what
 * a Team-signed copy inside the released app must hash to once its signature is removed too (release-mac.mjs).
 * macOS only: other platforms build nothing (the guard walks there, as before).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMain } from './utils.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const ADDON_DIR = path.join(projectRoot, 'native', 'iclone-fsevents')
export const ADDON_SOURCE = path.join(ADDON_DIR, 'iclone_fsevents.c')
export const ADDON_OUTPUT = path.join(ADDON_DIR, 'build', 'iclone_fsevents.node')
export const ADDON_PIN = path.join(ADDON_DIR, 'PIN.json')
/** The app's macOS minimum (package.json build.mac.minimumSystemVersion); checked against it below. */
export const MACOS_MINIMUM = '13.0'

const sha256 = data => createHash('sha256').update(data).digest('hex')

/** Only this environment reaches clang: no caller variable can add a header path, a flag or another SDK. */
const CLANG_ENV = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', ZERO_AR_DATE: '1' }

/** The N-API headers of the Node install running this script; refuses anything that resolves outside it. */
export function nodeHeaderDir(execPath = process.execPath) {
  const prefix = path.resolve(path.dirname(execPath), '..')
  const include = path.join(prefix, 'include', 'node')
  const header = path.join(include, 'node_api.h')

  if (!existsSync(header)) {
    throw new Error(`[build-iclone-fsevents] no node_api.h in the local Node install (${include})`)
  }

  const realInclude = realpathSync(include)
  const realPrefix = realpathSync(prefix)
  const realNode = realpathSync(execPath)
  // Homebrew links /opt/homebrew/include/node into the formula's keg, next to the node binary it runs.
  const kegOf = file => path.resolve(path.dirname(file), '..')
  const insideInstall = [realPrefix, kegOf(realNode)].some(root => realInclude.startsWith(`${root}${path.sep}`))

  if (!insideInstall || realpathSync(header) !== path.join(realInclude, 'node_api.h')) {
    throw new Error(`[build-iclone-fsevents] the N-API headers resolve outside the local Node install: ${realInclude}`)
  }

  return realInclude
}

export function clangArgs(includeDir, sdk, output = ADDON_OUTPUT, source = ADDON_SOURCE) {
  return [
    '-isysroot',
    sdk,
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-fvisibility=hidden',
    '-fno-ident',
    `-I${includeDir}`,
    '-undefined',
    'dynamic_lookup',
    '-framework',
    'CoreServices',
    '-bundle',
    '-arch',
    'arm64',
    `-mmacosx-version-min=${MACOS_MINIMUM}`,
    '-o',
    output,
    source
  ]
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: CLANG_ENV })

  if (result.status !== 0) {
    throw new Error(`[build-iclone-fsevents] ${command} ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`)
  }

  return result.stdout.trim()
}

/** sha256 of `file` with its code signature removed (a copy is stripped; the file itself is untouched). */
export function unsignedSha256(file) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-fsev-pin-'))

  try {
    const copy = path.join(dir, 'addon.node')

    copyFileSync(file, copy)
    run('/usr/bin/codesign', ['--remove-signature', copy])

    return sha256(readFileSync(copy))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function readAddonPin(file = ADDON_PIN) {
  const pin = JSON.parse(readFileSync(file, 'utf8'))

  for (const key of ['sha256', 'sha256Unsigned', 'source']) {
    if (!/^[0-9a-f]{64}$/.test(String(pin[key]))) {
      throw new Error(`[build-iclone-fsevents] ${path.basename(file)}: ${key} is not a sha256`)
    }
  }

  return pin
}

/** Throws unless `file` is byte for byte the pinned build. */
export function assertPinnedAddon(file, pin = readAddonPin()) {
  const actual = sha256(readFileSync(file))

  if (actual !== pin.sha256) {
    throw new Error(`[build-iclone-fsevents] ${file} is not the pinned iclone_fsevents.node (sha256 ${actual})`)
  }
}

export function buildIcloneFsevents({ repin = false, platform = process.platform } = {}) {
  if (platform !== 'darwin') {
    return null
  }

  const pkg = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))

  if (pkg.build?.mac?.minimumSystemVersion !== MACOS_MINIMUM) {
    throw new Error('[build-iclone-fsevents] MACOS_MINIMUM is not package.json build.mac.minimumSystemVersion')
  }

  const includeDir = nodeHeaderDir()
  const clang = run('/usr/bin/xcrun', ['--find', 'clang'])
  const sdk = run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'])
  const source = sha256(readFileSync(ADDON_SOURCE))

  mkdirSync(path.dirname(ADDON_OUTPUT), { recursive: true })
  rmSync(ADDON_OUTPUT, { force: true })
  run(clang, clangArgs(includeDir, sdk))

  const built = {
    sha256: sha256(readFileSync(ADDON_OUTPUT)),
    sha256Unsigned: unsignedSha256(ADDON_OUTPUT),
    source,
    compiler: run(clang, ['--version']).split('\n')[0],
    sdk: run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-version']),
    minimumSystemVersion: MACOS_MINIMUM,
    arch: 'arm64'
  }

  if (repin) {
    writeFileSync(ADDON_PIN, `${JSON.stringify(built, null, 2)}\n`)
    console.log(`[build-iclone-fsevents] pinned ${built.sha256}`)

    return ADDON_OUTPUT
  }

  const pin = readAddonPin()

  if (pin.source !== built.source) {
    rmSync(ADDON_OUTPUT, { force: true })
    throw new Error('[build-iclone-fsevents] iclone_fsevents.c changed since PIN.json: review it, then --repin')
  }

  if (pin.sha256 !== built.sha256 || pin.sha256Unsigned !== built.sha256Unsigned) {
    rmSync(ADDON_OUTPUT, { force: true })
    throw new Error(
      `[build-iclone-fsevents] the build is not the pinned bytes (${built.sha256}; pinned ${pin.sha256}, ` +
        `${pin.compiler}; this compiler ${built.compiler})`
    )
  }

  console.log(`[build-iclone-fsevents] built ${path.relative(projectRoot, ADDON_OUTPUT)} = pin ${pin.sha256}`)

  return ADDON_OUTPUT
}

if (isMain(import.meta.url)) {
  buildIcloneFsevents({ repin: process.argv.includes('--repin') })
}
