// v0.0.9 F1-B — BUILD time: the bundled tree is materialised with the checks the v0.0.3–v0.0.8 installer ran (registry
// tarballs only, sha512 per package, no install scripts, the runtime closure for the target), and a release reseals it
// after signing with nothing else allowed to change. Fake registry (fixture.ts): no network.
import { appendFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ACP_CLI_NAME } from '../../src/iclone-shared/acp-pin'

import { BUNDLE_ORIGIN, readBundleManifest } from './bundle'
import { AcpToolsError } from './errors'
import { defaultPackages, type FixturePackage, makeTgz, writeAddonDir, writeFixtureBundle, writeFixturePin } from './fixture'
import { MANIFEST_FILE, sha256Hex, verifyTree } from './manifest'
import { materialiseBundle, resealBundle, signerPath } from './materialise'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function home() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-acp-materialise-'))

  temps.push(dir)

  return dir
}

const MAC = { platform: 'darwin', arch: 'arm64' }
const cli = (out: string, rel: string) => path.join(out, 'runtime', 'node_modules', ...ACP_CLI_NAME.split('/'), rel)

async function failure(run: Promise<unknown>): Promise<AcpToolsError> {
  try {
    await run
  } catch (error) {
    expect(error).toBeInstanceOf(AcpToolsError)

    return error as AcpToolsError
  }

  throw new Error('expected a refusal')
}

describe('materialiseBundle — the pinned closure for the target, checked like the first-use installer was', () => {
  it('only this target’s packages and files; the signer 0755; NOTICES and a bundle manifest the tree verifies against', async () => {
    const h = home()
    const pin = writeFixturePin(path.join(h, 'pin'))
    const out = path.join(h, 'acp-tools')
    const manifest = await writeFixtureBundle(pin, out)

    expect(manifest.cliVersion).toBe('1.0.38')
    expect(manifest.target).toBe('darwin-arm64')
    expect(manifest.lockSha256).toBe(sha256Hex(pin.lockText))
    expect(manifest.packages).toBe(2)
    expect(existsSync(path.join(out, 'runtime', 'node_modules', 'native-linux'))).toBe(false)
    // The per-file prune: other platforms' signers and prebuilds, source maps, test dirs.
    expect(existsSync(cli(out, 'bin/acp-cli-signer-linux'))).toBe(false)
    expect(existsSync(cli(out, 'dist/bin/acp.js.map'))).toBe(false)
    expect(existsSync(path.join(out, 'runtime', 'node_modules', 'dep-a', 'test'))).toBe(false)
    expect(existsSync(path.join(out, 'runtime', 'node_modules', 'dep-a', 'prebuilds', 'linux-x64'))).toBe(false)
    // The CLI keeps its own data (SKILL.md, README) and the signer runs.
    expect(existsSync(cli(out, 'SKILL.md'))).toBe(true)
    expect(lstatSync(cli(out, 'bin/acp-cli-signer-macos')).mode & 0o777).toBe(0o755)
    expect(manifest.files[signerPath('darwin')]?.mode).toBe(0o755)

    const read = readBundleManifest(out)

    expect(read.ok && read.manifest.origin).toBe(BUNDLE_ORIGIN)
    expect(JSON.parse(readFileSync(path.join(out, MANIFEST_FILE), 'utf8'))).not.toHaveProperty('mac')
    expect((await verifyTree(out, manifest)).ok).toBe(true)
  })

  it('a tarball that is not the lockfile’s sha512 is refused and nothing is left behind', async () => {
    const h = home()

    const pin = writeFixturePin(path.join(h, 'pin'), defaultPackages(), (url, tgz) =>
      url.includes('dep-a') ? makeTgz({ 'index.js': { data: 'swapped' } }) : tgz
    )

    const out = path.join(h, 'acp-tools')
    const error = await failure(writeFixtureBundle(pin, out))

    expect(error.reason).toBe('integrity')
    expect(error.subject).toBe('dep-a@2.0.0')
    expect(existsSync(out)).toBe(false)
  })

  it('a package carrying its own node_modules (any case) is refused', async () => {
    const h = home()

    const packages: FixturePackage[] = defaultPackages().map(pkg =>
      pkg.name === 'dep-a'
        ? { ...pkg, files: { ...pkg.files, 'Node_Modules/evil/index.js': { data: 'x' } } }
        : pkg
    )

    expect((await failure(writeFixtureBundle(writeFixturePin(path.join(h, 'pin'), packages), path.join(h, 'o')))).reason).toBe(
      'nested-modules'
    )
  })

  it('ruling 28: a package that names its licence FILE ships only with it', async () => {
    const h = home()

    const packages: FixturePackage[] = defaultPackages().map(pkg =>
      pkg.name === 'dep-a' ? { ...pkg, license: 'SEE LICENSE IN TERMS.txt' } : pkg
    )

    expect((await failure(writeFixtureBundle(writeFixturePin(path.join(h, 'pin'), packages), path.join(h, 'o')))).reason).toBe(
      'licence-file-missing'
    )
  })

  it('never writes into a folder that already holds something', async () => {
    const h = home()
    const out = path.join(h, 'o')
    const pin = writeFixturePin(path.join(h, 'pin'))

    await writeFixtureBundle(pin, out)
    expect((await failure(writeFixtureBundle(pin, out))).reason).toBe('internal')
  })

  it('every fetch is the row’s own registry URL', async () => {
    const h = home()
    const pin = writeFixturePin(path.join(h, 'pin'))
    const urls: string[] = []

    await materialiseBundle({
      pinDir: pin.pinDir,
      outDir: path.join(h, 'o'),
      target: MAC,
      fetch: async url => {
        urls.push(url)

        return pin.tarballs.get(url) as Buffer
      },
      native: { dir: null, required: false },
      log: () => undefined
    })

    expect(urls.length).toBe(2)
    expect(urls.every(url => url.startsWith('https://registry.npmjs.org/'))).toBe(true)
  })
})

describe('ruling 33 at build time, and the release reseal after signing', () => {
  const ADDON = 'node_modules/bufferutil/prebuilds/darwin-x64+arm64/bufferutil.node'
  const NPM_BYTES = 'npm ad-hoc signed addon'

  const packages = (): FixturePackage[] => [
    ...defaultPackages().map(pkg =>
      pkg.name === ACP_CLI_NAME ? { ...pkg, deps: [...(pkg.deps ?? []), 'bufferutil'] } : pkg
    ),
    {
      name: 'bufferutil',
      version: '4.1.0',
      license: 'MIT',
      files: {
        'package.json': { data: '{"name":"bufferutil"}' },
        LICENSE: { data: 'MIT' },
        'prebuilds/darwin-x64+arm64/bufferutil.node': { data: NPM_BYTES }
      }
    }
  ]

  async function built() {
    const h = home()
    const pin = writeFixturePin(path.join(h, 'pin'), packages())

    const nativeDir = writeAddonDir(path.join(h, 'acp-native', 'darwin-arm64'), {
      target: 'darwin-arm64',
      lockText: pin.lockText,
      addons: [{ pkg: 'bufferutil', version: '4.1.0', file: ADDON, npm: NPM_BYTES, shipped: 'unsigned app copy' }]
    })

    const native = { dir: nativeDir, required: true }
    const out = path.join(h, 'acp-tools')
    const manifest = await writeFixtureBundle(pin, out, { native })

    return { h, pin, nativeDir, native, out, manifest }
  }

  it('the app’s add-on copy replaces npm’s before the manifest is written (source app, the list’s digest)', async () => {
    const { out, manifest, nativeDir } = await built()

    expect(readFileSync(path.join(out, 'runtime', ADDON), 'utf8')).toBe('unsigned app copy')
    expect(manifest.files[`runtime/${ADDON}`]).toMatchObject({ source: 'app', sha256: sha256Hex('unsigned app copy') })
    expect(manifest.addons).toBe(sha256Hex(readFileSync(path.join(nativeDir, 'ADDONS.json'))))
  })

  it('reseal: the signed signer and the Team-signed add-ons go in; the tree verifies against the new manifest', async () => {
    const { out, native, nativeDir } = await built()

    // What sign-acp-bundle.mjs's codesign and sign-acp-native.mjs did: new bytes for the signer and for the copy.
    appendFileSync(cli(out, 'bin/acp-cli-signer-macos'), '\n[signature]')

    const list = JSON.parse(readFileSync(path.join(nativeDir, 'ADDONS.json'), 'utf8'))
    const blob = list.addons[0].blob as string

    writeFileSync(path.join(nativeDir, blob), 'TEAM-SIGNED copy')
    list.addons[0].sha256 = sha256Hex('TEAM-SIGNED copy')
    list.signed = true
    list.team = 'TEAMID0000'
    writeFileSync(path.join(nativeDir, 'ADDONS.json'), JSON.stringify(list))

    const resealed = await resealBundle({ dir: out, native, target: MAC, log: () => undefined })

    expect(readFileSync(path.join(out, 'runtime', ADDON), 'utf8')).toBe('TEAM-SIGNED copy')
    expect(resealed.files[`runtime/${ADDON}`]).toMatchObject({ source: 'app', sha256: sha256Hex('TEAM-SIGNED copy') })
    expect(resealed.files[signerPath('darwin')]?.sha256).toBe(
      sha256Hex(readFileSync(cli(out, 'bin/acp-cli-signer-macos')))
    )
    expect(resealed.addons).toBe(sha256Hex(readFileSync(path.join(nativeDir, 'ADDONS.json'))))
    expect((await verifyTree(out, resealed)).ok).toBe(true)
  })

  it('reseal refuses any other changed file (only the signer and the add-ons may change)', async () => {
    const { out, native } = await built()

    appendFileSync(cli(out, 'dist/bin/acp.js'), ';evil()')
    expect((await failure(resealBundle({ dir: out, native, target: MAC, log: () => undefined }))).reason).toBe(
      'file-changed'
    )
  })

  it('reseal refuses an added file, and a Team-signed copy that is not the listed one', async () => {
    const extra = await built()

    writeFileSync(cli(extra.out, 'dist/bin/planted.js'), 'x')
    expect(
      (await failure(resealBundle({ dir: extra.out, native: extra.native, target: MAC, log: () => undefined }))).reason
    ).toBe('new-tree-unverified')

    const wrong = await built()
    const list = JSON.parse(readFileSync(path.join(wrong.nativeDir, 'ADDONS.json'), 'utf8'))

    writeFileSync(path.join(wrong.nativeDir, list.addons[0].blob), 'not the listed bytes')
    expect(
      (await failure(resealBundle({ dir: wrong.out, native: wrong.native, target: MAC, log: () => undefined }))).reason
    ).toBe('addon-swap')
  })
})
