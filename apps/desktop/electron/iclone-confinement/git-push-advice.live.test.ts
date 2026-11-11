/**
 * fx14, live under the real profile: what the pane may tell an agent to do after `git push -u` could not save its
 * upstream. Each row is measured, so the sentence in `ledger.why['git-config']` says only what these rows show.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createLiveWorld, type LiveWorld } from './live-harness'
import { SANDBOX_EXEC } from './probe'

const LIVE = process.platform === 'darwin' && existsSync(SANDBOX_EXEC)
const IDENTITY = 'export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t; '

let world: LiveWorld
let serial = 0

beforeAll(() => {
  world = createLiveWorld()
})

afterAll(() => {
  world?.dispose()
})

/** A repository the project already was, with a local remote and one pushed commit, on branch `work`. */
async function project(): Promise<string> {
  serial += 1

  const dir = path.join(world.root, `advice-${serial}`)

  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'a.txt'), 'a\n')

  const setup = await world.runPlain(
    `${IDENTITY}git init -q -b work . && git add a.txt && git commit -q -m one && git init -q --bare remote.bare && git remote add origin "$PWD/remote.bare" && git push -q origin work`,
    dir
  )

  expect(setup.code, setup.out).toBe(0)

  return dir
}

const confined = (command: string, dir: string) =>
  world.runConfined(IDENTITY + command, { projectRoot: dir, cwd: dir, writeProject: true })

const remoteHead = async (dir: string) => (await world.runPlain('git -C remote.bare rev-parse work', dir)).out.trim()
const localHead = async (dir: string) => (await world.runPlain('git rev-parse work', dir)).out.trim()

const commitThen = (then: string) => `git commit -q --allow-empty -m next && ${then}`

describe.skipIf(!LIVE)('what to do when git could not save an upstream', () => {
  it('measures each route in order', async () => {
    const dir = await project()
    const rows: Record<string, { code: number | null; landed: boolean; out: string }> = {}

    const measure = async (name: string, command: string) => {
      const run = await confined(commitThen(command), dir)

      rows[name] = {
        code: run.code,
        landed: (await remoteHead(dir)) === (await localHead(dir)),
        out: run.out.slice(-300)
      }
    }

    await measure('push -u', 'git push -u origin work')
    await measure('bare push after -u', 'git push')
    await measure('named push', 'git push origin work')
    await measure('global remote only, then bare push', 'git config --global branch.work.remote origin; git push')
    await measure(
      'global remote and merge, then bare push',
      'git config --global branch.work.remote origin; git config --global branch.work.merge refs/heads/work; git push'
    )
    await measure('bare push in the next command', 'git push')
    await measure(
      'identity by -c',
      'git -c user.name=me -c user.email=me@me commit -q --allow-empty -m c; git push origin work'
    )

    if (process.env.ADVICE_OUT) {
      writeFileSync(process.env.ADVICE_OUT, `${JSON.stringify(rows, null, 2)}\n`)
    }

    // branch.<b>.remote alone does not bring back a bare push (the pane never suggests it); with .merge it does.
    expect(rows['global remote only, then bare push']?.landed, JSON.stringify(rows)).toBe(false)
    expect(rows['global remote and merge, then bare push']?.landed, JSON.stringify(rows)).toBe(true)
    // Named push always lands, and so does -c.
    expect(rows['named push']?.landed, JSON.stringify(rows)).toBe(true)
    expect(rows['identity by -c']?.landed, JSON.stringify(rows)).toBe(true)
    // The lens's own finding: the bare push after -u does not.
    expect(rows['bare push after -u']?.landed, JSON.stringify(rows)).toBe(false)
  }, 120_000)
})
