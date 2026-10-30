import { describe, expect, it } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

import { groupMsgSessions, hasManyProfiles, listedSessionIds, type MsgGroupSources } from './msg-sidebar-groups'

function row(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return { id, last_active: 0, message_count: 1, source: 'desktop', started_at: 0, title: id, ...over } as SessionInfo
}

function sources(over: Partial<MsgGroupSources> = {}): MsgGroupSources {
  return { cron: [], messaging: [], pinnedIds: [], sessions: [], unconfirmedPinWrites: new Set(), ...over }
}

const shape = (input: MsgGroupSources) =>
  groupMsgSessions(input).map(group => [group.key, group.sessions.map(session => session.id)])

describe('groupMsgSessions', () => {
  it('returns nothing for empty stores (every empty group is dropped)', () => {
    expect(groupMsgSessions(sources())).toEqual([])
  })

  it('shows ONE local session as one Sessions group (the owner machine today)', () => {
    expect(shape(sources({ sessions: [row('a')] }))).toEqual([['sessions', ['a']]])
  })

  it('orders local sessions by latest activity, falling back to start time', () => {
    const sessions = [row('old', { started_at: 10 }), row('new', { last_active: 30 }), row('mid', { started_at: 20 })]

    expect(shape(sources({ sessions }))).toEqual([['sessions', ['new', 'mid', 'old']]])
  })

  it('keeps cli and tui sessions in the local group', () => {
    const sessions = [row('c', { source: 'cli' }), row('t', { source: 'tui' }), row('n', { source: null })]

    expect(shape(sources({ sessions }))[0][0]).toBe('sessions')
    expect(groupMsgSessions(sources({ sessions }))).toHaveLength(1)
  })

  it('puts locally pinned ids first, in the hand-picked pin order', () => {
    const sessions = [row('a', { last_active: 3 }), row('b', { last_active: 2 }), row('c', { last_active: 1 })]

    expect(shape(sources({ pinnedIds: ['c', 'a'], sessions }))).toEqual([
      ['pinned', ['c', 'a']],
      ['sessions', ['b']]
    ])
  })

  it('pins server-flagged rows the local pin set does not know', () => {
    expect(shape(sources({ sessions: [row('a', { pinned: true }), row('b')] }))).toEqual([
      ['pinned', ['a']],
      ['sessions', ['b']]
    ])
  })

  it('respects an in-flight unpin over a stale server pin flag', () => {
    const input = sources({ sessions: [row('a', { pinned: true })], unconfirmedPinWrites: new Set(['a']) })

    expect(shape(input)).toEqual([['sessions', ['a']]])
  })

  it('makes one group per messaging platform, labelled by the platform', () => {
    const messaging = [row('t1', { source: 'telegram' }), row('d1', { source: 'discord' })]
    const groups = groupMsgSessions(sources({ messaging }))

    expect(groups.map(group => group.kind)).toEqual(['platform', 'platform'])
    expect(groups.map(group => group.label).sort()).toEqual(['Discord', 'Telegram'])
  })

  it('orders platform groups by their latest activity', () => {
    const messaging = [
      row('t1', { last_active: 5, source: 'telegram' }),
      row('d1', { last_active: 9, source: 'discord' }),
      row('t2', { last_active: 1, source: 'telegram' })
    ]

    expect(shape(sources({ messaging }))).toEqual([
      ['platform:discord', ['d1']],
      ['platform:telegram', ['t1', 't2']]
    ])
  })

  it('routes a messaging-source row that arrived through recents to its platform group', () => {
    expect(shape(sources({ sessions: [row('s1', { source: 'slack' })] }))).toEqual([['platform:slack', ['s1']]])
  })

  it('collects cron store rows under Scheduled jobs, whatever their source', () => {
    const cron = [row('j1', { source: 'cron' }), row('j2', { source: 'telegram' })]

    expect(shape(sources({ cron }))).toEqual([['scheduled', ['j1', 'j2']]])
  })

  it('dedupes a row present in several stores (one row, recents copy wins)', () => {
    const recent = row('x', { title: 'from recents' })
    const groups = groupMsgSessions(sources({ messaging: [row('x', { title: 'dup' })], sessions: [recent] }))

    expect(groups).toHaveLength(1)
    expect(groups[0].sessions).toEqual([recent])
  })

  it('a row in the cron store stays scheduled even when recents also has it', () => {
    expect(shape(sources({ cron: [row('j')], sessions: [row('j')] }))).toEqual([['scheduled', ['j']]])
  })

  it('collects archived rows into Archived, last, and never elsewhere', () => {
    const sessions = [row('a'), row('z', { archived: true, pinned: true })]

    expect(shape(sources({ pinnedIds: ['z'], sessions }))).toEqual([
      ['sessions', ['a']],
      ['archived', ['z']]
    ])
  })

  it('nests a branch in its parent group even when its own source differs', () => {
    const messaging = [row('p', { source: 'telegram' })]
    const sessions = [row('child', { parent_session_id: 'p', source: 'desktop' })]

    expect(shape(sources({ messaging, sessions }))).toEqual([['platform:telegram', ['child', 'p']]])
  })

  it('follows a branch chain up to the first ancestor present', () => {
    const cron = [row('root')]
    const sessions = [row('mid', { parent_session_id: 'root' }), row('leaf', { parent_session_id: 'mid' })]

    expect(shape(sources({ cron, sessions }))[0][0]).toBe('scheduled')
    expect(groupMsgSessions(sources({ cron, sessions }))).toHaveLength(1)
  })

  it('a branch whose parent is absent stays in its own group', () => {
    expect(shape(sources({ sessions: [row('orphan', { parent_session_id: 'gone' })] }))).toEqual([
      ['sessions', ['orphan']]
    ])
  })

  it('survives a parent cycle', () => {
    const sessions = [row('a', { parent_session_id: 'b' }), row('b', { parent_session_id: 'a' })]

    expect(shape(sources({ sessions }))[0][1]).toHaveLength(2)
  })

  it('keeps the fixed group order: pinned, sessions, platforms, scheduled, archived', () => {
    const input = sources({
      cron: [row('j')],
      messaging: [row('t', { source: 'telegram' })],
      pinnedIds: ['p'],
      sessions: [row('p'), row('l'), row('old', { archived: true })]
    })

    expect(groupMsgSessions(input).map(group => group.key)).toEqual([
      'pinned',
      'sessions',
      'platform:telegram',
      'scheduled',
      'archived'
    ])
  })
})

describe('listedSessionIds', () => {
  it('is every unique non-archived id across the three stores', () => {
    const ids = listedSessionIds({
      cron: [row('j'), row('a')],
      messaging: [row('t', { source: 'telegram' })],
      sessions: [row('a'), row('gone', { archived: true })]
    })

    expect(ids.sort()).toEqual(['a', 'j', 't'])
  })

  it('equals the rows the groups list outside Archived', () => {
    const input = sources({
      cron: [row('j')],
      messaging: [row('t', { source: 'discord' })],
      pinnedIds: ['a'],
      sessions: [row('a'), row('b'), row('x', { archived: true })]
    })

    const listed = groupMsgSessions(input)
      .filter(group => group.kind !== 'archived')
      .flatMap(group => group.sessions.map(session => session.id))

    expect(listed.sort()).toEqual(listedSessionIds(input).sort())
  })
})

describe('optimistic deletes', () => {
  it('drops tombstoned ids from every group, archived included, before the stores refresh', () => {
    const groups = groupMsgSessions(
      sources({
        cron: [row('job')],
        removedIds: new Set(['gone', 'job', 'old']),
        sessions: [row('kept'), row('gone'), row('old', { archived: true })]
      })
    )

    expect(groups.flatMap(group => group.sessions.map(session => session.id))).toEqual(['kept'])
  })
})

describe('hasManyProfiles', () => {
  it('is false for one profile (an unset profile counts as default)', () => {
    const groups = groupMsgSessions(sources({ sessions: [row('a'), row('b', { profile: 'default' })] }))

    expect(hasManyProfiles(groups)).toBe(false)
  })

  it('is true once a second profile is listed', () => {
    const groups = groupMsgSessions(sources({ sessions: [row('a'), row('b', { profile: 'work' })] }))

    expect(hasManyProfiles(groups)).toBe(true)
  })
})
