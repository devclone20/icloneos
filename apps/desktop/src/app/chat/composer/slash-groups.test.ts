import { describe, expect, it } from 'vitest'

import { slash as copy } from '@/i18n/en/slash'

import { decorateSlashMeta, portedSkillMap } from './slash-groups'

const ICLONE = {
  skills: [
    { name: 'economyos' },
    { name: 'ridervoice', port: { needs: [{ kind: 'bin' as const, name: 'ffmpeg' }] } },
    { name: 'hm-qa', port: { needs: [] } }
  ]
}

describe('portedSkillMap', () => {
  it('maps /name to the port facts of every ported row and ignores the rest', () => {
    const map = portedSkillMap(ICLONE)

    expect([...map.keys()].sort()).toEqual(['/hm-qa', '/ridervoice'])
    expect(map.get('/ridervoice')?.needs).toEqual([{ kind: 'bin', name: 'ffmpeg' }])
    expect(portedSkillMap(null).size).toBe(0)
    expect(portedSkillMap({}).size).toBe(0)
  })
})

describe('decorateSlashMeta', () => {
  const ported = portedSkillMap(ICLONE)

  it('tags a ported skill row with the library and, when unmet, what the machine lacks', () => {
    expect(decorateSlashMeta('/hm-qa', 'Use when testing.', { copy, ported, group: 'Skills' })).toBe(
      'Use when testing. · from your library'
    )
    expect(decorateSlashMeta('/ridervoice', 'Use when speaking.', { copy, ported, group: 'Skills' })).toBe(
      'Use when speaking. · from your library · needs ffmpeg'
    )
    expect(decorateSlashMeta('/RiderVoice', 'x', { copy, ported, group: 'Skills' })).toContain('from your library')
  })

  it('leaves an ordinary skill and an ordinary command alone', () => {
    expect(decorateSlashMeta('/economyos', 'Use when paying.', { copy, ported, group: 'Skills' })).toBe(
      'Use when paying.'
    )
    expect(decorateSlashMeta('/new', 'Start a new chat', { copy, ported, group: 'Session' })).toBe('Start a new chat')
  })

  it('says "also /compact" on the /compress row', () => {
    expect(
      decorateSlashMeta('/compress', 'Compress this conversation context', { copy, ported, group: 'Session' })
    ).toBe('Compress this conversation context · also /compact')
  })
})
