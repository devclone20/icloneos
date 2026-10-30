import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ACTIVITY_CLASSES } from '../../src/iclone-shared/confinement'

import {
  acceptableProjectRoot,
  buildProfileSpec,
  type ConfinementPaths,
  KEYCHAIN_SERVICES,
  NEVER_EXEC
} from './profiles'
import { auditSbpl, globToSbplRegex, renderSbpl } from './sbpl'

const paths: ConfinementPaths = {
  home: '/Users/owner',
  hermesHome: '/Users/owner/.hermes',
  userDataDir: '/Users/owner/Library/Application Support/iclone os',
  hermesRoot: '/Applications/iclone os.app/Contents/Resources/hermes',
  profilesDir: '/Users/owner/Library/Application Support/iclone os/confinement/profiles',
  scratchRoot: '/Users/owner/Library/Caches/iclone-os-confinement/scratch',
  membersDir: '/Users/owner/Library/Caches/iclone-os-confinement/members'
}

const render = (cls: (typeof ACTIVITY_CLASSES)[number]) => renderSbpl(buildProfileSpec(cls, paths))
const code = (text: string) => text.split('\n').filter(line => !line.startsWith(';'))

describe('renderSbpl', () => {
  it.each(ACTIVITY_CLASSES)('%s opens with a tagged (deny default) right after the version', cls => {
    const lines = code(render(cls))

    expect(lines[0]).toBe('(version 1)')
    expect(lines[1]).toBe(`(deny default (with message "iclone-confined:${cls}"))`)
  })

  it.each(ACTIVITY_CLASSES)('%s is byte-stable for the same spec', cls => {
    expect(render(cls)).toBe(render(cls))
  })

  it.each(ACTIVITY_CLASSES)('%s ends with the denies no allow can lift, every one tagged', cls => {
    const tail = render(cls).split('\n').filter(Boolean).slice(-6)

    expect(tail[0]).toMatch(/^; never/)
    expect(
      tail
        .slice(1)
        .every(line => line.startsWith('(deny ') && line.endsWith(`(with message "iclone-confined:${cls}"))`))
    ).toBe(true)
    expect(tail.join('\n')).toContain('(subpath "/Users/owner/.ssh")')
    expect(tail.join('\n')).toContain('(subpath "/Users/owner/Library/Keychains")')
    expect(tail.join('\n')).toContain('(subpath "/Library/Keychains")')
    expect(tail.join('\n')).toContain(`(subpath "${paths.userDataDir}")`)
    // F7: no hard link is made from inside, in any class (a link renames an inode the path rules judged elsewhere).
    expect(tail.at(-1)).toBe(`(deny file-link (with message "iclone-confined:${cls}"))`)

    for (const service of KEYCHAIN_SERVICES) {
      expect(tail.join('\n')).toContain(`(global-name "${service}")`)
    }

    for (const binary of NEVER_EXEC) {
      expect(tail.join('\n')).toContain(`(literal "${binary}")`)
    }
  })

  it('opens the network only inside the NET conditional, and never for offline and media', () => {
    for (const cls of ['research', 'project', 'build'] as const) {
      const lines = render(cls)
        .split('\n')
        .filter(line => line.includes('network-outbound'))

      expect(lines).toHaveLength(1)
      expect(lines[0].startsWith('(if (equal? (param "NET") "1")')).toBe(true)
      expect(lines[0]).toContain('(remote ip "*:*")')
      expect(lines[0]).not.toMatch(/\(allow network-outbound\)/)
    }

    expect(render('offline')).not.toContain('network')
    expect(render('media')).not.toContain('network')
  })

  it('writes the project only under WRITE_PROJECT=1, and only in the classes that may', () => {
    for (const cls of ['project', 'build', 'offline'] as const) {
      expect(render(cls)).toContain(
        '(if (equal? (param "WRITE_PROJECT") "1") (allow file-write* (subpath (param "PROJECT_ROOT"))))'
      )
    }

    for (const cls of ['research', 'media'] as const) {
      expect(render(cls)).not.toContain('WRITE_PROJECT')
      expect(render(cls)).not.toMatch(/file-write\*[^\n]*PROJECT_ROOT/)
    }
  })

  it('media reads and writes one output dir; build fills the package caches', () => {
    expect(render('media')).toContain('(allow file-write* (subpath (param "SCRATCH")) (subpath (param "OUTPUT_DIR")))')
    expect(render('build')).toContain('(subpath "/Users/owner/.npm/_cacache")')
    expect(render('project')).not.toContain('.npm/_cacache')
  })

  it('never names an rc file that holds a token as readable', () => {
    for (const cls of ACTIVITY_CLASSES) {
      const allows = render(cls)
        .split('\n')
        .filter(line => line.startsWith('(allow'))
        .join('\n')

      for (const secret of [
        '.npmrc',
        '.netrc',
        '.pypirc',
        '.git-credentials',
        '.ssh',
        'Keychains',
        '.aws',
        '.config/gh'
      ]) {
        expect(allows).not.toContain(secret)
      }
    }
  })

  it('refuses a path that could close the SBPL string early', () => {
    for (const bad of ['/tmp/a"b', '/tmp/a\\b', '/tmp/a\nb', 'relative/path', '/tmp/\u0000']) {
      expect(() => renderSbpl({ ...buildProfileSpec('project', paths), extraReads: [bad] })).toThrow(/unsafe path/)
    }
  })
})

describe('globToSbplRegex', () => {
  it('turns * into one path segment and escapes the rest', () => {
    expect(globToSbplRegex('/Users/owner/.ssh/id_*')).toBe('(regex #"^/Users/owner/\\.ssh/id_[^/]*$")')
    expect(globToSbplRegex('/a/b(c).d')).toBe('(regex #"^/a/b\\(c\\)\\.d$")')
  })
})

describe('auditSbpl — the negative control detector', () => {
  it.each(ACTIVITY_CLASSES)('the generated %s profile is not widened', cls => {
    expect(auditSbpl(render(cls))).toEqual({ widened: false, problems: [] })
  })

  it('flags (allow default), a missing default deny, and unfiltered allows', () => {
    expect(auditSbpl('(version 1)\n(allow default)\n').problems).toEqual(['no (deny default)', '(allow default)'])
    expect(auditSbpl(`${render('project')}(allow default)\n`).widened).toBe(true)
    expect(auditSbpl(`${render('project')}(allow file-read*)\n`).problems).toEqual([
      'an operation allowed with no filter'
    ])
    expect(auditSbpl(`${render('project')}(allow network-outbound)\n`).widened).toBe(true)
    expect(auditSbpl(render('project').replace('(deny default', '(allow default')).widened).toBe(true)
  })

  it('a widening hidden inside a NET-looking conditional is still caught', () => {
    const smuggled = `${render('offline')}(if (equal? (param "NET") "1") (allow file-read*))\n`

    expect(auditSbpl(smuggled).widened).toBe(true)
  })

  it('a comment cannot hide or fake the default deny', () => {
    const text = render('project').replace(/^\(deny default.*$/m, '; (deny default)')

    expect(auditSbpl(text).problems).toContain('no (deny default)')
  })
})

describe('acceptableProjectRoot', () => {
  const spec = buildProfileSpec('project', paths)
  const ok = (root: string) => acceptableProjectRoot(root, spec, paths.home)

  it('accepts a project under the home', () => {
    expect(ok('/Users/owner/Developer/app')).toBe(true)
  })

  it('refuses /, the home, its ancestors, Library, the app state and every secret dir', () => {
    for (const root of [
      '/',
      '/Users',
      '/Users/owner',
      '/Users/owner/Library',
      '/Users/owner/Library/Application Support/iclone os',
      '/Users/owner/.ssh',
      '/Users/owner/.aws/sub',
      path.join(paths.hermesHome, '.env'),
      'relative'
    ]) {
      expect(ok(root)).toBe(false)
    }
  })
})
