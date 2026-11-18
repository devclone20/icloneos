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

const MH_MAGIC_64 = 0xfeedfacf
const LC_SEGMENT_64 = 0x19
const LINKEDIT_PAGE = 0x4000
/** The most a Developer ID signature has been measured to grow __LINKEDIT.vmsize past its canonical value (2 pages). */
const LINKEDIT_SIGNATURE_GROWTH = 0x8000n

/**
 * `codesign --remove-signature` drops the signature and shrinks __LINKEDIT's filesize, but leaves its vmsize as the
 * signing left it: a Developer ID signature is larger than the linker's ad-hoc one, so after a Team signature and a strip
 * the one header field __LINKEDIT.vmsize reads 0x8000 where the linker-signed build read 0x4000 (measured on the
 * v0.0.7 release, 2026-11-12: one byte differs, every code byte equal). This puts that one field back to its canonical
 * value, filesize rounded up to the 16 KiB arm64 page, so a stripped Team-signed copy and the stripped pinned build hash
 * alike. Nothing else is touched: any other byte that differs still differs. Refuses anything that is not one thin
 * little-endian Mach-O 64 with exactly one __LINKEDIT, and a vmsize that is not a page multiple between the canonical
 * value and two pages more (L6.2).
 */
export function canonicalLinkedit(buffer) {
  const bytes = Buffer.from(buffer)

  if (bytes.length < 32 || bytes.readUInt32LE(0) !== MH_MAGIC_64) {
    throw new Error('[build-iclone-fsevents] not a thin little-endian Mach-O 64')
  }

  const ncmds = bytes.readUInt32LE(16)
  const sizeofcmds = bytes.readUInt32LE(20)
  let offset = 32
  let found = 0

  if (32 + sizeofcmds > bytes.length) {
    throw new Error('[build-iclone-fsevents] load commands run past the file')
  }

  for (let index = 0; index < ncmds; index += 1) {
    if (offset + 8 > 32 + sizeofcmds) {
      throw new Error('[build-iclone-fsevents] a load command runs past sizeofcmds')
    }

    const cmd = bytes.readUInt32LE(offset)
    const cmdsize = bytes.readUInt32LE(offset + 4)

    if (cmdsize < 8 || offset + cmdsize > 32 + sizeofcmds) {
      throw new Error('[build-iclone-fsevents] a load command has a bad size')
    }

    if (cmd === LC_SEGMENT_64 && cmdsize >= 72) {
      const name = bytes.subarray(offset + 8, offset + 24).toString('latin1').replace(/\0+$/, '')

      if (name === '__LINKEDIT') {
        const filesize = bytes.readBigUInt64LE(offset + 48)
        const vmsize = bytes.readBigUInt64LE(offset + 32)
        const page = BigInt(LINKEDIT_PAGE)
        const canonical = ((filesize + page - 1n) / page) * page

        // L6.2: only what a signature can have grown it to, so the pin still states this header, not "any vmsize".
        if (vmsize % page !== 0n || vmsize < canonical || vmsize > canonical + LINKEDIT_SIGNATURE_GROWTH) {
          throw new Error(
            `[build-iclone-fsevents] __LINKEDIT vmsize 0x${vmsize.toString(16)} is not what a signature grows 0x${canonical.toString(16)} to`
          )
        }

        bytes.writeBigUInt64LE(canonical, offset + 32)
        found += 1
      }
    }

    offset += cmdsize
  }

  if (found !== 1) {
    throw new Error(`[build-iclone-fsevents] expected one __LINKEDIT segment, found ${found}`)
  }

  return bytes
}

/**
 * sha256 of `file` with its code signature removed (a copy is stripped; the file itself is untouched) and its
 * __LINKEDIT vmsize made canonical (canonicalLinkedit): the same value for the linker-signed build and for any
 * Team-signed copy of it.
 */
export function unsignedSha256(file) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-fsev-pin-'))

  try {
    const copy = path.join(dir, 'addon.node')

    copyFileSync(file, copy)
    run('/usr/bin/codesign', ['--remove-signature', copy])

    return sha256(canonicalLinkedit(readFileSync(copy)))
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
