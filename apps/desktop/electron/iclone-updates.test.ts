import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, test, vi } from 'vitest'

import type { IcloneUpstreamStatus } from '../src/iclone-shared/update-status'

import {
  cachedUpstream,
  checkUpstreamOnce,
  createUpstreamChecker,
  EMPTY_UPSTREAM_CACHE,
  parseImportCommitSubject,
  parseLatestReleaseTag,
  parseShortstat,
  parseUpstreamBase,
  pickUpdaterRoot,
  readRuntimeStatus,
  settleUpstream,
  UPSTREAM_FAILURE_TTL_MS,
  UPSTREAM_NOT_CHECKED,
  UPSTREAM_TTL_MS
} from './iclone-updates'

test('parseUpstreamBase reads the first bare sha, ignoring comments and blanks', () => {
  const file = [
    '# The upstream commit this fork was imported from.',
    '#',
    '# One 40-character sha, alone on its line.',
    '',
    '10b388300a63d83857fac3ca4f8b05b64e01bc50',
    ''
  ].join('\n')

  assert.equal(parseUpstreamBase(file), '10b388300a63d83857fac3ca4f8b05b64e01bc50')
})

test('parseUpstreamBase uppercases down and tolerates trailing whitespace', () => {
  assert.equal(
    parseUpstreamBase('  10B388300A63D83857FAC3CA4F8B05B64E01BC50  \n'),
    '10b388300a63d83857fac3ca4f8b05b64e01bc50'
  )
})

test('parseUpstreamBase refuses anything that is not a full sha', () => {
  // A short sha is a real hazard here: it looks right, resolves locally, and
  // silently stops resolving the day upstream grows a collision prefix.
  assert.equal(parseUpstreamBase('10b38830\n'), null)
  assert.equal(parseUpstreamBase('main\n'), null)
  assert.equal(parseUpstreamBase('10b388300a63d83857fac3ca4f8b05b64e01bc50 # base\n'), null)
  assert.equal(parseUpstreamBase(''), null)
  assert.equal(parseUpstreamBase('# only comments\n'), null)
  assert.equal(parseUpstreamBase(undefined as unknown as string), null)
})

test('parseImportCommitSubject recovers the anchor from the root commit', () => {
  assert.equal(
    parseImportCommitSubject('chore: import hermes-agent @ 10b38830 (upstream main, v0.20.6 era)'),
    '10b38830'
  )
  assert.equal(
    parseImportCommitSubject('chore: import hermes-agent @ 10b388300a63d83857fac3ca4f8b05b64e01bc50'),
    '10b388300a63d83857fac3ca4f8b05b64e01bc50'
  )
})

test('parseImportCommitSubject returns null for a subject that names no sha', () => {
  assert.equal(parseImportCommitSubject('first commit'), null)
  assert.equal(parseImportCommitSubject('chore: import hermes-agent'), null)
  assert.equal(parseImportCommitSubject(''), null)
})

test('parseShortstat reads git diff --shortstat', () => {
  assert.deepEqual(parseShortstat(' 1324 files changed, 99189 insertions(+), 41677 deletions(-)'), {
    deletions: 41677,
    files: 1324,
    insertions: 99189
  })
})

test('parseShortstat handles the singular and one-sided forms git actually emits', () => {
  assert.deepEqual(parseShortstat(' 1 file changed, 1 insertion(+)'), {
    deletions: 0,
    files: 1,
    insertions: 1
  })
  assert.deepEqual(parseShortstat(' 2 files changed, 3 deletions(-)'), {
    deletions: 3,
    files: 2,
    insertions: 0
  })
})

test('parseShortstat returns null when there is no diff to report', () => {
  // An identical tree prints nothing at all — that must not read as zero
  // files changed on a real comparison that simply failed to run.
  assert.equal(parseShortstat(''), null)
  assert.equal(parseShortstat('fatal: bad object'), null)
})

// ── The newest release tag: the re-import point ────────────────────────────

const TAGS = [
  // Newest by date, but a canary: cut from main between releases, never a re-import point.
  'v0.21.4+canary.20260925T065930Z\ta9a0ba7506c725137a204780458e022187035bbf\t7b761da2de4979e424510ca7022bf9527aa65b68\t2026-09-25T06:59:33Z',
  'v2026.9.24\te3dd27ee2d8b011737a4eea8e3eb3d711ab78690\tf97608f178d1ffeca59860195ab7da295f7c8e5f\t2026-09-24T03:09:32-07:00',
  'v2026.9.21\tdd2c35f4f6d14c518a46d8ceb5311f57851a1ee2\td337b736aa1e8ebecfab043842d13e4a2d2f48a3\t2026-09-21T11:10:51-07:00'
].join('\n')

test('parseLatestReleaseTag skips canaries and peels the annotated tag to its commit', () => {
  assert.deepEqual(parseLatestReleaseTag(TAGS), {
    date: '2026-09-24T03:09:32-07:00',
    name: 'v2026.9.24',
    sha: 'f97608f178d1ffeca59860195ab7da295f7c8e5f'
  })
})

test('parseLatestReleaseTag reads a lightweight tag, whose object is already the commit', () => {
  assert.deepEqual(
    parseLatestReleaseTag('v0.21.5\tC15EBB143574CE8F6136B2519CA57CD684AEB3C5\t\t2026-09-25T20:00:57-05:00'),
    {
      date: '2026-09-25T20:00:57-05:00',
      name: 'v0.21.5',
      sha: 'c15ebb143574ce8f6136b2519ca57cd684aeb3c5'
    }
  )
  assert.equal(
    parseLatestReleaseTag('v2026.8.16.2\t2160b2d59c87316e82f749d77c1f25969bea1533\t\t2026-08-17')?.name,
    'v2026.8.16.2'
  )
})

test('parseLatestReleaseTag returns null rather than a pre-release or a malformed line', () => {
  assert.equal(parseLatestReleaseTag(''), null)
  assert.equal(parseLatestReleaseTag('v0.22.0-rc.1\te3dd27ee2d8b011737a4eea8e3eb3d711ab78690\t\t2026-09-26'), null)
  assert.equal(parseLatestReleaseTag('v2026.9.24\tnot-a-sha\t\t2026-09-24'), null)
  assert.equal(parseLatestReleaseTag('v2026.9.24\te3dd27ee2d8b011737a4eea8e3eb3d711ab78690'), null)
  assert.equal(parseLatestReleaseTag(undefined as unknown as string), null)
})

// ── Which tree the desktop's own updater rewrites ──────────────────────────

const FORK = '/Users/owner/Desktop/iClone OS/app'
const RUNTIME = '/Users/owner/.hermes/hermes-agent'
const everywhere = () => true

test('pickUpdaterRoot: a dev run updates the fork checkout, not the runtime', () => {
  assert.equal(
    pickUpdaterRoot({
      hasGit: everywhere,
      isSourceRoot: everywhere,
      packaged: false,
      runtimeRoot: RUNTIME,
      sourceRoot: FORK
    }),
    FORK
  )
})

test('pickUpdaterRoot: the installed app updates the runtime', () => {
  assert.equal(
    pickUpdaterRoot({
      hasGit: everywhere,
      isSourceRoot: everywhere,
      packaged: true,
      runtimeRoot: RUNTIME,
      sourceRoot: FORK
    }),
    RUNTIME
  )
})

test('pickUpdaterRoot: an explicit root wins, and a git checkout beats a bare tree', () => {
  assert.equal(
    pickUpdaterRoot({
      hasGit: everywhere,
      isSourceRoot: everywhere,
      override: '/tmp/worktree',
      packaged: true,
      runtimeRoot: RUNTIME,
      sourceRoot: FORK
    }),
    '/tmp/worktree'
  )
  assert.equal(
    pickUpdaterRoot({
      hasGit: root => root === RUNTIME,
      isSourceRoot: everywhere,
      packaged: false,
      runtimeRoot: RUNTIME,
      sourceRoot: FORK
    }),
    RUNTIME
  )
  assert.equal(
    pickUpdaterRoot({
      hasGit: () => false,
      isSourceRoot: () => false,
      packaged: true,
      runtimeRoot: RUNTIME,
      sourceRoot: FORK
    }),
    RUNTIME
  )
})

// ── The upstream cache ─────────────────────────────────────────────────────

const GOOD: IcloneUpstreamStatus = { available: true, behind: 18018 }
const OFFLINE: IcloneUpstreamStatus = { available: false, reason: 'git fetch: could not resolve host' }

test('cachedUpstream serves a good answer until the TTL, and never on force', () => {
  const cache = { failure: null, good: { at: 1_000, value: GOOD } }

  assert.equal(cachedUpstream(cache, {}, 1_000 + UPSTREAM_TTL_MS - 1), GOOD)
  assert.equal(cachedUpstream(cache, {}, 1_000 + UPSTREAM_TTL_MS), null)
  assert.equal(cachedUpstream(cache, { force: true }, 1_001), null)
  assert.equal(cachedUpstream(EMPTY_UPSTREAM_CACHE, {}, 1_001), null)
})

test('cachedUpstream holds a failure back from a non-forced retry only for the failure TTL', () => {
  const cache = { failure: { at: 1_000, value: OFFLINE }, good: null }

  assert.equal(cachedUpstream(cache, {}, 1_000 + UPSTREAM_FAILURE_TTL_MS - 1), OFFLINE)
  assert.equal(cachedUpstream(cache, {}, 1_000 + UPSTREAM_FAILURE_TTL_MS), null)
  assert.equal(cachedUpstream(cache, { force: true }, 1_001), null)
})

test('cachedUpstream cacheOnly always answers from memory, whatever the age', () => {
  assert.deepEqual(cachedUpstream(EMPTY_UPSTREAM_CACHE, { cacheOnly: true }, 0), UPSTREAM_NOT_CHECKED)
  // A stale answer is still the answer to show; the pane says how old it is.
  assert.equal(
    cachedUpstream({ failure: null, good: { at: 0, value: GOOD } }, { cacheOnly: true }, UPSTREAM_TTL_MS * 10),
    GOOD
  )
  assert.equal(cachedUpstream({ failure: { at: 0, value: OFFLINE }, good: null }, { cacheOnly: true }, 1), OFFLINE)
})

test('settleUpstream never lets a failure erase the last good answer', () => {
  const first = settleUpstream(EMPTY_UPSTREAM_CACHE, GOOD, 1_000)

  assert.equal(first.answer, GOOD)

  const failed = settleUpstream(first.cache, OFFLINE, 2_000)

  assert.deepEqual(failed.answer, { ...GOOD, refreshError: OFFLINE.reason })
  assert.deepEqual(cachedUpstream(failed.cache, { cacheOnly: true }, 3_000), failed.answer)

  const recovered = settleUpstream(failed.cache, { ...GOOD, behind: 18020 }, 4_000)

  assert.deepEqual(recovered.answer, { ...GOOD, behind: 18020 })
  assert.equal(recovered.cache.failure, null)
})

test('settleUpstream reports a first failure as-is', () => {
  assert.equal(settleUpstream(EMPTY_UPSTREAM_CACHE, OFFLINE, 1).answer, OFFLINE)
})

// ── The checker: what reaches git ──────────────────────────────────────────

function fakeRun(values: IcloneUpstreamStatus[]) {
  const pending: ((value: IcloneUpstreamStatus) => void)[] = []

  const run = vi.fn(
    () =>
      new Promise<IcloneUpstreamStatus>(resolve => {
        pending.push(resolve)
      })
  )

  const settleNext = async () => {
    pending.shift()?.(values.shift() ?? GOOD)
    await new Promise(resolve => setImmediate(resolve))
  }

  return { run, settleNext }
}

test('checker: cacheOnly never starts git, even with nothing cached', async () => {
  const { run } = fakeRun([])
  const check = createUpstreamChecker(run, () => 0)

  assert.deepEqual(await check({ cacheOnly: true }), UPSTREAM_NOT_CHECKED)
  assert.equal(run.mock.calls.length, 0)
})

test('checker: concurrent checks share one fetch, and a later one is served from cache', async () => {
  const { run, settleNext } = fakeRun([GOOD])
  const check = createUpstreamChecker(run, () => 0)

  const first = check()
  const forced = check({ force: true })

  await settleNext()

  assert.equal(await first, GOOD)
  assert.equal(await forced, GOOD)
  assert.equal(await check(), GOOD)
  assert.equal(run.mock.calls.length, 1)
})

test('checker: a dead network is not re-fetched by every non-forced call', async () => {
  let now = 0
  const { run, settleNext } = fakeRun([OFFLINE, GOOD])
  const check = createUpstreamChecker(run, () => now)

  const failed = check()
  await settleNext()

  assert.equal(await failed, OFFLINE)
  assert.equal(await check(), OFFLINE)
  assert.equal(run.mock.calls.length, 1)

  now = UPSTREAM_FAILURE_TTL_MS
  const retried = check()
  await settleNext()

  assert.equal(await retried, GOOD)
  assert.equal(run.mock.calls.length, 2)
})

test('checker: a run that throws settles as a failure, not a rejection', async () => {
  const check = createUpstreamChecker(
    () => Promise.reject(new Error('spawn git ENOENT')),
    () => 0
  )

  assert.deepEqual(await check({ force: true }), { available: false, reason: 'spawn git ENOENT' })
})

// ── Scratch repositories: the real git path ────────────────────────────────

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_AUTHOR_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  LC_ALL: 'C'
}

function sh(cwd: string, args: string[], date = '2026-09-01T00:00:00Z'): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  }).trim()
}

function commit(cwd: string, file: string, message: string, date: string): string {
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
  writeFileSync(path.join(cwd, file), `${message}\n`)
  sh(cwd, ['add', '-A'], date)
  sh(cwd, ['commit', '--quiet', '-m', message], date)

  return sh(cwd, ['rev-parse', 'HEAD'])
}

let scratch = ''

beforeAll(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'iclone-updates-'))
  // The module's git inherits process.env; keep the owner's config out of it.
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
})

afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(scratch, { force: true, recursive: true })
})

interface Repos {
  base: string
  fork: string
  release: string
  tip: string
  upstream: string
}

function makeRepos(name: string): Repos {
  const upstream = path.join(scratch, name, 'upstream')
  const fork = path.join(scratch, name, 'fork')

  mkdirSync(upstream, { recursive: true })
  mkdirSync(fork, { recursive: true })
  sh(upstream, ['init', '--quiet', '-b', 'main'])
  sh(fork, ['init', '--quiet', '-b', 'main'])

  const base = commit(upstream, 'hermes_cli/main.py', 'upstream: base', '2026-09-01T00:00:00Z')
  const release = commit(upstream, 'a.txt', 'upstream: release', '2026-09-02T00:00:00Z')

  sh(upstream, ['tag', '-a', 'v1.0.0', '-m', 'v1.0.0'], '2026-09-02T00:00:00Z')

  const tip = commit(upstream, 'b.txt', 'upstream: tip', '2026-09-03T00:00:00Z')

  // Newest of all by date, and never a re-import point.
  sh(upstream, ['tag', 'v1.0.1+canary.1'], '2026-09-04T00:00:00Z')

  writeFileSync(path.join(fork, 'README'), 'fork\n')
  mkdirSync(path.join(fork, 'iclone'), { recursive: true })
  writeFileSync(path.join(fork, 'iclone', 'UPSTREAM_BASE'), `# anchor\n${base}\n`)
  commit(fork, 'hermes_cli/main.py', `chore: import hermes-agent @ ${base.slice(0, 8)}`, '2026-09-05T00:00:00Z')
  commit(fork, 'iclone/ours.txt', 'feat: ours', '2026-09-06T00:00:00Z')
  // A fork tag that sorts above every upstream one.
  sh(fork, ['tag', 'v9.9.9'], '2026-09-07T00:00:00Z')
  sh(fork, ['remote', 'add', 'upstream', upstream])

  return { base, fork, release, tip, upstream }
}

test('checkUpstreamOnce measures from the anchor and reads tags from upstream only', async () => {
  const repos = makeRepos('measure')
  const status = await checkUpstreamOnce(repos.fork)

  assert.equal(status.available, true, status.reason)
  assert.equal(status.behind, 2)
  assert.equal(status.ownCommits, 1)
  assert.equal(status.upstreamBase, repos.base.slice(0, 10))
  assert.ok(status.upstreamTip?.endsWith('upstream: tip'))
  assert.equal(status.recent?.length, 3)
  // The fork's v9.9.9 is newer, but it is not upstream's; the canary is skipped.
  assert.deepEqual(status.latestTag, { date: '2026-09-02T00:00:00Z', name: 'v1.0.0', sha: repos.release })
  // Upstream's tags stay out of the fork's own refs/tags.
  assert.equal(sh(repos.fork, ['tag', '--list']), 'v9.9.9')
}, 30_000)

test('checkUpstreamOnce follows a tag upstream moved instead of failing the fetch', async () => {
  const repos = makeRepos('moved-tag')

  assert.equal((await checkUpstreamOnce(repos.fork)).latestTag?.sha, repos.release)

  sh(repos.upstream, ['tag', '-f', '-a', 'v1.0.0', '-m', 'v1.0.0 again', repos.tip], '2026-09-08T00:00:00Z')

  const moved = await checkUpstreamOnce(repos.fork)

  assert.equal(moved.available, true, moved.reason)
  assert.equal(moved.latestTag?.sha, repos.tip)
}, 30_000)

test('checkUpstreamOnce is unavailable, never a guessed number, without its inputs', async () => {
  const repos = makeRepos('unavailable')

  assert.equal((await checkUpstreamOnce(null)).available, false)

  sh(repos.fork, ['remote', 'remove', 'upstream'])
  assert.match((await checkUpstreamOnce(repos.fork)).reason ?? '', /Remote "upstream" is not configured/)

  sh(repos.fork, ['remote', 'add', 'upstream', repos.upstream])
  rmSync(path.join(repos.fork, 'iclone', 'UPSTREAM_BASE'))
  // The root subject names only a short sha, which cannot anchor anything.
  assert.match((await checkUpstreamOnce(repos.fork)).reason ?? '', /Cannot resolve the upstream import base/)
}, 30_000)

// ── The runtime, from local reads ──────────────────────────────────────────

function makeRuntime(name: string) {
  const homeDir = path.join(scratch, name)
  const home = path.join(homeDir, '.hermes')
  const runtime = path.join(home, 'hermes-agent')

  mkdirSync(runtime, { recursive: true })
  sh(runtime, ['init', '--quiet', '-b', 'main'])

  mkdirSync(path.join(runtime, 'hermes_cli'), { recursive: true })
  writeFileSync(path.join(runtime, 'hermes_cli', '__init__.py'), "__version__ = '0.21.5'\n")
  sh(runtime, ['add', 'hermes_cli/__init__.py'])
  const head = commit(runtime, 'hermes_cli/main.py', 'runtime head', '2026-09-20T00:00:00Z')

  // The old updater's leftovers: present on disk, never read again (H1b).
  mkdirSync(path.join(home, 'logs', 'update_receipts'), { recursive: true })
  writeFileSync(path.join(home, 'logs', 'update_receipts', 'latest.json'), '{"schema":1}')
  mkdirSync(path.join(home, 'backups'), { recursive: true })
  writeFileSync(path.join(home, 'backups', 'pre-update-2026-09-20-000100.zip'), 'zip')
  mkdirSync(path.join(homeDir, '.hermes-update-backups', 'hermes-agent-abcdef1'), { recursive: true })

  return { head, home, runtime }
}

test('readRuntimeStatus reports HEAD and the checkout version; the old receipts, zips and clones are never read', async () => {
  const { head, home, runtime } = makeRuntime('runtime-installed')

  const status = await readRuntimeStatus({
    home,
    packaged: true,
    sourceRoot: path.join(scratch, 'no-checkout')
  })

  assert.equal(status.available, true, status.reason)
  assert.equal(status.head?.sha, head)
  assert.equal(status.version, '0.21.5')
  assert.equal(status.branch, 'main')
  assert.equal(status.dirty, false)
  assert.equal(status.shallow, false)
  assert.equal(status.backupZip, null)
  assert.equal(status.receipt, null)
  assert.deepEqual(status.rollbackClones, [])
  assert.equal(status.updaterRoot, runtime)
  assert.equal(status.updaterRootIsRuntime, true)

  writeFileSync(path.join(runtime, 'scratch.txt'), 'local change\n')
  assert.equal((await readRuntimeStatus({ home, packaged: true, sourceRoot: runtime })).dirty, true)
}, 30_000)

test('readRuntimeStatus: a dev run updates its checkout, but a worktree .git file does not count', async () => {
  const { home, runtime } = makeRuntime('runtime-dev')
  const checkout = path.join(scratch, 'runtime-dev', 'checkout')

  mkdirSync(path.join(checkout, 'hermes_cli'), { recursive: true })
  writeFileSync(path.join(checkout, 'hermes_cli', 'main.py'), '')
  mkdirSync(path.join(checkout, '.git'))

  const dev = await readRuntimeStatus({ home, packaged: false, sourceRoot: checkout })

  assert.equal(dev.updaterRoot, checkout)
  assert.equal(dev.updaterRootIsRuntime, false)

  rmSync(path.join(checkout, '.git'), { recursive: true })
  writeFileSync(path.join(checkout, '.git'), 'gitdir: /elsewhere\n')

  const worktree = await readRuntimeStatus({ home, packaged: false, sourceRoot: checkout })

  assert.equal(worktree.updaterRoot, runtime)
}, 30_000)

test('V3-S r4 (ruling 36): readRuntimeStatus says "unmanaged" while a dev-backend checkout runs, never when packaged', async () => {
  const { home } = makeRuntime('runtime-unmanaged')
  const checkout = path.join(scratch, 'runtime-unmanaged', 'checkout')

  mkdirSync(path.join(checkout, 'hermes_cli'), { recursive: true })
  writeFileSync(path.join(checkout, 'hermes_cli', 'main.py'), '')

  assert.equal((await readRuntimeStatus({ home, packaged: false, sourceRoot: checkout })).unmanaged, true)
  assert.equal(
    (await readRuntimeStatus({ home, packaged: false, sourceRoot: scratch, updaterOverride: checkout })).unmanaged,
    true
  )
  assert.equal((await readRuntimeStatus({ home, packaged: false, sourceRoot: scratch })).unmanaged, false)
  assert.equal((await readRuntimeStatus({ home, packaged: true, sourceRoot: checkout })).unmanaged, false)
}, 30_000)

test('readRuntimeStatus is unavailable, with the reason, when the runtime is not a checkout', async () => {
  const homeDir = path.join(scratch, 'runtime-missing')

  const status = await readRuntimeStatus({
    home: path.join(homeDir, '.hermes'),
    packaged: true,
    sourceRoot: homeDir
  })

  assert.equal(status.available, false)
  assert.match(status.reason ?? '', /is not a git checkout/)
  assert.equal(status.receipt, null)
  assert.deepEqual(status.rollbackClones, [])
})
