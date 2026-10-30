#!/usr/bin/env node
// acp-pack-absent.mjs — REL-6 (ruling 26): a packed app carries NO ACP CLI. The app installs the CLI at first use
// from the npm registry (electron/iclone-acp-tools/); the bundle ships only the pin (Resources/acp-pin: the committed
// lockfile and our own launcher). This check reads the packed tree, never launches it:
//
//   - no `acp-cli` directory anywhere (the old Resources/acp-cli, a linux acp-cli-linux-*);
//   - no package directory of the CLI's closure that ruling 20 is about: nothing under a `node_modules/@alchemy`
//     path, no `rpc-websockets` package, no `@virtuals-protocol` package;
//   - no Go signer binary: no executable (Mach-O, ELF or PE, by its magic) whose bytes carry the signer's Go module
//     path, whatever its name (a text that only names the module, such as a notices file, is not the binary);
//   - the pin is there and byte-equal to the committed one (acp-cli-lock), with the launcher byte-equal to
//     scripts/acp-launch.cjs.
//
//   node scripts/acp-pack-absent.mjs <app.app | resources dir>
//
// The lockfile NAMES the packages the installer fetches (that is its job); names are counted and reported, never
// package bytes. Exit 0/1, one JSON line.

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, closeSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMain } from './utils.mjs'

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const PIN_DIR = 'acp-pin'
export const PIN_FILES = {
  'package.json': path.join(DESKTOP, 'acp-cli-lock', 'package.json'),
  'package-lock.json': path.join(DESKTOP, 'acp-cli-lock', 'package-lock.json'),
  'launch.cjs': path.join(DESKTOP, 'scripts', 'acp-launch.cjs')
}

// Built by concatenation so this script's own bytes never match the scan.
const SIGNER_MODULE = Buffer.from(['github.com', 'anthropics', 'acp-cli-signer'].join('/'))
const CHUNK = 1 << 20

// Mach-O (thin both endians, fat), ELF, PE: the first bytes of an executable or a library.
const BINARY_MAGIC = [
  Buffer.from('feedfacf', 'hex'),
  Buffer.from('cffaedfe', 'hex'),
  Buffer.from('feedface', 'hex'),
  Buffer.from('cefaedfe', 'hex'),
  Buffer.from('cafebabe', 'hex'),
  Buffer.from('7f454c46', 'hex'),
  Buffer.from('4d5a', 'hex')
]

/** True when the file starts like an executable or a library. */
function isBinary(file) {
  const fd = openSync(file, 'r')
  const head = Buffer.alloc(4)

  try {
    const read = readSync(fd, head, 0, 4, 0)

    return BINARY_MAGIC.some(magic => read >= magic.length && head.subarray(0, magic.length).equals(magic))
  } finally {
    closeSync(fd)
  }
}

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')

/** Resources dir of a macOS bundle, the `resources` dir of a linux/win unpacked tree, or the dir itself. */
export function resourcesOf(target) {
  const mac = path.join(target, 'Contents', 'Resources')

  if (existsSync(mac)) {
    return mac
  }

  const lower = path.join(target, 'resources')

  return existsSync(lower) ? lower : target
}

/** True when `file` holds `needle` anywhere (read in overlapping chunks: large binaries never load whole). */
function fileHolds(file, needle) {
  const fd = openSync(file, 'r')
  const buffer = Buffer.alloc(CHUNK + needle.length)

  try {
    let carry = 0

    for (;;) {
      const read = readSync(fd, buffer, carry, CHUNK, null)

      if (read <= 0) {
        return false
      }

      const filled = carry + read

      if (buffer.subarray(0, filled).includes(needle)) {
        return true
      }

      carry = Math.min(needle.length - 1, filled)
      buffer.copy(buffer, 0, filled - carry, filled)
    }
  } finally {
    closeSync(fd)
  }
}

/** The paths inside an asar archive (its JSON header), `/`-separated, directories with a trailing `/`. */
export function asarPaths(file) {
  const fd = openSync(file, 'r')

  try {
    const head = Buffer.alloc(16)

    readSync(fd, head, 0, 16, 0)

    const length = head.readUInt32LE(12)
    const json = Buffer.alloc(length)

    readSync(fd, json, 0, length, 16)

    const out = []
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const at = prefix ? `${prefix}/${name}` : name

        if (child.files) {
          out.push(`${at}/`)
          walk(child, at)
        } else {
          out.push(at)
        }
      }
    }

    walk(JSON.parse(json.toString('utf8')), '')

    return out
  } finally {
    closeSync(fd)
  }
}

/**
 * Walk the packed tree. `pinRel` is the pin dir relative to the root; its lockfile is the one place the CLI's
 * package names may appear, and only as text.
 */
export function scanPack(root, { pinRel = null } = {}) {
  const counts = {
    files: 0,
    asars: 0,
    acpCliDirs: 0,
    alchemyPaths: 0,
    rpcWebsocketsPaths: 0,
    virtualsPaths: 0,
    signerBinaries: 0
  }
  const hits = []

  const dirHit = at => {
    const name = at.slice(at.lastIndexOf('/') + 1)

    if (name === 'acp-cli' || name.startsWith('acp-cli-linux')) {
      counts.acpCliDirs += 1
      hits.push(at)
    }

    if (/(^|\/)node_modules\/@alchemy$/.test(at)) {
      counts.alchemyPaths += 1
      hits.push(at)
    }

    if (/(^|\/)node_modules\/rpc-websockets$/.test(at)) {
      counts.rpcWebsocketsPaths += 1
      hits.push(at)
    }

    if (/(^|\/)node_modules\/@virtuals-protocol$/.test(at)) {
      counts.virtualsPaths += 1
      hits.push(at)
    }
  }

  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const at = rel ? `${rel}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        dirHit(at)
        walk(full, at)
      } else if (entry.isFile()) {
        counts.files += 1

        if (entry.name.endsWith('.asar')) {
          // Inside the archive: every directory by its header, and the signer's module path anywhere in its bytes.
          counts.asars += 1

          for (const inner of asarPaths(full)) {
            if (inner.endsWith('/')) {
              dirHit(`${at}/${inner.slice(0, -1)}`)
            }
          }

          if (fileHolds(full, SIGNER_MODULE)) {
            counts.signerBinaries += 1
            hits.push(at)
          }
        } else if (lstatSync(full).size > 0 && isBinary(full) && fileHolds(full, SIGNER_MODULE)) {
          counts.signerBinaries += 1
          hits.push(at)
        }
      }
    }
  }

  walk(root, '')

  const pinNames = { alchemy: 0, rpcWebsockets: 0 }

  if (pinRel) {
    const lock = path.join(root, pinRel, 'package-lock.json')

    if (existsSync(lock)) {
      const text = readFileSync(lock, 'utf8')

      pinNames.alchemy = (text.match(/"node_modules\/[^"]*@alchemy\//g) ?? []).length
      pinNames.rpcWebsockets = (text.match(/"node_modules\/[^"]*rpc-websockets"/g) ?? []).length
    }
  }

  return { counts, hits: hits.slice(0, 20), pinNames }
}

/** The verdict on one packed app (or resources dir). */
export function checkAcpAbsent(target, { pinFiles = PIN_FILES } = {}) {
  const resources = resourcesOf(target)
  const problems = []
  const pinDir = path.join(resources, PIN_DIR)

  for (const [name, source] of Object.entries(pinFiles)) {
    const shipped = path.join(pinDir, name)

    if (!existsSync(shipped)) {
      problems.push(`${PIN_DIR}/${name} is missing`)
    } else if (sha256(shipped) !== sha256(source)) {
      problems.push(`${PIN_DIR}/${name} differs from ${path.relative(DESKTOP, source)}`)
    }
  }

  if (existsSync(pinDir)) {
    const extra = readdirSync(pinDir).filter(name => !(name in pinFiles))

    if (extra.length > 0) {
      problems.push(`${PIN_DIR} holds more than the pin: ${extra.join(', ')}`)
    }
  }

  const scan = scanPack(target, { pinRel: path.relative(target, pinDir) })
  const { counts } = scan

  if (counts.acpCliDirs > 0) problems.push(`${counts.acpCliDirs} acp-cli dir(s) in the pack`)
  if (counts.alchemyPaths > 0) problems.push(`${counts.alchemyPaths} node_modules/@alchemy dir(s) in the pack`)
  if (counts.rpcWebsocketsPaths > 0) problems.push(`${counts.rpcWebsocketsPaths} rpc-websockets package(s) in the pack`)
  if (counts.virtualsPaths > 0) problems.push(`${counts.virtualsPaths} @virtuals-protocol package dir(s) in the pack`)
  if (counts.signerBinaries > 0) problems.push(`${counts.signerBinaries} file(s) carry the ACP Go signer`)

  return { ok: problems.length === 0, problems, ...scan }
}

if (isMain(import.meta.url)) {
  const target = process.argv[2]

  if (!target) {
    console.error('usage: node scripts/acp-pack-absent.mjs <app.app | resources dir>')
    process.exit(64)
  }

  const verdict = checkAcpAbsent(path.resolve(target))

  console.log(JSON.stringify(verdict))
  process.exit(verdict.ok ? 0 : 1)
}
