// The build-time bundle of the pinned runtime: a fake download (never the network), a codeload-shaped fixture.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'vitest'

import { assertRuntimeBundle } from './before-pack.mjs'
import {
  BUNDLE_MANIFEST,
  bundleRepoRuntime,
  verifyPackedRuntime,
  fetchRuntimePin,
  readPin,
  tarballName,
  tarballUrl,
  verifyRuntimeBundle
} from './fetch-runtime-pin.mjs'
import { buildRuntimeArtifact, RUNTIME_MANIFEST_FILE } from './runtime-artifact.mjs'
import { runtimeRepo } from './runtime-artifact.test-helpers.mjs'

const SHA = 'c'.repeat(40)

// K-RT4: every call names a temp cacheDir. Without one, fetchRuntimePin falls back to the REAL per-user cache
// (~/Library/Caches/iclone-os/hermes-runtime), and a test that downloads the fixture tarball would write into it.
async function pinFetch(opts) {
  assert.ok(
    typeof opts.cacheDir === 'string' && path.resolve(opts.cacheDir).startsWith(path.resolve(os.tmpdir())),
    'a test never touches the real user cache: pass the fixture cacheDir (K-RT4)'
  )

  return fetchRuntimePin(opts)
}
const hash = data => createHash('sha256').update(data).digest('hex')

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-pin-test-'))
  const tree = path.join(root, `hermes-agent-${SHA}`)
  const script = '#!/bin/sh\necho pinned installer\n'
  fs.mkdirSync(path.join(tree, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(tree, 'pyproject.toml'), '[project]\nname = "hermes-agent"\n')
  fs.writeFileSync(path.join(tree, 'scripts', 'install.sh'), script)
  const archive = path.join(root, 'codeload.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', root, `hermes-agent-${SHA}`])
  const pin = { sha: SHA, tarballSha256: hash(fs.readFileSync(archive)), installShSha256: hash(script) }
  const urls = []
  const download = async (url, dest) => {
    urls.push(url)
    fs.copyFileSync(archive, dest)
  }

  return {
    root,
    archive,
    pin,
    urls,
    download,
    out: path.join(root, 'build', 'hermes-runtime'),
    cache: path.join(root, 'cache')
  }
}

describe('fetch-runtime-pin', () => {
  test('fetches once, verifies tarball and install.sh, then stays offline', async () => {
    const f = fixture()

    try {
      const first = await pinFetch({ pin: f.pin, cacheDir: f.cache, outDir: f.out, download: f.download })
      assert.equal(first.downloaded, true)
      assert.deepEqual(f.urls, [tarballUrl(SHA)])
      assert.deepEqual(fs.readdirSync(f.out).sort(), [BUNDLE_MANIFEST, tarballName(SHA), 'install.sh'].sort())
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(f.out, BUNDLE_MANIFEST), 'utf8')).tarball_sha256,
        f.pin.tarballSha256
      )
      assert.deepEqual(await verifyRuntimeBundle(f.out, f.pin), [])

      const again = await pinFetch({
        pin: f.pin,
        cacheDir: f.cache,
        outDir: f.out,
        download: f.download,
        offline: true
      })
      assert.equal(again.downloaded, false)
      assert.equal(f.urls.length, 1, 'a present bundle is never downloaded again')
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('refuses bytes that are not the pin and leaves nothing behind', async () => {
    const f = fixture()

    try {
      const wrong = { ...f.pin, tarballSha256: 'e'.repeat(64) }
      await assert.rejects(
        pinFetch({ pin: wrong, cacheDir: f.cache, outDir: f.out, download: f.download }),
        /failed its sha256 check/
      )
      assert.deepEqual(fs.readdirSync(f.out), [])

      const badScript = { ...f.pin, installShSha256: 'd'.repeat(64) }
      await assert.rejects(
        pinFetch({ pin: badScript, cacheDir: path.join(f.root, 'cache-bad'), outDir: f.out, download: f.download }),
        /install\.sh .* pinned sha256/
      )

      await assert.rejects(
        pinFetch({ pin: f.pin, cacheDir: f.cache, outDir: path.join(f.root, 'empty'), offline: true }),
        /--offline/
      )
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('a corrupt or stale bundle is replaced by the pinned bytes', async () => {
    const f = fixture()

    try {
      fs.mkdirSync(f.out, { recursive: true })
      fs.writeFileSync(path.join(f.out, tarballName(SHA)), 'corrupt')
      fs.writeFileSync(path.join(f.out, tarballName('a'.repeat(40))), 'old pin')
      assert.equal((await verifyRuntimeBundle(f.out, f.pin)).length, 3)

      await pinFetch({ pin: f.pin, cacheDir: f.cache, outDir: f.out, download: f.download })
      assert.equal(f.urls.length, 1)
      assert.deepEqual(await verifyRuntimeBundle(f.out, f.pin), [])
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('a verified user-cache copy replaces the network; a download seeds the cache; a corrupt copy is ignored', async () => {
    const f = fixture()

    try {
      const first = await pinFetch({ pin: f.pin, cacheDir: f.cache, outDir: f.out, download: f.download })
      assert.equal(first.downloaded, true)
      assert.equal(hash(fs.readFileSync(path.join(f.cache, tarballName(SHA)))), f.pin.tarballSha256, 'cache seeded')

      // A fresh clone (empty outDir) with the cache: no network at all.
      const clone = path.join(f.root, 'clone', 'hermes-runtime')
      const second = await pinFetch({ pin: f.pin, cacheDir: f.cache, outDir: clone, download: f.download })
      assert.equal(second.downloaded, false)
      assert.equal(second.fromCache, true)
      assert.equal(f.urls.length, 1, 'the cache copy is used instead of the network')
      assert.deepEqual(await verifyRuntimeBundle(clone, f.pin), [])

      // A corrupt cache copy is never used: the network is asked and the copy is replaced.
      fs.writeFileSync(path.join(f.cache, tarballName(SHA)), 'garbage')
      const third = await pinFetch({
        pin: f.pin,
        cacheDir: f.cache,
        outDir: path.join(f.root, 'c3'),
        download: f.download
      })
      assert.equal(third.downloaded, true)
      assert.equal(f.urls.length, 2)
      assert.equal(hash(fs.readFileSync(path.join(f.cache, tarballName(SHA)))), f.pin.tarballSha256, 'cache repaired')
    } finally {
      fs.rmSync(f.root, { force: true, recursive: true })
    }
  })

  test('readPin takes the real RUNTIME_PIN.json and refuses a malformed one', () => {
    const real = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'iclone', 'RUNTIME_PIN.json'), 'utf8')
    assert.match(readPin(real).sha, /^[0-9a-f]{40}$/)
    assert.throws(() => readPin('{"sha":"main"}'), /RUNTIME_PIN\.json needs/)
  })

  test('before-pack refuses to pack without the verified bundle', async () => {
    const f = fixture()
    const pinText = JSON.stringify({
      sha: SHA,
      tarball_sha256: f.pin.tarballSha256,
      install_sh_sha256: f.pin.installShSha256
    })

    try {
      await assert.rejects(
        assertRuntimeBundle({ dir: f.out, pinText }),
        /not bundled \(missing hermes-agent-c+\.tar\.gz/
      )
      await pinFetch({ pin: f.pin, cacheDir: f.cache, outDir: f.out, download: f.download })
      // RT-5: a verified upstream tarball is still not this repository's runtime: the pack is refused.
      await assert.rejects(
        assertRuntimeBundle({ dir: f.out, pinText }),
        /is not this repository \(RT-5\): the pinned runtime is not built from this repository \(source upstream/
      )
      fs.appendFileSync(path.join(f.out, tarballName(SHA)), 'x')
      await assert.rejects(assertRuntimeBundle({ dir: f.out, pinText }), /does not match the pinned sha256/)
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true })
    }
  })
})

describe('a source "repo" pin (V3-RT RT-2)', () => {
  function repoPin() {
    const repo = runtimeRepo()
    const artifact = buildRuntimeArtifact({ cwd: repo.dir, rev: repo.sha })
    const pinJson = {
      sha: repo.sha,
      date: artifact.date,
      source: 'repo',
      tarball_sha256: artifact.tarballSha256,
      tarball_bytes: artifact.tarball.length,
      install_sh_sha256: artifact.installShSha256,
      manifest_sha256: artifact.manifestSha256,
      files: artifact.files,
      bytes: artifact.bytes,
      min_app: '1.1.0',
      verified: 'amber:3-roots'
    }

    return { artifact, pin: readPin(JSON.stringify(pinJson)), pinJson, repo }
  }

  test('is built from git objects, offline, and the bundle verifies (tarball, installer, manifest)', async () => {
    const { artifact, pin, repo } = repoPin()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-bundle-'))
    const download = () => {
      throw new Error('a repo pin never downloads')
    }

    const result = await pinFetch({ pin, outDir: out, cacheDir: path.join(out, 'cache'), download, repo: repo.dir })

    assert.equal(result.built, true)
    assert.deepEqual(
      fs.readdirSync(out).sort(),
      [BUNDLE_MANIFEST, RUNTIME_MANIFEST_FILE, 'install.sh', tarballName(repo.sha)].sort()
    )
    assert.equal(hash(fs.readFileSync(path.join(out, tarballName(repo.sha)))), artifact.tarballSha256)
    assert.deepEqual(await verifyRuntimeBundle(out, pin), [])
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, BUNDLE_MANIFEST), 'utf8')).source, 'repo')

    fs.appendFileSync(path.join(out, RUNTIME_MANIFEST_FILE), ' ')
    assert.deepEqual(await verifyRuntimeBundle(out, pin), [
      `${RUNTIME_MANIFEST_FILE} does not match the pinned manifest_sha256`
    ])
  })

  test('the packed folder must hold exactly the bundle, its manifest included (the live RT-4 pack had dropped it)', async () => {
    const { pin, repo } = repoPin()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-packed-'))
    bundleRepoRuntime({ pin, outDir: out, repo: repo.dir })

    assert.deepEqual(await verifyPackedRuntime(out, pin), [])

    fs.rmSync(path.join(out, RUNTIME_MANIFEST_FILE))
    assert.deepEqual(await verifyPackedRuntime(out, pin), [`missing ${RUNTIME_MANIFEST_FILE}`])

    bundleRepoRuntime({ pin, outDir: out, repo: repo.dir })
    fs.writeFileSync(path.join(out, 'stray.txt'), 'x')
    assert.deepEqual(await verifyPackedRuntime(out, pin), ['unexpected stray.txt'])
  })

  test('both mac and linux packs carry RUNTIME_MANIFEST.json into Resources/hermes-runtime', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'))
    const entries = [pkg.build.mac, pkg.build.linux].flatMap(target =>
      (target.extraResources || []).filter(entry => entry.from === 'build/hermes-runtime')
    )

    assert.equal(entries.length, 2)
    assert.ok(entries.every(entry => entry.filter.includes(RUNTIME_MANIFEST_FILE)))
  })

  test('a pin whose values are not what the commit builds is refused and nothing is written', () => {
    const { pin, repo } = repoPin()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-bundle-'))

    for (const wrong of [
      { ...pin, manifestSha256: 'f'.repeat(64) },
      { ...pin, tarballSha256: 'e'.repeat(64) },
      { ...pin, files: pin.files + 1 }
    ]) {
      assert.throws(() => bundleRepoRuntime({ pin: wrong, outDir: out, repo: repo.dir }), /is not the pinned one/)
    }

    assert.deepEqual(fs.readdirSync(out), [])
  })

  test('a pin compressed by another zlib build is refused by name before any sha comparison (K-RT10)', () => {
    const { pin, repo } = repoPin()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-bundle-'))

    assert.throws(
      () => bundleRepoRuntime({ pin: { ...pin, gzip: 'zlib 0.0.0 level 9' }, outDir: out, repo: repo.dir }),
      /compressed by zlib 0\.0\.0 level 9; this Node has zlib .* level 9/
    )
    assert.deepEqual(fs.readdirSync(out), [])
  })

  test('a pin compiled by another CPython build is refused by name (critic r1 m5)', () => {
    const { pin, repo } = repoPin()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-bundle-'))
    const other = { build: ['main', 'x'], executable_sha256: '0'.repeat(64), version: '3.14.7 (other build)' }

    assert.throws(
      () => bundleRepoRuntime({ pin: { ...pin, pythonBuild: other }, outDir: out, repo: repo.dir }),
      /compiled by CPython 3\.14\.7 \(other build\) \(interpreter sha256 000000000000\); this build has .*build with the CPython the pin names/
    )
    assert.deepEqual(fs.readdirSync(out), [])
  })

  test('readPin refuses a repo pin without its manifest values', () => {
    const { pinJson } = repoPin()

    assert.throws(
      () => readPin(JSON.stringify({ ...pinJson, manifest_sha256: undefined })),
      /source "repo" pin needs manifest_sha256/
    )
    assert.equal(readPin(JSON.stringify({ ...pinJson, source: undefined })).source, 'upstream')
  })
})
