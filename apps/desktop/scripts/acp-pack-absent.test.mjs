import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { renderAcpNotices, readLock, NOTICES_FILE } from './acp-cli-notices.mjs'
import { checkAcpAbsent, PIN_FILES, scanPack } from './acp-pack-absent.mjs'

const temps = []

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const SIGNER_MODULE = ['github.com', 'anthropics', 'acp-cli-signer'].join('/')

/** A packed macOS bundle with only the pin under Resources. */
function bundle() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'iclone-acp-absent-'))
  const app = path.join(root, 'iclone os.app')
  const resources = path.join(app, 'Contents', 'Resources')

  temps.push(root)
  mkdirSync(path.join(resources, 'acp-pin'), { recursive: true })
  mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(path.join(app, 'Contents', 'MacOS', 'iclone os'), 'binary')

  for (const [name, from] of Object.entries(PIN_FILES)) {
    copyFileSync(from, path.join(resources, 'acp-pin', name))
  }

  return { app, resources }
}

describe('checkAcpAbsent — REL-6: the pack carries the pin and no ACP CLI', () => {
  it('passes a bundle that holds only the pin; the pin still names what the installer fetches', () => {
    const { app } = bundle()
    const verdict = checkAcpAbsent(app)

    expect(verdict.problems).toEqual([])
    expect(verdict.counts).toMatchObject({ acpCliDirs: 0, alchemyPaths: 0, rpcWebsocketsPaths: 0, signerBinaries: 0 })
    expect(verdict.pinNames.alchemy).toBeGreaterThan(0)
    expect(verdict.pinNames.rpcWebsockets).toBeGreaterThan(0)
  })

  it.each([
    ['the old Resources/acp-cli tree', 'acp-cli/launch.cjs', 'x', /acp-cli dir/],
    [
      'an @alchemy package anywhere',
      'app.asar.unpacked/node_modules/@alchemy/wallet-api-types/index.js',
      'x',
      /@alchemy/
    ],
    ['rpc-websockets anywhere', 'x/node_modules/rpc-websockets/index.js', 'x', /rpc-websockets/],
    ['a @virtuals-protocol package', 'y/node_modules/@virtuals-protocol/acp-node/index.js', 'x', /@virtuals-protocol/],
    [
      'the Go signer under any name',
      'tools/helper',
      Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from(` ${SIGNER_MODULE} suffix`)]),
      /Go signer/
    ],
    ['an ELF signer', 'x/acp-cli-signer-linux', `\u007fELF ${SIGNER_MODULE}`, /Go signer/]
  ])('refuses %s', (_name, rel, body, problem) => {
    const { app, resources } = bundle()

    mkdirSync(path.dirname(path.join(resources, rel)), { recursive: true })
    writeFileSync(path.join(resources, rel), body)

    const verdict = checkAcpAbsent(app)

    expect(verdict.ok).toBe(false)
    expect(verdict.problems.join('\n')).toMatch(problem)
  })

  it('looks inside app.asar: a CLI package bundled there is refused; the real header shape is read', () => {
    const { app, resources } = bundle()
    const asar = files => {
      const json = Buffer.from(JSON.stringify({ files }))
      const head = Buffer.alloc(16)

      head.writeUInt32LE(4, 0)
      head.writeUInt32LE(json.length + 8, 4)
      head.writeUInt32LE(json.length + 4, 8)
      head.writeUInt32LE(json.length, 12)

      return Buffer.concat([head, json])
    }

    writeFileSync(path.join(resources, 'app.asar'), asar({ dist: { files: { 'main.js': { size: 1, offset: '0' } } } }))
    expect(checkAcpAbsent(app).problems).toEqual([])

    writeFileSync(
      path.join(resources, 'app.asar'),
      asar({ node_modules: { files: { '@alchemy': { files: { 'wallet-api-types': { files: {} } } } } } })
    )
    expect(checkAcpAbsent(app).problems.join('\n')).toMatch(/node_modules\/@alchemy/)
  })

  it('a text that only names the module (a notices file) is not the binary', () => {
    const { app, resources } = bundle()

    writeFileSync(path.join(resources, 'NOTES.md'), `main module ${SIGNER_MODULE}, part of the package`)
    expect(checkAcpAbsent(app).counts.signerBinaries).toBe(0)
  })

  it('finds the signer bytes across the 1 MiB read boundary', () => {
    const { app, resources } = bundle()
    const at = (1 << 20) - 10
    const big = Buffer.alloc((1 << 20) + 100, 0x41)

    Buffer.from('cffaedfe', 'hex').copy(big, 0)

    Buffer.from(SIGNER_MODULE).copy(big, at)
    writeFileSync(path.join(resources, 'big.bin'), big)

    expect(scanPack(app).counts.signerBinaries).toBe(1)
  })

  it('refuses a missing, edited or padded pin', () => {
    const missing = bundle()

    rmSync(path.join(missing.resources, 'acp-pin', 'package-lock.json'))
    expect(checkAcpAbsent(missing.app).problems).toContain('acp-pin/package-lock.json is missing')

    const edited = bundle()
    const launcher = path.join(edited.resources, 'acp-pin', 'launch.cjs')

    writeFileSync(launcher, `${readFileSync(launcher, 'utf8')}\n// edit`)
    expect(checkAcpAbsent(edited.app).problems.join('\n')).toMatch(/launch\.cjs differs/)

    const padded = bundle()

    writeFileSync(path.join(padded.resources, 'acp-pin', 'acp.js'), 'x')
    expect(checkAcpAbsent(padded.app).problems.join('\n')).toMatch(/more than the pin: acp\.js/)
  })
})

describe('acp-cli-lock/NOTICES.md — generated from the lockfile', () => {
  it('is exactly what the committed lockfile says', () => {
    const { packageJson, lock } = readLock()

    expect(readFileSync(NOTICES_FILE, 'utf8')).toBe(renderAcpNotices(packageJson, lock))
  })

  it('names every package that declares no licence, the unlicensed Alchemy package among them', () => {
    const { packageJson, lock } = readLock()
    const text = renderAcpNotices(packageJson, lock)

    expect(text).toMatch(/Declaring no licence \(\d+\): .*`@alchemy\/wallet-api-types@/)
    expect(text).toMatch(/not shipped in the app/)
    // Ruling 28: the Segment packages name a licence FILE; the install requires it (installer.test.ts).
    expect(text).toMatch(
      /Declaring `SEE LICENSE IN <file>` \(4\): `@segment\/facade@3\.4\.10`, `@segment\/isodate@1\.0\.3`/
    )
    // The Go signer is part of the npm package, never iclone os source.
    expect(text).toMatch(/Go signer\n`bin\/acp-cli-signer-<os>` published inside `@virtuals-protocol\/acp-cli` itself/)
  })
})
