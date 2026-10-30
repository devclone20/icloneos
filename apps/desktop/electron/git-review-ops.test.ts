import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import {
  gitFor,
  gitForShip,
  isSafeRef,
  repoStatus,
  resolveRenamePath,
  REVIEW_FILE_CAP,
  reviewCommit,
  reviewDiff,
  reviewList,
  reviewPush,
  reviewRevParse,
  SHIP_ENVIRONMENT
} from './git-review-ops'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

/** A repo with `tracked.txt` and `files` committed by one `git add` + one `git commit`: no per-file git work. */
function makeRepo(files: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-desktop-git-status-'))

  tempDirs.push(dir)

  for (const [name, body] of Object.entries({ 'tracked.txt': 'tracked\n', ...files })) {
    fs.writeFileSync(path.join(dir, name), body)
  }

  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync(
    'git',
    ['-c', 'user.email=hermes-test@example.com', '-c', 'user.name=Hermes Test', 'commit', '-qm', 'initial'],
    { cwd: dir }
  )

  return dir
}

test('resolveRenamePath: plain path is unchanged', () => {
  assert.equal(resolveRenamePath('src/a.ts'), 'src/a.ts')
})

test('gitFor accepts an internally resolved git binary path containing spaces', () => {
  assert.doesNotThrow(() => gitFor(process.cwd(), 'C:\\Program Files\\Git\\cmd\\git.exe'))
})

test('gitFor runs git through a spaced binary path', async () => {
  if (process.platform !== 'win32') {
    return
  }

  const gitBin = path.join(process.env.ProgramFiles || String.raw`C:\Program Files`, 'Git', 'cmd', 'git.exe')

  if (!fs.existsSync(gitBin)) {
    return
  }

  const repo = makeRepo()

  fs.writeFileSync(path.join(repo, 'changed.txt'), 'review me\n')

  const status = await gitFor(repo, gitBin).status()

  assert.equal(status.not_added.includes('changed.txt'), true)
})

test('resolveRenamePath: simple rename resolves to the new path', () => {
  assert.equal(resolveRenamePath('old.ts => new.ts'), 'new.ts')
})

test('resolveRenamePath: brace rename resolves to the new path', () => {
  assert.equal(resolveRenamePath('src/{old => new}/file.ts'), 'src/new/file.ts')
})

test('resolveRenamePath: brace rename collapsing a segment', () => {
  assert.equal(resolveRenamePath('src/{lib => }/file.ts'), 'src/file.ts')
})

test('repoStatus reports an untracked directory without recursively listing its contents', async () => {
  const dir = makeRepo()
  const nested = path.join(dir, 'generated', 'deep')

  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(nested, 'large-output.txt'), 'generated\n')

  const status = await repoStatus(dir, 'git')

  assert.ok(status)
  assert.equal(status.untracked, 1)
  assert.equal(status.changed, 1)
  assert.deepEqual(
    status.files.map(file => file.path),
    ['generated/']
  )
})

test('reviewList reports an untracked directory without recursively listing its contents', async () => {
  const dir = makeRepo()
  const nested = path.join(dir, 'browser-profile', 'Default', 'Cache')

  fs.mkdirSync(nested, { recursive: true })

  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(path.join(nested, `cache-${i}.bin`), 'generated\n')
  }

  const result = await reviewList(dir, 'uncommitted', null, 'git')

  assert.deepEqual(
    result.files.map(file => file.path),
    ['browser-profile/']
  )
})

test('reviewList caps the file payload returned to the renderer', async () => {
  const names = Array.from({ length: REVIEW_FILE_CAP + 10 }, (_, i) => `file-${String(i).padStart(4, '0')}.txt`)
  const dir = makeRepo(Object.fromEntries(names.map(name => [name, 'committed\n'])))

  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), 'changed\n')
  }

  const result = await reviewList(dir, 'uncommitted', null, 'git')

  assert.equal(result.files.length, REVIEW_FILE_CAP)
  assert.deepEqual(result.files[0], { path: 'file-0000.txt', added: 1, removed: 1, status: 'M', staged: false })
  // 2 010 files through real git: under a parallel --full run this took 16 s, past the project's 15 s default.
}, 60_000)

// G-42: simple-git 4 removes ambient GIT_* variables from git's environment (gitFor's allowEnvironment is empty).
// A GIT_DIR leaked into the main process (a git hook, a terminal launch) must not point the review ops at another
// repository: with the variable let through, rev-parse answers with the other repository's HEAD.
test('the review ops read the repository they were given, whatever GIT_DIR the main process carries', async () => {
  const mine = makeRepo()
  const other = makeRepo({ 'other.txt': 'other\n' })
  const headOf = (dir: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  const mineHead = headOf(mine)

  assert.notEqual(headOf(other), mineHead)

  const saved = process.env.GIT_DIR

  process.env.GIT_DIR = path.join(other, '.git')

  try {
    assert.equal(await reviewRevParse(mine, 'HEAD', 'git'), mineHead)
    assert.equal((await gitFor(mine, 'git').revparse(['HEAD'])).trim(), mineHead)
  } finally {
    if (saved === undefined) {
      delete process.env.GIT_DIR
    } else {
      process.env.GIT_DIR = saved
    }
  }
})

// G-42 (review R1-A minor 1): a ref from the renderer sits after the subcommand, where simple-git's guard does not
// look; `git diff --output=<file>` writes a file. The ref is checked, and follows --end-of-options.
test('a ref that is an option is refused before git reads it as one', async () => {
  const repo = makeRepo()
  const out = path.join(repo, 'written-by-git.txt')

  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n')

  assert.equal(await reviewRevParse(repo, `--output=${out}`, 'git'), null)
  assert.deepEqual(await reviewList(repo, 'lastTurn', `--output=${out}`, 'git'), { files: [], base: null })
  assert.equal(await reviewDiff(repo, 'tracked.txt', 'lastTurn', `--output=${out}`, false, 'git'), '')
  assert.equal(fs.existsSync(out), false)

  // The baseline the app really sends (a sha from rev-parse) still works.
  const head = await reviewRevParse(repo, 'HEAD', 'git')

  assert.match(String(head), /^[0-9a-f]{40}$/)
  assert.deepEqual(
    (await reviewList(repo, 'lastTurn', head, 'git')).files.map(file => file.path),
    ['tracked.txt']
  )
  assert.match(String(await reviewDiff(repo, 'tracked.txt', 'lastTurn', head, false, 'git')), /^\+changed$/m)
})

test('isSafeRef: revisions in, options, ranges and odd shapes out', () => {
  for (const ref of ['HEAD', 'HEAD~1', 'abc123^', 'origin/main', 'feature/x-y', 'v1.2.3', 'a'.repeat(40)]) {
    assert.equal(isSafeRef(ref), true, ref)
  }

  for (const ref of [
    '',
    '-x',
    '--output=/tmp/x',
    '--end-of-options',
    'a..b',
    'a...b',
    'a b',
    '/abs',
    '.hidden',
    'a//b',
    'dir/',
    'x.lock',
    'x.',
    'HEAD@{1}',
    'a;b',
    'a\nb',
    'x'.repeat(257),
    null,
    42
  ]) {
    assert.equal(isSafeRef(ref), false, String(ref))
  }
})

/** Run `fn` with `vars` set in this (main) process's environment, then put every one back as it was. */
async function withMainEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]))

  Object.assign(process.env, vars)

  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

const SHIP_IDENTITY = {
  GIT_AUTHOR_NAME: 'Shell Author',
  GIT_AUTHOR_EMAIL: 'shell-author@example.com',
  GIT_COMMITTER_NAME: 'Shell Committer',
  GIT_COMMITTER_EMAIL: 'shell-committer@example.com'
}

const lastCommit = (dir: string, format: string) =>
  execFileSync('git', ['log', '-1', `--format=${format}`], { cwd: dir, encoding: 'utf8' }).trim()

// v0.0.4 review F2: simple-git 4 strips ambient GIT_* and SSH_ASKPASS. The review pane's write ops let exactly these
// eight through, from the main process's own environment; the read ops keep an empty list.
test('the ship environment is exactly the identity, push-auth and CA-bundle variables', () => {
  assert.deepEqual(
    [...SHIP_ENVIRONMENT],
    [
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
      'GIT_SSH_COMMAND',
      'GIT_ASKPASS',
      'SSH_ASKPASS',
      'GIT_SSL_CAINFO'
    ]
  )
  assert.equal((SHIP_ENVIRONMENT as readonly string[]).includes('GIT_SSL_NO_VERIFY'), false)
})

/** A script that writes the GIT_SSL_* variables it was started with to `out`, then exits with `code`. */
function sslEnvRecorder(dir: string, name: string, out: string, code: number) {
  const script = path.join(dir, name)

  fs.writeFileSync(script, `#!/bin/sh\nenv | grep '^GIT_SSL_' | sort > '${out}'\nexit ${code}\n`, { mode: 0o755 })

  return script
}

const SSL_ENV = { GIT_SSL_CAINFO: '/etc/corporate-ca.pem', GIT_SSL_NO_VERIFY: '1' }

// v0.0.4 review m6 (lead addendum): GIT_SSL_CAINFO reaches git for commit and push; GIT_SSL_NO_VERIFY, present in the
// same main-process environment, never does. git hands its own environment to its hooks and to the ssh command, so
// what they record is what git ran with.
test('a review-pane commit gets GIT_SSL_CAINFO from the main process, never GIT_SSL_NO_VERIFY', async () => {
  const repo = makeRepo()
  const seen = path.join(repo, 'commit-env.txt')

  sslEnvRecorder(path.join(repo, '.git', 'hooks'), 'pre-commit', seen, 0)
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n')

  await withMainEnv({ ...SHIP_IDENTITY, ...SSL_ENV }, () => reviewCommit(repo, 'ssl env', false, 'git'))

  assert.equal(lastCommit(repo, '%s'), 'ssl env')
  assert.equal(fs.readFileSync(seen, 'utf8'), 'GIT_SSL_CAINFO=/etc/corporate-ca.pem\n')
})

test('a review-pane push gets GIT_SSL_CAINFO from the main process, never GIT_SSL_NO_VERIFY', async () => {
  const repo = makeRepo()
  const seen = path.join(repo, 'push-env.txt')
  const recorder = sslEnvRecorder(repo, 'record-ssh-env.sh', seen, 1)

  execFileSync('git', ['remote', 'add', 'origin', 'ssh://git@example.invalid/repo.git'], { cwd: repo })

  await withMainEnv({ GIT_SSH_COMMAND: `sh '${recorder}'`, ...SSL_ENV }, () =>
    assert.rejects(() => reviewPush(repo, 'git'))
  )

  assert.equal(fs.readFileSync(seen, 'utf8'), 'GIT_SSL_CAINFO=/etc/corporate-ca.pem\n')
})

test('a review-pane commit is by the GIT_AUTHOR_* and GIT_COMMITTER_* the main process carries', async () => {
  const repo = makeRepo()

  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n')

  await withMainEnv(SHIP_IDENTITY, () => reviewCommit(repo, 'from the review pane', false, 'git'))

  assert.equal(lastCommit(repo, '%s'), 'from the review pane')
  assert.equal(lastCommit(repo, '%an <%ae>'), 'Shell Author <shell-author@example.com>')
  assert.equal(lastCommit(repo, '%cn <%ce>'), 'Shell Committer <shell-committer@example.com>')
})

test('a review-pane push runs the GIT_SSH_COMMAND the main process carries', async () => {
  const repo = makeRepo()
  const marker = path.join(repo, 'ssh-command-ran.txt')
  const recorder = path.join(repo, 'record-ssh.sh')

  // Records its argv and refuses the connection: offline, and git reports the push as failed.
  fs.writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n' "$@" > '${marker}'\nexit 1\n`)
  execFileSync('git', ['remote', 'add', 'origin', 'ssh://git@example.invalid/repo.git'], { cwd: repo })

  await withMainEnv({ GIT_SSH_COMMAND: `sh '${recorder}'` }, () => assert.rejects(() => reviewPush(repo, 'git')))

  assert.ok(fs.existsSync(marker), 'git never ran the GIT_SSH_COMMAND of the main process')
  assert.match(fs.readFileSync(marker, 'utf8'), /example\.invalid/)
})

test('the write ops still strip every other guarded variable (GIT_DIR, GIT_CONFIG_PARAMETERS)', async () => {
  const mine = makeRepo()
  const other = makeRepo({ 'other.txt': 'other\n' })
  const otherHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: other, encoding: 'utf8' }).trim()
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-desktop-git-hooks-'))
  const marker = path.join(hooks, 'hook-ran.txt')

  tempDirs.push(hooks)
  fs.writeFileSync(path.join(hooks, 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(mine, 'tracked.txt'), 'changed\n')

  await withMainEnv(
    {
      ...SHIP_IDENTITY,
      GIT_DIR: path.join(other, '.git'),
      GIT_CONFIG_PARAMETERS: `'core.hookspath'='${hooks}'`
    },
    () => reviewCommit(mine, 'mine only', false, 'git')
  )

  assert.equal(lastCommit(mine, '%s'), 'mine only')
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: other, encoding: 'utf8' }).trim(), otherHead)
  assert.equal(fs.existsSync(marker), false, 'GIT_CONFIG_PARAMETERS reached git')
})

test('a GIT_SSH_COMMAND handed to git explicitly is refused: only the main process environment supplies it', async () => {
  const repo = makeRepo()
  const marker = path.join(repo, 'explicit-ssh-command-ran.txt')

  execFileSync('git', ['remote', 'add', 'origin', 'ssh://git@example.invalid/repo.git'], { cwd: repo })

  await assert.rejects(
    () =>
      gitForShip(repo, 'git')
        .env({ PATH: process.env.PATH ?? '', GIT_SSH_COMMAND: `touch '${marker}'` })
        .raw(['push', 'origin', 'HEAD']),
    /allowUnsafeSshCommand/
  )
  assert.equal(fs.existsSync(marker), false)
})
