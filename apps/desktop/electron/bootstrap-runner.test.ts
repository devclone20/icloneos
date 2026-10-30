import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { test, vi } from 'vitest'

// The repo's scripts/install.sh stands in for install.sh at the runtime pin: the
// pin's sha and tarball hash stay real, only the script hash is the fixture's
// (runtime-pin.test.ts asserts the real generated pin against RUNTIME_PIN.json).
vi.mock('./runtime-pin.generated', async () => {
  const { createHash: hash } = await import('node:crypto')
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const real = JSON.parse(readFileSync(resolve(__dirname, '../../../iclone/RUNTIME_PIN.json'), 'utf8'))
  const script = readFileSync(resolve(__dirname, '../../../scripts/install.sh'))

  return {
    RUNTIME_PIN: {
      sha: real.sha,
      date: real.date,
      tarballSha256: real.tarball_sha256,
      installShSha256: hash('sha256').update(script).digest('hex'),
      minApp: real.min_app,
      verified: real.verified
    }
  }
})

import {
  alignCheckoutToPin,
  appMeetsMinimum,
  buildPinArgs,
  buildPosixPinArgs,
  bundledRuntimeTarballName,
  cachedScriptPath,
  extractTarball,
  hasExistingGitCheckout,
  installedAgentInstallScript,
  installRefForStamp,
  installSourceTarball,
  isPinnedCommit,
  parseRuntimePin,
  readSourceMarker,
  resolveCheckoutHead,
  resolveInstallScript,
  resolveMarkerPinnedCommit,
  runAlignStage,
  runBootstrap,
  runGit,
  runPinnedRuntimeUpdate,
  RUNTIME_BUNDLE_LOG_TAG,
  RUNTIME_PIN_INSTALL_SH_SHA256,
  RUNTIME_PIN_LOG_TAG,
  RUNTIME_PIN_SHA,
  RUNTIME_PIN_TARBALL_SHA256,
  SOURCE_MARKER_FILE,
  sourceTarballUrl,
  UPSTREAM_BASE_SHA
} from './bootstrap-runner'
import type { BootstrapEvent, InstallStamp } from './bootstrap-runner'
import { ICLONE_MANAGED_FILE, readManagedStamp } from './iclone-managed-runtime'
import { readMainProcessSource } from './main/main-process-source'

const SCRIPT_NAME = process.platform === 'win32' ? 'install.ps1' : 'install.sh'
const ZERO_COMMIT = '0000000000000000000000000000000000000000'
const PIN_KEY = `pin-${RUNTIME_PIN_SHA}`
const PINNED_REF = { ref: RUNTIME_PIN_SHA, cacheKey: PIN_KEY, pinned: true }
// The repo's copy of upstream's installer at the import base (byte-identical by construction).
const PINNED_INSTALL_SH = fs.readFileSync(path.resolve(__dirname, '../../../scripts/install.sh'))

// The stage list install.sh prints at the pin (`stage_names`).
const MANIFEST_STAGES = [
  'prerequisites',
  'repository',
  'venv',
  'python-deps',
  'config',
  'products',
  'setup',
  'gateway',
  'complete'
]

const MANIFEST_LINE = JSON.stringify({ protocol_version: 1, stages: MANIFEST_STAGES.map(name => ({ name })) })

function mkTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-bootstrap-test-'))
}

test('runBootstrap bails immediately when the signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort()

  const events: BootstrapEvent[] = []

  const result = await runBootstrap({
    installStamp: null,
    activeRoot: '/tmp/hermes-runner-test',
    sourceRepoRoot: null,
    hermesHome: '/tmp/hermes-runner-test',
    logRoot: '/tmp/hermes-runner-test',
    onEvent: ev => events.push(ev),
    abortSignal: controller.signal
  })

  // Cancelled before any install script is spawned.
  assert.deepEqual(result, { ok: false, cancelled: true })
  assert.ok(
    events.some(ev => ev.type === 'failed' && /cancelled/i.test(ev.error)),
    'should emit a cancelled failure event'
  )
})

test('installedAgentInstallScript resolves the installer in the agent checkout', () => {
  const home = mkTmpHome()

  try {
    assert.equal(installedAgentInstallScript(home), null, 'absent before the checkout exists')

    const scriptsDir = path.join(home, 'hermes-agent', 'scripts')
    fs.mkdirSync(scriptsDir, { recursive: true })
    const scriptPath = path.join(scriptsDir, SCRIPT_NAME)
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho hi\n')

    assert.equal(installedAgentInstallScript(home), scriptPath)
    assert.equal(installedAgentInstallScript(null), null, 'null home -> null')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('existing checkout detection requires git metadata', () => {
  const home = mkTmpHome()

  try {
    const activeRoot = path.join(home, 'hermes-agent')
    assert.equal(hasExistingGitCheckout(activeRoot), false)

    fs.mkdirSync(path.join(activeRoot, '.git'), { recursive: true })
    assert.equal(hasExistingGitCheckout(activeRoot), true)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('fresh bootstrap args pin the upstream import base, never the fork commit or a moving branch', () => {
  const installStamp = { commit: 'a'.repeat(40), branch: 'main' }

  assert.deepEqual(buildPinArgs(installStamp), ['-Branch', 'main'])
  assert.deepEqual(
    buildPosixPinArgs({
      installStamp,
      activeRoot: '/tmp/hermes-agent',
      hermesHome: '/tmp/hermes'
    }),
    ['--dir', '/tmp/hermes-agent', '--hermes-home', '/tmp/hermes', '--branch', 'main', '--commit', RUNTIME_PIN_SHA]
  )
  assert.deepEqual(installRefForStamp(installStamp), PINNED_REF)
})

test('existing-checkout bootstrap args (developer policy) keep branch but skip the packaged commit pin', () => {
  const installStamp = { commit: 'a'.repeat(40), branch: 'main' }

  assert.deepEqual(buildPinArgs(installStamp, { pinCommit: false }), ['-Branch', 'main'])
  assert.deepEqual(
    buildPosixPinArgs({
      installStamp,
      activeRoot: '/tmp/hermes-agent',
      hermesHome: '/tmp/hermes',
      pinCommit: false
    }),
    ['--dir', '/tmp/hermes-agent', '--hermes-home', '/tmp/hermes', '--branch', 'main']
  )
})

test('fallback install stamps are pinned to the import base too, never to the zero commit', () => {
  const stamp = { commit: ZERO_COMMIT, branch: 'main' }

  assert.equal(isPinnedCommit(ZERO_COMMIT), false)
  assert.deepEqual(installRefForStamp(stamp), PINNED_REF)
  // Must NOT pass the all-zero placeholder; the pin is upstream's commit.
  assert.deepEqual(buildPinArgs(stamp), ['-Branch', 'main'])
  assert.deepEqual(
    buildPosixPinArgs({
      installStamp: stamp,
      activeRoot: '/tmp/hermes',
      hermesHome: '/tmp/home'
    }),
    ['--dir', '/tmp/hermes', '--hermes-home', '/tmp/home', '--branch', 'main', '--commit', RUNTIME_PIN_SHA]
  )
})

test('resolveMarkerPinnedCommit prefers real HEAD over fallback stamp zeros', () => {
  const realHead = 'c'.repeat(40)
  assert.equal(
    resolveMarkerPinnedCommit({ commit: ZERO_COMMIT, branch: 'main' }, '/tmp/checkout', {
      resolveHead: () => realHead
    }),
    realHead
  )
  assert.equal(
    resolveMarkerPinnedCommit({ commit: 'd'.repeat(40), branch: 'main' }, '/tmp/checkout', {
      resolveHead: () => realHead
    }),
    'd'.repeat(40),
    'packaged real pin wins over checkout HEAD'
  )
  assert.equal(
    resolveMarkerPinnedCommit({ commit: ZERO_COMMIT, branch: 'main' }, '/tmp/missing', {
      resolveHead: () => null
    }),
    null
  )
})

test('resolveInstallScript downloads the pinned installer and verifies its sha256', async () => {
  const home = mkTmpHome()

  try {
    const logs: BootstrapEvent[] = []
    const refs: string[] = []

    const result = await resolveInstallScript({
      installStamp: { commit: ZERO_COMMIT, branch: 'main' },
      sourceRepoRoot: null,
      hermesHome: home,
      emit: ev => logs.push(ev),
      _download: async (ref, destPath) => {
        refs.push(ref)
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        fs.writeFileSync(destPath, PINNED_INSTALL_SH)

        return destPath
      }
    })

    assert.deepEqual(refs, [RUNTIME_PIN_SHA])
    assert.equal(result.source, 'download')
    assert.equal(result.commit, RUNTIME_PIN_SHA)
    assert.equal(result.path, cachedScriptPath(home, PIN_KEY))

    if (SCRIPT_NAME === 'install.sh') {
      assert.ok(
        logs.some(ev => (ev.line || '').startsWith(`${RUNTIME_PIN_LOG_TAG} install.sh`)),
        'logs the verified pin'
      )
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveInstallScript prefers a cached script without touching the network', async () => {
  const home = mkTmpHome()

  try {
    const commit = 'a'.repeat(40)
    const cached = cachedScriptPath(home, PIN_KEY)
    fs.mkdirSync(path.dirname(cached), { recursive: true })
    fs.writeFileSync(cached, PINNED_INSTALL_SH)

    const logs: BootstrapEvent[] = []

    const result = await resolveInstallScript({
      installStamp: { commit },
      sourceRepoRoot: null,
      hermesHome: home,
      emit: ev => logs.push(ev)
    })

    assert.equal(result.source, 'cache')
    assert.equal(result.path, cached)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveInstallScript falls back to the installed agent checkout on a 404', async () => {
  const home = mkTmpHome()

  try {
    const commit = 'a'.repeat(40)
    // Seed the installed agent checkout so the fallback has something to resolve.
    const scriptsDir = path.join(home, 'hermes-agent', 'scripts')
    fs.mkdirSync(scriptsDir, { recursive: true })
    const installed = path.join(scriptsDir, SCRIPT_NAME)
    fs.writeFileSync(installed, PINNED_INSTALL_SH)

    const logs: BootstrapEvent[] = []

    const result = await resolveInstallScript({
      installStamp: { commit },
      sourceRepoRoot: null,
      hermesHome: home,
      emit: ev => logs.push(ev),
      // Simulate GitHub returning a 404 for the pinned commit.
      _download: async () => {
        throw new Error('Failed to download install.sh: HTTP 404')
      }
    })

    assert.equal(result.source, 'installed-agent')
    // It should have copied the installer into the bootstrap cache.
    assert.equal(result.path, cachedScriptPath(home, PIN_KEY))
    assert.ok(fs.existsSync(result.path), 'fallback script copied into cache')
    assert.ok(
      logs.some(ev => /falling back to installed agent/.test(ev.line || '')),
      'emits a fallback log line'
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveInstallScript rethrows when the 404 fallback is unavailable', async () => {
  const home = mkTmpHome()

  try {
    const commit = 'a'.repeat(40)
    // No installed agent checkout seeded -> nothing to fall back to.
    await assert.rejects(
      resolveInstallScript({
        installStamp: { commit },
        sourceRepoRoot: null,
        hermesHome: home,
        emit: () => {},
        _download: async () => {
          throw new Error('Failed to download install.sh: HTTP 404')
        }
      }),
      /HTTP 404|Failed to download/
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('the source import base is iclone/UPSTREAM_BASE and is not the runtime pin', () => {
  const base = fs.readFileSync(path.resolve(__dirname, '../../../iclone/UPSTREAM_BASE'), 'utf8')
  const sha = base.split('\n').find(line => /^[0-9a-f]{40}\s*$/.test(line))

  assert.equal(sha?.trim(), UPSTREAM_BASE_SHA)
  assert.notEqual(RUNTIME_PIN_SHA, UPSTREAM_BASE_SHA)
  assert.equal(createHash('sha256').update(PINNED_INSTALL_SH).digest('hex'), RUNTIME_PIN_INSTALL_SH_SHA256)
})

test('a tampered pinned installer is refused, never run', async () => {
  if (SCRIPT_NAME !== 'install.sh') {
    return
  }

  const home = mkTmpHome()

  try {
    await assert.rejects(
      resolveInstallScript({
        installStamp: { commit: 'a'.repeat(40) },
        sourceRepoRoot: null,
        hermesHome: home,
        emit: () => {},
        _download: async (_ref, destPath) => {
          fs.mkdirSync(path.dirname(destPath), { recursive: true })
          fs.writeFileSync(destPath, '#!/bin/sh\necho evil\n')
        }
      }),
      /does not match the recorded sha256/
    )
    assert.equal(fs.existsSync(cachedScriptPath(home, PIN_KEY)), false)

    // A cached copy that drifted is discarded and fetched again.
    const cached = cachedScriptPath(home, PIN_KEY)
    fs.writeFileSync(cached, '#!/bin/sh\necho stale\n')

    const result = await resolveInstallScript({
      installStamp: { commit: 'a'.repeat(40) },
      sourceRepoRoot: null,
      hermesHome: home,
      emit: () => {},
      _download: async (_ref, destPath) => fs.writeFileSync(destPath, PINNED_INSTALL_SH)
    })

    assert.equal(result.source, 'download')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('parseRuntimePin accepts only a 40-hex sha and a semver min_app', () => {
  const sha = 'b'.repeat(40)

  assert.deepEqual(parseRuntimePin(`{"sha":"${sha}","min_app":"1.0.0"}`), { sha, minApp: '1.0.0' })
  assert.equal(parseRuntimePin({ sha: 'main', min_app: '1.0.0' }), null)
  assert.equal(parseRuntimePin({ sha: sha.slice(0, 12), min_app: '1.0.0' }), null)
  assert.equal(parseRuntimePin({ sha, min_app: 'latest' }), null)
  assert.equal(parseRuntimePin('not json'), null)
  assert.equal(appMeetsMinimum('1.0.0', '1.0.0'), true)
  assert.equal(appMeetsMinimum('1.2.0', '1.10.0'), false)
  assert.equal(appMeetsMinimum('2.0.0', '1.9.9'), true)
  assert.equal(appMeetsMinimum('0.17.0', '1.0.0'), false)
})

test('runPinnedRuntimeUpdate runs install.sh --commit <pin> and never promises a relaunch', async () => {
  const home = mkTmpHome()
  const sha = 'c'.repeat(40)

  try {
    const calls: { args: string[]; script: string }[] = []
    const downloads: string[] = []

    const agent = path.join(home, 'hermes-agent')
    fs.mkdirSync(path.join(agent, '.git'), { recursive: true })

    const result = await runPinnedRuntimeUpdate({
      activeRoot: agent,
      appVersion: '1.0.0',
      emit: () => {},
      hermesHome: home,
      _fetchPin: async () => ({
        sha,
        minApp: '1.0.0',
        installShSha256: createHash('sha256').update('#!/bin/sh\n').digest('hex')
      }),
      _download: async (ref, dest) => {
        downloads.push(ref)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, '#!/bin/sh\n')
      },
      _spawn: async (script, args) => {
        calls.push({ script, args })

        return { code: 0 }
      }
    })

    assert.deepEqual(downloads, [sha])
    assert.equal(result.ok, true)
    assert.equal(result.manualRestart, true)
    assert.equal(result.message, 'Runtime updated — reopen iclone os')
    const { args } = calls[0]
    assert.deepEqual(args.slice(args.indexOf('--commit')), ['--commit', sha])
    assert.ok(!args.includes('main') || args[args.indexOf('main') - 1] === '--branch')
    assert.ok(!/restart/i.test(result.message))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('runPinnedRuntimeUpdate refuses when the app is older than min_app or the pin is unavailable', async () => {
  const spawnFn = async () => {
    throw new Error('must not run')
  }

  const pending = await runPinnedRuntimeUpdate({
    activeRoot: '/tmp/a',
    appUpdatePending: true,
    appVersion: '1.0.0',
    emit: () => {},
    hermesHome: '/tmp/h',
    _fetchPin: async () => {
      throw new Error('must not fetch while an app update is pending')
    },
    _spawn: spawnFn
  })

  assert.equal(pending.error, 'app-update-pending')

  const old = await runPinnedRuntimeUpdate({
    activeRoot: '/tmp/a',
    appVersion: '1.0.0',
    emit: () => {},
    hermesHome: '/tmp/h',
    _fetchPin: async () => ({ sha: 'd'.repeat(40), minApp: '1.1.0' }),
    _spawn: spawnFn
  })

  assert.equal(old.ok, false)
  assert.equal(old.error, 'app-too-old')

  const offline = await runPinnedRuntimeUpdate({
    activeRoot: '/tmp/a',
    appVersion: '1.0.0',
    emit: () => {},
    hermesHome: '/tmp/h',
    _fetchPin: async () => {
      throw new Error('HTTP 404')
    },
    _spawn: spawnFn
  })

  assert.equal(offline.ok, false)
  assert.equal(offline.error, 'runtime-pin-unavailable')
})

// A codeload-shaped tarball (one `hermes-agent-<sha>/` prefix) built with the system tar.
function makeSourceTarball(dir: string, sha: string, extra: Record<string, string> = {}) {
  const root = path.join(dir, `hermes-agent-${sha}`)
  const files = { 'pyproject.toml': '[project]\n', 'scripts/install.sh': '#!/bin/sh\n', ...extra }

  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), body)
  }

  const archive = path.join(dir, `${sha}.tar.gz`)
  execFileSync('tar', ['-czf', archive, '-C', dir, `hermes-agent-${sha}`])
  fs.rmSync(root, { recursive: true, force: true })

  return { archive, sha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex') }
}

function copyDownload(archive: string, urls: string[] = []) {
  return async (url: string, dest: string) => {
    urls.push(url)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(archive, dest)

    return createHash('sha256').update(fs.readFileSync(dest)).digest('hex')
  }
}

const POSIX_ONLY = process.platform === 'win32' ? test.skip : test

test('the fresh-install source is the codeload tarball of the pinned commit with a recorded sha256', () => {
  assert.equal(
    sourceTarballUrl(RUNTIME_PIN_SHA),
    `https://codeload.github.com/NousResearch/hermes-agent/tar.gz/${RUNTIME_PIN_SHA}`
  )
  assert.match(RUNTIME_PIN_TARBALL_SHA256, /^[0-9a-f]{64}$/)
})

POSIX_ONLY('installSourceTarball verifies, unpacks, marks, and never deletes an unknown tree', async () => {
  const home = mkTmpHome()
  const sha = 'a'.repeat(40)

  try {
    const { archive, sha256 } = makeSourceTarball(home, sha, { 'run_agent.py': 'print(1)\n' })
    const target = path.join(home, 'hermes-agent')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'mine.txt'), 'keep')
    const urls: string[] = []
    const cacheDir = path.join(home, 'bootstrap-cache')

    const first = await installSourceTarball({
      cacheDir,
      emit: () => {},
      sha,
      sha256,
      targetDir: target,
      _download: copyDownload(archive, urls)
    })

    assert.deepEqual(urls, [sourceTarballUrl(sha)])
    assert.equal(first.reused, false)
    assert.equal(fs.readFileSync(path.join(target, 'run_agent.py'), 'utf8'), 'print(1)\n')
    assert.equal(readSourceMarker(target)?.sha, sha)
    const previousDir = first.previousDir

    assert.ok(previousDir)
    assert.equal(fs.readFileSync(path.join(previousDir, 'mine.txt'), 'utf8'), 'keep')
    assert.ok(!fs.existsSync(`${target}.incoming`))
    assert.deepEqual(fs.readdirSync(cacheDir), [])
    assert.ok(!fs.existsSync(path.join(target, '.git')))

    const again = await installSourceTarball({
      cacheDir,
      emit: () => {},
      sha,
      sha256,
      targetDir: target,
      _download: async () => {
        throw new Error('must not download an installed pin')
      }
    })

    assert.equal(again.reused, true)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

POSIX_ONLY(
  'V3-S r3 m-d: the tarball installer stamps the tree it installs; a reused tree of its own gets one, a git tree never',
  async () => {
    const home = mkTmpHome()
    const sha = 'd'.repeat(40)

    try {
      const { archive, sha256 } = makeSourceTarball(home, sha)
      const target = path.join(home, 'hermes-agent')
      const cacheDir = path.join(home, 'bootstrap-cache')

      const install = () =>
        installSourceTarball({
          appVersion: '0.0.0.3',
          cacheDir,
          emit: () => {},
          sha,
          sha256,
          targetDir: target,
          _download: copyDownload(archive)
        })

      await install()
      const first = readManagedStamp(target)

      assert.ok(first)
      assert.equal(first.lockHash, sha256)
      assert.equal(first.runtimeSha, sha)
      assert.equal(first.appVersion, '0.0.0.3')

      // A tree from before the stamp (same pin, reused): this installer stamps it.
      fs.rmSync(path.join(target, ICLONE_MANAGED_FILE))
      assert.equal((await install()).reused, true)
      assert.ok(readManagedStamp(target))

      // A git work tree is never stamped, even with the pin's source marker.
      fs.rmSync(path.join(target, ICLONE_MANAGED_FILE))
      fs.mkdirSync(path.join(target, '.git'))
      assert.equal((await install()).reused, true)
      assert.equal(readManagedStamp(target), null)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
)

POSIX_ONLY(
  'installSourceTarball: a crash right after the tree swap still leaves the tree with its marker',
  async () => {
    const home = mkTmpHome()
    const sha = 'b'.repeat(40)
    const target = path.join(home, 'hermes-agent')
    const realRename = fs.renameSync

    const crash = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      realRename(from, to)

      if (from === `${target}.incoming` && to === target) {
        throw new Error('crash after the swap')
      }
    })

    try {
      const { archive, sha256 } = makeSourceTarball(home, sha)

      await assert.rejects(
        installSourceTarball({
          cacheDir: path.join(home, 'bootstrap-cache'),
          emit: () => {},
          sha,
          sha256,
          targetDir: target,
          _download: copyDownload(archive)
        }),
        /crash after the swap/
      )

      const marker = readSourceMarker(target)
      assert.equal(marker?.sha, sha)
      assert.equal(marker?.sha256, sha256)
      // Same bytes as the old in-place write: 2-space JSON and a trailing newline.
      assert.equal(
        fs.readFileSync(path.join(target, SOURCE_MARKER_FILE), 'utf8'),
        `${JSON.stringify(marker, null, 2)}\n`
      )
    } finally {
      crash.mockRestore()
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
)

POSIX_ONLY('a tarball that fails its sha256 is never unpacked and the target is untouched', async () => {
  const home = mkTmpHome()
  const sha = 'b'.repeat(40)

  try {
    const { archive } = makeSourceTarball(home, sha)
    const target = path.join(home, 'hermes-agent')
    let extracted = false

    await assert.rejects(
      installSourceTarball({
        cacheDir: path.join(home, 'cache'),
        emit: () => {},
        sha,
        sha256: 'f'.repeat(64),
        targetDir: target,
        _download: copyDownload(archive),
        _extract: async () => {
          extracted = true
        }
      }),
      /sha256 check/
    )
    assert.equal(extracted, false)
    assert.ok(!fs.existsSync(target))
    assert.deepEqual(fs.readdirSync(path.join(home, 'cache')), [])
    await assert.rejects(
      installSourceTarball({ cacheDir: home, emit: () => {}, sha: 'main', sha256: 'f'.repeat(64), targetDir: target }),
      /40-hex/
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

POSIX_ONLY('extractTarball refuses members that climb out of the destination', async () => {
  const home = mkTmpHome()

  try {
    const evil = path.join(home, 'evil.tar.gz')
    execFileSync('python3', [
      '-c',
      'import io,sys,tarfile\n' +
        't=tarfile.open(sys.argv[1],"w:gz")\n' +
        'i=tarfile.TarInfo("p/../../escaped.txt");d=b"x";i.size=len(d);t.addfile(i,io.BytesIO(d));t.close()',
      evil
    ])
    const dest = path.join(home, 'a', 'b')
    fs.mkdirSync(dest, { recursive: true })
    await extractTarball(evil, dest).catch(() => {})
    assert.ok(!fs.existsSync(path.join(home, 'escaped.txt')))
    assert.ok(!fs.existsSync(path.join(home, 'a', 'escaped.txt')))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// Found by the V3-RT gate as a flaky "Premature close": tar exits 0 at the end-of-archive blocks while padding after
// them is still being written to its stdin. Megabytes of padding make the early close all but certain (three runs).
POSIX_ONLY(
  'extractTarball accepts an archive whose padding tar never reads; a corrupt archive head still fails',
  async () => {
    const home = mkTmpHome()

    try {
      const src = path.join(home, 'src', 'top')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'a.txt'), 'hi\n')
      const plain = path.join(home, 'padded.tar')
      execFileSync('tar', ['-cf', plain, '-C', path.dirname(src), 'top'])
      fs.appendFileSync(plain, Buffer.alloc(8_000_000))
      const padded = path.join(home, 'padded.tar.gz')
      fs.writeFileSync(padded, zlib.gzipSync(fs.readFileSync(plain)))

      for (let run = 0; run < 3; run++) {
        const dest = path.join(home, `out-${run}`)
        fs.mkdirSync(dest)
        await extractTarball(padded, dest)
        assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'hi\n')
      }

      const corrupt = path.join(home, 'corrupt.tar.gz')
      const bytes = fs.readFileSync(padded)
      fs.writeFileSync(corrupt, Buffer.concat([bytes.subarray(0, 40), Buffer.alloc(64, 0xff), bytes.subarray(104)]))
      fs.mkdirSync(path.join(home, 'out-corrupt'))
      await assert.rejects(
        extractTarball(corrupt, path.join(home, 'out-corrupt')),
        /could not be decompressed|tar exited/
      )
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
)

function fakeBootstrap(
  activeRoot: string,
  home: string,
  installStamp: InstallStamp | null,
  overrides: Record<string, unknown> = {}
) {
  const ran: string[] = []
  const installs: any[] = []
  const events: any[] = []
  const stage = (name: string) => ({ name, title: name, category: 'runtime', needs_user_input: false })

  const run = () =>
    runBootstrap({
      installStamp,
      activeRoot,
      hermesHome: home,
      logRoot: path.join(home, 'logs'),
      onEvent: ev => events.push(ev),
      _resolveInstallScript: async () => ({ path: path.join(home, 'install.sh'), kind: 'posix' }),
      _fetchManifest: async () => ({
        protocol_version: 1,
        stages: ['prerequisites', 'repository', 'venv', 'complete'].map(stage)
      }),
      _runStage: async ({ stage: s }: any) => {
        ran.push(s.name)

        return { type: 'stage', name: s.name, state: 'succeeded' }
      },
      _installSource: async (opts: any) => {
        installs.push(opts)
        fs.mkdirSync(opts.targetDir, { recursive: true })
        fs.writeFileSync(
          path.join(opts.targetDir, SOURCE_MARKER_FILE),
          JSON.stringify({ sha: opts.sha, sha256: opts.sha256 })
        )

        return { previousDir: null, reused: false, sha: opts.sha }
      },
      ...overrides
    })

  return { events, installs, ran, run }
}

test('a packaged fresh install takes the source tarball and never runs the git stages', async () => {
  const home = mkTmpHome()
  const activeRoot = path.join(home, 'hermes-agent')

  try {
    const fake = fakeBootstrap(activeRoot, home, { commit: ZERO_COMMIT, branch: 'main' })
    const result: any = await fake.run()

    assert.equal(result.ok, true)
    assert.deepEqual(fake.ran, ['venv', 'complete'])
    assert.equal(fake.installs.length, 1)
    assert.equal(fake.installs[0].sha, RUNTIME_PIN_SHA)
    assert.equal(fake.installs[0].sha256, RUNTIME_PIN_TARBALL_SHA256)
    assert.equal(fake.installs[0].targetDir, activeRoot)
    const states = fake.events.filter(e => e.type === 'stage' && e.state !== 'running').map(e => `${e.name}:${e.state}`)
    assert.deepEqual(states.slice(0, 2), ['prerequisites:skipped', 'repository:succeeded'])
    // A fallback stamp resolves the marker pin from the source marker, not from `git rev-parse`.
    assert.equal(result.marker.pinnedCommit, RUNTIME_PIN_SHA)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('runBootstrap returns only once its run log is closed and holds every event', async () => {
  const home = mkTmpHome()

  try {
    const fake = fakeBootstrap(path.join(home, 'hermes-agent'), home, { commit: ZERO_COMMIT, branch: 'main' })
    await fake.run()
    const logs = fs.readdirSync(path.join(home, 'logs'))

    assert.equal(logs.length, 1)

    const lines = fs
      .readFileSync(path.join(home, 'logs', logs[0]), 'utf8')
      .trim()
      .split('\n')

    assert.equal(lines.length, fake.events.length)
    const lastLine = lines.at(-1)

    assert.ok(lastLine)
    assert.equal(JSON.parse(lastLine).type, 'complete')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

async function runWithBrokenLog(breakLogRoot: (logs: string) => void) {
  const home = mkTmpHome()
  const logs = path.join(home, 'logs')
  const uncaught: unknown[] = []
  const onUncaught = (err: unknown) => uncaught.push(err)
  process.prependListener('uncaughtException', onUncaught)

  try {
    breakLogRoot(logs)

    // A real run outlasts the log's open, so its error fires before closeRunLog listens for it.
    const fake = fakeBootstrap(
      path.join(home, 'hermes-agent'),
      home,
      { commit: ZERO_COMMIT, branch: 'main' },
      {
        _runStage: async ({ stage }: any) => {
          await new Promise(resolve => setTimeout(resolve, 20))

          return { type: 'stage', name: stage.name, state: 'succeeded' }
        }
      }
    )

    const result: any = await fake.run()
    await new Promise(resolve => setImmediate(resolve))

    return { events: fake.events, result, uncaught }
  } finally {
    process.removeListener('uncaughtException', onUncaught)
    fs.rmSync(home, { recursive: true, force: true })
  }
}

POSIX_ONLY('an unwritable run log loses only the log: the run succeeds and main sees no uncaught error', async () => {
  const run = await runWithBrokenLog(logs => fs.mkdirSync(logs, { mode: 0o500 }))

  assert.equal(run.result.ok, true)
  assert.equal(run.events.at(-1).type, 'complete')
  assert.deepEqual(run.uncaught, [])
})

test('a log root that cannot be created loses only the log: the run succeeds and main sees no uncaught error', async () => {
  const run = await runWithBrokenLog(logs => fs.writeFileSync(logs, 'not a directory'))

  assert.equal(run.result.ok, true)
  assert.equal(run.events.at(-1).type, 'complete')
  assert.deepEqual(run.uncaught, [])
})

test('an existing git checkout and a dev run keep install.sh for every stage', async () => {
  const home = mkTmpHome()
  const activeRoot = path.join(home, 'hermes-agent')

  try {
    fs.mkdirSync(path.join(activeRoot, '.git'), { recursive: true })
    const checkout = fakeBootstrap(activeRoot, home, { commit: 'e'.repeat(40), branch: 'main' })
    await checkout.run()
    assert.deepEqual(checkout.ran, ['prerequisites', 'repository', 'venv', 'complete'])
    assert.equal(checkout.installs.length, 0)

    fs.rmSync(path.join(activeRoot, '.git'), { recursive: true })
    const dev = fakeBootstrap(activeRoot, home, null)
    await dev.run()
    assert.deepEqual(dev.ran, ['prerequisites', 'repository', 'venv', 'complete'])
    assert.equal(dev.installs.length, 0)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a failed tarball download fails the repository stage with its reason', async () => {
  const home = mkTmpHome()

  try {
    const events: any[] = []

    const result: any = await runBootstrap({
      installStamp: { commit: 'e'.repeat(40), branch: 'main' },
      activeRoot: path.join(home, 'hermes-agent'),
      hermesHome: home,
      logRoot: path.join(home, 'logs'),
      onEvent: ev => events.push(ev),
      _resolveInstallScript: async () => ({ path: '/x/install.sh', kind: 'posix' }),
      _fetchManifest: async () => ({ stages: [{ name: 'repository' }, { name: 'venv' }] }),
      _runStage: async () => {
        throw new Error('must not run install.sh after a failed source stage')
      },
      _installSource: async () => {
        throw new Error('HTTP 503 from codeload')
      }
    })

    assert.equal(result.ok, false)
    assert.equal(result.failedStage, 'repository')
    assert.match(result.error, /HTTP 503/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveCheckoutHead never runs git for a tree without .git', () => {
  const home = mkTmpHome()

  try {
    assert.equal(resolveCheckoutHead(home), null)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('parseRuntimePin accepts an optional 64-hex tarball_sha256 and rejects a malformed one', () => {
  const sha = 'c'.repeat(40)

  assert.deepEqual(parseRuntimePin({ sha, min_app: '1.0.0', tarball_sha256: 'd'.repeat(64) }), {
    minApp: '1.0.0',
    sha,
    tarballSha256: 'd'.repeat(64)
  })
  assert.equal(parseRuntimePin({ sha, min_app: '1.0.0', tarball_sha256: 'nope' }), null)
})

POSIX_ONLY('a tarball install updates from the new source tree, keeps the venv, and restores on failure', async () => {
  const home = mkTmpHome()
  const oldSha = 'a'.repeat(40)
  const newSha = 'b'.repeat(40)
  const agent = path.join(home, 'hermes-agent')

  try {
    const oldTar = makeSourceTarball(home, oldSha)
    await installSourceTarball({
      cacheDir: path.join(home, 'cache'),
      emit: () => {},
      sha: oldSha,
      sha256: oldTar.sha256,
      targetDir: agent,
      _download: copyDownload(oldTar.archive)
    })
    fs.mkdirSync(path.join(agent, 'venv'))
    fs.writeFileSync(path.join(agent, 'venv', 'pyvenv.cfg'), 'old')
    const newTar = makeSourceTarball(home, newSha, { 'NEW.txt': 'new' })

    const update = (failAt: null | string) => {
      const stages: string[] = []

      const result = runPinnedRuntimeUpdate({
        activeRoot: agent,
        appVersion: '1.0.0',
        emit: () => {},
        hermesHome: home,
        _fetchPin: async () => ({ sha: newSha, minApp: '1.0.0', tarballSha256: newTar.sha256 }),
        _installSource: (opts: any) => installSourceTarball({ ...opts, _download: copyDownload(newTar.archive) }),
        _spawn: async (script, args) => {
          const name = args[args.indexOf('--stage') + 1]
          stages.push(name)
          assert.equal(script, path.join(agent, 'scripts', 'install.sh'))
          assert.ok(!args.includes('--commit'))
          const ok = name !== failAt

          return { code: ok ? 0 : 1, stdout: JSON.stringify({ ok, stage: name }) }
        }
      })

      return { result, stages }
    }

    // V3-RT: install.sh's own stage names at the pin (it has no node-deps or path stage: "unknown stage", exit 2).
    const failed = update('config')
    const failedResult = await failed.result
    assert.equal(failedResult.error, 'runtime-update-failed')
    assert.deepEqual(failed.stages, ['python-deps', 'config'])
    assert.equal(readSourceMarker(agent)?.sha, oldSha)
    assert.equal(fs.readFileSync(path.join(agent, 'venv', 'pyvenv.cfg'), 'utf8'), 'old')
    assert.ok(!fs.existsSync(path.join(agent, 'NEW.txt')))

    const ok = update(null)
    const okResult = await ok.result
    assert.equal(okResult.ok, true)
    assert.equal(okResult.manualRestart, true)
    assert.deepEqual(ok.stages, ['python-deps', 'config', 'products'])
    assert.equal(readSourceMarker(agent)?.sha, newSha)
    assert.equal(fs.readFileSync(path.join(agent, 'venv', 'pyvenv.cfg'), 'utf8'), 'old')
    assert.equal(fs.readFileSync(path.join(agent, 'NEW.txt'), 'utf8'), 'new')

    const noSum = await runPinnedRuntimeUpdate({
      activeRoot: agent,
      appVersion: '1.0.0',
      emit: () => {},
      hermesHome: home,
      _fetchPin: async () => ({ sha: 'c'.repeat(40), minApp: '1.0.0' }),
      _spawn: async () => {
        throw new Error('must not run without a tarball checksum')
      }
    })

    assert.equal(noSum.error, 'pin-no-tarball')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('curated: every install.sh invocation carries --commit <bundled pin>, a repair of an existing checkout too', () => {
  const installStamp = { commit: 'a'.repeat(40), branch: 'main' }

  const args = buildPosixPinArgs({
    installStamp,
    activeRoot: '/tmp/hermes-agent',
    hermesHome: '/tmp/hermes',
    pinCommit: false,
    policy: 'curated'
  })

  assert.deepEqual(args.slice(-4), ['--branch', 'main', '--commit', RUNTIME_PIN_SHA])
  assert.deepEqual(
    buildPosixPinArgs({ installStamp: null, activeRoot: '/a', hermesHome: '/h', policy: 'curated' }).slice(-2),
    ['--commit', RUNTIME_PIN_SHA]
  )
  // V3-RT: the pin is this repository's runtime build (iclone/RUNTIME_PIN.json), compiled in unchanged.
  const pinJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../iclone/RUNTIME_PIN.json'), 'utf8'))
  assert.equal(RUNTIME_PIN_SHA, pinJson.sha)
  assert.equal(RUNTIME_PIN_TARBALL_SHA256, pinJson.tarball_sha256)
  assert.equal(pinJson.source, 'repo')
})

test('runPinnedRuntimeUpdate with the bundled pin never fetches runtime.json and skips min_app', async () => {
  const home = mkTmpHome()

  try {
    const agent = path.join(home, 'hermes-agent')
    fs.mkdirSync(path.join(agent, '.git'), { recursive: true })
    let fetched = 0
    const calls: string[][] = []
    const aligned: string[] = []

    const result = await runPinnedRuntimeUpdate({
      activeRoot: agent,
      appVersion: '1.0.0',
      emit: () => {},
      hermesHome: home,
      pin: { sha: RUNTIME_PIN_SHA, minApp: '9.9.9', installShSha256: RUNTIME_PIN_INSTALL_SH_SHA256 },
      _fetchPin: async () => {
        fetched++

        throw new Error('network')
      },
      _download: async (_ref: string, dest: string) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, PINNED_INSTALL_SH)
      },
      _alignCheckout: async (o: any) => {
        aligned.push(o.sha)

        return { ok: true, fetched: false, from: 'a'.repeat(40), message: 'ok' }
      },
      _spawn: async (_script, args) => {
        calls.push(args)

        return args[0] === '--manifest'
          ? { code: 0, stdout: `${MANIFEST_LINE}\n` }
          : { code: 0, stdout: JSON.stringify({ ok: true, stage: args[1] }) }
      }
    })

    assert.equal(fetched, 0)
    assert.equal(result.ok, true)
    assert.deepEqual(aligned, [RUNTIME_PIN_SHA])

    for (const args of calls) {
      assert.deepEqual(args.slice(-2), ['--commit', RUNTIME_PIN_SHA])
    }

    // Curated: install.sh runs only as --manifest or one --stage at a time, never its repository stage.
    assert.equal(calls[0][0], '--manifest')
    assert.deepEqual(
      calls.slice(1).map(a => a.slice(0, 2)),
      MANIFEST_STAGES.filter(n => n !== 'repository').map(n => ['--stage', n])
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('runPinnedRuntimeUpdate refuses an installer that does not match the pin hash, or a pin without one', async () => {
  const home = mkTmpHome()

  try {
    const agent = path.join(home, 'hermes-agent')
    fs.mkdirSync(path.join(agent, '.git'), { recursive: true })
    let spawned = 0

    const base = {
      activeRoot: agent,
      appVersion: '1.1.0',
      emit: () => {},
      hermesHome: home,
      _download: async (_ref: string, dest: string) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, '#!/bin/sh\necho tampered\n')
      },
      _spawn: async () => {
        spawned++

        return { code: 0 }
      }
    }

    const tampered = await runPinnedRuntimeUpdate({ ...base, pin: { sha: RUNTIME_PIN_SHA, minApp: '1.1.0' } })

    const unhashed = await runPinnedRuntimeUpdate({
      ...base,
      _fetchPin: async () => ({ sha: 'd'.repeat(40), minApp: '1.0.0' })
    })

    assert.equal(tampered.error, 'pin-mismatch')
    assert.equal(unhashed.error, 'pin-mismatch')
    assert.equal(spawned, 0)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('runBootstrap under curated: a repair of an existing checkout carries --commit <bundled pin> (R1.probe.bootstrap_policy)', async () => {
  const home = mkTmpHome()

  try {
    const agent = path.join(home, 'hermes-agent')
    fs.mkdirSync(path.join(agent, '.git'), { recursive: true })

    const runOnce = async (policy: 'curated' | 'developer') => {
      const argv: string[][] = []
      const pinArgs = (o: any) => buildPosixPinArgs(o)

      await runBootstrap({
        installStamp: null,
        activeRoot: agent,
        sourceRepoRoot: null,
        hermesHome: home,
        logRoot: path.join(home, 'logs'),
        onEvent: () => {},
        writeMarker: () => {},
        policy,
        _resolveInstallScript: async () => ({ kind: 'posix', path: path.join(agent, 'scripts', 'install.sh') }),
        _fetchManifest: async (o: any) => {
          argv.push(['--manifest', ...pinArgs(o)])

          return { stages: [{ name: 'repo' }] }
        },
        _runStage: async (o: any) => {
          argv.push(['--stage', o.stage.name, ...pinArgs(o)])

          return { state: 'ok' }
        },
        _alignCheckout: async () => ({ ok: true, fetched: false, from: null, message: 'ok' })
      }).catch(() => undefined)

      return argv
    }

    const curated = await runOnce('curated')
    assert.equal(curated.length, 2)

    for (const args of curated) {
      assert.deepEqual(args.slice(args.indexOf('--commit')), ['--commit', RUNTIME_PIN_SHA])
    }

    for (const args of await runOnce('developer')) {
      assert.ok(!args.includes('--commit'), 'pnpm dev keeps the unpinned repair')
    }

    // main.ts hands its policy to the runner (the default stays 'developer' for pnpm dev only).
    const main = readMainProcessSource(__dirname)
    const call = main.slice(main.indexOf('await runBootstrap({'), main.indexOf('writeMarker: writeBootstrapMarker'))
    assert.match(call, /policy: updatePolicy\(\)/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 30_000)

test('U.repair_no_downgrade: a curated Repair keeps the runtime the user chose while HEAD is it, else the pin', async () => {
  const home = mkTmpHome()

  try {
    const agent = path.join(home, 'hermes-agent')
    const choiceFile = path.join(home, 'runtime-choice.json')
    const chosen = 'c'.repeat(40)
    fs.mkdirSync(path.join(agent, '.git'), { recursive: true })
    fs.writeFileSync(
      choiceFile,
      JSON.stringify({ door: 'agent-latest', sha: chosen, version: '0.22.0', at: '2026-10-19T00:00:00Z' })
    )

    const commits = async (head: null | string, file: null | string) => {
      const argv: string[][] = []
      const aligned: string[] = []

      await runBootstrap({
        installStamp: null,
        activeRoot: agent,
        sourceRepoRoot: null,
        hermesHome: home,
        logRoot: path.join(home, 'logs'),
        onEvent: () => {},
        writeMarker: () => {},
        policy: 'curated',
        runtimeChoiceFile: file,
        _resolveHead: () => head,
        _resolveInstallScript: async () => ({ kind: 'posix', path: path.join(agent, 'scripts', 'install.sh') }),
        _fetchManifest: async (o: any) => {
          argv.push(buildPosixPinArgs(o))

          return { stages: [{ name: 'repository' }, { name: 'deps' }] }
        },
        _runStage: async (o: any) => {
          argv.push(buildPosixPinArgs(o))

          return { state: 'ok' }
        },
        _alignCheckout: async (o: any) => {
          aligned.push(o.sha)

          return { ok: true, fetched: false, from: null, message: 'ok' }
        }
      }).catch(() => undefined)

      return { aligned, commits: argv.map(a => a[a.indexOf('--commit') + 1]) }
    }

    const kept = await commits(chosen, choiceFile)
    assert.ok(kept.commits.length > 0)
    assert.ok(
      kept.commits.every(c => c === chosen),
      'install.sh gets --commit <chosen>, never the pin'
    )
    assert.ok(kept.aligned.every(sha => sha === chosen))

    for (const run of [await commits('d'.repeat(40), choiceFile), await commits(chosen, null)]) {
      assert.ok(
        run.commits.every(c => c === RUNTIME_PIN_SHA),
        'moved HEAD or no record: the pin, as before'
      )
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 30_000)

// ---------------------------------------------------------------------------
// R1-T9: curated align/repair of an existing checkout is content-addressed
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_ALLOW_PROTOCOL: 'file',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid'
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim()
}

function commitFile(repo: string, name: string, body: string) {
  fs.writeFileSync(path.join(repo, name), body)
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', name)

  return git(repo, 'rev-parse', 'HEAD')
}

// The tests that drive real git spawn ~15 processes each: a loaded machine pushes them past vitest's 5 s default.
/**
 * file:// upstream whose main is OLD -> PIN -> TIP; the user's checkout was cloned
 * at OLD, so it lacks the pin object and its origin/main is behind.
 */
function gitFixture(root: string) {
  const seed = path.join(root, 'seed')
  fs.mkdirSync(seed)
  git(seed, 'init', '-q', '-b', 'main')
  const old = commitFile(seed, 'a.txt', 'old\n')
  const origin = path.join(root, 'origin.git')
  execFileSync('git', ['clone', '-q', '--bare', seed, origin], { env: GIT_ENV })
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  const agent = path.join(root, 'hermes-agent')
  execFileSync('git', ['clone', '-q', `file://${origin}`, agent], { env: GIT_ENV })
  const pin = commitFile(seed, 'b.txt', 'pin\n')
  const tip = commitFile(seed, 'c.txt', 'upstream moved\n')
  git(seed, 'push', '-q', origin, 'main')

  return { agent, old, origin, pin, tip }
}

function recordingGit(calls: string[][]) {
  return (args: string[], cwd: string, timeoutMs?: number) => {
    calls.push(args)

    return runGit(args, cwd, timeoutMs)
  }
}

test('curated runPinnedRuntimeUpdate on an existing checkout: content-addressed, no repository stage, no branch fetch (R1.r3.repair_moving_ref_fetch)', async () => {
  const root = mkTmpHome()
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file')
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0')

  try {
    const { agent, old, pin, tip } = gitFixture(root)
    // Local work in the checkout is parked, never discarded (install.sh's autostash contract).
    fs.writeFileSync(path.join(agent, 'a.txt'), 'local edit\n')
    const reflogBefore = git(agent, 'reflog', '--format=%H').split('\n').length
    const gitCalls: string[][] = []
    const spawned: string[][] = []

    const result = await runPinnedRuntimeUpdate({
      activeRoot: agent,
      appVersion: '1.0.0',
      emit: () => {},
      hermesHome: root,
      pin: { sha: pin, minApp: '9.9.9', installShSha256: RUNTIME_PIN_INSTALL_SH_SHA256 },
      _download: async (_ref: string, dest: string) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, PINNED_INSTALL_SH)
      },
      _alignCheckout: (o: any) => alignCheckoutToPin({ ...o, _git: recordingGit(gitCalls) }),
      _spawn: async (_script, args) => {
        spawned.push(args)

        return args[0] === '--manifest'
          ? { code: 0, stdout: `${MANIFEST_LINE}\n` }
          : { code: 0, stdout: JSON.stringify({ ok: true, stage: args[1] }) }
      }
    })

    assert.equal(result.ok, true, result.message)
    assert.equal(git(agent, 'rev-parse', 'HEAD'), pin)
    // HEAD never passed through the upstream tip (only the entries this run added are read).
    const added = git(agent, 'reflog', '--format=%H').split('\n')
    assert.ok(!added.slice(0, added.length - reflogBefore).includes(tip))
    // The tracking branch was not fetched: origin/main still names the commit the user cloned.
    assert.equal(git(agent, 'rev-parse', 'refs/remotes/origin/main'), old)
    // Exactly one fetch, by sha; zero refspecs / branch names on any git call.
    const fetches = gitCalls.filter(a => a.includes('fetch'))
    assert.equal(fetches.length, 1)
    assert.deepEqual(fetches[0].slice(-2), ['origin', pin])
    assert.ok(gitCalls.every(a => !a.some(x => /refs\/heads|^main$|origin\/main|^\+/.test(x))))
    // The parked local edit is re-applied on the pin and its stash dropped (install.sh's autostash).
    assert.equal(fs.readFileSync(path.join(agent, 'a.txt'), 'utf8'), 'local edit\n')
    assert.equal(git(agent, 'stash', 'list'), '')
    // install.sh: never its repository stage, never the whole ladder.
    assert.ok(spawned.every(a => a[0] === '--manifest' || a[0] === '--stage'))
    assert.ok(!spawned.some(a => a[0] === '--stage' && a[1] === 'repository'))
    assert.equal(spawned.length, MANIFEST_STAGES.length)
  } finally {
    vi.unstubAllEnvs()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test('alignCheckoutToPin: already at the pin = no fetch/checkout; an unfetchable pin leaves HEAD where it was', async () => {
  const root = mkTmpHome()
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file')

  try {
    const { agent, old } = gitFixture(root)
    const calls: string[][] = []

    const same = await alignCheckoutToPin({ activeRoot: agent, emit: () => {}, sha: old, _git: recordingGit(calls) })
    assert.equal(same.ok, true)
    assert.ok(calls.every(a => !a.includes('fetch') && !a.includes('checkout')))

    const missing = await alignCheckoutToPin({ activeRoot: agent, emit: () => {}, sha: 'e'.repeat(40) })
    assert.equal(missing.ok, false)
    assert.equal(missing.error, 'pin-fetch-failed')
    assert.equal(git(agent, 'rev-parse', 'HEAD'), old)

    const bad = await alignCheckoutToPin({ activeRoot: agent, emit: () => {}, sha: 'main' })
    assert.equal(bad.error, 'pin-invalid')
  } finally {
    vi.unstubAllEnvs()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test('alignCheckoutToPin: a failed checkout after the autostash restores HEAD and the local changes (R1.r4.align_failure_keeps_worktree)', async () => {
  const root = mkTmpHome()
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file')
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0')

  try {
    const { agent, old, pin } = gitFixture(root)
    const edit = () => fs.writeFileSync(path.join(agent, 'a.txt'), 'local edit\n')
    const kept = () => fs.readFileSync(path.join(agent, 'a.txt'), 'utf8') === 'local edit\n'
    const stashes = () => git(agent, 'stash', 'list')

    const atOldOnMain = () => {
      assert.equal(git(agent, 'rev-parse', 'HEAD'), old)
      assert.equal(git(agent, 'symbolic-ref', '-q', 'HEAD'), 'refs/heads/main')
    }

    // (a) git refuses the checkout: HEAD never moved, the stash is popped back.
    edit()

    const refuse = (args: string[], cwd: string, t?: number) =>
      args.includes('checkout')
        ? Promise.resolve({ code: 1, stdout: '', stderr: 'checkout refused' })
        : runGit(args, cwd, t)

    const refused = await alignCheckoutToPin({ activeRoot: agent, emit: () => {}, sha: pin, _git: refuse })
    assert.equal(refused.ok, false)
    assert.equal(refused.error, 'checkout-failed')
    assert.equal(refused.stash, undefined)
    assert.ok(kept(), 'local edit restored in the working tree')
    assert.equal(stashes(), '')
    atOldOnMain()

    // (b) the checkout moves HEAD to the pin and still reports a failure: HEAD goes back to main@OLD, then the pop.
    edit()
    const backCalls: string[][] = []
    let first = true

    const movesThenFails = async (args: string[], cwd: string, t?: number) => {
      backCalls.push(args)

      if (first && args[0] === 'checkout') {
        first = false
        await runGit(args, cwd, t)

        return { code: 1, stdout: '', stderr: 'checkout reported failure' }
      }

      return runGit(args, cwd, t)
    }

    const moved = await alignCheckoutToPin({ activeRoot: agent, emit: () => {}, sha: pin, _git: movesThenFails })
    assert.equal(moved.error, 'checkout-failed')
    assert.ok(backCalls.some(a => a.join(' ') === 'checkout -q main --'))
    assert.ok(kept())
    assert.equal(stashes(), '')
    atOldOnMain()

    // (c) the pop cannot apply: the stash stays parked and is named in the message runAlignStage shows.
    edit()

    const dirtyBeforePop = (args: string[], cwd: string, t?: number) => {
      if (args.includes('checkout')) {
        fs.writeFileSync(path.join(agent, 'a.txt'), 'written meanwhile\n')

        return Promise.resolve({ code: 1, stdout: '', stderr: 'checkout refused' })
      }

      return runGit(args, cwd, t)
    }

    const events: any[] = []

    const ev: any = await runAlignStage({
      stage: { name: 'repository' },
      emit: e => events.push(e),
      activeRoot: agent,
      sha: pin,
      align: (o: any) => alignCheckoutToPin({ ...o, _git: dirtyBeforePop })
    })

    assert.equal(ev.state, 'failed')
    const parked = /iclone-align-autostash-\d{8}T\d{6}/.exec(ev.error)?.[0]
    assert.ok(parked, ev.error)
    assert.match(ev.error, /^checkout-failed: .*local changes kept in stash/)
    assert.match(stashes(), new RegExp(parked))
    assert.equal(git(agent, 'rev-parse', 'HEAD'), old)
  } finally {
    vi.unstubAllEnvs()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

/**
 * Local checkout on main at OLD with the PIN object present (no fetch). OLD: a.txt, local.txt,
 * package.json, package-lock.json, d/x, sub/package.json, sub/package-lock.json. PIN: a.txt
 * changed and d/y added.
 */
function localAlignFixture(root: string) {
  const seed = path.join(root, 'seed')

  const files: Record<string, string> = {
    'a.txt': 'old\n',
    'local.txt': 'upstream\n',
    'package.json': '{}\n',
    'package-lock.json': '{"v":1}\n',
    'd/x': 'x\n',
    'sub/package.json': '{}\n',
    'sub/package-lock.json': '{"v":1}\n'
  }

  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, name)), { recursive: true })
    fs.writeFileSync(path.join(seed, name), body)
  }

  git(seed, 'init', '-q', '-b', 'main')
  git(seed, 'add', '.')
  git(seed, 'commit', '-qm', 'old')
  const old = git(seed, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(seed, 'a.txt'), 'pin\n')
  fs.writeFileSync(path.join(seed, 'd/y'), 'y\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-qm', 'pin')
  const pin = git(seed, 'rev-parse', 'HEAD')
  const agent = path.join(root, 'hermes-agent')
  execFileSync('git', ['clone', '-q', seed, agent], { env: GIT_ENV })
  git(agent, 'reset', '-q', '--hard', old)

  return { agent, old, pin }
}

function stubGitIdentity() {
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0')
  vi.stubEnv('GIT_AUTHOR_NAME', 't')
  vi.stubEnv('GIT_AUTHOR_EMAIL', 't@example.invalid')
  vi.stubEnv('GIT_COMMITTER_NAME', 't')
  vi.stubEnv('GIT_COMMITTER_EMAIL', 't@example.invalid')
}

test('alignCheckoutToPin: a successful align re-applies local changes and leaves no stash (R1.r5.align_success_restores_local_changes)', async () => {
  const root = mkTmpHome()
  stubGitIdentity()

  try {
    const { agent, pin } = localAlignFixture(root)
    const read = (f: string) => fs.readFileSync(path.join(agent, f), 'utf8')
    fs.writeFileSync(path.join(agent, 'local.txt'), 'my patch\n')
    fs.writeFileSync(path.join(agent, 'notes.md'), 'my notes\n')
    git(agent, 'add', 'local.txt')

    const res = await alignCheckoutToPin({ activeRoot: agent, emit: () => {}, sha: pin })

    assert.equal(res.ok, true, res.message)
    assert.equal(res.stash, undefined)
    assert.match(res.message, /with its local changes/)
    assert.equal(git(agent, 'rev-parse', 'HEAD'), pin)
    assert.equal(read('a.txt'), 'pin\n')
    assert.equal(read('local.txt'), 'my patch\n')
    assert.equal(read('notes.md'), 'my notes\n')
    // `--index`: the staged edit is staged again.
    assert.equal(git(agent, 'diff', '--cached', '--name-only'), 'local.txt')
    assert.equal(git(agent, 'stash', 'list'), '')
  } finally {
    vi.unstubAllEnvs()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test('alignCheckoutToPin: package-lock.json churn is discarded, never stashed, unless its package.json is dirty (R1.r5.align_lockfile_churn_no_stash)', async () => {
  const root = mkTmpHome()
  stubGitIdentity()

  try {
    const { agent, pin } = localAlignFixture(root)
    const read = (f: string) => fs.readFileSync(path.join(agent, f), 'utf8')
    const gitCalls: string[][] = []

    // Churn only: no stash at all.
    fs.writeFileSync(path.join(agent, 'package-lock.json'), '{"v":1,"churn":true}\n')

    const churn = await alignCheckoutToPin({
      activeRoot: agent,
      emit: () => {},
      sha: pin,
      _git: recordingGit(gitCalls)
    })

    assert.equal(churn.ok, true, churn.message)
    assert.equal(churn.stash, undefined)
    assert.equal(read('package-lock.json'), '{"v":1}\n')
    assert.ok(!gitCalls.some(a => a[0] === 'stash'))
    assert.equal(git(agent, 'stash', 'list'), '')

    // A lockfile next to a dirty package.json is real work: kept and re-applied.
    git(agent, 'checkout', '-q', '--detach', `${pin}~1`)
    fs.writeFileSync(path.join(agent, 'sub/package.json'), '{"dependencies":{}}\n')
    fs.writeFileSync(path.join(agent, 'sub/package-lock.json'), '{"v":2}\n')
    fs.writeFileSync(path.join(agent, 'package-lock.json'), '{"v":1,"churn":true}\n')
    const real = await alignCheckoutToPin({ activeRoot: agent, emit: () => {}, sha: pin })

    assert.equal(real.ok, true, real.message)
    assert.equal(read('sub/package-lock.json'), '{"v":2}\n')
    assert.equal(read('sub/package.json'), '{"dependencies":{}}\n')
    assert.equal(read('package-lock.json'), '{"v":1}\n')
    assert.equal(git(agent, 'stash', 'list'), '')
  } finally {
    vi.unstubAllEnvs()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test('alignCheckoutToPin: a conflicting re-apply resets to the pin and names the kept stash; alignBundledPin shows it', async () => {
  const root = mkTmpHome()
  stubGitIdentity()

  try {
    const { agent, pin } = localAlignFixture(root)
    // The pin changes a.txt too: the re-applied edit conflicts.
    fs.writeFileSync(path.join(agent, 'a.txt'), 'my conflicting edit\n')

    const result = await runPinnedRuntimeUpdate({
      activeRoot: agent,
      appVersion: '1.0.0',
      emit: () => {},
      hermesHome: root,
      pin: { sha: pin, minApp: '9.9.9', installShSha256: RUNTIME_PIN_INSTALL_SH_SHA256 },
      _download: async (_ref: string, dest: string) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, PINNED_INSTALL_SH)
      },
      _alignCheckout: (o: any) => alignCheckoutToPin(o),
      _spawn: async (_script, args) =>
        args[0] === '--manifest'
          ? { code: 0, stdout: `${MANIFEST_LINE}\n` }
          : { code: 0, stdout: JSON.stringify({ ok: true, stage: args[1] }) }
    })

    assert.equal(result.ok, true, result.message)
    const parked = /iclone-align-autostash-\d{8}T\d{6}/.exec(result.message)?.[0]
    assert.ok(parked, result.message)
    assert.match(result.message, /^Runtime updated — reopen iclone os\. Local changes conflict with the pin/)
    assert.match(git(agent, 'stash', 'list'), new RegExp(parked))
    // The tree is the clean pin: no conflict markers, no half-applied stash.
    assert.equal(git(agent, 'rev-parse', 'HEAD'), pin)
    assert.equal(git(agent, 'status', '--porcelain'), '')
    assert.equal(fs.readFileSync(path.join(agent, 'a.txt'), 'utf8'), 'pin\n')
    // The edit is recoverable from the named stash.
    assert.match(git(agent, 'stash', 'show', '-p', 'stash@{0}'), /my conflicting edit/)
  } finally {
    vi.unstubAllEnvs()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test('alignCheckoutToPin: a checkout that exits 0 but leaves tracked files unwritten is checkout-incomplete and restored (R1.r5.align_checkout_incomplete_tree)', async () => {
  const root = mkTmpHome()
  stubGitIdentity()
  const { agent, old, pin } = localAlignFixture(root)
  const ro = path.join(agent, 'd')

  try {
    fs.writeFileSync(path.join(agent, 'local.txt'), 'my patch\n')
    // git writes a.txt, then cannot create d/y in the read-only directory.
    fs.chmodSync(ro, 0o555)
    const res = await alignCheckoutToPin({ activeRoot: agent, emit: () => {}, sha: pin })
    fs.chmodSync(ro, 0o755)

    assert.equal(res.ok, false)
    assert.equal(res.error, 'checkout-incomplete')
    assert.match(res.message, /left tracked files unwritten; checkout left at .* with its local changes/)
    assert.equal(git(agent, 'rev-parse', 'HEAD'), old)
    assert.equal(git(agent, 'symbolic-ref', '-q', 'HEAD'), 'refs/heads/main')
    assert.equal(fs.readFileSync(path.join(agent, 'a.txt'), 'utf8'), 'old\n')
    assert.equal(fs.readFileSync(path.join(agent, 'local.txt'), 'utf8'), 'my patch\n')
    assert.equal(git(agent, 'status', '--porcelain'), 'M local.txt')
    assert.equal(git(agent, 'stash', 'list'), '')
  } finally {
    fs.chmodSync(ro, 0o755)
    vi.unstubAllEnvs()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test('alignBundledPin: a stage failure after a successful alignment says the checkout is already at the pin', async () => {
  const root = mkTmpHome()
  const pin = 'c'.repeat(40)

  try {
    const agent = path.join(root, 'hermes-agent')
    fs.mkdirSync(path.join(agent, '.git'), { recursive: true })
    const order: string[] = []

    const run = (failAt: string) =>
      runPinnedRuntimeUpdate({
        activeRoot: agent,
        appVersion: '1.0.0',
        emit: () => {},
        hermesHome: root,
        pin: { sha: pin, minApp: '9.9.9', installShSha256: RUNTIME_PIN_INSTALL_SH_SHA256 },
        _download: async (_ref: string, dest: string) => {
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          fs.writeFileSync(dest, PINNED_INSTALL_SH)
        },
        _alignCheckout: async () => {
          order.push('align')

          return { ok: true, fetched: false, from: 'a'.repeat(40), message: 'Runtime checkout at the pin.' }
        },
        _spawn: async (_script, args) => {
          if (args[0] === '--manifest') {
            return { code: 0, stdout: `${MANIFEST_LINE}\n` }
          }

          order.push(args[1])

          return args[1] === failAt
            ? { code: 1, stdout: JSON.stringify({ ok: false, stage: args[1] }) }
            : { code: 0, stdout: JSON.stringify({ ok: true, stage: args[1] }) }
        }
      })

    // After the alignment (venv runs later): the old runtime is gone, Repair/reopen finishes the job.
    const late = await run('venv')

    assert.equal(late.ok, false)
    assert.deepEqual(order, ['prerequisites', 'align', 'venv'])
    assert.match(
      late.message,
      new RegExp(
        `^Runtime update failed at venv \\(exit 1\\)\\. The runtime checkout is already at ${pin.slice(0, 7)}; Repair or reopening iclone os finishes the update\\.$`
      )
    )
    assert.doesNotMatch(late.message, /keeps running on the current runtime/)

    // Before the alignment the checkout never moved: the old runtime still runs.
    const early = await run('prerequisites')

    assert.equal(early.ok, false)
    assert.match(early.message, /^Runtime update failed at prerequisites \(exit 1\)\. iclone os keeps running/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runBootstrap curated repair: the repository stage is the in-app alignment; developer keeps install.sh (R1.r3.repair_transient_upstream_head)', async () => {
  const home = mkTmpHome()

  try {
    const agent = path.join(home, 'hermes-agent')
    fs.mkdirSync(path.join(agent, '.git'), { recursive: true })

    const runOnce = async (policy: 'curated' | 'developer', alignOk = true) => {
      const stages: string[] = []
      const aligned: string[] = []

      const result = await runBootstrap({
        installStamp: null,
        activeRoot: agent,
        sourceRepoRoot: null,
        hermesHome: home,
        logRoot: path.join(home, 'logs'),
        onEvent: () => {},
        writeMarker: () => ({}),
        policy,
        _resolveInstallScript: async () => ({ kind: 'posix', path: path.join(agent, 'scripts', 'install.sh') }),
        _fetchManifest: async () => ({ stages: [{ name: 'prerequisites' }, { name: 'repository' }, { name: 'venv' }] }),
        _runStage: async (o: any) => {
          stages.push(o.stage.name)

          return { state: 'succeeded' }
        },
        _alignCheckout: async (o: any) => {
          aligned.push(o.sha)

          return alignOk
            ? { ok: true, fetched: false, from: null, message: 'ok' }
            : { ok: false, error: 'pin-fetch-failed', fetched: true, from: null, message: 'no pin' }
        }
      })

      return { aligned, result, stages }
    }

    const curated = await runOnce('curated')
    assert.deepEqual(curated.stages, ['prerequisites', 'venv'])
    assert.deepEqual(curated.aligned, [RUNTIME_PIN_SHA])
    assert.equal(curated.result.ok, true)

    const failed = await runOnce('curated', false)
    assert.deepEqual(failed.stages, ['prerequisites'])
    assert.equal(failed.result.failedStage, 'repository')

    const developer = await runOnce('developer')
    assert.deepEqual(developer.stages, ['prerequisites', 'repository', 'venv'])
    assert.deepEqual(developer.aligned, [])
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// Install from the bundle (PLANO_R §6 R7/R11 item 4): with the pinned runtime inside the app, a fresh install
// reaches no GitHub host at all; a missing or corrupt bundle falls back to the pinned URL and says so.
function networkSpy() {
  const hosts: string[] = []

  const block = (target: unknown) => {
    hosts.push(String(typeof target === 'string' ? target : ((target as { hostname?: string })?.hostname ?? target)))
    throw new Error('network blocked in this test')
  }

  return {
    hosts,
    spies: [
      vi.spyOn(https, 'get').mockImplementation(block as never),
      vi.spyOn(https, 'request').mockImplementation(block as never)
    ],
    restore() {
      for (const spy of this.spies) {
        spy.mockRestore()
      }
    }
  }
}

POSIX_ONLY('installSourceTarball installs from the app bundle with 0 network calls and keeps the bundle', async () => {
  const home = mkTmpHome()
  const sha = 'b'.repeat(40)
  const net = networkSpy()

  try {
    const { archive, sha256 } = makeSourceTarball(home, sha, { 'run_agent.py': 'print(2)\n' })
    const bundleDir = path.join(home, 'Resources', 'hermes-runtime')
    fs.mkdirSync(bundleDir, { recursive: true })
    fs.renameSync(archive, path.join(bundleDir, bundledRuntimeTarballName(sha)))
    const target = path.join(home, 'hermes-agent')
    const logs: string[] = []

    const result = await installSourceTarball({
      bundleDir,
      cacheDir: path.join(home, 'bootstrap-cache'),
      emit: ev => ev.type === 'log' && logs.push(ev.line),
      sha,
      sha256,
      targetDir: target
    })

    assert.deepEqual(net.hosts, [], 'no https request of any kind')
    assert.equal(result.reused, false)
    assert.equal(fs.readFileSync(path.join(target, 'run_agent.py'), 'utf8'), 'print(2)\n')
    assert.equal(readSourceMarker(target)?.sha256, sha256)
    assert.ok(fs.existsSync(path.join(bundleDir, bundledRuntimeTarballName(sha))), 'the bundle is read, never consumed')
    assert.ok(logs.some(line => /from the app bundle \(sha256 verified; nothing downloaded\)/.test(line)))
  } finally {
    net.restore()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

POSIX_ONLY('a corrupt or missing bundle falls back to the pinned URL and logs why', async () => {
  const home = mkTmpHome()
  const sha = 'c'.repeat(40)

  try {
    const { archive, sha256 } = makeSourceTarball(home, sha)
    const bundleDir = path.join(home, 'hermes-runtime')
    fs.mkdirSync(bundleDir, { recursive: true })
    fs.writeFileSync(path.join(bundleDir, bundledRuntimeTarballName(sha)), 'truncated')

    for (const [label, dir] of [
      ['corrupt', bundleDir],
      ['missing', path.join(home, 'no-bundle')]
    ]) {
      const urls: string[] = []
      const logs: string[] = []
      const target = path.join(home, `agent-${label}`)

      await installSourceTarball({
        bundleDir: dir,
        cacheDir: path.join(home, 'bootstrap-cache'),
        emit: ev => ev.type === 'log' && logs.push(ev.line),
        sha,
        sha256,
        targetDir: target,
        _download: copyDownload(archive, urls)
      })

      assert.deepEqual(urls, [sourceTarballUrl(sha)], label)
      assert.equal(readSourceMarker(target)?.sha, sha, label)

      const reason =
        label === 'corrupt'
          ? /failed its sha256 check.*falling back to the pinned URL/
          : /no bundled runtime at .*falling back/

      assert.ok(
        logs.some(line => line.startsWith(RUNTIME_BUNDLE_LOG_TAG) && reason.test(line)),
        `${label}: ${logs.join(' | ')}`
      )
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

POSIX_ONLY('resolveInstallScript takes the bundled install.sh (sha256-checked) without touching GitHub', async () => {
  const home = mkTmpHome()
  const net = networkSpy()

  try {
    const bundleDir = path.join(home, 'hermes-runtime')
    fs.mkdirSync(bundleDir, { recursive: true })
    fs.writeFileSync(path.join(bundleDir, 'install.sh'), PINNED_INSTALL_SH)
    const downloads: string[] = []

    const fail = async (ref: string) => {
      downloads.push(ref)
      throw new Error('must not download')
    }

    const result = await resolveInstallScript({
      installStamp: { commit: ZERO_COMMIT, branch: 'main' },
      sourceRepoRoot: null,
      hermesHome: home,
      emit: () => {},
      bundleDir,
      _download: fail
    })

    assert.equal(result.source, 'bundle')
    assert.equal(result.commit, RUNTIME_PIN_SHA)
    assert.equal(fs.readFileSync(result.path, 'utf8'), PINNED_INSTALL_SH.toString())
    // A length check: deepEqual(downloads, []) would narrow `downloads` to never[] for the rest of the test.
    assert.equal(downloads.length, 0)
    assert.deepEqual(net.hosts, [])

    fs.rmSync(cachedScriptPath(home, PIN_KEY))
    fs.writeFileSync(path.join(bundleDir, 'install.sh'), '#!/bin/sh\necho tampered\n')
    const logs: string[] = []

    const fallback = await resolveInstallScript({
      installStamp: { commit: ZERO_COMMIT, branch: 'main' },
      sourceRepoRoot: null,
      hermesHome: home,
      emit: ev => ev.type === 'log' && logs.push(ev.line),
      bundleDir,
      _download: async (ref: string, destPath: string) => {
        downloads.push(ref)
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        fs.writeFileSync(destPath, PINNED_INSTALL_SH)

        return destPath
      }
    })

    assert.equal(fallback.source, 'download')
    assert.deepEqual(downloads, [RUNTIME_PIN_SHA])
    assert.ok(logs.some(line => line.startsWith(RUNTIME_BUNDLE_LOG_TAG) && /falling back to the pinned URL/.test(line)))
  } finally {
    net.restore()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

POSIX_ONLY(
  'installSourceTarball keeps on disk exactly the bytes it hashed, even when the body arrives with the headers',
  async () => {
    const home = mkTmpHome()
    const body = Buffer.alloc(3 * 1024 * 1024)

    for (let i = 0; i < body.length; i++) {
      body[i] = (i * 2654435761) >>> 24
    }

    const sha256 = createHash('sha256').update(body).digest('hex')

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(body.length) })
      res.end(body)
    })

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))

    const { port } = server.address() as AddressInfo

    const get = vi
      .spyOn(https, 'get')
      .mockImplementation(((url: string, options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) =>
        http.get(url.replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${port}`), options, callback)) as never)

    let archived = ''

    try {
      await assert.rejects(
        installSourceTarball({
          bundleDir: null,
          cacheDir: path.join(home, 'cache'),
          emit: () => {},
          sha: 'a'.repeat(40),
          sha256,
          targetDir: path.join(home, 'target'),
          _extract: async archive => {
            archived = createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
            throw new Error('stop after the download')
          }
        }),
        /stop after the download/
      )
      assert.equal(archived, sha256)
    } finally {
      get.mockRestore()
      await new Promise<void>(resolve => server.close(() => resolve()))
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
)

test('a redirect without a location fails the installer download instead of requesting the local host', async () => {
  const home = mkTmpHome()
  const bundleDir = path.join(home, 'empty-bundle')
  fs.mkdirSync(bundleDir, { recursive: true })
  const urls: unknown[] = []

  const get = vi.spyOn(https, 'get').mockImplementation(((
    url: unknown,
    callback: (res: { headers: Record<string, string>; statusCode: number }) => void
  ) => {
    urls.push(url)
    callback({ headers: {}, statusCode: 302 })

    return { on: () => undefined }
  }) as never)

  try {
    await assert.rejects(
      resolveInstallScript({
        installStamp: { commit: ZERO_COMMIT, branch: 'main' },
        sourceRepoRoot: null,
        hermesHome: home,
        emit: () => {},
        bundleDir
      }),
      /HTTP 302 without a location/
    )
    assert.equal(urls.length, 1, 'no second request to an undefined location')
  } finally {
    get.mockRestore()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
