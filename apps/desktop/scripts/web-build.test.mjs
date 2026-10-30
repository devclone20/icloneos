import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'

import {
  checkWebDist,
  refuseViteEnvFiles,
  viteEnvFiles,
  webBuildCommit,
  writeWebCommit,
  writeWebSums
} from './web-build.mjs'

function dist(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-web-'))
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), data)
  return dir
}

const GOOD = {
  'index.html':
    '<link rel="manifest" href="/manifest.webmanifest" /><script type="module" src="/assets/index-1.js"></script>',
  'sw.js': "function swRoute(pathname) { const networkOnly = ['/api'] }\ncache.put(event.request, copy)",
  'manifest.webmanifest': JSON.stringify({ display: 'standalone', start_url: '/', icons: [{ sizes: '512x512' }] }),
  'icon-512.png': 'png',
  'offline.html': 'offline'
}

test('checkWebDist accepts a complete PWA and hashes it', () => {
  const dir = dist(GOOD)
  assert.deepEqual(checkWebDist(dir), [])
  assert.equal(writeWebSums(dir), 5)
  assert.equal(fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8').trim().split('\n').length, 5)
  fs.rmSync(dir, { recursive: true })
})

test('checkWebDist refuses a service worker that caches /api, a missing manifest and unbundled sources', () => {
  const dir = dist({
    ...GOOD,
    'index.html': '<script type="module" src="/src/main.tsx"></script>',
    'sw.js': "function swRoute() { ['/api'] }\ncaches.open(C).then(c => c.addAll(['/api/sessions']))",
    'manifest.webmanifest': JSON.stringify({ display: 'browser' })
  })
  assert.deepEqual(checkWebDist(dir), [
    'index.html does not link manifest.webmanifest',
    'index.html still references /src/ (shim not bundled)',
    'sw.js caches /api',
    'manifest.webmanifest is not installable (display/icons/start_url)'
  ])
  fs.rmSync(dir, { recursive: true })
})

const HEAD = 'd'.repeat(40)

function fakeGit({ head = HEAD, status = '' } = {}) {
  const calls = []
  const git = args => {
    calls.push(args)
    if (args[0] === 'rev-parse') return `${head}\n`
    if (args[0] === 'status') return status
    throw new Error(`unexpected git ${args.join(' ')}`)
  }
  return { calls, git }
}

test('webBuildCommit stamps HEAD of a clean tree, or GITHUB_SHA when it is HEAD', () => {
  const local = fakeGit()
  assert.equal(webBuildCommit({ env: {}, git: local.git }), HEAD)
  // Every change but dist-web (the build's own output) counts, untracked files included.
  assert.deepEqual(local.calls[1], ['status', '--porcelain', '--', '.', ':(exclude)apps/desktop/dist-web'])
  assert.equal(webBuildCommit({ env: { GITHUB_SHA: HEAD }, git: fakeGit().git }), HEAD)
})

test('webBuildCommit refuses a dirty tree, a GITHUB_SHA that is not HEAD and a non-commit', () => {
  assert.throws(
    () =>
      webBuildCommit({
        env: {},
        git: fakeGit({ status: ' M apps/desktop/src/app.tsx\n?? apps/desktop/public/x.png\n' }).git
      }),
    /2 uncommitted change\(s\).*--dev/
  )
  assert.throws(
    () => webBuildCommit({ env: { GITHUB_SHA: 'e'.repeat(40) }, git: fakeGit().git }),
    /is not the checked-out HEAD/
  )
  assert.throws(() => webBuildCommit({ env: {}, git: fakeGit({ head: 'HEAD' }).git }), /no build commit/)
})

test('the commit stamp is part of the hashed dist', () => {
  const dir = dist(GOOD)
  writeWebCommit(dir, HEAD)
  assert.equal(fs.readFileSync(path.join(dir, 'BUILD_COMMIT.txt'), 'utf8'), `${HEAD}\n`)
  assert.equal(writeWebSums(dir), 6)
  assert.match(fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8'), /^[0-9a-f]{64} {2}BUILD_COMMIT\.txt$/m)
  fs.rmSync(dir, { recursive: true })
})

test('an ignored .env* that Vite would read refuses the build (plain git status never lists it)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-web-env-'))

  try {
    const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
    git(['init', '-q'])
    fs.mkdirSync(path.join(repo, 'apps', 'desktop'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.gitignore'), '.env*\n')
    fs.writeFileSync(path.join(repo, 'apps', 'desktop', 'index.html'), '<p>ok</p>')
    git(['add', '.'])
    git(['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'base'])
    assert.deepEqual(viteEnvFiles({ git }), [])
    assert.doesNotThrow(() => refuseViteEnvFiles({ git }))

    fs.writeFileSync(path.join(repo, 'apps', 'desktop', '.env.local'), 'VITE_SECRET=1\n')
    assert.equal(git(['status', '--porcelain']).trim(), '', 'the old dirty check cannot see it')
    assert.deepEqual(viteEnvFiles({ git }), ['apps/desktop/.env.local'])
    assert.throws(() => refuseViteEnvFiles({ git }), /Vite would read apps\/desktop\/\.env\.local/)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
