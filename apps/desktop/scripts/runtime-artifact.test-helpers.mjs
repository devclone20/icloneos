// Fixture git repositories for the V3-RT runtime artifact tests (never the real repo, never the network).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-artifact-'))
  const run = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-06T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-06T00:00:00Z' }
    })
      .toString()
      .trim()

  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 't@example.invalid')
  run('config', 'user.name', 't')
  run('config', 'commit.gpgsign', 'false')

  const write = (rel, text, mode) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
    if (mode) fs.chmodSync(path.join(dir, rel), mode)
  }

  const commit = message => {
    run('add', '-A')
    run('commit', '-q', '--no-verify', '-m', message)

    return run('rev-parse', 'HEAD')
  }

  return { commit, dir, run, write }
}

/** A minimal runtime repo: what buildRuntimeArtifact requires, plus the shapes the tar writer must get right. */
export function runtimeRepo() {
  const repo = gitRepo()
  repo.write('pyproject.toml', '[project]\nname = "hermes-agent"\n')
  repo.write('scripts/install.sh', '#!/bin/sh\necho installer\n', 0o755)
  repo.write('hermes_cli/iclone_policy_env.py', 'KEY = 1\n')
  repo.write('iclone/telemetry/runtime-venv-exclusions.txt', '# list\nnemo-relay\nlangfuse\n')
  repo.write('pm/runtime-venv-exclusions.txt', '# shipped\nlangfuse\nnemo-relay\n')
  repo.write('tests/test_skip.py', 'not shipped\n')
  repo.write('web/public/fonts/Commercial.woff2', 'font')
  repo.write(`deep/${'d'.repeat(90)}/${'e'.repeat(90)}/f.py`, 'long ustar path\n')
  repo.write(`deep/${'x'.repeat(200)}/${'y'.repeat(120)}.py`, 'pax path\n')
  repo.write('skills/caf\u00e9/SKILL.md', 'non-ascii\n')
  fs.mkdirSync(path.join(repo.dir, 'links'), { recursive: true })
  fs.symlinkSync('../pyproject.toml', path.join(repo.dir, 'links', 'pp.toml'))
  const big = Buffer.alloc(200_000, 7)
  fs.writeFileSync(path.join(repo.dir, 'blob.bin'), big)
  const sha = repo.commit('runtime')

  return { ...repo, sha }
}
