/**
 * V3-RT K-RT9: main's project rule (the plugin's `project_root`, same rule) never walks up to the home folder and never
 * above HERMES_HOME — the owner's home IS a git repository, so before this every folder in it was one project.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { projectRootOf } from './classify-policy'

function world() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'krt9-')))
  const home = path.join(repo, 'home')
  const hermesHome = path.join(repo, 'hh')

  for (const dir of [
    path.join(repo, '.git'),
    path.join(home, '.git'),
    path.join(home, 'proj', 'sub'),
    path.join(home, 'code', '.git'),
    path.join(home, 'code', 'sub'),
    path.join(hermesHome, 'profiles', 'p1'),
    path.join(repo, 'elsewhere', 'deep')
  ]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  return { ceilings: [home, hermesHome], hermesHome, home, repo }
}

describe('projectRootOf (K-RT9)', () => {
  it('stops below the home folder and inside HERMES_HOME; elsewhere the git root above, as before', () => {
    const w = world()
    const root = (dir: string) => projectRootOf(dir, w.ceilings)

    expect(root(path.join(w.home, 'proj', 'sub'))).toBe(path.join(w.home, 'proj', 'sub'))
    expect(root(path.join(w.home, 'code', 'sub'))).toBe(path.join(w.home, 'code'))
    expect(root(w.home)).toBe(w.home)
    expect(root(path.join(w.hermesHome, 'profiles', 'p1'))).toBe(path.join(w.hermesHome, 'profiles', 'p1'))
    expect(root(path.join(w.repo, 'elsewhere', 'deep'))).toBe(w.repo)
  })
})

describe('the renderer-skew git call (K-RT9, found live)', () => {
  it('passes a ceiling at the update root, so git never finds the home repository around the app folder', () => {
    const settings = fs.readFileSync(path.join(__dirname, '..', 'main', 'desktop-settings.ts'), 'utf8')

    expect(settings).toMatch(
      /runResolvedGit\(args, \{\s+\.\.\.options,\s+env: \{ GIT_CEILING_DIRECTORIES: path\.dirname\(options\.cwd\), GIT_OPTIONAL_LOCKS: '0' \}/
    )
  })

  it('with that ceiling a folder without .git inside a repository is not a repository', () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'krt9-skew-')))
    const runtime = path.join(repo, 'Library', 'hermes-runtime', 'abc')

    const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
      spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', ...env } })

    fs.mkdirSync(runtime, { recursive: true })
    git(repo, ['init', '-q'])
    git(repo, [
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'home'
    ])

    expect(git(runtime, ['rev-list', '--count', 'HEAD']).status).toBe(0)
    expect(
      git(runtime, ['rev-list', '--count', 'HEAD'], { GIT_CEILING_DIRECTORIES: path.dirname(runtime) }).status
    ).not.toBe(0)
    fs.rmSync(repo, { force: true, recursive: true })
  })
})
