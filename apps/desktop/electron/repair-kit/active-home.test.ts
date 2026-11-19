// v0.0.9 W1b — the repair kit's HERMES_HOME is the one the spawned agent reads (spawnProfile + profileHermesHome),
// never an assumed `~/.hermes`. Throwaway homes only (env.HOME points at a temp folder). Red on the old code: the
// module did not exist and the kit read only the root HERMES_HOME.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { activeProfileHermesHome } from './active-home'

let root: string
let home: string
let hermes: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w1b-active-home-')))
  home = path.join(root, 'home')
  hermes = path.join(home, '.hermes')
  fs.mkdirSync(path.join(hermes, 'profiles', 'work'), { recursive: true })
})

afterEach(() => fs.rmSync(root, { force: true, recursive: true }))

const env = () => ({ HOME: home }) as NodeJS.ProcessEnv

describe('activeProfileHermesHome', () => {
  it('the desktop profile wins: <root>/profiles/<name>', () => {
    expect(activeProfileHermesHome(hermes, 'work', { env: env(), platform: 'darwin' })).toBe(
      path.join(hermes, 'profiles', 'work')
    )
  })

  it('"default" is the root itself', () => {
    expect(activeProfileHermesHome(hermes, 'default', { env: env(), platform: 'darwin' })).toBe(hermes)
  })

  it('no desktop preference: the sticky active_profile file decides, read the way Hermes reads it', () => {
    fs.writeFileSync(path.join(hermes, 'active_profile'), 'work\n')

    expect(activeProfileHermesHome(hermes, null, { env: env(), platform: 'darwin' })).toBe(
      path.join(hermes, 'profiles', 'work')
    )
  })

  it('a sticky name with no folder (Hermes refuses it): the root', () => {
    fs.writeFileSync(path.join(hermes, 'active_profile'), 'ghost\n')

    expect(activeProfileHermesHome(hermes, null, { env: env(), platform: 'darwin' })).toBe(hermes)
  })

  it('a custom root HERMES_HOME is honoured (never ~/.hermes)', () => {
    const custom = path.join(root, 'elsewhere')

    fs.mkdirSync(path.join(custom, 'profiles', 'lab'), { recursive: true })

    expect(activeProfileHermesHome(custom, 'lab', { env: env(), platform: 'darwin' })).toBe(
      path.join(custom, 'profiles', 'lab')
    )
    expect(activeProfileHermesHome(custom, null, { env: env(), platform: 'darwin' })).toBe(custom)
  })
})
