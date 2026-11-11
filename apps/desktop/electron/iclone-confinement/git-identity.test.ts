import { spawnSync } from 'node:child_process'
import type * as Fs from 'node:fs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { gitIdentityEnv, gitIdentityFromText, readGlobalGitIdentity, unquoteGitValue } from './git-identity'

vi.mock('node:fs', async importOriginal => {
  const real = await importOriginal<typeof Fs>()

  return { ...real, default: real, readFileSync: vi.fn(real.readFileSync) }
})

/** fx18 (F3): main reads the user's name and e-mail, and only those, for the runtime's scratch git config. */
describe('fx20 — lens5 m2: what travels and what is read', () => {
  it('a control character never reaches the spawn env, which Node would refuse whole; a value is capped at 256', () => {
    const env = gitIdentityEnv(gitIdentityFromText(`[user]\n\tname = a\u0000b\u0007c\n\temail = ${'e'.repeat(400)}\n`))

    expect(env.ICLONE_GIT_USER_NAME).toBe('abc')
    expect(env.ICLONE_GIT_USER_EMAIL).toHaveLength(256)
    expect(spawnSync('/usr/bin/true', [], { env }).status).toBe(0)
  })

  it('a link is followed (lead, proof5 F-a); a FIFO, a link to one and a file over 1 MB are not read: no hang', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'iclone-git-m2-'))
    const config = path.join(scratch, '.gitconfig')
    const identity = () => readGlobalGitIdentity(scratch, path.join(scratch, 'xdg'))

    try {
      writeFileSync(path.join(scratch, 'real'), '[user]\n\tname = Linked\n')
      symlinkSync(path.join(scratch, 'real'), config)
      expect(identity().name).toBe('Linked')
      rmSync(config)
      symlinkSync(path.join(scratch, 'gone'), config)
      expect(identity().name).toBe('')
      rmSync(config)
      // fx23 (critic r2-A): a FIFO with no writer also reads empty, so an empty name alone proves nothing: it is never read.
      vi.mocked(readFileSync).mockClear()
      expect(spawnSync('/usr/bin/mkfifo', [config]).status).toBe(0)
      expect(identity().name).toBe('')
      expect(vi.mocked(readFileSync)).not.toHaveBeenCalled()
      rmSync(config)
      expect(spawnSync('/usr/bin/mkfifo', [path.join(scratch, 'pipe')]).status).toBe(0)
      symlinkSync(path.join(scratch, 'pipe'), config)
      expect(identity().name).toBe('')
      expect(vi.mocked(readFileSync)).not.toHaveBeenCalled()
      rmSync(config)
      writeFileSync(path.join(scratch, 'big'), `[user]\n\tname = BigLinked\n${'#'.repeat(1024 * 1024)}\n`)
      symlinkSync(path.join(scratch, 'big'), config)
      expect(identity().name).toBe('')
      rmSync(config)
      writeFileSync(config, `[user]\n\tname = Big\n${'#'.repeat(1024 * 1024)}\n`)
      expect(identity().name).toBe('')
      rmSync(config)
      writeFileSync(config, '[user]\n\tname = Plain\n')
      expect(identity().name).toBe('Plain')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

describe('git identity for a confined commit', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true })}
  })

  it('reads name and email from [user] and nothing from the rest of the file', () => {
    const text = [
      '[credential]',
      '\thelper = store',
      '[user]',
      '\tname = Alex "the" Rider ; trailing comment',
      '\temail = alex@example.invalid # trailing comment',
      '\tsigningkey = ABCDEF',
      '[url "https://token:secret@example.invalid/"]',
      '\tinsteadOf = https://example.invalid/'
    ].join('\n')

    const identity = gitIdentityFromText(text)
    expect(identity).toEqual({ name: 'Alex the Rider', email: 'alex@example.invalid' })
    expect(JSON.stringify(identity)).not.toContain('secret')
    expect(JSON.stringify(identity)).not.toContain('ABCDEF')
  })

  it('[users] and [user "sub"] are not [user], and a later file wins', () => {
    const first = gitIdentityFromText('[users]\n\tname = wrong\n[user "x"]\n\tname = wrong-too\n[user]\n\tname = first\n')
    expect(first).toEqual({ name: 'first', email: '' })
    const second = gitIdentityFromText('[user]\n\temail = second@example.invalid\n', first)
    expect(second).toEqual({ name: 'first', email: 'second@example.invalid' })
  })

  it('values follow git quoting: escapes, quoted comment marks, newlines never survive', () => {
    expect(unquoteGitValue('  "a # not a comment" \\"q\\" \\\\ ')).toBe('a # not a comment "q" \\')
    expect(unquoteGitValue(' plain ; comment')).toBe('plain')
    expect(gitIdentityFromText('[user]\n\tname = "line\\nbreak"\n').name).toBe('line break')
  })

  it('reads the XDG file then ~/.gitconfig, and an unreadable file is no identity', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'iclone-git-identity-'))
    roots.push(home)
    expect(readGlobalGitIdentity(home)).toEqual({ name: '', email: '' })
    mkdirSync(path.join(home, '.config', 'git'), { recursive: true })
    writeFileSync(path.join(home, '.config', 'git', 'config'), '[user]\n\tname = from-xdg\n\temail = xdg@example.invalid\n')
    writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = from-home\n')
    expect(readGlobalGitIdentity(home)).toEqual({ name: 'from-home', email: 'xdg@example.invalid' })
  })

  it('the spawn env carries only the two values, and none for an empty identity', () => {
    expect(gitIdentityEnv({ name: 'n', email: 'e' })).toEqual({ ICLONE_GIT_USER_NAME: 'n', ICLONE_GIT_USER_EMAIL: 'e' })
    expect(gitIdentityEnv({ name: '', email: '' })).toEqual({})
  })
})
