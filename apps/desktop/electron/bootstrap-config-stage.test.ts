/** Critic B-m1 and B-n3: the managed update judges config.yaml and .env as the launch does, and says why when it refuses. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const confined = vi.hoisted(() => ({ on: true }))

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', isPackaged: false, getVersion: () => '0.0.6' } }))
vi.mock('./iclone-confinement/ipc', () => ({
  confinementSpawnEnv: () => (confined.on ? { ICLONE_RUNTIME_CONFINED: '1' } : {})
}))

const { removeOrphanedBootstrapCache, spawnBash } = await import('./bootstrap-runner')

describe('the config stage in spawnBash', () => {
  let base: string
  let home: string
  let script: string

  const runConfig = () => {
    const lines: string[] = []

    return spawnBash(script, ['--stage', 'config', '--non-interactive', '--json'], {
      emit: event => {
        if (event.type === 'log') {
          lines.push(event.line)
        }
      },
      hermesHome: home
    }).then(result => ({ ...result, lines }))
  }

  beforeEach(() => {
    confined.on = true
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bcs-')))
    home = path.join(base, 'hh')
    fs.mkdirSync(home)
    script = path.join(base, 's.sh')
    fs.writeFileSync(script, 'echo RAN\n')
  })

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('a link inside the home runs the stage, as it starts (critic repro: code 78, script never run)', async () => {
    fs.writeFileSync(path.join(home, 'real.yaml'), 'a: 1\n')
    fs.symlinkSync(path.join(home, 'real.yaml'), path.join(home, 'config.yaml'))

    const result = await runConfig()

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('RAN')
  })

  it('a link outside, confined: refused before bash, with the reason and the command on the result and in the log', async () => {
    fs.writeFileSync(path.join(base, 'env'), 'A=1\n')
    fs.symlinkSync(path.join(base, 'env'), path.join(home, '.env'))

    const result = await runConfig()

    expect(result.code).toBe(78)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Your .env is a link to a file outside')
    expect(result.stderr).toContain('so the runtime update did not run.')
    expect(result.stderr).toContain('cp -L')
    expect(result.lines.join('\n')).toContain('cp -L')
  })

  it('a link outside, unconfined: the same as its launch, the stage runs', async () => {
    confined.on = false
    fs.writeFileSync(path.join(base, 'env'), 'A=1\n')
    fs.symlinkSync(path.join(base, 'env'), path.join(home, '.env'))

    expect((await runConfig()).code).toBe(0)
  })

  it('a dangling link is refused either way: the old installer would seed through it', async () => {
    confined.on = false
    fs.symlinkSync(path.join(base, 'made'), path.join(home, 'config.yaml'))

    expect((await runConfig()).code).toBe(78)
    expect(fs.existsSync(path.join(base, 'made'))).toBe(false)
  })
})

describe('removeOrphanedBootstrapCache', () => {
  let base: string
  let home: string

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'boc-')))
    home = path.join(base, 'hh')
    fs.mkdirSync(home)
  })

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('removes the old folder, leaves the new one, says it once', () => {
    fs.mkdirSync(path.join(home, 'bootstrap-cache', 'sub'), { recursive: true })
    fs.writeFileSync(path.join(home, 'bootstrap-cache', 'install-abc.sh'), 'x')
    fs.writeFileSync(path.join(home, 'bootstrap-cache', 'sub', 'y'), 'y')
    fs.mkdirSync(path.join(home, 'installs', 'bootstrap-cache'), { recursive: true })
    fs.writeFileSync(path.join(home, 'installs', 'bootstrap-cache', 'install-new.sh'), 'x')
    const log = vi.fn()

    removeOrphanedBootstrapCache(home, log)
    removeOrphanedBootstrapCache(home, log)

    expect(fs.existsSync(path.join(home, 'bootstrap-cache'))).toBe(false)
    expect(fs.existsSync(path.join(home, 'installs', 'bootstrap-cache', 'install-new.sh'))).toBe(true)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('a planted link inside it or in its place is removed, its target untouched', () => {
    const victim = path.join(base, 'victim')

    fs.mkdirSync(victim)
    fs.writeFileSync(path.join(victim, 'keep'), 'k')
    fs.mkdirSync(path.join(home, 'bootstrap-cache'))
    fs.symlinkSync(victim, path.join(home, 'bootstrap-cache', 'in'))
    removeOrphanedBootstrapCache(home, () => undefined)
    expect(fs.readFileSync(path.join(victim, 'keep'), 'utf8')).toBe('k')
    expect(fs.existsSync(path.join(home, 'bootstrap-cache'))).toBe(false)

    fs.symlinkSync(victim, path.join(home, 'bootstrap-cache'))
    removeOrphanedBootstrapCache(home, () => undefined)
    expect(fs.readFileSync(path.join(victim, 'keep'), 'utf8')).toBe('k')
    expect(fs.lstatSync(path.join(home, 'bootstrap-cache'), { throwIfNoEntry: false })).toBeUndefined()
  })
})
