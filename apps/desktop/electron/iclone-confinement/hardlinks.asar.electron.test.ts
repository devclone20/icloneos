/**
 * v0.0.8 FX-ASAR — run the guard INSIDE Electron (ELECTRON_RUN_AS_NODE), where `node:fs` serves every `*.asar` file as
 * an archive: a valid one lstat()s as a directory, a malformed one makes lstat throw "Invalid package" with no errno.
 * The owner's real-app smoke refused every command because the walk could not stat asar parser probes in his project.
 * vitest runs under plain Node, which has no asar support, so only a run in the Electron binary can see this.
 *
 * The code under test is bundled the way the app is (bundle-electron-main.mjs: an ESM main bundle with the worker
 * script beside it), so the guard's full scan runs in the packaged worker, in Electron, as in the owner's app.
 */
import { execFile } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { build, type BuildOptions } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))

/** An asar archive as Electron's parser reads it: a size pickle, then a header pickle holding the JSON index. */
function asar(json: string, body = 'hi', declaredHeaderSize?: number): Buffer {
  const text = Buffer.from(json)
  const padded = Math.ceil(text.length / 4) * 4
  const header = Buffer.alloc(8 + padded)

  header.writeUInt32LE(4 + padded, 0)
  header.writeUInt32LE(text.length, 4)
  text.copy(header, 8)

  const size = Buffer.alloc(8)

  size.writeUInt32LE(4, 0)
  size.writeUInt32LE(declaredHeaderSize ?? header.length, 4)

  return Buffer.concat([size, header, Buffer.from(body)])
}

const VALID = asar('{"files":{"a.txt":{"size":2,"offset":"0"}}}')

/** The parser probes that broke the owner's scan, in kind: each one makes Electron's lstat throw. */
const MALFORMED: Record<string, Buffer> = {
  'hdr_huge.asar': asar('{"files":{}}', '', 0xfffffff0),
  'truncated_json.asar': asar('{"files":{"a.txt":'),
  'empty.asar': Buffer.alloc(0),
  'garbage.asar': Buffer.from('this is not an archive at all')
}

const ENTRY = `
import * as walk from ${JSON.stringify(path.join(here, 'hardlinks-walk.ts'))}
import { createHardlinkGuard, scanTree } from ${JSON.stringify(path.join(here, 'hardlinks.ts'))}
import { admissibleRoot } from ${JSON.stringify(path.join(here, 'index.ts'))}
import { realOrSelf } from ${JSON.stringify(path.join(here, 'profiles.ts'))}

const [root, home, top] = process.argv.slice(2)
const asarFs = process.getBuiltinModule('fs')
const judge = (file) => {
  try {
    return asarFs.lstatSync(file).isDirectory() ? 'directory' : 'file'
  } catch {
    return 'throws'
  }
}
const scanView = (scan) => ({ unscannable: scan.unscannable, linked: scan.linked.map(inode => inode.paths) })

const guard = createHardlinkGuard({ ackFile: top + '/userdata/acks.json', fsEvents: null })
const check = await guard.check(root)
guard.close()

console.log(JSON.stringify({
  electron: process.versions.electron ?? null,
  original: walk.projectFs?.sync === process.getBuiltinModule('original-fs'),
  asarFsSees: { valid: judge(root + '/probe/ok.asar'), malformed: judge(root + '/probe/hdr_huge.asar') },
  check: check.ok ? { ok: true, files: check.files } : { ok: false, kind: check.block.kind, paths: check.block.paths },
  scan: scanView(await scanTree(root)),
  async: scanView(walk.scanOf((await walk.walkTree(root, null)).records)),
  sync: scanView(walk.scanOf(walk.walkTreeSync(root))),
  admissible: admissibleRoot(root, home),
  realOfLinked: realOrSelf(root + '/sub/linked.asar')
}))
process.exit(0)
`

interface ScanView {
  unscannable: string[]
  linked: string[][]
}

interface ElectronReport {
  electron: string | null
  original: boolean
  asarFsSees: { valid: string; malformed: string }
  check: { ok: true; files: number } | { ok: false; kind: string; paths: string[] }
  scan: ScanView
  async: ScanView
  sync: ScanView
  admissible: boolean
  realOfLinked: string
}

const electronBinary = (): string => {
  const binary: unknown = createRequire(import.meta.url)('electron')

  if (typeof binary !== 'string') {
    throw new Error('the electron package did not give a binary path')
  }

  return binary
}

describe('FX-ASAR: the guard in Electron sees *.asar files as files', () => {
  let top: string
  let report: ElectronReport
  let root: string

  beforeAll(async () => {
    top = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fx-asar-electron-')))
    root = path.join(top, 'project')

    const home = path.join(top, 'home')
    const outside = path.join(top, 'outside')
    const bundleDir = path.join(top, 'bundle')

    for (const dir of [root, path.join(root, 'probe'), path.join(root, 'sub'), home, outside, bundleDir, path.join(top, 'userdata')]) {
      mkdirSync(dir, { recursive: true })
    }

    writeFileSync(path.join(root, 'probe', 'ok.asar'), VALID)
    Object.entries(MALFORMED).forEach(([name, bytes]) => writeFileSync(path.join(root, 'probe', name), bytes))
    writeFileSync(path.join(outside, 'linked.asar'), VALID)
    linkSync(path.join(outside, 'linked.asar'), path.join(root, 'sub', 'linked.asar'))

    // The app's own bundle options (an untyped .mjs, read through a specifier the checker does not resolve).
    const script = '../../scripts/bundle-electron-main.mjs'
    const bundler: { bundleOptions?: unknown } = await import(script)

    const options = (bundler.bundleOptions as (o: { logLevel: string }) => Record<string, BuildOptions>)({
      logLevel: 'silent'
    })

    const { entryPoints: _main, outfile: _out, ...main } = options.main
    const { outfile: _worker, ...walkWorker } = options.walkWorker

    await build({
      ...main,
      stdin: { contents: ENTRY, resolveDir: here, loader: 'ts', sourcefile: 'fx-asar-entry.ts' },
      outfile: path.join(bundleDir, 'entry.mjs')
    })
    await build({ ...walkWorker, outfile: path.join(bundleDir, 'hardlinks-walk-worker.cjs') })

    const { stdout } = await promisify(execFile)(
      electronBinary(),
      // --use-mock-keychain after the script: plain-Node argv the entry ignores (it reads argv[2..4]); kept so every
      // Electron launch in the tests names the mock keychain (v0.0.9 owner decision 2), though RUN_AS_NODE starts no Chromium.
      [path.join(bundleDir, 'entry.mjs'), root, home, top, '--use-mock-keychain'],
      {
        env: { ELECTRON_RUN_AS_NODE: '1', HOME: home, TMPDIR: path.join(top, 'userdata'), PATH: '/usr/bin:/bin' },
        timeout: 60_000,
        maxBuffer: 1 << 20
      }
    )

    report = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as ElectronReport
  }, 120_000)

  afterAll(() => {
    rmSync(top, { recursive: true, force: true })
  })

  it('runs in Electron, whose own fs really does intercept the fixture (the test cannot pass vacuously)', () => {
    expect(report.electron).toMatch(/^\d+\./)
    expect(report.asarFsSees).toEqual({ valid: 'directory', malformed: 'throws' })
    expect(report.original).toBe(true)
  })

  it('the guard scans the folder of malformed and valid archives and finds the hard-linked .asar as a link', () => {
    const linked = path.join(root, 'sub', 'linked.asar')

    expect(report.check).toEqual({ ok: false, kind: 'hard-links', paths: [linked] })

    for (const view of [report.scan, report.async, report.sync]) {
      expect(view).toEqual({ unscannable: [], linked: [[linked]] })
    }
  })

  it('root admission and the profiles’ real paths read an .asar file as the file it is', () => {
    expect(report.admissible).toBe(true)
    expect(report.realOfLinked).toBe(path.join(root, 'sub', 'linked.asar'))
  })
})
