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
import { auditSbpl, debuggerDenials, globToSbplRegex, renderSbpl } from './sbpl'

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
/** The tag every deny carries: the class, then the run's own token file, resolved from the MEMBER parameter. */
const tag = (cls: string) => `(with message (string-append "iclone-confined:${cls}:" (param "MEMBER")))`

describe('renderSbpl', () => {
  // R31, R32: both halves of the kernel route to another process, in every class; never kern.proc*, never an open allow.
  it.each(ACTIVITY_CLASSES)('%s: sysctl-read is a named list and process-info reaches only the process itself', cls => {
    const code = render(cls).split('\n')
    const deny = code.findIndex(line => line.startsWith('(deny sysctl-read (with message'))

    expect(deny).toBeGreaterThan(0)
    expect(code).not.toContain('(allow sysctl-read)')
    expect(code[deny + 1]).toContain('(sysctl-name "kern.argmax")')
    expect(code[deny + 1]).toContain('(sysctl-name-prefix "hw.")')
    expect(code[deny + 1]).toContain('(sysctl-name-prefix "kern.os")')
    expect(code[deny + 1]).not.toContain('kern.proc')
    expect(code[deny + 1]).not.toMatch(/sysctl-name-prefix "kern\.?"/)
    expect(code.filter(line => line.startsWith('(allow sysctl-read'))).toHaveLength(1)
    expect(code[deny + 2]).toMatch(/^\(deny process-info\* \(with message/)
    expect(code[deny + 3]).toBe('(allow process-info* (target self))')
    expect(code.filter(line => line.includes('process-info'))).toHaveLength(2)
  })

  it.each(ACTIVITY_CLASSES)('%s opens with a tagged (deny default) right after the version', cls => {
    const lines = code(render(cls))

    expect(lines[0]).toBe('(version 1)')
    expect(lines[1]).toBe(`(deny default ${tag(cls)})`)
  })

  it('the tag names the run through the MEMBER parameter, never as a literal, so the kernel’s line names the run', () => {
    expect(render('project')).not.toMatch(/with message "iclone-confined/)
    expect(auditSbpl(render('project')).widened).toBe(false)
  })

  it.each(ACTIVITY_CLASSES)('%s is byte-stable for the same spec', cls => {
    expect(render(cls)).toBe(render(cls))
  })

  it.each(ACTIVITY_CLASSES)('%s ends with the denies no allow can lift, every one tagged', cls => {
    // fx10's and fx13's conditional denies are lines of this block with their own tests below; every other row holds.
    // The debugger's denies follow it, untagged on purpose, each its own exact line (browser-debugger.live.test.ts holds why).
    const rendered = render(cls).split('\n').filter(line => line && !line.startsWith('(if '))
    const tail = rendered.slice(-10, -4)

    expect(rendered.slice(-4, -2)).toEqual(debuggerDenials())

    expect(tail[0]).toMatch(/^; never/)
    expect(tail.slice(1).every(line => line.startsWith('(deny ') && line.endsWith(`${tag(cls)})`))).toBe(true)
    expect(tail.join('\n')).toContain('(subpath "/Users/owner/.ssh")')
    expect(tail.join('\n')).toContain('(subpath "/Users/owner/Library/Keychains")')
    expect(tail.join('\n')).toContain('(subpath "/Library/Keychains")')
    expect(tail.join('\n')).toContain(`(subpath "${paths.userDataDir}")`)
    // F7: no hard link is made from inside, in any class (a link renames an inode the path rules judged elsewhere).
    expect(tail.at(-1)).toBe(`(deny file-link ${tag(cls)})`)

    for (const service of KEYCHAIN_SERVICES) {
      expect(tail.join('\n')).toContain(`(global-name "${service}")`)
    }

    for (const binary of NEVER_EXEC) {
      expect(tail.join('\n')).toContain(`(literal "${binary}")`)
    }
  })

  it.each(ACTIVITY_CLASSES)(
    '%s closes with the OS logging probes denied without a report: two denies, no allow, nothing wider',
    cls => {
      const text = render(cls)
      const closing = text.split('\n').filter(Boolean).slice(-2)

      expect(closing).toEqual([
        '(deny mach-lookup (with no-report) (global-name "com.apple.diagnosticd"))',
        '(deny file-read* (with no-report) (subpath "/Library/Preferences/Logging"))'
      ])
      // Silent means unreported, never allowed: the only no-report rules are these two denies.
      expect(text.match(/\(with no-report\)/g)).toHaveLength(2)
      expect(text).not.toMatch(/\(allow [^\n]*no-report/)
      expect(text).not.toMatch(/\(allow [^\n]*(diagnosticd|Preferences\/Logging)/)
      expect(auditSbpl(text).widened).toBe(false)
    }
  )

  it('opens the network only inside the NET conditional, and never for offline and media', () => {
    for (const cls of ['research', 'project', 'build'] as const) {
      const lines = render(cls)
        .split('\n')
        .filter(line => line.includes('network-outbound') && !debuggerDenials().includes(line))

      expect(lines).toHaveLength(1)
      expect(lines[0].startsWith('(if (equal? (param "NET") "1")')).toBe(true)
      expect(lines[0]).toContain('(remote ip "*:*")')
      expect(lines[0]).toContain('(deny network-outbound (remote ip "localhost:*")) (deny network-outbound (remote tcp6 "*:*"))')
      expect(lines[0]).not.toContain('(remote ip6 ')
      expect(lines[0]).not.toMatch(/\(allow network-outbound\)/)
    }

    for (const cls of ['offline', 'media'] as const) {
      const rest = render(cls).split('\n').filter(line => !debuggerDenials().includes(line))

      expect(rest.join('\n')).not.toContain('network')
    }
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

describe('fx7: what the user’s shell runs from is written by no class, and is never a project', () => {
  const spec = buildProfileSpec('project', paths)
  const ok = (root: string) => acceptableProjectRoot(root, spec, paths.home)

  it('the never block denies writes to the binary folders and the shell startup files', () => {
    const text = render('project')
    const never = text.slice(text.indexOf('; never, whatever the class'))

    for (const item of ['/opt/homebrew', '/usr/local', '/Users/owner/.local/bin', '/Users/owner/bin', '/Users/owner/.zshrc', '/Users/owner/.gitconfig', '/Users/owner/Library/LaunchAgents', '/Users/owner/.cargo/bin']) {
      expect(never).toContain(`(subpath "${item}")`)
    }

    expect(auditSbpl(text).problems).toEqual([])
  })

  it('the videos folder: no confined command writes there, and neither it nor what holds it is a project root', () => {
    const text = render('project')
    const never = text.slice(text.indexOf('; never, whatever the class'))

    expect(never).toContain('(subpath "/Users/owner/Movies/icloneOS Recordings")')

    for (const root of ['/Users/owner/Movies', '/Users/owner/Movies/icloneOS Recordings', '/Users/owner/Movies/icloneOS Recordings/x']) {
      expect(ok(root)).toBe(false)
    }

    expect(ok('/Users/owner/Movies/other')).toBe(true)
  })

  it('refuses a project rooted at a .git folder, its hooks, a user bin folder, around one, or a Homebrew folder', () => {
    for (const root of [
      '/Users/owner/Developer/app/.git',
      '/Users/owner/Developer/app/.git/hooks',
      '/Users/owner/.local/bin',
      '/Users/owner/.local',
      '/Users/owner/bin/tools',
      '/opt/homebrew/bin',
      '/opt',
      '/usr/local/src/thing'
    ]) {
      expect({ root, ok: ok(root) }).toEqual({ root, ok: false })
    }
  })

  it('still accepts a normal repository, and a project folder beside the shell files', () => {
    for (const root of ['/Users/owner/Developer/app', '/Users/owner/Developer/app/packages/web', '/Users/owner/bin-utils']) {
      expect({ root, ok: ok(root) }).toEqual({ root, ok: true })
    }
  })
})

describe('fx10: the repository the project already was', () => {
  const ruleOf = (cls: (typeof ACTIVITY_CLASSES)[number]) => render(cls).split('\n').find(line => line.includes('PROJECT_GIT'))

  it('fx13 (lens3-policy H2): the never block denies project writes whenever WRITE_PROJECT is not 1, scratch excepted', () => {
    const line =
      '(if (and (string? (param "PROJECT_ROOT")) (not (equal? (param "WRITE_PROJECT") "1")) (not (equal? (param "PROJECT_ROOT") (param "SCRATCH")))) (deny file-write* (subpath (param "PROJECT_ROOT"))'

    for (const cls of ['project', 'build', 'offline'] as const) {
      const text = render(cls)

      expect(text.indexOf(line)).toBeGreaterThan(text.indexOf('; never, whatever the class'))
    }
  })

  it('the never block denies what names a program git runs, for every class that writes a project', () => {
    for (const cls of ['project', 'build', 'offline'] as const) {
      const text = render(cls)
      const rule = ruleOf(cls) ?? ''

      expect(text.indexOf(rule)).toBeGreaterThan(text.indexOf('; never, whatever the class'))

      for (const rel of ['.git"', '.git/config"', '.git/config.worktree"', '.git/commondir"']) {
        expect(rule).toContain(`(literal (string-append (param "PROJECT_ROOT") "/${rel}))`)
      }

      for (const rel of ['.git/hooks"', '.git/worktrees"']) {
        expect(rule).toContain(`(subpath (string-append (param "PROJECT_ROOT") "/${rel}))`)
      }

      expect(rule.endsWith(`${tag(cls)}))`)).toBe(true)
      expect(auditSbpl(text).problems).toEqual([])
    }
  })

  it('only the exact word unborn lifts it, so an absent parameter leaves the repository locked', () => {
    expect(ruleOf('project')).toContain('(not (equal? (param "PROJECT_GIT") "unborn"))')
  })

  it('a class that never writes a project has no such rule', () => {
    expect(ruleOf('research')).toBeUndefined()
    expect(ruleOf('media')).toBeUndefined()
  })
})
