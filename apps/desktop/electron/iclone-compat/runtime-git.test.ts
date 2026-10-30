import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { parseReflog, readRuntimeFile, repoGit, repoGitEnv, runtimeHead } from './runtime-git'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-rg-'))
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

// A throwaway repo with two commits, built without any inherited git config.
function twoCommitRepo(name: string): string {
  const dir = path.join(tmp, name)

  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=test', ...args], {
      cwd: dir,
      env: repoGitEnv(),
      stdio: 'pipe'
    })

  fs.mkdirSync(dir, { recursive: true })
  git('init', '-q')

  for (const i of [0, 1]) {
    fs.writeFileSync(path.join(dir, 'x'), `${name}${i}\n`)
    git('add', 'x')
    git('commit', '-qm', String(i))
  }

  return dir
}

function withEnv<T>(key: string, value: string, fn: () => T): T {
  process.env[key] = value

  try {
    return fn()
  } finally {
    delete process.env[key]
  }
}

describe('iclone-compat runtime-git', () => {
  it('reads HEAD through loose and packed refs without a git process', () => {
    const rt = path.join(tmp, 'rt')
    fs.mkdirSync(path.join(rt, '.git', 'refs', 'heads'), { recursive: true })
    fs.writeFileSync(path.join(rt, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    fs.writeFileSync(path.join(rt, '.git', 'packed-refs'), `# pack-refs\n${A} refs/heads/main\n`)
    expect(runtimeHead(rt)).toBe(A)
    fs.writeFileSync(path.join(rt, '.git', 'refs', 'heads', 'main'), `${B}\n`)
    expect(runtimeHead(rt)).toBe(B)
    expect(() => readRuntimeFile(rt, '.git/config')).toThrow(/refused/)
    expect(() => readRuntimeFile(rt, '../outside')).toThrow(/refused/)
  })

  it('parses reflog lines', () => {
    const line = `${A} ${B} Owner <o@example.invalid> 1757980800 +0100\tpull: Fast-forward`
    expect(parseReflog(line)).toEqual([{ from: A, to: B, at: 1757980800, message: 'pull: Fast-forward' }])
  })

  it('refuses write-capable subcommands, writing or networked flags and the runtime home', () => {
    expect(() => repoGit(tmp, ['status'])).toThrow(/refused subcommand/)
    expect(() => repoGit(tmp, ['fetch', 'upstream'])).toThrow(/refused subcommand/)
    expect(() => repoGit(tmp, ['diff', '--ext-diff'])).toThrow(/refused argument/)
    expect(() => repoGit(tmp, ['archive', '--output=x.tar', 'HEAD'])).toThrow(/refused argument/)
    expect(() => repoGit(tmp, ['log'], { forbidden: [tmp] })).toThrow(/runtime home/)
  })

  it('ignores an inherited GIT_DIR: git never reads a forbidden repo past the cwd check', () => {
    const allowed = twoCommitRepo('allowed')
    const forbidden = twoCommitRepo('forbidden')

    const gitDir = withEnv('GIT_DIR', path.join(forbidden, '.git'), () =>
      repoGit(allowed, ['rev-parse', '--absolute-git-dir'], { forbidden: [forbidden] }).trim()
    )

    expect(fs.realpathSync(gitDir)).toBe(fs.realpathSync(path.join(allowed, '.git')))
    expect(repoGitEnv({ PATH: '/bin', GIT_DIR: '/x', GIT_WORK_TREE: '/y', GIT_EXTERNAL_DIFF: 'z' })).toMatchObject({
      PATH: '/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_NO_LAZY_FETCH: '1',
      GIT_OPTIONAL_LOCKS: '0'
    })
    expect(Object.keys(repoGitEnv({ GIT_DIR: '/x', GIT_CONFIG_PARAMETERS: 'p', GIT_EXEC_PATH: '/e' }))).not.toEqual(
      expect.arrayContaining(['GIT_DIR', 'GIT_CONFIG_PARAMETERS', 'GIT_EXEC_PATH'])
    )
  })

  it('never runs an external diff program injected through GIT_CONFIG_PARAMETERS or GIT_EXTERNAL_DIFF', () => {
    const repo = twoCommitRepo('ext')
    const marker = path.join(tmp, 'external-ran')
    const program = path.join(tmp, 'ext.sh')
    fs.writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })

    const diff = withEnv('GIT_CONFIG_PARAMETERS', `'diff.external'='${program}'`, () =>
      withEnv('GIT_EXTERNAL_DIFF', program, () => repoGit(repo, ['diff', 'HEAD~1', 'HEAD'], { forbidden: [] }))
    )

    expect(diff).toContain('+ext1')
    expect(fs.existsSync(marker)).toBe(false)
  })
})
