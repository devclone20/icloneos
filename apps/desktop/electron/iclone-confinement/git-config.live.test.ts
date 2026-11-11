/**
 * fx10, live under the real profile: a confined command cannot make the user's next git command, in the repository the
 * project already was, run a program of its choosing. Every attack row is paired with its control: the same attack run
 * unconfined makes the same git command run the planted program, so a refusal here refuses something real. Every normal
 * command has its measured verdict. The rows named "stays open" pin what a path rule cannot close.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, chai, describe, expect, it, vi } from 'vitest'

import { createLiveWorld, type LiveWorld } from './live-harness'
import { plantHomeDecoys, probeVerdict } from './live-verdict.test-helpers'
import { SANDBOX_EXEC } from './probe'
import { createRefusalLog, startRefusalStream } from './refusals'
import { refusalWhy } from './runs'

const LIVE = process.platform === 'darwin' && existsSync(SANDBOX_EXEC)
chai.config.truncateThreshold = 0

const IDENTITY = 'export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t; '
const HOOKS_PATH_BODY = "'[core]\\n\\thooksPath = evilhooks\\n'"
const ABSOLUTE_HOOKS_PATH_BODY = '"[core]\\n\\thooksPath = $PWD/evilhooks\\n"'

let world: LiveWorld
let serial = 0

beforeAll(() => {
  if (LIVE) {
    plantHomeDecoys()
  }

  world = createLiveWorld()
})

// rmSync of a whole throwaway world, repositories included: a loaded machine takes longer than the 10 s default.
afterAll(() => {
  world?.dispose()
}, 120_000)

interface Lab {
  dir: string
  marker: string
  twin: string
}

async function plain(command: string, cwd: string): Promise<string> {
  const run = await world.runPlain(IDENTITY + command, cwd)

  if (run.code !== 0) {
    throw new Error(`setup failed (${command}): ${run.out}`)
  }

  return run.out
}

/** A folder holding the planted program; `repo` makes it a repository before any confined command runs. */
async function makeProject(repo: boolean, setup = ''): Promise<{ dir: string; marker: string }> {
  serial += 1
  const dir = path.join(world.root, `git-${serial}`)
  const marker = path.join(world.outside, `ran-${serial}`)

  mkdirSync(path.join(dir, 'evilhooks'), { recursive: true })

  const evil = `#!/bin/sh\necho ran >> '${marker}'\nexit 0\n`

  writeFileSync(path.join(dir, 'evil.sh'), evil, { mode: 0o755 })
  writeFileSync(path.join(dir, 'evilhooks', 'pre-commit'), evil, { mode: 0o755 })

  if (repo) {
    await plain(`git init -q . && git add evil.sh && git commit -q -m one ${setup ? `&& ${setup}` : ''}`, dir)
  }

  return { dir, marker }
}

const confined = (command: string, dir: string, cwd = dir) =>
  world.runConfined(IDENTITY + command, { projectRoot: dir, cwd, writeProject: true })

const ran = (marker: string) => existsSync(marker)

/** The user's next git command, unconfined; its own exit code does not matter, only whether the program ran. */
const userRuns = (command: string, cwd: string) => world.runPlain(IDENTITY + command, cwd)

interface AttackRow {
  id: string
  setup?: string
  attack: string
  trigger: string
  /** The folder the user's git command runs in, relative to the project. */
  triggerCwd?: string
}

const COMMIT = 'git commit -q --allow-empty -m two'
const WORKTREE = `git worktree add -q wt-probe -b wt-probe`

const ATTACKS: AttackRow[] = [
  { id: 'git config core.hooksPath', attack: 'git config core.hooksPath evilhooks', trigger: COMMIT },
  { id: 'git config core.fsmonitor', attack: 'git config core.fsmonitor "$PWD/evil.sh"', trigger: 'git status' },
  { id: 'append to .git/config', attack: `printf ${HOOKS_PATH_BODY} >> .git/config`, trigger: COMMIT },
  {
    id: 'rename a file over .git/config',
    attack: `(cat .git/config; printf ${HOOKS_PATH_BODY}) > .git/x; mv .git/x .git/config`,
    trigger: COMMIT
  },
  {
    id: 'unlink .git/config, then create it',
    attack: `(cat .git/config; printf ${HOOKS_PATH_BODY}) > keep; rm .git/config && cp keep .git/config`,
    trigger: COMMIT
  },
  {
    id: 'a symlink in place of .git/config',
    attack: `(cat .git/config; printf ${HOOKS_PATH_BODY}) > keep; ln -sf ../keep .git/config`,
    trigger: COMMIT
  },
  {
    id: 'write through a symlink to .git/config',
    attack: `ln -s .git/config c; printf ${HOOKS_PATH_BODY} >> c`,
    trigger: COMMIT
  },
  { id: 'case variant .GIT/config', attack: `printf ${HOOKS_PATH_BODY} >> .GIT/config`, trigger: COMMIT },
  { id: 'case variant .git/CONFIG', attack: `printf ${HOOKS_PATH_BODY} >> .git/CONFIG`, trigger: COMMIT },
  {
    id: 'firmlink form of .git/config',
    attack: `printf ${HOOKS_PATH_BODY} >> "/System/Volumes/Data$PWD/.git/config"`,
    trigger: COMMIT
  },
  {
    id: '.git/config.worktree',
    setup: 'git config extensions.worktreeConfig true',
    attack: `printf ${HOOKS_PATH_BODY} > .git/config.worktree`,
    trigger: COMMIT
  },
  {
    id: 'rename the whole .git and rebuild it',
    attack: `mv .git old && mkdir .git && cp -R old/. .git/ && printf ${HOOKS_PATH_BODY} >> .git/config`,
    trigger: COMMIT
  },
  {
    id: 'a .git file pointing at a new gitdir',
    attack: `mv .git new && printf ${HOOKS_PATH_BODY} >> new/config && printf 'gitdir: new\\n' > .git`,
    trigger: COMMIT
  },
  {
    id: 'rewrite a .git file (project is a linked checkout)',
    setup: `git init -q --separate-git-dir "$PWD.gitdir" .`,
    attack: `git init -q new && printf ${HOOKS_PATH_BODY} >> new/.git/config && printf 'gitdir: new/.git\\n' > .git`,
    trigger: COMMIT
  },
  {
    id: '.git/commondir redirects config and hooks',
    attack: `mkdir new && cp -R .git/. new/ && printf ${HOOKS_PATH_BODY} >> new/config && printf '../new\\n' > .git/commondir`,
    trigger: COMMIT
  },
  {
    id: 'a linked worktree: its commondir',
    setup: WORKTREE,
    attack: `mkdir new && cp -R .git/. new/ && printf ${ABSOLUTE_HOOKS_PATH_BODY} >> new/config && printf "$PWD/new\\n" > .git/worktrees/wt-probe/commondir`,
    trigger: COMMIT,
    triggerCwd: 'wt-probe'
  },
  {
    id: 'a linked worktree: its config.worktree',
    setup: `git config extensions.worktreeConfig true && ${WORKTREE}`,
    attack: `printf ${ABSOLUTE_HOOKS_PATH_BODY} > .git/worktrees/wt-probe/config.worktree`,
    trigger: COMMIT,
    triggerCwd: 'wt-probe'
  },
  {
    id: 'a linked worktree: its folder renamed and rebuilt',
    setup: WORKTREE,
    attack: `mkdir new && cp -R .git/. new/ && printf ${ABSOLUTE_HOOKS_PATH_BODY} >> new/config && W=.git/worktrees/wt-probe && mv $W $W.old && cp -R $W.old $W && printf "$PWD/new\\n" > $W/commondir`,
    trigger: COMMIT,
    triggerCwd: 'wt-probe'
  },
  { id: 'a hook, by name', attack: 'cp evil.sh .git/hooks/pre-commit', trigger: COMMIT },
  { id: 'a hook, case variant .Git/hooks', attack: 'cp evil.sh .Git/hooks/pre-commit', trigger: COMMIT },
  {
    id: 'the hooks folder renamed and rebuilt',
    attack: 'mv .git/hooks .git/h && mkdir .git/hooks && cp evil.sh .git/hooks/pre-commit',
    trigger: COMMIT
  }
]

describe.runIf(LIVE)('fx10: the repository the project already was', () => {
  it.each(ATTACKS)('$id: real unconfined, refused confined', async row => {
    const twin = await makeProject(true, row.setup)
    const control = await world.runPlain(IDENTITY + row.attack, twin.dir)

    expect({ control: control.code, out: control.out }).toEqual({ control: 0, out: control.out })

    await userRuns(row.trigger, path.join(twin.dir, row.triggerCwd ?? '.'))
    expect({ id: row.id, plantedProgramRan: ran(twin.marker) }).toEqual({ id: row.id, plantedProgramRan: true })

    const lab = await makeProject(true, row.setup)
    const outcome = await confined(row.attack, lab.dir)

    expect({ id: row.id, verdict: probeVerdict(outcome) }).toEqual({ id: row.id, verdict: 'refused' })

    await userRuns(row.trigger, path.join(lab.dir, row.triggerCwd ?? '.'))
    expect({ id: row.id, plantedProgramRan: ran(lab.marker) }).toEqual({ id: row.id, plantedProgramRan: false })
  })

  it('the project folder itself cannot be renamed away (its .git would be free to replace)', async () => {
    const lab = await makeProject(true)
    const outcome = await confined(`mv "$PWD" "$PWD.moved"`, lab.dir, world.root)

    expect(probeVerdict(outcome)).toBe('refused')
    expect(existsSync(path.join(lab.dir, '.git', 'config'))).toBe(true)
  })

  it.each([
    ['.git/remotes/origin', 'mkdir -p .git/remotes && printf "URL: ext::$PWD/evil.sh\\n" > .git/remotes/origin'],
    ['.git/branches/origin', 'mkdir -p .git/branches && printf "ext::$PWD/evil.sh\\n" > .git/branches/origin']
  ])('%s names a program as a remote, and git refuses the transport: no rule needed', async (_name, attack) => {
    const lab = await makeProject(true)

    expect(probeVerdict(await confined(attack, lab.dir)).startsWith('allowed')).toBe(true)
    const fetch = await userRuns('git fetch origin', lab.dir)

    expect(fetch.out).toContain("transport 'ext' not allowed")
    expect(ran(lab.marker)).toBe(false)
  })

  it('.git/info/attributes names a filter, and no program runs: drivers live in config only', async () => {
    const lab = await makeProject(true)
    const outcome = await confined(`printf '* filter=evil\\n' > .git/info/attributes; echo x > f`, lab.dir)

    expect(probeVerdict(outcome).startsWith('allowed')).toBe(true)
    await userRuns('git add f', lab.dir)
    expect(ran(lab.marker)).toBe(false)
  })
})

interface NormalRow {
  id: string
  setup?: string
  command: string
  verdict: 'allowed' | 'refused'
}

const REMOTE = 'git init -q --bare remote.bare && git remote add origin "$PWD/remote.bare" && git push -q origin HEAD:refs/heads/main && git update-ref refs/remotes/origin/main HEAD'
const REMOTE_AHEAD = `${REMOTE} && git clone -q remote.bare peer && (cd peer && git commit -q --allow-empty -m peer && git push -q origin HEAD:main; true) && git branch -q --set-upstream-to=origin/main`

const NORMAL_IN_A_REPOSITORY: NormalRow[] = [
  { id: 'git init (a nested folder)', command: 'git init -q nested', verdict: 'allowed' },
  { id: 'git clone (into the project)', setup: REMOTE, command: 'git clone -q remote.bare cloned', verdict: 'allowed' },
  {
    id: 'remote add, config and push -u inside a nested clone',
    setup: REMOTE,
    command: 'git clone -q remote.bare cloned && cd cloned && git config user.name me && git remote add two ../remote.bare && git checkout -q -b t && git commit -q --allow-empty -m t && git push -q --set-upstream origin t',
    verdict: 'allowed'
  },
  { id: 'git add', command: 'echo x > f && git add f', verdict: 'allowed' },
  { id: 'git commit', command: 'git commit -q --allow-empty -m two', verdict: 'allowed' },
  { id: 'git branch', command: 'git branch b', verdict: 'allowed' },
  { id: 'git checkout -b', command: 'git checkout -q -b b', verdict: 'allowed' },
  { id: 'git switch -c', command: 'git switch -q -c b', verdict: 'allowed' },
  { id: 'git fetch', setup: REMOTE, command: 'git fetch -q origin', verdict: 'allowed' },
  { id: 'git pull', setup: REMOTE_AHEAD, command: 'git pull -q --no-rebase origin main', verdict: 'allowed' },
  { id: 'git push', setup: REMOTE, command: 'git push -q origin HEAD:refs/heads/next', verdict: 'allowed' },
  { id: 'git stash, tag, merge, rebase, gc', command: 'echo a >> evil.sh && git stash -q && git stash pop -q && git tag t && git checkout -q -b b && git commit -q -am b && git checkout -q - && git merge -q b && git rebase -q b && git gc -q', verdict: 'allowed' },
  { id: 'git config --global (this session only)', command: 'git config --global user.name me', verdict: 'allowed' },
  { id: 'git -c user.name for one command', command: 'git -c user.name=me commit -q --allow-empty -m two', verdict: 'allowed' },
  { id: 'git remote add', command: 'git remote add other "$PWD"', verdict: 'refused' },
  { id: 'git config user.name', command: 'git config user.name me', verdict: 'refused' },
  { id: 'git worktree add', command: 'git worktree add -q wt -b wt', verdict: 'refused' },
  { id: 'git init again on the same repository', command: 'git init -q .', verdict: 'refused' }
]

describe.runIf(LIVE)('fx10: normal git work, measured', () => {
  it.each(NORMAL_IN_A_REPOSITORY)('in an existing repository, $id: $verdict', async row => {
    const lab = await makeProject(true, row.setup)
    const outcome = await confined(row.command, lab.dir)
    const verdict = probeVerdict(outcome)

    expect({ id: row.id, verdict: verdict.startsWith('allowed') ? 'allowed' : verdict }).toEqual({ id: row.id, verdict: row.verdict })
  })

  // git exits 0 here: the work is done, only the upstream is not recorded, and it prints the kernel's refusal.
  it.each([
    ['git push --set-upstream', 'git push -q --set-upstream origin HEAD:refs/heads/up', 'git -C remote.bare rev-parse -q --verify refs/heads/up'],
    ['git branch --set-upstream-to', 'git branch --set-upstream-to=origin/main', 'git rev-parse HEAD'],
    ['git checkout -b x origin/x', 'git checkout -q -b t origin/main', 'git rev-parse -q --verify refs/heads/t']
  ])('in an existing repository, %s: the work goes, the upstream is refused', async (_id, command, workDone) => {
    const lab = await makeProject(true, REMOTE)
    const config = path.join(lab.dir, '.git', 'config')
    const before = readFileSync(config, 'utf8')
    const outcome = await confined(command, lab.dir)

    expect(outcome.code).toBe(0)
    expect(outcome.out).toContain('Operation not permitted')
    expect(readFileSync(config, 'utf8')).toBe(before)
    await plain(workDone, lab.dir)
  })

  it('a project with no .git: git init, remote add, config, commit and push -u all go in one run', async () => {
    const lab = await makeProject(false)

    const outcome = await confined(
      'git init -q . && git config user.name me && git init -q --bare "$TMPDIR/r.bare" && git remote add origin "$TMPDIR/r.bare" && git add evil.sh && git commit -q -m one && git push -q --set-upstream origin HEAD',
      lab.dir
    )

    expect(probeVerdict(outcome).startsWith('allowed')).toBe(true)
    expect(readFileSync(path.join(lab.dir, '.git', 'config'), 'utf8')).toContain('[remote "origin"]')
  })

  it('a project with no .git: git clone into the project root', async () => {
    const lab = await makeProject(false)
    const empty = path.join(lab.dir, 'empty')

    mkdirSync(empty)

    const outcome = await confined('git init -q --bare "$TMPDIR/s.bare" && git clone -q "$TMPDIR/s.bare" .', empty)

    expect(probeVerdict(outcome).startsWith('allowed')).toBe(true)
  })

  it('from the next run on, a repository is what it is: the same config write is refused', async () => {
    const lab = await makeProject(false)

    expect(probeVerdict(await confined('git init -q .', lab.dir)).startsWith('allowed')).toBe(true)
    expect(probeVerdict(await confined('git config user.name me', lab.dir))).toBe('refused')
  })
})

describe.runIf(LIVE)('fx10: what stays open, on purpose and in the public text', () => {
  const OPEN: AttackRow[] = [
    {
      id: 'a repository the agent creates in a subfolder',
      attack: `git init -q sub && cp -R evilhooks sub/evilhooks && printf ${HOOKS_PATH_BODY} >> sub/.git/config`,
      trigger: COMMIT,
      triggerCwd: 'sub'
    },
    {
      id: 'an existing nested repository: its parent folder moved aside and rebuilt',
      setup: 'mkdir -p a && git init -q a/sub',
      attack: `mv a a.old && mkdir a && git init -q a/sub && cp -R evilhooks a/sub/evilhooks && printf ${HOOKS_PATH_BODY} >> a/sub/.git/config`,
      trigger: COMMIT,
      triggerCwd: 'a/sub'
    },
    {
      id: 'a bare-layout folder (no .git at all)',
      attack: `mkdir sub && git init -q --bare sub/b && cp -R evilhooks sub/b/evilhooks && printf '[core]\\n\\tbare = false\\n\\tworktree = .\\n\\thooksPath = evilhooks\\n' >> sub/b/config`,
      trigger: COMMIT,
      triggerCwd: 'sub/b'
    }
  ]

  it.each(OPEN)('$id: the planted program runs (stays open)', async row => {
    const lab = await makeProject(true, row.setup)
    const outcome = await confined(row.attack, lab.dir)

    expect(probeVerdict(outcome).startsWith('allowed')).toBe(true)
    await userRuns(row.trigger, path.join(lab.dir, row.triggerCwd ?? '.'))
    expect({ id: row.id, plantedProgramRan: ran(lab.marker) }).toEqual({ id: row.id, plantedProgramRan: true })
  })

  it('a project that had no .git when the run started: the agent writes its config (stays open)', async () => {
    const lab = await makeProject(false)
    const outcome = await confined(`git init -q . && printf ${HOOKS_PATH_BODY} >> .git/config`, lab.dir)

    expect(probeVerdict(outcome).startsWith('allowed')).toBe(true)
    await userRuns(COMMIT, lab.dir)
    expect(ran(lab.marker)).toBe(true)
  })
})

describe.runIf(LIVE)('fx10: the refusal row the Containers pane shows', () => {
  it('a blocked git config reaches the log with its target, and main reads it as git-config', async () => {
    const lab = await makeProject(true)
    const target = path.join(realpathSync(lab.dir), '.git', 'config')
    const seen: { operation: string; process: string; target: string }[] = []

    const stream = startRefusalStream({
      log: createRefusalLog(path.join(world.root, 'git-refusals')),
      membersDir: world.paths.membersDir,
      confined: async () => new Map(),
      onRefusal: refusal => seen.push(refusal)
    })

    try {
      await vi.waitFor(
        async () => {
          expect(probeVerdict(await confined('git config user.name me', lab.dir))).toBe('refused')
          expect(seen.some(row => row.target === target)).toBe(true)
        },
        { timeout: 15_000, interval: 500 }
      )
    } finally {
      stream.stop()
    }

    const row = seen.find(item => item.target === target)!

    expect(row.operation.startsWith('file-write')).toBe(true)
    expect(refusalWhy(row, null, { project: realpathSync(lab.dir), write: true })).toBe('git-config')
  }, 30_000)
})
