// sign-hook.mjs — electron-builder `mac.sign` hook: least-privilege entitlements per Mach-O (contract P7 decision 6).
//
// Builder's own optionsForFile gives the inherit plist to EVERY nested file, so spawn-helper, get-windows/main,
// ShipIt, chrome_crashpad_handler and the ACP signer would all carry allow-jit. This wraps it: the app bundle keeps
// the main plist, Electron helper apps and libraries keep the inherit plist (allow-jit only), and every other
// executable is signed with an empty entitlements dict. Signing itself stays @electron/osx-sign's, with builder's
// identity, keychain, hardened runtime and timestamp options untouched.

import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'

export const MH_EXECUTE = 2

/** Purpose strings with a code path (decision 6). Electron's default Info.plist adds Camera; it goes. */
export const PURPOSE_ALLOWED = [
  'NSMicrophoneUsageDescription',
  'NSAudioCaptureUsageDescription',
  'NSAppleEventsUsageDescription',
  'NSScreenCaptureUsageDescription',
  'NSLocalNetworkUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription'
]

export function unjustifiedPurposeKeys(keys) {
  return keys.filter(key => /^NS\w+UsageDescription$/.test(key) && !PURPOSE_ALLOWED.includes(key))
}

/** Removes every purpose string without a code path from the bundle's Info.plist (before it is sealed). */
export function stripPurposeStrings(appPath) {
  const plistPath = join(appPath, 'Contents', 'Info.plist')
  const read = spawnSync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' })

  if (read.status !== 0) {
    throw new Error(`cannot read ${plistPath}`)
  }

  const removed = unjustifiedPurposeKeys(Object.keys(JSON.parse(read.stdout)))

  for (const key of removed) {
    if (spawnSync('plutil', ['-remove', key, plistPath]).status !== 0) {
      throw new Error(`cannot remove ${key} from Info.plist`)
    }
  }

  return removed
}
const MH_MAGIC_64 = 0xfeedfacf
const MH_MAGIC = 0xfeedface
const FAT_MAGIC = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length)
  const n = readSync(fd, buf, 0, length, position)

  return n === length ? buf : null
}

/** Mach-O `filetype` of a thin file or of the first slice of a fat one; null when not Mach-O. */
export function machoFileType(filePath) {
  let fd

  try {
    fd = openSync(filePath, 'r')
    const head = readAt(fd, 0, 24)

    if (!head) {
      return null
    }

    const be = head.readUInt32BE(0)

    if (be === FAT_MAGIC || be === FAT_MAGIC_64) {
      // fat_header (8 bytes), then the first fat_arch[_64]: cputype, cpusubtype, offset (u32 or u64, big-endian).
      const sliceOffset = be === FAT_MAGIC ? head.readUInt32BE(16) : Number(head.readBigUInt64BE(16))
      const slice = readAt(fd, sliceOffset, 16)

      return slice ? thinFileType(slice) : null
    }

    return thinFileType(head)
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

function thinFileType(head) {
  const le = head.readUInt32LE(0)

  return le === MH_MAGIC_64 || le === MH_MAGIC ? head.readUInt32LE(12) : null
}

/** Electron helper bundles live at Contents/Frameworks/<Product> Helper[ (Renderer|GPU|Plugin)].app. */
export function isHelperPath(rel) {
  return /^Contents\/Frameworks\/[^/]+ Helper(?: \([A-Za-z]+\))?\.app(?:\/|$)/.test(rel)
}

/**
 * The entitlements class of one signed path: 'main' | 'inherit' | 'none'. Pure, so the policy is testable
 * without a bundle: `isDirectory` and `fileType` are what the caller measured.
 */
export function entitlementsClass({ appPath, filePath, isDirectory, fileType }) {
  if (filePath === appPath) {
    return 'main'
  }

  const rel = relative(appPath, filePath).split(sep).join('/')

  if (rel.startsWith('Contents/MacOS/')) {
    return 'main'
  }

  if (isHelperPath(rel)) {
    return 'inherit'
  }

  if (isDirectory) {
    // Frameworks and other code bundles are libraries: allow-jit at most.
    return 'inherit'
  }

  return fileType === MH_EXECUTE ? 'none' : 'inherit'
}

export function wrapOptionsForFile(appPath, builderOptionsForFile) {
  return filePath => {
    const base = builderOptionsForFile ? builderOptionsForFile(filePath) : {}
    let isDirectory = false

    try {
      isDirectory = statSync(filePath).isDirectory()
    } catch {
      isDirectory = false
    }

    const cls = entitlementsClass({
      appPath,
      filePath,
      isDirectory,
      fileType: isDirectory ? null : machoFileType(filePath)
    })

    if (cls === 'main' && filePath !== appPath && builderOptionsForFile) {
      // Builder hands the inherit plist to the app's own executable when osx-sign visits it as a file.
      return builderOptionsForFile(appPath)
    }

    // osx-sign turns an array into a temporary plist; [] is an empty dict, i.e. no entitlements.
    return cls === 'none' ? { ...base, entitlements: [] } : base
  }
}

/**
 * REL-6 round 2, ruling 33: the ACP CLI's native add-ons in Resources/acp-native are Team-signed by release:mac BEFORE
 * the pack (sign-acp-native.mjs), and the list the installer checks them against holds those exact bytes. Re-signing
 * them here would change the bytes; so osx-sign leaves them alone (the app's own seal still covers them).
 */
export function isAcpNative(appPath, filePath) {
  const rel = relative(appPath, filePath).split(sep).join('/')

  return rel === 'Contents/Resources/acp-native' || rel.startsWith('Contents/Resources/acp-native/')
}

/**
 * The `ignore` handed to osx-sign: ONE function that skips the add-ons and keeps every rule Builder passed (a function,
 * a RegExp or a string, alone or in an array). Never an array: @electron/osx-sign 1.3.x keeps `ignore` only when it is
 * not one (its option check returns nothing for an array), so an array signs every file, the add-ons included, and the
 * release then fails ruling 33's byte check (2026-10-29, the first Developer ID release run of v0.0.3).
 */
export function acpNativeIgnore(appPath, ignore) {
  const rules = ignore === undefined || ignore === null ? [] : Array.isArray(ignore) ? ignore : [ignore]

  return filePath =>
    isAcpNative(appPath, filePath) ||
    rules.some(rule => (typeof rule === 'function' ? Boolean(rule(filePath)) : filePath.match(rule) !== null))
}

export default async function signHook(opts) {
  const { signAsync } = await import('@electron/osx-sign')
  const appPath = opts.app

  console.log(`[sign-hook] least-privilege entitlements for ${basename(appPath)}`)
  // codesign refuses to seal "resource fork, Finder information, or similar detritus" (file-provider xattrs).
  spawnSync('xattr', ['-cr', appPath], { stdio: 'ignore' })

  const removed = stripPurposeStrings(appPath)

  if (removed.length) {
    console.log(`[sign-hook] removed purpose strings without a code path: ${removed.join(', ')}`)
  }

  return signAsync({
    ...opts,
    // Ad-hoc (`-c.mac.identity=-`, the credential-free P7a shape) needs no keychain lookup at all.
    ...(opts.identity === '-' ? { identityValidation: false } : {}),
    ignore: acpNativeIgnore(appPath, opts.ignore),
    optionsForFile: wrapOptionsForFile(appPath, opts.optionsForFile)
  })
}
