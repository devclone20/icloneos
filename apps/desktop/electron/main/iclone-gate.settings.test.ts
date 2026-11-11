/** The real prepareHermesSpawn on a home whose settings file is a link: refused first, in plain words, for primary and pool. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { HOME_SETTINGS_NOT_STARTED } from '../../src/iclone-shared/home-settings'
import { isIcloneGateFailure } from '../../src/iclone-shared/iclone-gate'
import { homeSettingsRefusalView } from '../home-settings-files'

const h = vi.hoisted(() => ({ confined: true, home: '' }))

h.home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'igs-')))

vi.mock('electron', () => ({
  app: { getAppPath: () => h.home, getPath: () => h.home, getVersion: () => '0.0.6', isPackaged: false },
  safeStorage: {}
}))
vi.mock('./env', () => ({
  get HERMES_HOME() {
    return path.join(h.home, 'hh')
  },
  IS_PACKAGED: false,
  isHermesSourceRoot: () => false,
  SOURCE_REPO_ROOT: h.home
}))
vi.mock('./log', () => ({ rememberLog: vi.fn() }))
vi.mock('../iclone-confinement/ipc', () => ({
  confinementSpawnEnv: () => (h.confined ? { ICLONE_CONFINEMENT: '1', ICLONE_RUNTIME_CONFINED: '1' } : {})
}))

const { prepareHermesSpawn } = await import('./iclone-gate')

const hermesHome = path.join(h.home, 'hh')

const spawnFor = (profile: null | string, role: 'pool' | 'primary') =>
  prepareHermesSpawn({ backend: { command: '/nowhere/python', root: null }, cwd: h.home, profile, role })

const messageOf = (run: Promise<unknown>) =>
  run.then(
    () => '',
    (error: Error) => error.message
  )

describe('prepareHermesSpawn on linked settings', () => {
  beforeEach(() => {
    h.confined = true
    fs.rmSync(hermesHome, { force: true, recursive: true })
    fs.mkdirSync(path.join(hermesHome, 'profiles', 'p'), { recursive: true })
    fs.writeFileSync(path.join(h.home, 'dot'), 'a: 1\n')
  })

  afterAll(() => fs.rmSync(h.home, { force: true, recursive: true }))

  it('primary, confined: the file named and the fix, not a gate failure', async () => {
    fs.symlinkSync(path.join(h.home, 'dot'), path.join(hermesHome, 'config.yaml'))

    const message = await messageOf(spawnFor(null, 'primary'))

    expect(message).toContain("Your config.yaml is a link to a file outside the agent's home")
    expect(message).toContain('cp -L')
    // What the overlay is told over IPC is what the start really threw: the two can never drift apart.
    const view = homeSettingsRefusalView(hermesHome, { doing: 'start', linksOutsideRefused: true, root: hermesHome })

    expect(view?.findings.map(finding => finding.message).join(' ')).toBe(message)
    expect(isIcloneGateFailure(message)).toBe(false)
  })

  it('pool: the home of its own profile is the one judged', async () => {
    fs.symlinkSync(path.join(h.home, 'dot'), path.join(hermesHome, 'profiles', 'p', '.env'))

    expect(await messageOf(spawnFor('p', 'pool'))).toContain('Your .env is a link')
    expect(await messageOf(spawnFor(null, 'pool'))).not.toContain(HOME_SETTINGS_NOT_STARTED)
  })

  it('unconfined: a link out of the home is not this refusal, since the runtime can read it', async () => {
    h.confined = false
    fs.symlinkSync(path.join(h.home, 'dot'), path.join(hermesHome, 'config.yaml'))

    expect(await messageOf(spawnFor(null, 'primary'))).not.toContain(HOME_SETTINGS_NOT_STARTED)
  })
})
