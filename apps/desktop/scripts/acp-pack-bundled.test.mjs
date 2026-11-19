// v0.0.9 F1-B — the packed app SHIPS the ACP CLI exactly as built (acp-pack-bundled.mjs), the release signs its native
// code in place and reseals it (sign-acp-bundle.mjs), and osx-sign leaves the tree alone (sign-hook.mjs). Fakes only:
// a fake registry, a fake codesign, temp folders. No network, no keychain, no real signing.
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  defaultPackages,
  writeAddonDir,
  writeFixtureBundle,
  writeFixturePin
} from '../electron/iclone-acp-tools/fixture.ts'
import * as acpTools from '../electron/iclone-acp-tools/build-entry.ts'
import { treeDigest as tsTreeDigest } from '../electron/iclone-acp-tools/manifest.ts'

import { checkAcpBundled, treeDigest } from './acp-pack-bundled.mjs'
import { signAcpBundle, signedPaths } from './sign-acp-bundle.mjs'
import { ensureAcpBundleFor, stagedUpToDate } from './stage-acp-bundle.mjs'
import { acpNativeIgnore, isAcpBundle } from './sign-hook.mjs'

const temps = []

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const sha256 = data => createHash('sha256').update(data).digest('hex')
const TEAM = 'ABCDE12345'
const ADDON = 'node_modules/bufferutil/prebuilds/darwin-arm64/bufferutil.node'
const SIGNER = 'runtime/node_modules/@virtuals-protocol/acp-cli/bin/acp-cli-signer-macos'
const PIN_NOTICES = '# ACP CLI — fixture pin table\n'

/** A packed macOS app: the pin (+ its NOTICES.md), the add-ons and the bundle built from that pin by the real code. */
async function packedApp({ strayNode = false } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'acp-pack-bundled-'))

  temps.push(home)

  // The real closure's only native code is the add-ons the app swaps in; the shared fixture's dep-a darwin prebuild
  // would be a stray unsigned .node (kept only when a test asks for it: the release must refuse it).
  const withoutStray = pkg => {
    if (strayNode || pkg.name !== 'dep-a') {
      return pkg
    }

    const files = { ...pkg.files }

    delete files['prebuilds/darwin-arm64/a.node']

    return { ...pkg, files }
  }

  const packages = [
    ...defaultPackages()
      .map(withoutStray)
      .map(pkg => (pkg.name === '@virtuals-protocol/acp-cli' ? { ...pkg, deps: [...pkg.deps, 'bufferutil'] } : pkg)),
    {
      name: 'bufferutil',
      version: '4.1.0',
      license: 'MIT',
      files: {
        'package.json': { data: '{}' },
        LICENSE: { data: 'MIT bufferutil' },
        'prebuilds/darwin-arm64/bufferutil.node': { data: 'npm bufferutil arm64' }
      }
    }
  ]
  const pin = writeFixturePin(path.join(home, 'pin'), packages)

  writeFileSync(path.join(pin.pinDir, 'NOTICES.md'), PIN_NOTICES)

  const nativeRoot = path.join(home, 'build', 'acp-native')
  const nativeDir = writeAddonDir(path.join(nativeRoot, 'darwin-arm64'), {
    target: 'darwin-arm64',
    lockText: pin.lockText,
    addons: [{ pkg: 'bufferutil', version: '4.1.0', file: ADDON, npm: 'npm bufferutil arm64', shipped: 'app copy' }]
  })
  const staged = path.join(home, 'build', 'acp-tools')

  await writeFixtureBundle(pin, staged, { native: { dir: nativeDir, required: true }, lockNotices: PIN_NOTICES })

  const app = path.join(home, 'iclone os.app')
  const resources = path.join(app, 'Contents', 'Resources')

  mkdirSync(path.join(resources, 'acp-pin'), { recursive: true })
  writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist/>')

  const pinFiles = {
    'package.json': path.join(pin.pinDir, 'package.json'),
    'package-lock.json': path.join(pin.pinDir, 'package-lock.json'),
    'NOTICES.md': path.join(pin.pinDir, 'NOTICES.md'),
    'launch.cjs': pin.launcher
  }

  for (const [name, from] of Object.entries(pinFiles)) {
    cpSync(from, path.join(resources, 'acp-pin', name))
  }

  const pack = () => {
    rmSync(path.join(resources, 'acp-tools'), { recursive: true, force: true })
    rmSync(path.join(resources, 'acp-native'), { recursive: true, force: true })
    cpSync(staged, path.join(resources, 'acp-tools'), { recursive: true })
    cpSync(nativeRoot, path.join(resources, 'acp-native'), { recursive: true })
  }

  pack()

  return { home, app, resources, staged, nativeRoot, nativeDir, pinFiles, pack }
}

/** A codesign double: `--force --sign` appends a signature marker; `-dvv` shows the team only for marked files. */
function fakeCodesign() {
  const calls = []

  const run = (command, args) => {
    calls.push([command, ...args])

    const file = args.at(-1)

    if (args[0] === '--force') {
      appendFileSync(file, `\n[signed ${TEAM}]`)

      return { status: 0, stdout: '', stderr: '' }
    }

    const signed = readFileSync(file, 'utf8').includes(`[signed ${TEAM}]`)

    if (args[0] === '--verify') {
      return { status: signed ? 0 : 1, stdout: '', stderr: '' }
    }

    return { status: 0, stdout: '', stderr: signed ? `TeamIdentifier=${TEAM}\n` : 'Signature=adhoc\n' }
  }

  return { run, calls }
}

describe('the tree digest is one formula: the pack check’s, the app’s (manifest.ts) and the launcher’s', () => {
  it('equal on every entry shape, the app-sourced one included', () => {
    const files = {
      'b.js': { sha256: 'a'.repeat(64), size: 3, mode: 0o644 },
      'a/x.node': { sha256: 'b'.repeat(64), size: 9, mode: 0o644, source: 'app' },
      'bin/s': { sha256: 'c'.repeat(64), size: 1, mode: 0o755 }
    }

    expect(treeDigest(files)).toBe(tsTreeDigest(files))

    const launcher = readFileSync(fileURLToPath(new URL('./acp-launch.cjs', import.meta.url)), 'utf8')

    // The launcher's copy of the line format (it is a plain CJS file run before anything resolves).
    expect(launcher).toContain("`${key}\\0${entry.sha256}\\0${entry.size}\\0${Number(entry.mode).toString(8)}")
  })
})

describe('checkAcpBundled — the pack ships the CLI exactly once, exactly as built', () => {
  it('passes the packed app: pin, manifest, every file, the signer 0755, the listed add-on copy', async () => {
    const w = await packedApp()
    const verdict = checkAcpBundled(w.app, { pinFiles: w.pinFiles })

    expect(verdict.problems).toEqual([])
    expect(verdict.ok).toBe(true)
    expect(verdict.version).toBe('1.0.38')
    expect(verdict.target).toBe('darwin-arm64')
  })

  it('a changed, added or missing file of the tree fails (negative controls)', async () => {
    const w = await packedApp()
    const acpJs = path.join(w.resources, 'acp-tools', 'runtime/node_modules/@virtuals-protocol/acp-cli/dist/bin/acp.js')

    appendFileSync(acpJs, ';evil()')
    expect(checkAcpBundled(w.app, { pinFiles: w.pinFiles }).problems.join('\n')).toMatch(/not the manifest's: .*acp\.js/)

    w.pack()
    writeFileSync(path.join(w.resources, 'acp-tools', 'runtime', 'planted.js'), 'x')
    expect(checkAcpBundled(w.app, { pinFiles: w.pinFiles }).problems.join('\n')).toMatch(/not in the manifest/)

    w.pack()
    rmSync(path.join(w.resources, 'acp-tools', 'NOTICES.md'))
    expect(checkAcpBundled(w.app, { pinFiles: w.pinFiles }).problems.join('\n')).toMatch(/manifest file\(s\) missing/)
  })

  it('no bundle, a pin without its NOTICES.md, or a second copy elsewhere in the pack fail', async () => {
    const w = await packedApp()

    rmSync(path.join(w.resources, 'acp-tools'), { recursive: true })
    expect(checkAcpBundled(w.app, { pinFiles: w.pinFiles }).problems.join('\n')).toMatch(/must ship the ACP CLI/)

    w.pack()
    rmSync(path.join(w.resources, 'acp-pin', 'NOTICES.md'))
    expect(checkAcpBundled(w.app, { pinFiles: w.pinFiles }).problems.join('\n')).toMatch(/acp-pin\/NOTICES\.md is missing/)

    cpSync(w.pinFiles['NOTICES.md'], path.join(w.resources, 'acp-pin', 'NOTICES.md'))
    mkdirSync(path.join(w.resources, 'app.asar.unpacked', 'acp-cli'), { recursive: true })
    expect(checkAcpBundled(w.app, { pinFiles: w.pinFiles }).problems.join('\n')).toMatch(/acp-cli dir\(s\) outside/)
  })

  it('the bundle must carry the add-on list the app ships (ruling 33)', async () => {
    const w = await packedApp()
    const list = path.join(w.resources, 'acp-native', 'darwin-arm64', 'ADDONS.json')

    writeFileSync(list, readFileSync(list, 'utf8').replace('"signed":false', '"signed":true'))
    expect(checkAcpBundled(w.app, { pinFiles: w.pinFiles }).problems.join('\n')).toMatch(/another add-on list/)
  })
})

describe('the release signs the signer and the add-ons in place, reseals, and the pack check sees them signed', () => {
  it('sign-acp-bundle: Developer-ID signs the signer, swaps the Team-signed copy, reseals; --signed passes', async () => {
    const w = await packedApp()
    const codesign = fakeCodesign()

    // sign-acp-native.mjs's part: the add-on copy signed and its list rewritten with the signed bytes.
    const listFile = path.join(w.nativeDir, 'ADDONS.json')
    const list = JSON.parse(readFileSync(listFile, 'utf8'))
    const blob = path.join(w.nativeDir, list.addons[0].blob)

    appendFileSync(blob, `\n[signed ${TEAM}]`)
    list.addons[0].sha256 = sha256(readFileSync(blob))
    writeFileSync(listFile, JSON.stringify({ ...list, signed: true, team: TEAM }))

    const manifest = await signAcpBundle({
      dir: w.staged,
      identity: 'A'.repeat(40),
      keychain: '/k.keychain-db',
      team: TEAM,
      nativeRoot: w.nativeRoot,
      run: codesign.run,
      tools: acpTools
    })

    expect(codesign.calls[0]).toEqual([
      'codesign',
      '--force',
      '--sign',
      'A'.repeat(40),
      '--keychain',
      '/k.keychain-db',
      '--options',
      'runtime',
      '--timestamp',
      path.join(w.staged, ...SIGNER.split('/'))
    ])
    expect(signedPaths(manifest, SIGNER)).toEqual([`runtime/${ADDON}`, SIGNER].sort())

    w.pack()

    const unsignedCheck = checkAcpBundled(w.app, { pinFiles: w.pinFiles })

    expect(unsignedCheck.problems).toEqual([])

    const signed = checkAcpBundled(w.app, { pinFiles: w.pinFiles, signed: true, team: TEAM, run: codesign.run })

    expect(signed.problems).toEqual([])
    expect(signed.signedFiles).toBe(2)
  })

  it('sign-acp-bundle refuses a tree with any other unsigned .node (a stray native file never reaches the notary)', async () => {
    const w = await packedApp({ strayNode: true })
    const codesign = fakeCodesign()
    const listFile = path.join(w.nativeDir, 'ADDONS.json')
    const list = JSON.parse(readFileSync(listFile, 'utf8'))
    const blob = path.join(w.nativeDir, list.addons[0].blob)

    appendFileSync(blob, `\n[signed ${TEAM}]`)
    list.addons[0].sha256 = sha256(readFileSync(blob))
    writeFileSync(listFile, JSON.stringify({ ...list, signed: true, team: TEAM }))

    await expect(
      signAcpBundle({
        dir: w.staged,
        identity: 'A'.repeat(40),
        keychain: '/k.keychain-db',
        team: TEAM,
        nativeRoot: w.nativeRoot,
        run: codesign.run,
        tools: acpTools
      })
    ).rejects.toThrow(/not signed by team ABCDE12345 in the resealed bundle: .*dep-a\/prebuilds\/darwin-arm64\/a\.node/)
  })

  it('--signed fails a pack whose signer is not Team-signed (negative control)', async () => {
    const w = await packedApp()
    const codesign = fakeCodesign()
    const verdict = checkAcpBundled(w.app, { pinFiles: w.pinFiles, signed: true, team: TEAM, run: codesign.run })

    expect(verdict.problems.join('\n')).toMatch(/not signed by team ABCDE12345: acp-tools\/runtime\/.*acp-cli-signer-macos/)
  })

  it('osx-sign leaves the bundled tree alone (its bytes are the manifest’s), and still signs everything else', () => {
    const app = '/R/iclone os.app'
    const ignore = acpNativeIgnore(app, undefined)

    expect(isAcpBundle(app, `${app}/Contents/Resources/acp-tools/${SIGNER}`)).toBe(true)
    expect(ignore(`${app}/Contents/Resources/acp-tools/runtime/${ADDON}`)).toBe(true)
    expect(ignore(`${app}/Contents/Resources/acp-pin/launch.cjs`)).toBe(false)
    expect(ignore(`${app}/Contents/Resources/app.asar.unpacked/node_modules/x.node`)).toBe(false)
  })
})

describe('stage-acp-bundle: the pack’s own target, kept when it still verifies', () => {
  it('another target is staged without a smoke run (its binaries cannot run here); the host’s keeps it', async () => {
    const seen = []
    const stage = options => {
      seen.push(options)

      return { kept: true }
    }

    ensureAcpBundleFor({ platform: 'win32', arch: 'x64', stage, log: () => undefined })
    ensureAcpBundleFor({ platform: process.platform, arch: process.arch, stage, log: () => undefined })
    expect(seen[0]).toMatchObject({ target: { platform: 'win32', arch: 'x64', libc: null }, smoke: false })
    expect(seen[1]).toMatchObject({ target: { platform: process.platform, arch: process.arch }, smoke: true })
  })

  it('a staged tree is kept only while it is this lock’s, target’s and add-on list’s, and verifies', async () => {
    const w = await packedApp()
    const pinLock = readFileSync(w.pinFiles['package-lock.json'], 'utf8')
    const native = { dir: w.nativeDir, required: true }
    const target = { platform: 'darwin', arch: 'arm64', libc: null }
    const lockSha256 = sha256(pinLock)

    expect(await stagedUpToDate(acpTools, w.staged, { lockSha256, target, native })).toBe(true)
    expect(await stagedUpToDate(acpTools, w.staged, { lockSha256: 'f'.repeat(64), target, native })).toBe(false)
    expect(
      await stagedUpToDate(acpTools, w.staged, { lockSha256, target: { ...target, arch: 'x64' }, native })
    ).toBe(false)
    appendFileSync(path.join(w.staged, 'NOTICES.md'), 'edit')
    expect(await stagedUpToDate(acpTools, w.staged, { lockSha256, target, native })).toBe(false)
  })
})
