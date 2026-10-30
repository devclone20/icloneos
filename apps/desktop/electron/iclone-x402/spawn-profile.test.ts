import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { spawnProfile } from './spawn-profile'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** A user home with `.hermes` (the platform default) and its `profiles/`. */
function world(): { base: string; home: string; hermesHome: string; env: NodeJS.ProcessEnv } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v3jsp-')))
  const home = path.join(base, 'home')
  const hermesHome = path.join(home, '.hermes')

  dirs.push(base)
  fs.mkdirSync(path.join(hermesHome, 'profiles'), { recursive: true })

  return { base, home, hermesHome, env: { HOME: home } }
}

/** Every entry under `dir` with its bytes and mtime: the resolver must leave all of it as it was. */
function snapshot(dir: string): string[] {
  const out: string[] = []

  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const file = path.join(at, entry.name)
      const stat = fs.lstatSync(file)

      out.push(`${path.relative(dir, file)}:${stat.mtimeMs}:${entry.isFile() ? fs.readFileSync(file, 'hex') : ''}`)

      if (entry.isDirectory()) {
        walk(file)
      }
    }
  }

  walk(dir)

  return out.sort()
}

describe('J4-1: the profile a spawn runs as is the one Hermes would pick (fix m-r3-2)', () => {
  it('J4-1: a desktop profile is pinned as it always was; the sticky file is not read', () => {
    const w = world()

    fs.writeFileSync(path.join(w.hermesHome, 'active_profile'), 'away\n')

    expect(spawnProfile('coder', { hermesHome: w.hermesHome, env: w.env })).toMatchObject({
      args: ['--profile', 'coder'],
      slug: 'coder'
    })
    expect(spawnProfile('default', { hermesHome: w.hermesHome, env: w.env })).toMatchObject({
      args: ['--profile', 'default'],
      slug: 'default'
    })
  })

  it('J4-1: no sticky file (or empty, or `default` in any case) ⇒ `default`, pinned so a later file cannot move it', () => {
    const w = world()
    const run = () => spawnProfile(null, { hermesHome: w.hermesHome, env: w.env })

    expect(run()).toMatchObject({ args: ['--profile', 'default'], slug: 'default' })

    for (const text of ['', '\n', '  default  \n', 'DEFAULT\n', 'Default']) {
      fs.writeFileSync(path.join(w.hermesHome, 'active_profile'), text)
      expect(run()).toMatchObject({ args: ['--profile', 'default'], slug: 'default' })
    }
  })

  it('J4-1: a sticky profile with a folder is pinned and is the slug; Hermes’ own normalisation (strip, lower case)', () => {
    const w = world()

    fs.mkdirSync(path.join(w.hermesHome, 'profiles', 'away'))

    for (const text of ['away', 'away\n', '  Away \r\n', '\tAWAY　', '\u0085away\u001c']) {
      fs.writeFileSync(path.join(w.hermesHome, 'active_profile'), text)
      expect(spawnProfile(null, { hermesHome: w.hermesHome, env: w.env })).toMatchObject({
        args: ['--profile', 'away'],
        slug: 'away'
      })
    }
  })

  it('J4-1: a profile folder that is a link counts (Hermes follows it); the unprotected check is the socket’s, after the seed', () => {
    const w = world()
    const outside = path.join(w.base, 'elsewhere', 'away')

    fs.mkdirSync(outside, { recursive: true })
    fs.symlinkSync(outside, path.join(w.hermesHome, 'profiles', 'away'))
    fs.writeFileSync(path.join(w.hermesHome, 'active_profile'), 'away\n')

    expect(spawnProfile(null, { hermesHome: w.hermesHome, env: w.env })).toMatchObject({
      args: ['--profile', 'away'],
      slug: 'away'
    })
  })

  it('J4-1: a sticky value Hermes refuses (bad name, reserved, no folder, BOM kept by Python) ⇒ no flag and no slug', () => {
    const w = world()

    fs.mkdirSync(path.join(w.hermesHome, 'profiles', 'hermes'))
    fs.mkdirSync(path.join(w.hermesHome, 'profiles', 'away'))

    for (const text of ['bad name\n', '../away\n', 'hermes\n', 'ghost\n', '﻿away\n', `${'a'.repeat(65)}\n`]) {
      fs.writeFileSync(path.join(w.hermesHome, 'active_profile'), text)
      expect(spawnProfile(null, { hermesHome: w.hermesHome, env: w.env })).toMatchObject({ args: [], slug: null })
    }
  })

  it('J4-1: a sticky file Hermes skips (not UTF-8, a folder, a dangling link) ⇒ `default`', () => {
    const w = world()
    const file = path.join(w.hermesHome, 'active_profile')

    fs.writeFileSync(file, Buffer.from([0x61, 0xff, 0x0a]))
    expect(spawnProfile(null, { hermesHome: w.hermesHome, env: w.env }).slug).toBe('default')

    fs.rmSync(file)
    fs.mkdirSync(file)
    expect(spawnProfile(null, { hermesHome: w.hermesHome, env: w.env }).slug).toBe('default')

    fs.rmSync(file, { recursive: true })
    fs.symlinkSync(path.join(w.base, 'nothing'), file)
    expect(spawnProfile(null, { hermesHome: w.hermesHome, env: w.env }).slug).toBe('default')
  })

  it('J4-1: a supervised s6 child never follows the sticky file; a profile-shaped HERMES_HOME runs as itself', () => {
    const w = world()

    fs.mkdirSync(path.join(w.hermesHome, 'profiles', 'away'))
    fs.writeFileSync(path.join(w.hermesHome, 'active_profile'), 'away\n')

    expect(
      spawnProfile(null, { hermesHome: w.hermesHome, env: { ...w.env, HERMES_S6_SUPERVISED_CHILD: '1' } })
    ).toMatchObject({ args: ['--profile', 'default'], slug: 'default' })
    expect(spawnProfile(null, { hermesHome: path.join(w.hermesHome, 'profiles', 'away'), env: w.env })).toMatchObject({
      args: [],
      slug: 'default'
    })
  })

  it('J4-1: the sticky file lives in Hermes’ default root (the platform home when HERMES_HOME is under it), the folder under HERMES_HOME', () => {
    const w = world()
    const sub = path.join(w.hermesHome, 'sub')
    const custom = path.join(w.base, 'custom-home')

    fs.mkdirSync(path.join(sub, 'profiles', 'away'), { recursive: true })
    fs.mkdirSync(path.join(custom, 'profiles', 'mine'), { recursive: true })
    fs.writeFileSync(path.join(w.hermesHome, 'active_profile'), 'away\n')
    fs.writeFileSync(path.join(sub, 'active_profile'), 'ignored\n')
    fs.writeFileSync(path.join(custom, 'active_profile'), 'mine\n')

    expect(spawnProfile(null, { hermesHome: sub, env: w.env }).slug).toBe('away')
    expect(spawnProfile(null, { hermesHome: custom, env: w.env }).slug).toBe('mine')
    expect(
      spawnProfile(null, { hermesHome: custom, env: { LOCALAPPDATA: path.join(w.base, 'local') }, platform: 'win32' })
        .slug
    ).toBe('mine')
  })

  it('J4-1: resolving never writes: the Hermes home is byte- and mtime-identical afterwards', () => {
    const w = world()

    fs.mkdirSync(path.join(w.hermesHome, 'profiles', 'away'))
    fs.writeFileSync(path.join(w.hermesHome, 'active_profile'), 'away\n')

    const before = snapshot(w.base)

    spawnProfile(null, { hermesHome: w.hermesHome, env: w.env })
    expect(snapshot(w.base)).toEqual(before)
  })

  it('m-r4-5: a sticky file over 64 KiB is read as empty: `default`, pinned, even when a strip of it would name a profile', () => {
    const w = world()

    fs.mkdirSync(path.join(w.hermesHome, 'profiles', 'coder'))
    fs.writeFileSync(path.join(w.hermesHome, 'active_profile'), `coder${' '.repeat(64 * 1024)}`)

    expect(spawnProfile(null, { hermesHome: w.hermesHome, env: w.env })).toMatchObject({
      args: ['--profile', 'default'],
      slug: 'default'
    })

    fs.writeFileSync(path.join(w.hermesHome, 'active_profile'), `coder${' '.repeat(64 * 1024 - 6)}`)
    expect(spawnProfile(null, { hermesHome: w.hermesHome, env: w.env }).slug).toBe('coder')
  })

  it('m-r4-5: the default root is decided on resolved paths: a HERMES_HOME reached through a link into ~/.hermes reads ~/.hermes/active_profile', () => {
    const w = world()
    const alias = path.join(w.base, 'alias')
    const sub = path.join(w.hermesHome, 'sub')

    fs.mkdirSync(path.join(sub, 'profiles', 'coder'), { recursive: true })
    fs.symlinkSync(w.hermesHome, alias)
    // Hermes' default root for <alias>/sub is the platform home (it resolves both): its sticky file decides.
    fs.writeFileSync(path.join(w.hermesHome, 'active_profile'), 'coder\n')

    expect(spawnProfile(null, { hermesHome: path.join(alias, 'sub'), env: w.env })).toMatchObject({
      args: ['--profile', 'coder'],
      slug: 'coder'
    })
  })
})
