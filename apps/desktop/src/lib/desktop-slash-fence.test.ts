import { describe, expect, it } from 'vitest'

import type { CommandsCatalogLike } from '@/lib/desktop-slash-commands'

import { desktopSlashAlsoKnownAs, fencedBackendCommands, isFencedBackendCommand } from './desktop-slash-fence'

// A catalog shaped like the gateway's: registry commands in categories (one the desktop knows, one it does not),
// a skill uncategorised, and the alias map the gateway sends.
const CATALOG: CommandsCatalogLike & { canon?: Record<string, string> } = {
  categories: [
    { name: 'Session', pairs: [['/new', 'Start a new session']] },
    { name: 'Tools & Skills', pairs: [['/fence-me', 'A terminal-only verb of the runtime']] }
  ],
  pairs: [
    ['/new', 'Start a new session'],
    ['/fence-me', 'A terminal-only verb of the runtime'],
    ['/work', 'Kick off a task']
  ],
  canon: { '/fm': '/fence-me', '/reset': '/new', '/fence-me': '/fence-me' }
}

describe('fencedBackendCommands', () => {
  it('fences a categorised backend command the desktop has no spec for, and its aliases through canon', () => {
    const fenced = fencedBackendCommands(CATALOG)

    expect([...fenced].sort()).toEqual(['/fence-me', '/fm'])
    expect(isFencedBackendCommand('/fence-me', CATALOG)).toBe(true)
    expect(isFencedBackendCommand('fm', CATALOG)).toBe(true)
    expect(isFencedBackendCommand('/FENCE-ME', CATALOG)).toBe(true)
  })

  it('never fences a desktop spec, its aliases, or an uncategorised skill', () => {
    expect(isFencedBackendCommand('/new', CATALOG)).toBe(false)
    expect(isFencedBackendCommand('/reset', CATALOG)).toBe(false)
    expect(isFencedBackendCommand('/work', CATALOG)).toBe(false)
  })

  it('fences nothing without a catalog or without categories (an older backend)', () => {
    expect(fencedBackendCommands(undefined).size).toBe(0)
    expect(fencedBackendCommands(null).size).toBe(0)
    expect(fencedBackendCommands({ pairs: [['/fence-me', 'x']] }).size).toBe(0)
  })
})

describe('desktopSlashAlsoKnownAs', () => {
  it('advertises /compact on /compress (and resolves through the alias itself)', () => {
    expect(desktopSlashAlsoKnownAs('/compress')).toEqual(['/compact'])
    expect(desktopSlashAlsoKnownAs('/compact')).toEqual(['/compact'])
  })

  it('advertises nothing for other commands, unknown names, or an alias the spec no longer carries', () => {
    expect(desktopSlashAlsoKnownAs('/new')).toEqual([])
    expect(desktopSlashAlsoKnownAs('/permissions')).toEqual([])
    expect(desktopSlashAlsoKnownAs('/unknown-skill')).toEqual([])
  })
})
