import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HOME_SETTINGS_REFUSED } from '../src/iclone-shared/home-settings'

import { homeSettingsRefusal, homeSettingsRefusalView, judgeHomeSettings, replaceLinkWithCopy } from './home-settings-files'

describe('homeSettingsRefusal', () => {
  let base: string
  let home: string

  const confined = () => homeSettingsRefusal(home, { doing: 'start', linksOutsideRefused: true, root: home })

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hs-')))
    home = path.join(base, 'my home')
    fs.mkdirSync(home)
  })

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('absent and plain files pass', () => {
    expect(confined()).toBeNull()
    fs.writeFileSync(path.join(home, '.env'), 'A=1\n')
    fs.writeFileSync(path.join(home, 'config.yaml'), 'a: 1\n')
    expect(confined()).toBeNull()
  })

  it('a link inside the home passes, also through a chain', () => {
    fs.writeFileSync(path.join(home, 'real.yaml'), 'a: 1\n')
    fs.symlinkSync(path.join(home, 'real.yaml'), path.join(home, 'mid.yaml'))
    fs.symlinkSync('mid.yaml', path.join(home, 'config.yaml'))
    expect(confined()).toBeNull()
  })

  it('a chain that leaves the home is outside, whatever the first hop says', () => {
    const outside = path.join(base, 'dot.yaml')

    fs.writeFileSync(outside, 'a: 1\n')
    fs.symlinkSync(outside, path.join(home, 'mid.yaml'))
    fs.symlinkSync('mid.yaml', path.join(home, 'config.yaml'))
    expect(confined()).toContain(`Your config.yaml is a link to a file outside the agent's home (${outside})`)
  })

  it('a sibling folder whose name starts with the home is outside', () => {
    const sibling = `${home}-other`

    fs.mkdirSync(sibling)
    fs.writeFileSync(path.join(sibling, 'c.yaml'), 'a: 1\n')
    fs.symlinkSync(path.join(sibling, 'c.yaml'), path.join(home, 'config.yaml'))
    expect(confined()).toContain('outside the agent')
  })

  it('a link outside passes only while the runtime is unconfined', () => {
    fs.writeFileSync(path.join(base, 'env'), 'A=1\n')
    fs.symlinkSync(path.join(base, 'env'), path.join(home, '.env'))
    expect(homeSettingsRefusal(home, { doing: 'start', linksOutsideRefused: false, root: home })).toBeNull()
    expect(confined()).toContain('Your .env is a link')
  })

  it('names both files, on one line, with a command that works on a path with a space', () => {
    fs.writeFileSync(path.join(base, 'env'), 'A=1\n')
    fs.writeFileSync(path.join(base, 'c.yaml'), 'a: 1\n')
    fs.symlinkSync(path.join(base, 'env'), path.join(home, '.env'))
    fs.symlinkSync(path.join(base, 'c.yaml'), path.join(home, 'config.yaml'))

    const refusal = confined() ?? ''

    expect(refusal).not.toContain('\n')
    expect(homeSettingsRefusalView(home, { doing: 'start', linksOutsideRefused: true, root: home })?.code).toBe(HOME_SETTINGS_REFUSED)

    for (const part of refusal.split(/(?<=\))\s(?=Your )/)) {
      execFileSync('/bin/sh', ['-c', part.slice(part.lastIndexOf('then try again: ') + 16)])
    }

    expect(confined()).toBeNull()
    expect(fs.lstatSync(path.join(home, '.env')).isFile()).toBe(true)
    expect(fs.statSync(path.join(home, '.env')).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(path.join(home, '.env'), 'utf8')).toBe('A=1\n')
    expect(fs.readFileSync(path.join(base, 'env'), 'utf8')).toBe('A=1\n')
  })

  // Decision D9, replacing "refused, confined or not": unconfined Python warns and carries on, so nothing should stop it.
  it('a dangling link: refused confined, with rm as its way out; unconfined it starts and warns', () => {
    fs.symlinkSync(path.join(base, 'gone'), path.join(home, 'config.yaml'))

    expect(confined()).toContain('a file that does not exist')
    expect(confined()).toContain(`rm '${path.join(home, 'config.yaml')}'`)

    const off = { doing: 'start', linksOutsideRefused: false, root: home } as const

    expect(homeSettingsRefusal(home, off)).toBeNull()
    expect(judgeHomeSettings(home, off).warned[0]?.message).toContain('so the agent runs without these settings.')
  })

  it('unconfined: an unreadable .env or .op.env warns, an unreadable config.yaml and a special file still stop', () => {
    const off = { doing: 'start', linksOutsideRefused: false, root: home } as const

    for (const name of ['.env', '.op.env']) {
      fs.writeFileSync(path.join(home, name), 'A=1\n')
      fs.chmodSync(path.join(home, name), 0o000)
    }

    expect(homeSettingsRefusal(home, off)).toBeNull()
    expect(judgeHomeSettings(home, off).warned.map(item => item.file)).toEqual(['.env', '.op.env'])
    expect(judgeHomeSettings(home, off).warned[0]?.message).toContain('so no key from it is loaded.')

    fs.writeFileSync(path.join(home, 'config.yaml'), 'a: 1\n')
    fs.chmodSync(path.join(home, 'config.yaml'), 0o000)
    expect(homeSettingsRefusal(home, off)).toContain('Your config.yaml')
    fs.rmSync(path.join(home, 'config.yaml'))
    execFileSync('/usr/bin/mkfifo', [path.join(home, 'config.yaml')])
    expect(homeSettingsRefusal(home, off)).toContain('is not a plain file')
  })

  it('.op.env linked outside is refused like the others, by name', () => {
    fs.writeFileSync(path.join(base, 'op'), 'OP_SERVICE_ACCOUNT_TOKEN=x\n')
    fs.symlinkSync(path.join(base, 'op'), path.join(home, '.op.env'))
    expect(confined()).toContain("Your .op.env is a link to a file outside the agent's home")
  })

  it('a home that cannot be opened is a refusal naming the folder, never a raw EACCES', () => {
    const locked = path.join(home, 'profiles-locked')

    fs.mkdirSync(locked)
    fs.chmodSync(locked, 0o000)

    try {
      const refusal = homeSettingsRefusal(locked, { doing: 'start', linksOutsideRefused: true, root: home })

      expect(refusal).toContain('sits behind a folder this app cannot open')
      expect(refusal).toContain(`chmod u+rwx`)
    } finally {
      fs.chmodSync(locked, 0o700)
    }
  })

  it('a link whose target folder is locked names that folder: chmod on the link would fail', () => {
    const folder = path.join(base, 'locked')

    fs.mkdirSync(folder)
    fs.writeFileSync(path.join(folder, 'env'), 'A=1\n')
    fs.symlinkSync(path.join(folder, 'env'), path.join(home, '.env'))
    fs.chmodSync(folder, 0o000)

    try {
      const refusal = confined()

      expect(refusal).toContain(folder)
      expect(refusal).not.toContain('chmod 600')
    } finally {
      fs.chmodSync(folder, 0o700)
    }
  })

  describe('replaceLinkWithCopy', () => {
    const on = () => ({ doing: 'start', linksOutsideRefused: true, root: home }) as const

    const linked = (name: 'config.yaml' | '.env' | '.op.env' = '.env', body = 'A=1\n') => {
      const target = path.join(fs.realpathSync(base), `real${name}`)

      fs.writeFileSync(target, body, { mode: 0o644 })
      fs.symlinkSync(target, path.join(home, name))

      return target
    }

    it.each(['config.yaml', '.env', '.op.env'] as const)('%s: the link becomes a plain 0600 copy, the original untouched', name => {
      const target = linked(name)

      expect(replaceLinkWithCopy(home, name, target, on())).toEqual({ ok: true, refusal: null })

      const after = fs.lstatSync(path.join(home, name))

      expect(after.isFile()).toBe(true)
      expect(after.mode & 0o777).toBe(0o600)
      expect(fs.readFileSync(path.join(home, name), 'utf8')).toBe('A=1\n')
      expect(fs.statSync(target).mode & 0o777).toBe(0o644)
      expect(fs.readdirSync(home).filter(item => item.endsWith('.tmp'))).toEqual([])
    })

    it('a target it cannot read says so, and the link stays', () => {
      const target = linked()

      fs.chmodSync(target, 0o000)
      expect(replaceLinkWithCopy(home, '.env', target, on())).toMatchObject({ ok: false, reason: 'unreadable' })
      expect(fs.lstatSync(path.join(home, '.env')).isSymbolicLink()).toBe(true)
      fs.chmodSync(target, 0o644)
    })

    it('a link that changed since the owner read the card is not copied', () => {
      linked()
      expect(replaceLinkWithCopy(home, '.env', path.join(base, 'something-else'), on())).toMatchObject({ ok: false, reason: 'changed' })
      expect(fs.lstatSync(path.join(home, '.env')).isSymbolicLink()).toBe(true)
    })

    it('never for what is not a refused link out: a plain file, a link inside, a link to a FIFO', () => {
      fs.writeFileSync(path.join(home, 'config.yaml'), 'a: 1\n')
      expect(replaceLinkWithCopy(home, 'config.yaml', path.join(home, 'config.yaml'), on())).toMatchObject({ ok: false, reason: 'not-a-link' })

      fs.writeFileSync(path.join(home, 'inner'), 'A=1\n')
      fs.symlinkSync(path.join(home, 'inner'), path.join(home, '.env'))
      expect(replaceLinkWithCopy(home, '.env', path.join(home, 'inner'), on())).toMatchObject({ ok: false, reason: 'not-eligible' })
      expect(fs.lstatSync(path.join(home, '.env')).isSymbolicLink()).toBe(true)

      const pipe = path.join(fs.realpathSync(base), 'pipe')

      execFileSync('/usr/bin/mkfifo', [pipe])
      fs.symlinkSync(pipe, path.join(home, '.op.env'))
      expect(replaceLinkWithCopy(home, '.op.env', pipe, on())).toMatchObject({ ok: false, reason: 'not-eligible' })
    })

    it('a file past the cap is refused, not read into main', () => {
      const target = linked()

      fs.truncateSync(target, 16 * 1024 * 1024 + 1)
      expect(replaceLinkWithCopy(home, '.env', target, on())).toMatchObject({ ok: false, reason: 'too-large' })
    })
  })

  it('a FIFO is refused without opening it, and so is a link to one, and a folder', () => {
    execFileSync('/usr/bin/mkfifo', [path.join(home, '.env')])
    expect(confined()).toContain('is not a plain file')
    fs.rmSync(path.join(home, '.env'))
    execFileSync('/usr/bin/mkfifo', [path.join(home, 'pipe')])
    fs.symlinkSync(path.join(home, 'pipe'), path.join(home, '.env'))
    expect(confined()).toContain('is not a plain file')
    fs.rmSync(path.join(home, '.env'))
    fs.mkdirSync(path.join(home, '.env'))
    expect(confined()).toContain('is not a plain file')
  })

  it('a .env that exists and cannot be read is shown, never treated as absent', () => {
    fs.writeFileSync(path.join(home, '.env'), 'A=1\n')
    fs.chmodSync(path.join(home, '.env'), 0o000)
    expect(confined()).toContain('Your .env')
    expect(confined()).toContain('exists but this app cannot read it')
    expect(confined()).toContain('chmod 600')
  })

  it('the update says the update did not run; the overlay keys only on the start', () => {
    fs.symlinkSync(path.join(base, 'gone'), path.join(home, '.env'))

    const refusal = homeSettingsRefusal(home, { doing: 'update', linksOutsideRefused: true, root: home })

    expect(refusal).toContain('so the runtime update did not run.')
    expect(refusal).not.toContain('so the agent was not started.')
  })

  it('a profile home judges inside against the root the sandbox reads', () => {
    const profile = path.join(home, 'profiles', 'p')

    fs.mkdirSync(profile, { recursive: true })
    fs.writeFileSync(path.join(home, 'config.yaml'), 'a: 1\n')
    fs.symlinkSync(path.join(home, 'config.yaml'), path.join(profile, 'config.yaml'))
    expect(homeSettingsRefusal(profile, { doing: 'start', linksOutsideRefused: true, root: home })).toBeNull()
  })
})
