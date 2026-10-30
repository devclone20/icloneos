/**
 * REL-6 test fixture: a fake npm registry served from memory. It builds real gzip'd ustar tarballs and a pin
 * (package.json + package-lock.json) whose rows point at them with their true sha512, so the installer runs its real
 * download → integrity → extract → manifest path with no network at all.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import { ADDONS_FILE, blobName } from '../../src/iclone-shared/acp-native'
import { ACP_CLI_NAME, registryUrl } from '../../src/iclone-shared/acp-pin'

import type { InstallRecord } from './record'

export interface FixtureFile {
  data: string | Buffer
  mode?: number
}

function header(name: string, size: number, mode: number, type = '0'): Buffer {
  const block = Buffer.alloc(512)

  block.write(name.slice(0, 100), 0, 'utf8')
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii')
  block.write('0000000\0', 108, 'ascii')
  block.write('0000000\0', 116, 'ascii')
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  block.write('00000000000\0', 136, 'ascii')
  block.write('        ', 148, 'ascii')
  block.write(type, 156, 'ascii')
  block.write('ustar\0', 257, 'ascii')
  block.write('00', 263, 'ascii')

  let sum = 0

  for (const byte of block) {
    sum += byte
  }

  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')

  return block
}

/** A tarball with `package/<path>` entries (a symlink entry when `link` is given). */
export function makeTgz(files: Record<string, FixtureFile>, extra: Buffer[] = []): Buffer {
  const parts: Buffer[] = []

  for (const [rel, file] of Object.entries(files)) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data)

    parts.push(header(`package/${rel}`, data.length, file.mode ?? 0o644), data)
    parts.push(Buffer.alloc((512 - (data.length % 512)) % 512))
  }

  parts.push(...extra, Buffer.alloc(1024))

  return gzipSync(Buffer.concat(parts))
}

export function rawEntry(name: string, data: string, type = '0'): Buffer {
  const body = Buffer.from(data)

  return Buffer.concat([header(name, body.length, 0o644, type), body, Buffer.alloc((512 - (body.length % 512)) % 512)])
}

const sri = (data: Buffer) => `sha512-${createHash('sha512').update(data).digest('base64')}`

export interface FixturePackage {
  name: string
  version: string
  files: Record<string, FixtureFile>
  deps?: string[]
  license?: string
  os?: string[]
  cpu?: string[]
  optional?: boolean
  /** Lockfile key, when not `node_modules/<name>`. */
  key?: string
}

/** The default tree: the CLI (with every platform's signer), one dependency, one other-platform optional. */
export function defaultPackages(cliVersion = '1.0.38'): FixturePackage[] {
  return [
    {
      name: ACP_CLI_NAME,
      version: cliVersion,
      license: 'ISC',
      deps: ['dep-a', 'native-linux'],
      files: {
        'package.json': { data: JSON.stringify({ name: ACP_CLI_NAME, version: cliVersion }) },
        'SKILL.md': { data: '# skill' },
        'README.md': { data: '# readme (the CLI keeps its root files)' },
        'dist/bin/acp.js': { data: 'console.log("acp")' },
        'dist/bin/acp.js.map': { data: '{}' },
        'bin/acp-cli-signer-macos': { data: 'macho', mode: 0o644 },
        'bin/acp-cli-signer-linux': { data: 'elf', mode: 0o755 },
        'bin/acp-cli-signer-windows.exe': { data: 'pe' }
      }
    },
    {
      name: 'dep-a',
      version: '2.0.0',
      license: 'MIT',
      files: {
        'package.json': { data: '{"name":"dep-a"}' },
        'index.js': { data: 'module.exports = 1' },
        LICENSE: { data: 'MIT License — dep-a' },
        'README.md': { data: 'readme' },
        'test/a.test.js': { data: 'x' },
        'prebuilds/darwin-arm64/a.node': { data: 'node-darwin' },
        'prebuilds/linux-x64/a.node': { data: 'node-linux' }
      }
    },
    {
      name: 'native-linux',
      version: '1.0.0',
      license: 'MIT',
      optional: true,
      os: ['linux'],
      cpu: ['x64'],
      files: { 'package.json': { data: '{}' }, 'x.node': { data: 'linux only' } }
    }
  ]
}

export interface FixtureRegistry {
  pinDir: string
  launcher: string
  tarballs: Map<string, Buffer>
  lockText: string
}

/** Write the pin into `dir` and return the tarballs by URL. `tamper` swaps a tarball after its sha512 was taken. */
export function writeFixturePin(
  dir: string,
  packages = defaultPackages(),
  tamper?: (url: string, tgz: Buffer) => Buffer
): FixtureRegistry {
  const tarballs = new Map<string, Buffer>()
  const cli = packages.find(pkg => pkg.name === ACP_CLI_NAME) as FixturePackage

  const lockPackages: Record<string, unknown> = {
    '': { name: 'stage', version: '0.0.0', dependencies: { [ACP_CLI_NAME]: cli.version } }
  }

  for (const pkg of packages) {
    const tgz = makeTgz(pkg.files)
    const url = registryUrl(pkg.name, pkg.version)

    tarballs.set(url, tamper ? tamper(url, tgz) : tgz)
    lockPackages[pkg.key ?? `node_modules/${pkg.name}`] = {
      version: pkg.version,
      resolved: url,
      integrity: sri(tgz),
      ...(pkg.license ? { license: pkg.license } : {}),
      ...(pkg.optional ? { optional: true } : {}),
      ...(pkg.os ? { os: pkg.os } : {}),
      ...(pkg.cpu ? { cpu: pkg.cpu } : {}),
      ...(pkg.deps ? { dependencies: Object.fromEntries(pkg.deps.map(name => [name, '*'])) } : {})
    }
  }

  const lockText = JSON.stringify(
    { name: 'stage', lockfileVersion: 3, requires: true, packages: lockPackages },
    null,
    2
  )

  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { [ACP_CLI_NAME]: cli.version } }))
  writeFileSync(path.join(dir, 'package-lock.json'), lockText)
  writeFileSync(path.join(dir, 'launch.cjs'), "'use strict'\n")

  return { pinDir: dir, launcher: path.join(dir, 'launch.cjs'), tarballs, lockText }
}

/** An in-memory sealer (the safeStorage double). */
export const memorySealer = {
  seal: (plain: string) => Buffer.from(plain).toString('base64'),
  unseal: (sealed: string) => Buffer.from(sealed, 'base64').toString()
}

/** The install record in memory (main keeps it in V3-F's protected state: record.ts). */
export function memoryRecord() {
  let record: InstallRecord | null = null

  return {
    read: () => record,
    write: (next: InstallRecord) => {
      record = next
    },
    clear: () => {
      record = null
    }
  }
}

/**
 * Ruling 33: an add-on folder (ADDONS.json + the shipped copies) for `files` installed by `pkg@version`, the copies'
 * bytes being `shipped(file)`. Returns the folder.
 */
export function writeAddonDir(
  dir: string,
  input: {
    target: string
    lockText: string
    addons: { pkg: string; version: string; file: string; npm: Buffer | string; shipped: Buffer | string }[]
    signed?: boolean
  }
): string {
  mkdirSync(path.join(dir, 'licences'), { recursive: true })
  writeFileSync(path.join(dir, 'licences', 'LICENSE'), 'MIT License (fixture)')

  const addons = input.addons.map(addon => {
    const blob = blobName(addon.pkg, addon.version, addon.file)
    const shipped = Buffer.isBuffer(addon.shipped) ? addon.shipped : Buffer.from(addon.shipped)

    writeFileSync(path.join(dir, blob), shipped)

    return {
      file: addon.file,
      package: addon.pkg,
      version: addon.version,
      blob,
      npmSha256: sha256(addon.npm),
      sha256: sha256(shipped),
      licences: ['LICENSE']
    }
  })

  writeFileSync(
    path.join(dir, ADDONS_FILE),
    JSON.stringify({
      v: 1,
      target: input.target,
      lockSha256: sha256(input.lockText),
      signed: input.signed ?? false,
      team: input.signed ? 'TEAMID0000' : null,
      addons,
      notices: [{ file: 'licences/LICENSE', sha256: sha256('MIT License (fixture)') }]
    })
  )

  return dir
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
