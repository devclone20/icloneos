import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'vitest'

import { compileMarkers, scanTree } from './artifact-hygiene.mjs'

import {
  buildCommit,
  DESKTOP_DIR,
  FOLDERS,
  listFiles,
  makeDistribution,
  parseArgs,
  parseSums,
  readDmgStamp,
  versionFolder
} from './make-distribution.mjs'

// Ruling 48: a test never reads the owner's private markers file, whatever the shell exports.
delete process.env.ICLONE_PRIVATE_MARKERS

const REPO = path.resolve(DESKTOP_DIR, '..', '..')
const PIN = JSON.parse(fs.readFileSync(path.join(REPO, 'iclone', 'RUNTIME_PIN.json'), 'utf8'))
const V = '1.1.0'
// The folder carries the owner's three-number form (src/iclone-shared/version.ts): 1.1.0 → v1.1.0.
const FOLDER = 'v1.1.0'
const COMMIT = 'a'.repeat(40)
const temps = []
const sha = data => createHash('sha256').update(data).digest('hex')

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function writeWithSums(dir, files, sumsName) {
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), data)
  }
  const lines = Object.entries(files).map(([name, data]) => `${sha(data)}  ${name}`)
  fs.writeFileSync(path.join(dir, sumsName), lines.join('\n') + '\n')
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-dist-'))
  temps.push(base)
  const runtime = JSON.stringify({ sha: PIN.sha, tarball_sha256: PIN.tarball_sha256, min_app: PIN.min_app }) + '\n'
  writeWithSums(
    path.join(base, 'mac'),
    {
      'iclone-os-mac-arm64.dmg': 'DMG',
      'latest-mac.yml': `version: ${V}\n`,
      'runtime.json': runtime,
      'iclone os.zip': 'ZIP'
    },
    'SHA256SUMS.txt'
  )
  writeWithSums(
    path.join(base, 'web'),
    {
      'BUILD_COMMIT.txt': `${COMMIT}\n`,
      'index.html': '<html></html>',
      'manifest.webmanifest': JSON.stringify({ name: 'icloneOS Web', version: V }),
      'sw.js': 'self',
      'assets/app.js': 'js'
    },
    'SHA256SUMS.txt'
  )
  writeWithSums(
    path.join(base, 'linux', 'iclone-os-linux-x64'),
    {
      [`iclone-os-${V}-linux-amd64.deb`]: 'DEB64',
      [`iclone-os-${V}-linux-x86_64.AppImage`]: 'AI64',
      'latest-linux.yml': `version: ${V}\n`,
      'runtime.json': runtime
    },
    'SHA256SUMS-linux-x64.txt'
  )
  writeWithSums(
    path.join(base, 'linux', 'iclone-os-linux-arm64'),
    {
      [`iclone-os-${V}-linux-arm64.deb`]: 'DEBARM',
      [`iclone-os-${V}-linux-arm64.AppImage`]: 'AIARM',
      'latest-linux-arm64.yml': `version: ${V}\n`,
      'runtime.json': runtime
    },
    'SHA256SUMS-linux-arm64.txt'
  )
  for (const arch of ['x64', 'arm64']) {
    fs.writeFileSync(path.join(base, 'linux', `iclone-os-linux-${arch}`, 'BUILD_COMMIT.txt'), `${COMMIT}\n`)
  }
  const calls = []
  const deps = {
    platform: 'darwin',
    home: base,
    now: () => '2026-10-17T00:00:00.000Z',
    log() {},
    dmgStamp: () => ({ commit: COMMIT, dirty: false }),
    hygiene: () => [],
    privateMarkers: () => ({ tokens: [], ids: [], source: 'given' }),
    run: (cmd, args) => {
      calls.push([cmd, ...args])
      return { status: 0, stdout: '', stderr: '' }
    }
  }
  const opts = {
    version: V,
    dmgDir: path.join(base, 'mac'),
    webDir: path.join(base, 'web'),
    linuxDir: path.join(base, 'linux'),
    out: path.join(base, 'out'),
    commit: COMMIT
  }
  return { base, deps, opts, calls }
}

describe('make-distribution', () => {
  test('parseArgs', () => {
    assert.equal(parseArgs(['1.1.0', '--linux-run', '42', '--replace']).linuxRun, '42')
    assert.throws(() => parseArgs([]), /usage/)
    assert.throws(() => parseArgs(['1.1.0', '--linux', 'a', '--linux-run', '1']), /exclusive/)
    assert.throws(() => parseArgs(['1.1.0', '--publish']), /unknown argument/)
  })

  test('builds exactly the three named folders + MANIFEST.json, every hash true', async () => {
    const { deps, opts, calls } = fixture()
    const { root, manifest } = await makeDistribution(opts, deps)
    assert.deepEqual(fs.readdirSync(root).sort(), ['01-macOS-DMG', '02-Chrome-App', '03-Linux-Ubuntu', 'MANIFEST.json'])
    assert.deepEqual(fs.readdirSync(path.join(root, FOLDERS.mac)).sort(), [
      'README.txt',
      'SHA256SUMS.txt',
      'iclone-os-mac-arm64.dmg',
      'latest-mac.yml',
      'runtime.json'
    ])
    assert.deepEqual(listFiles(path.join(root, FOLDERS.web)), [
      'README.txt',
      'SHA256SUMS.txt',
      'start-gateway.sh',
      'web/BUILD_COMMIT.txt',
      'web/assets/app.js',
      'web/index.html',
      'web/manifest.webmanifest',
      'web/sw.js'
    ])
    assert.equal(fs.readdirSync(path.join(root, FOLDERS.linux)).filter(n => /\.(deb|AppImage)$/.test(n)).length, 4)
    assert.equal(fs.statSync(path.join(root, FOLDERS.web, 'start-gateway.sh')).mode & 0o111, 0o111)
    assert.equal(manifest.app_commit, COMMIT)
    assert.equal(manifest.runtime_pin.sha, PIN.sha)
    for (const a of manifest.artifacts) {
      assert.equal(sha(fs.readFileSync(path.join(root, a.folder, a.file))), a.sha256, a.file)
      assert.equal(fs.statSync(path.join(root, a.folder, a.file)).size, a.bytes)
    }
    for (const folder of Object.values(FOLDERS)) {
      for (const [name, digest] of parseSums(fs.readFileSync(path.join(root, folder, 'SHA256SUMS.txt'), 'utf8'))) {
        assert.equal(sha(fs.readFileSync(path.join(root, folder, name))), digest, `${folder}/${name}`)
      }
    }
    assert.ok(manifest.artifacts.some(a => a.kind === 'deb' && a.arch === 'arm64'))
    assert.ok(calls.some(c => c[0] === '/usr/sbin/spctl' && c.includes('-a') && c.includes('-vv')))
    assert.match(fs.readFileSync(path.join(root, FOLDERS.web, 'README.txt'), 'utf8'), /iT terminals/)
  })

  test('refuses a file whose sha256 does not match its SHA256SUMS', async () => {
    const { base, deps, opts } = fixture()
    fs.writeFileSync(path.join(base, 'linux', 'iclone-os-linux-arm64', `iclone-os-${V}-linux-arm64.deb`), 'TAMPERED')
    await assert.rejects(makeDistribution(opts, deps), /sha256 mismatch for iclone-os-1\.1\.0-linux-arm64\.deb/)
    const second = fixture()
    fs.appendFileSync(path.join(second.base, 'web', 'sw.js'), '// cache /api')
    await assert.rejects(makeDistribution(second.opts, second.deps), /sha256 mismatch for sw\.js/)
    assert.ok(!fs.existsSync(second.opts.out), 'nothing is written when an input is refused')
  })

  test('refuses a DMG Gatekeeper rejects, and refuses to verify off macOS', async () => {
    const { deps, opts } = fixture()
    const rejected = {
      ...deps,
      run: cmd =>
        cmd === '/usr/sbin/spctl'
          ? { status: 3, stdout: '', stderr: 'rejected source=Unnotarized Developer ID' }
          : { status: 0, stdout: '' }
    }
    await assert.rejects(makeDistribution(opts, rejected), /Gatekeeper rejects .*Unnotarized/)
    await assert.rejects(makeDistribution(opts, { ...deps, platform: 'linux' }), /spctl on macOS/)
  })

  test('refuses a version or runtime pin that does not match', async () => {
    const { deps, opts } = fixture()
    await assert.rejects(
      makeDistribution({ ...opts, version: '1.2.0' }, deps),
      /latest-mac\.yml is version 1\.1\.0, not 1\.2\.0/
    )
    const drift = fixture()
    const other = JSON.stringify({ sha: 'b'.repeat(40), tarball_sha256: PIN.tarball_sha256 })
    writeWithSums(path.join(drift.base, 'linux', 'iclone-os-linux-x64'), { 'runtime.json': other }, 'SHA256SUMS-x.txt')
    await assert.rejects(makeDistribution(drift.opts, drift.deps), /two different runtime\.json/)
  })

  test('refuses a web build without BUILD_COMMIT.txt, from another commit, or with a stamp not in its sums', async () => {
    const other = 'c'.repeat(40)
    const missing = fixture()
    const webSums = path.join(missing.base, 'web', 'SHA256SUMS.txt')
    fs.rmSync(path.join(missing.base, 'web', 'BUILD_COMMIT.txt'))
    fs.writeFileSync(webSums, fs.readFileSync(webSums, 'utf8').replace(/^.*BUILD_COMMIT\.txt\n/m, ''))
    await assert.rejects(makeDistribution(missing.opts, missing.deps), /web build has no BUILD_COMMIT\.txt/)

    const foreign = fixture()
    writeWithSums(
      path.join(foreign.base, 'web'),
      {
        'BUILD_COMMIT.txt': `${other}\n`,
        'index.html': '<html></html>',
        'manifest.webmanifest': JSON.stringify({ version: V }),
        'sw.js': 'self'
      },
      'SHA256SUMS.txt'
    )
    fs.rmSync(path.join(foreign.base, 'web', 'assets'), { recursive: true })
    await assert.rejects(
      makeDistribution(foreign.opts, foreign.deps),
      new RegExp(`web build was built from ${other}, the Linux artifacts from ${COMMIT}`)
    )

    const forged = fixture()
    fs.writeFileSync(path.join(forged.base, 'web', 'BUILD_COMMIT.txt'), `${other}\n`)
    await assert.rejects(makeDistribution(forged.opts, forged.deps), /BUILD_COMMIT\.txt/)
    assert.ok(!fs.existsSync(path.join(forged.opts.out, FOLDER)))
  })

  test('--linux-pending: the DMG commit leads, Linux is not required, and it excludes the other Linux inputs', () => {
    const clean = { commit: COMMIT, dirty: false }

    assert.equal(parseArgs(['0.0.1', '--linux-pending']).linuxPending, true)
    assert.throws(() => parseArgs(['0.0.1', '--linux-pending', '--linux-run', '42']), /exclusive/)
    assert.equal(buildCommit({ dmgStamp: clean, linuxPending: true, webCommit: COMMIT }), COMMIT)
    assert.throws(
      () => buildCommit({ dmgStamp: clean, linuxPending: true, webCommit: 'b'.repeat(40) }),
      /web build was built from/
    )
    assert.throws(() => buildCommit({ dmgStamp: clean, webCommit: COMMIT }), /no Linux build commit/)
  })

  test('buildCommit: one commit for the DMG, the Linux CI run and the web build', () => {
    const clean = { commit: COMMIT, dirty: false }
    assert.equal(buildCommit({ dmgStamp: clean, linuxCommit: COMMIT, webCommit: COMMIT }), COMMIT)
    assert.throws(() => buildCommit({ dmgStamp: clean, linuxCommit: COMMIT, webCommit: null }), /no BUILD_COMMIT\.txt/)
    assert.throws(
      () => buildCommit({ dmgStamp: clean, linuxCommit: COMMIT, webCommit: 'dev' }),
      /web build has no BUILD_COMMIT/
    )
    assert.throws(
      () => buildCommit({ dmgStamp: clean, runHeadSha: COMMIT, linuxCommit: COMMIT, webCommit: 'b'.repeat(40) }),
      /web build was built from b{40}/
    )
  })

  test('refuses missing Linux arches and unlisted web files', async () => {
    const { base, deps, opts } = fixture()
    fs.rmSync(path.join(base, 'linux', 'iclone-os-linux-arm64'), { recursive: true })
    await assert.rejects(makeDistribution(opts, deps), /SHA256SUMS-linux-arm64\.txt/)
    const extra = fixture()
    fs.writeFileSync(path.join(extra.base, 'web', 'stray.js'), 'x')
    await assert.rejects(makeDistribution(extra.opts, extra.deps), /not in its SHA256SUMS\.txt: stray\.js/)
  })

  test('the version folder is the three-number form; the README and the manifest say it too', async () => {
    assert.equal(versionFolder('0.0.3'), 'v0.0.3')
    assert.equal(versionFolder('0.0.10'), 'v0.0.10')
    assert.equal(versionFolder('1.2.0-beta.1'), '1.2.0-beta.1')
    const { deps, opts } = fixture()
    await makeDistribution(opts, deps)
    const readme = fs.readFileSync(path.join(opts.out, FOLDER, '01-macOS-DMG', 'README.txt'), 'utf8')
    assert.match(readme, /^iclone os 1\.1\.0 for macOS$/m)
    assert.doesNotMatch(readme, /1\.1\.0\.0/)
    const manifest = JSON.parse(fs.readFileSync(path.join(opts.out, FOLDER, 'MANIFEST.json'), 'utf8'))
    assert.equal(manifest.display, 'v1.1.0')
    assert.equal(manifest.version, '1.1.0')
  })

  test('an existing version folder needs --replace, which removes only that folder', async () => {
    const { deps, opts } = fixture()
    await makeDistribution(opts, deps)
    fs.mkdirSync(path.join(opts.out, '1.0.0'))
    await assert.rejects(makeDistribution(opts, deps), /exists; pass --replace/)
    await makeDistribution({ ...opts, replace: true }, deps)
    assert.ok(fs.existsSync(path.join(opts.out, '1.0.0')))
  })

  test('--linux-run downloads the CI artifacts with gh', async () => {
    const { base, deps, opts } = fixture()
    let downloaded = null
    const run =
      (
        headSha,
        conclusion = 'success',
        workflowName = 'release-linux',
        runPath = '.github/workflows/release-linux.yml'
      ) =>
      (cmd, args) => {
        if (cmd === 'gh' && args[1] === 'view') {
          assert.deepEqual(args.slice(-2), ['--json', 'headSha,conclusion,workflowName'])
          return { status: 0, stdout: JSON.stringify({ conclusion, headSha, workflowName }), stderr: '' }
        }
        if (cmd === 'gh' && args[0] === 'api') {
          assert.deepEqual(args, ['api', 'repos/devclone20/iclone-os/actions/runs/123', '--jq', '.path'])
          return { status: 0, stdout: `${runPath}\n`, stderr: '' }
        }
        if (cmd === 'gh') {
          downloaded = args[args.indexOf('--dir') + 1]
          fs.cpSync(path.join(base, 'linux'), downloaded, { recursive: true })
        }
        return { status: 0, stdout: '', stderr: '' }
      }
    const ci = { ...opts, linuxDir: null, linuxRun: '123' }
    const { manifest } = await makeDistribution(ci, { ...deps, run: run(COMMIT) })
    assert.equal(manifest.artifacts.filter(a => a.platform === 'linux' && a.kind === 'appimage').length, 2)
    assert.equal(manifest.app_commit, COMMIT)
    assert.ok(downloaded && !fs.existsSync(downloaded), 'the gh download temp dir is removed')
    const other = 'b'.repeat(40)
    await assert.rejects(
      makeDistribution({ ...ci, replace: true }, { ...deps, run: run(other) }),
      /the CI run built b{40}/
    )
    await assert.rejects(
      makeDistribution({ ...ci, replace: true }, { ...deps, run: run(COMMIT, 'failure') }),
      /not a successful run/
    )
    await assert.rejects(
      makeDistribution({ ...ci, replace: true }, { ...deps, run: run(COMMIT, 'success', 'ci') }),
      /CI run 123 is ci .*not \.github\/workflows\/release-linux\.yml/
    )
    await assert.rejects(
      makeDistribution(
        { ...ci, replace: true },
        { ...deps, run: run(COMMIT, 'success', 'release-linux', '.github/workflows/other.yml') }
      ),
      /\(\.github\/workflows\/other\.yml\), not \.github\/workflows\/release-linux\.yml/
    )
    assert.ok(!fs.existsSync(downloaded))
  })

  test('artifact hygiene runs on every collected file; a hit leaves no folder and no partial behind', async () => {
    const { deps, opts } = fixture()
    let scannedRoot = null
    const seen = []
    const spy = root => {
      scannedRoot = root
      const walk = dir =>
        fs
          .readdirSync(dir, { withFileTypes: true })
          .forEach(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : seen.push(e.name)))
      walk(root)
      return []
    }
    await makeDistribution(opts, { ...deps, hygiene: spy })
    assert.ok(seen.some(name => name.endsWith('.dmg')) && seen.some(name => name.endsWith('.deb')))
    assert.ok(seen.includes('sw.js') && seen.some(name => name.endsWith('.AppImage')))
    assert.ok(!seen.includes('MANIFEST.json'), 'scanned before MANIFEST.json is written')
    assert.ok(!fs.existsSync(scannedRoot), 'the partial folder was renamed into place')

    const hit = () => [{ file: '02-Chrome-App/assets/index.js', id: 'key.github' }]
    await assert.rejects(
      makeDistribution({ ...opts, replace: true }, { ...deps, hygiene: hit }),
      /artifact hygiene: 1 marker hit\(s\) in the distribution folder[\s\S]*index\.js: key\.github/
    )
    assert.deepEqual(fs.readdirSync(opts.out), [FOLDER], 'the previous folder stays, no partial left')
  })

  test('ruling 48: without the private markers the distribution scan fails closed', async () => {
    const { deps, opts } = fixture()
    const withoutMarkers = { ...deps }

    delete withoutMarkers.privateMarkers
    await assert.rejects(makeDistribution(opts, withoutMarkers), /the release scan fails closed/)
  })

  test('an AppImage passes the scan only as the exact CI-built file; any other squashfs is an opaque hit', async () => {
    const { deps, opts } = fixture()
    let markers = null
    const named = { tokens: [], ids: [], names: [{ kind: 'series', sha256: sha('lark harbor') }], source: 'given' }

    await makeDistribution(opts, {
      ...deps,
      privateMarkers: () => named,
      hygiene: (root, options) => ((markers = options.markers), [])
    })
    // r5e X1: the distribution scan carries the owner names of its private markers to the skill tree.
    assert.ok(markers.ownerNames.series.has(sha('lark harbor')))
    const proved = [...markers.provenance.keys()]
    assert.ok(proved.includes(sha('AI64')) && proved.includes(sha('AIARM')))
    assert.ok(proved.includes(PIN.tarball_sha256))
    assert.equal(proved.length, 3, 'nothing but the two AppImages and the pinned runtime tarball')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdist-appimage-'))
    temps.push(dir)
    const image = Buffer.alloc(256)
    image.writeUInt32BE(0x7f454c46, 0)
    image[4] = 2
    image[5] = 1
    image.write('AI', 8, 'latin1')
    image[10] = 2
    fs.writeFileSync(path.join(dir, 'iclone-os-linux-x86_64.AppImage'), image)
    const lines = []
    const own = compileMarkers({ provenance: [{ label: 'CI-built', sha256: sha(image) }] })
    assert.deepEqual(scanTree(dir, { markers: own, log: line => lines.push(line) }), [])
    assert.match(lines.join('\n'), /allowed by provenance: iclone-os-linux-x86_64\.AppImage = CI-built/)
    assert.deepEqual(scanTree(dir, { markers, log: () => {} }), [
      { file: 'iclone-os-linux-x86_64.AppImage', id: 'scan.opaque-archive (squashfs)' }
    ])
  })

  test('the DMG must be built from the same clean commit as the Linux artifacts', async () => {
    const { deps, opts } = fixture()
    const other = 'c'.repeat(40)
    await assert.rejects(
      makeDistribution(opts, { ...deps, dmgStamp: () => ({ commit: other, dirty: false }) }),
      /DMG was built from c{40}/
    )
    await assert.rejects(
      makeDistribution(opts, { ...deps, dmgStamp: () => ({ commit: COMMIT, dirty: true }) }),
      /no clean build commit/
    )
    await assert.rejects(makeDistribution({ ...opts, commit: other }, deps), /--commit c{40} is not the build commit/)
  })

  test('assembles beside the target and swaps atomically: a failed rebuild keeps the old folder, no partial left', async () => {
    const { base, deps, opts } = fixture()
    await makeDistribution(opts, deps)
    const marker = path.join(opts.out, FOLDER, 'MANIFEST.json')
    const before = fs.readFileSync(marker, 'utf8')
    fs.writeFileSync(path.join(base, 'linux', 'iclone-os-linux-x64', 'latest-linux.yml'), 'TAMPERED')
    await assert.rejects(makeDistribution({ ...opts, replace: true }, deps), /sha256 mismatch/)
    assert.equal(fs.readFileSync(marker, 'utf8'), before)
    assert.deepEqual(fs.readdirSync(opts.out), [FOLDER])
  })

  test('readDmgStamp mounts read-only, reads the app stamp and always detaches', () => {
    const calls = []
    const run = (cmd, args) => {
      calls.push([cmd, args[0]])
      if (args[0] === 'attach') {
        const res = path.join(args[args.indexOf('-mountpoint') + 1], 'iclone os.app', 'Contents', 'Resources')
        fs.mkdirSync(res, { recursive: true })
        fs.writeFileSync(path.join(res, 'install-stamp.json'), JSON.stringify({ commit: COMMIT, dirty: false }))
      }
      return { status: 0, stdout: '', stderr: '' }
    }
    assert.deepEqual(readDmgStamp('/x/iclone-os.dmg', { run }), { commit: COMMIT, dirty: false })
    assert.deepEqual(calls, [
      ['hdiutil', 'attach'],
      ['hdiutil', 'detach']
    ])
    assert.throws(() => readDmgStamp('/x/iclone-os.dmg', { run: () => ({ status: 0, stdout: '' }) }), /no app with/)
  })
})
