import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  boundMailState,
  EMPTY_MAIL_STATE,
  emptyTrash,
  folderRows,
  MAIL_STATE_VERSION,
  type MailState,
  mailStateKey,
  mailStateRecord,
  type MarkableRow,
  mergeMailStates,
  mirrorAllMailStateFiles,
  mirrorMailStateFile,
  moveMail,
  parseMailState,
  placeOf,
  purgedRows,
  readMailState,
  readStampedMailState,
  reconcileMailStateFile,
  resetMailStateMirror,
  revertMarks,
  sameMailState,
  searchRows,
  serializeMailState,
  setRead,
  unloadedCount,
  withRead,
  writeMailState
} from './email-state'

interface Row extends MarkableRow {
  subject: string
}

function row(id: string, overrides: Partial<Row> = {}): Row {
  return { id, direction: 'inbound', isRead: true, at: 1_000, subject: id, ...overrides }
}

const ids = (rows: readonly MarkableRow[]) => rows.map(item => item.id)

describe('read marks', () => {
  it('local wins: a message read here stays read while the service still says unread', () => {
    const server = row('a', { isRead: false })
    const state = setRead(EMPTY_MAIL_STATE, [server], true, 10)

    expect(withRead(state, server).isRead).toBe(true)
    // A later page with the same (stale) word changes nothing.
    expect(withRead(state, { ...server }).isRead).toBe(true)
  })

  it('local wins the other way: marked unread over a service that says read', () => {
    const server = row('a', { isRead: true })
    const state = setRead(EMPTY_MAIL_STATE, [server], false, 10)

    expect(withRead(state, server).isRead).toBe(false)
  })

  it('stores a mark only where it disagrees — agreeing drops the older mark', () => {
    const unreadHere = setRead(EMPTY_MAIL_STATE, [row('a', { isRead: true })], false, 10)

    expect(unreadHere.read.size).toBe(1)

    // Read again while the service says read: nothing to remember.
    const readAgain = setRead(unreadHere, [row('a', { isRead: true })], true, 20)

    expect(readAgain.read.size).toBe(0)
    expect(setRead(EMPTY_MAIL_STATE, [row('b', { isRead: true })], true, 10)).toBe(EMPTY_MAIL_STATE)
  })

  it('a message left unread while the service also said unread follows the service once it is read there', () => {
    const state = setRead(EMPTY_MAIL_STATE, [row('a', { isRead: false })], false, 10)

    // The agent reads it through the CLI: that read is newer than the owner's touch.
    expect(withRead(state, row('a', { isRead: true })).isRead).toBe(true)
  })

  it('keeps a row’s identity across renders, so memoised rows do not render again', () => {
    const server = row('a', { isRead: false })
    const state = setRead(EMPTY_MAIL_STATE, [server], true, 10)

    expect(withRead(state, server)).toBe(withRead(state, server))
    expect(withRead(EMPTY_MAIL_STATE, server)).toBe(server)
    // An unchanged mark returns the same state object.
    expect(setRead(state, [server], true, 99)).toBe(state)
  })
})

describe('folders', () => {
  const base = [
    row('in-unread', { isRead: false, at: 5 }),
    row('in-read', { at: 4 }),
    row('archived', { at: 3 }),
    row('trashed', { at: 2 }),
    row('purged', { at: 1 }),
    row('out', { direction: 'outbound', at: 6 })
  ]

  const spam = [row('junk', { at: 7 }), row('junk-archived', { at: 8 })]

  function marked(): MailState {
    let state = moveMail(EMPTY_MAIL_STATE, 'archive', ['archived', 'junk-archived'], 10)

    state = moveMail(state, 'trash', ['trashed'], 10)
    state = moveMail(state, 'purge', ['purged'], 10)

    return state
  }

  it('Inbox, Unread, Sent and Spam leave out archived, trashed and purged mail', () => {
    const state = marked()

    expect(ids(folderRows(state, { base, spam }, 'inbox'))).toEqual(['in-unread', 'in-read'])
    expect(ids(folderRows(state, { base, spam }, 'unread'))).toEqual(['in-unread'])
    expect(ids(folderRows(state, { base, spam }, 'sent'))).toEqual(['out'])
    expect(ids(folderRows(state, { base, spam }, 'spam'))).toEqual(['junk'])
  })

  it('Archive gathers every list, newest first; Trash shows trashed; purged shows nowhere', () => {
    const state = marked()
    const adopted = [row('from-search', { at: 9 })]
    const withSearch = moveMail(state, 'archive', ['from-search'], 11)

    expect(ids(folderRows(withSearch, { base, spam, adopted }, 'archive'))).toEqual([
      'from-search',
      'junk-archived',
      'archived'
    ])
    expect(ids(folderRows(state, { base, spam }, 'trash'))).toEqual(['trashed'])

    for (const folder of ['inbox', 'unread', 'sent', 'spam', 'archive', 'trash'] as const) {
      expect(ids(folderRows(state, { base, spam }, folder))).not.toContain('purged')
    }
  })

  it('archived mail sent to Trash is in Trash only — and Restore puts it back in Archive', () => {
    const archived = moveMail(EMPTY_MAIL_STATE, 'archive', ['in-read'], 10)
    const trashed = moveMail(archived, 'trash', ['in-read'], 11)

    expect(placeOf(trashed, 'in-read')).toBe('trash')
    expect(ids(folderRows(trashed, { base }, 'archive'))).not.toContain('in-read')

    const restored = moveMail(trashed, 'restore', ['in-read'], 12)

    expect(placeOf(restored, 'in-read')).toBe('archive')
    expect(placeOf(moveMail(restored, 'inbox', ['in-read'], 13), 'in-read')).toBe('mailbox')
  })

  it('Unread follows the read marks', () => {
    const state = setRead(EMPTY_MAIL_STATE, [base[0]], true, 10)

    expect(folderRows(state, { base }, 'unread')).toEqual([])
    expect(folderRows(state, { base }, 'inbox')[0].isRead).toBe(true)
  })

  it('search still finds archived mail, never trashed or purged', () => {
    expect(ids(searchRows(marked(), base))).toEqual(['in-unread', 'in-read', 'archived', 'out'])
  })

  it('counts archived and trashed marks no loaded list holds', () => {
    const state = moveMail(marked(), 'archive', ['older-page'], 10)

    expect(unloadedCount(state, { base, spam }, 'archive')).toBe(1)
    expect(unloadedCount(state, { base, spam }, 'trash')).toBe(0)
  })
})

describe('changes', () => {
  it('returns the very same state when a change changes nothing', () => {
    const state = moveMail(EMPTY_MAIL_STATE, 'archive', ['a'], 10)

    expect(moveMail(state, 'archive', ['a'], 20)).toBe(state)
    expect(moveMail(state, 'restore', ['a'], 20)).toBe(state)
    expect(moveMail(state, 'inbox', ['nope'], 20)).toBe(state)
    expect(emptyTrash(state, 20)).toBe(state)
  })

  it('deleting forever takes every other mark with it, and nothing can mark a purged id again', () => {
    let state = setRead(EMPTY_MAIL_STATE, [row('a', { isRead: false })], true, 10)

    state = moveMail(state, 'trash', ['a'], 11)
    state = moveMail(state, 'purge', ['a'], 12)

    expect(placeOf(state, 'a')).toBe('purged')
    expect(state.read.has('a') || state.trashed.has('a') || state.archived.has('a')).toBe(false)
    expect(moveMail(state, 'archive', ['a'], 13)).toBe(state)
    expect(setRead(state, [row('a', { isRead: false })], true, 13)).toBe(state)
  })

  it('Empty trash deletes every trashed message forever, loaded or not', () => {
    const state = moveMail(moveMail(EMPTY_MAIL_STATE, 'trash', ['a', 'b'], 10), 'archive', ['c'], 10)
    const emptied = emptyTrash(state, 20)

    expect(emptied.trashed.size).toBe(0)
    expect([...emptied.purged.keys()]).toEqual(['a', 'b'])
    expect(placeOf(emptied, 'c')).toBe('archive')
  })

  it('Undo puts back only the ids it names — marks made since stay', () => {
    const before = EMPTY_MAIL_STATE
    const archived = moveMail(before, 'archive', ['a', 'b'], 10)
    // Meanwhile the owner opened another message.
    const opened = setRead(archived, [row('c', { isRead: false })], true, 11)
    const undone = revertMarks(opened, before, ['a', 'b'])

    expect(placeOf(undone, 'a')).toBe('mailbox')
    expect(placeOf(undone, 'b')).toBe('mailbox')
    expect(undone.read.get('c')?.read).toBe(true)
    expect(revertMarks(undone, before, ['a', 'b'])).toBe(undone)
  })
})

describe('the bound', () => {
  it('drops read marks first, then archive and trash marks, oldest first; purged ids last', () => {
    const state: MailState = {
      read: new Map([
        ['r-old', { read: true, at: 1 }],
        ['r-new', { read: true, at: 9 }]
      ]),
      archived: new Map([['a-old', 2]]),
      trashed: new Map([['t-new', 8]]),
      purged: new Map([
        ['p-old', 0],
        ['p-new', 7]
      ]),
      recovered: new Map()
    }

    const three = boundMailState(state, 4)

    expect([...three.read.keys()]).toEqual([])
    expect([...three.archived.keys(), ...three.trashed.keys()]).toEqual(['a-old', 't-new'])
    expect(three.purged.size).toBe(2)

    // Only when purged ids alone pass the cap do the oldest of them go.
    const tight = boundMailState(state, 1)

    expect([...tight.purged.keys()]).toEqual(['p-new'])
    expect(tight.read.size + tight.archived.size + tight.trashed.size).toBe(0)
    expect(boundMailState(state, 99)).toBe(state)
  })

  it('never grows past the cap, however many messages are opened', () => {
    let state = EMPTY_MAIL_STATE

    for (let index = 0; index < 60; index++) {
      state = setRead(state, [row(`m${index}`, { isRead: false })], true, index)
      state = boundMailState(state, 50)
    }

    expect(state.read.size).toBe(50)
    // The newest marks are the ones kept.
    expect(state.read.has('m59')).toBe(true)
    expect(state.read.has('m0')).toBe(false)
  })
})

describe('storage', () => {
  beforeEach(() => window.localStorage.clear())

  afterEach(() => vi.restoreAllMocks())

  it('round-trips per iNFT, under its own key', () => {
    let state = setRead(EMPTY_MAIL_STATE, [row('a', { isRead: false })], true, 10)

    state = moveMail(state, 'archive', ['b'], 11)
    state = moveMail(state, 'trash', ['c'], 12)
    state = moveMail(state, 'purge', ['d'], 13)
    writeMailState('inft-1', state)

    expect(window.localStorage.getItem(mailStateKey('inft-1'))).toContain('"v":1')
    expect(readMailState('inft-2')).toBe(EMPTY_MAIL_STATE)

    const back = readMailState('inft-1')

    expect(back.read.get('a')).toEqual({ read: true, at: 10 })
    expect(placeOf(back, 'b')).toBe('archive')
    expect(placeOf(back, 'c')).toBe('trash')
    expect(placeOf(back, 'd')).toBe('purged')
  })

  it('an emptied state leaves a stamped empty copy, no marks', () => {
    const state = moveMail(EMPTY_MAIL_STATE, 'archive', ['a'], 10)

    writeMailState('inft-1', state, 20)
    writeMailState('inft-1', moveMail(state, 'inbox', ['a'], 11), 30)

    expect(readStampedMailState('inft-1').writtenAt).toBe(30)
    expect(placeOf(readMailState('inft-1'), 'a')).toBe('mailbox')
  })

  it('lets in only well-formed entries, and nothing from another version', () => {
    const parsed = parseMailState({
      v: MAIL_STATE_VERSION,
      read: { ok: [true, 5], bad: ['yes', 5], neg: [false, -1], '': [true, 1], gone: [true, 1] },
      archived: { a: 1, b: 'x', gone: 2 },
      trashed: 'nope',
      purged: { gone: 3 }
    })

    expect([...parsed.read.keys()]).toEqual(['ok'])
    // A purged id carries no other mark.
    expect([...parsed.archived.keys()]).toEqual(['a'])
    expect(parsed.trashed.size).toBe(0)
    expect(placeOf(parsed, 'gone')).toBe('purged')
    expect(parseMailState({ v: 999, purged: { a: 1 } })).toBe(EMPTY_MAIL_STATE)
    expect(parseMailState('garbage')).toBe(EMPTY_MAIL_STATE)
    expect(parseMailState(JSON.parse(serializeMailState(parsed)))).toEqual(parsed)
  })

  it('survives storage that throws, on read and on write', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })

    expect(readMailState('inft-1')).toBe(EMPTY_MAIL_STATE)
    expect(() => writeMailState('inft-1', moveMail(EMPTY_MAIL_STATE, 'archive', ['a'], 1))).not.toThrow()
  })

  it('a corrupt entry reads as no marks', () => {
    window.localStorage.setItem(mailStateKey('inft-1'), '{not json')

    expect(readMailState('inft-1')).toBe(EMPTY_MAIL_STATE)
  })
})

describe('every server row has exactly one place', () => {
  // The shape of #7's real default list (U2 pass 2): 15 inbound, 2 outbound.
  const inbound = Array.from({ length: 15 }, (_, index) => row(`in${index}`, { at: 1_000 + index }))
  const outbound = [row('out0', { direction: 'outbound' }), row('out1', { direction: 'outbound' })]
  const pools = { base: [...inbound, ...outbound] }

  function places(state: MailState) {
    const shown = (['inbox', 'archive', 'trash'] as const).flatMap(folder => ids(folderRows(state, pools, folder)))
    const purged = ids(inbound).filter(id => placeOf(state, id) === 'purged')

    return { shown, purged }
  }

  it('without marks, Inbox holds every inbound row and Sent every outbound one', () => {
    expect(ids(folderRows(EMPTY_MAIL_STATE, pools, 'inbox'))).toHaveLength(15)
    expect(ids(folderRows(EMPTY_MAIL_STATE, pools, 'sent'))).toEqual(['out0', 'out1'])
  })

  it('Inbox, Archive, Trash and the purged ids partition the inbound rows — across a reload too', () => {
    let state = moveMail(EMPTY_MAIL_STATE, 'archive', ['in0', 'in1'], 5)

    state = moveMail(state, 'trash', ['in1', 'in2', 'in3', 'in4'], 6)
    state = moveMail(state, 'purge', ['in5'], 7)
    state = emptyTrash(moveMail(state, 'trash', ['in6'], 8), 9)

    for (const current of [state, parseMailState(JSON.parse(serializeMailState(state)))]) {
      const { shown, purged } = places(current)

      expect(new Set(shown).size).toBe(shown.length)
      expect([...shown, ...purged].sort()).toEqual(ids(inbound).sort())
      expect(purged.sort()).toEqual(['in1', 'in2', 'in3', 'in4', 'in5', 'in6'])
      expect(ids(folderRows(current, pools, 'sent'))).toEqual(['out0', 'out1'])
    }
  })
})

// R3d — "Delete forever" survives a wiped localStorage: the file in main holds it too.
describe('the two copies of the marks (localStorage ∪ email-state.json)', () => {
  const SLUG = 'inft-r3d'
  const saved: Array<Record<string, unknown>> = []
  let file: Record<string, unknown> | null = null
  let failLoad = false

  const at = (state: MailState, writtenAt: null | number) => ({ state, writtenAt })
  const purged = moveMail(EMPTY_MAIL_STATE, 'purge', ['gone-1', 'gone-2'], 100)

  beforeEach(() => {
    saved.length = 0
    file = null
    failLoad = false
    localStorage.clear()
    Object.assign(window, {
      hermesDesktop: {
        icloneAcp: {
          emailState: {
            load: async () => (failLoad ? { ok: false, error: 'boom' } : { ok: true, value: file }),
            save: async (_slug: string, value: Record<string, unknown>) => {
              saved.push(value)
              file = value

              return { ok: true, value }
            }
          }
        }
      }
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'hermesDesktop')
  })

  it('a wiped localStorage gets every tombstone back from the file', async () => {
    writeMailState(SLUG, purged, 500)
    await vi.waitFor(() => expect(saved).toHaveLength(1))
    localStorage.clear()

    const merged = await reconcileMailStateFile(SLUG, readMailState(SLUG))

    expect([...merged.purged.keys()].sort()).toEqual(['gone-1', 'gone-2'])
    expect(placeOf(merged, 'gone-1')).toBe('purged')
  })

  it('a corrupt (absent-reading) file loses to localStorage and is rewritten from it', async () => {
    writeMailState(SLUG, purged, 500)
    await vi.waitFor(() => expect(saved).toHaveLength(1))
    file = null

    const merged = await reconcileMailStateFile(SLUG, readMailState(SLUG))

    expect(sameMailState(merged, purged)).toBe(true)
    await vi.waitFor(() => expect(saved).toHaveLength(2))
    expect(Object.keys(saved[1].purged as object).sort()).toEqual(['gone-1', 'gone-2'])
  })

  it('both copies empty: the server alone decides (nothing is hidden)', async () => {
    const merged = await reconcileMailStateFile(SLUG, readMailState(SLUG))

    expect(merged).toBe(EMPTY_MAIL_STATE)
    expect(folderRows(merged, { base: [row('a'), row('b')] }, 'inbox').map(r => r.id)).toEqual(['a', 'b'])
  })

  it('a bridge that fails changes nothing and writes nothing', async () => {
    failLoad = true
    const local = readMailState(SLUG)

    expect(await reconcileMailStateFile(SLUG, local)).toBe(local)
    expect(saved).toHaveLength(0)
  })

  it('every write stamps both copies', async () => {
    writeMailState(SLUG, purged, 777)
    await vi.waitFor(() => expect(saved).toHaveLength(1))

    expect(readStampedMailState(SLUG).writtenAt).toBe(777)
    expect(saved[0].w).toBe(777)
  })

  it('purged wins over trashed wins over archived, and a purge never comes undone', () => {
    const trashed = moveMail(moveMail(EMPTY_MAIL_STATE, 'archive', ['x'], 10), 'trash', ['x', 'gone-1'], 11)
    const merged = mergeMailStates(at(trashed, 900), at(purged, 100))

    expect(placeOf(merged, 'gone-1')).toBe('purged')
    expect(merged.trashed.has('gone-1')).toBe(false)
    expect(placeOf(merged, 'x')).toBe('trash')
    expect(mergeMailStates(at(EMPTY_MAIL_STATE, 999), at(purged, 1)).purged.size).toBe(2)
  })

  it('a mark the newer copy took back (Restore) stays back; an unstamped copy unions', () => {
    const older = moveMail(EMPTY_MAIL_STATE, 'trash', ['r'], 10)

    expect(placeOf(mergeMailStates(at(EMPTY_MAIL_STATE, 50), at(older, 20)), 'r')).toBe('mailbox')
    expect(placeOf(mergeMailStates(at(EMPTY_MAIL_STATE, null), at(older, 20)), 'r')).toBe('trash')
  })

  it('read marks: the later mark wins whichever copy holds it', () => {
    const early = setRead(EMPTY_MAIL_STATE, [{ id: 'm', isRead: false }], true, 10)
    const late = setRead(EMPTY_MAIL_STATE, [{ id: 'm', isRead: true }], false, 20)

    expect(mergeMailStates(at(early, 30), at(late, 25)).read.get('m')?.read).toBe(false)
  })

  it('the warm-up mirror writes marks only localStorage held (Email never opened) to the file', async () => {
    localStorage.setItem(mailStateKey(SLUG), serializeMailState(purged, 400))

    const merged = await mirrorMailStateFile(SLUG)

    expect(merged && sameMailState(merged, purged)).toBe(true)
    await vi.waitFor(() => expect(saved).toHaveLength(1))
    expect(Object.keys(saved[0].purged as object).sort()).toEqual(['gone-1', 'gone-2'])
  })

  it('the warm-up mirror gives a wiped localStorage its tombstones back', async () => {
    writeMailState(SLUG, purged, 500)
    await vi.waitFor(() => expect(saved).toHaveLength(1))
    localStorage.clear()

    await mirrorMailStateFile(SLUG)

    expect([...readMailState(SLUG).purged.keys()].sort()).toEqual(['gone-1', 'gone-2'])
    expect(saved).toHaveLength(1)
  })

  it('a Restore of the last mark while the file save fails is not undone by the stale file', async () => {
    const trashed = moveMail(EMPTY_MAIL_STATE, 'trash', ['r'], 10)

    writeMailState(SLUG, trashed, 20)
    await vi.waitFor(() => expect(saved).toHaveLength(1))
    const stale = file
    writeMailState(SLUG, moveMail(trashed, 'restore', ['r'], 25), 30)
    await vi.waitFor(() => expect(saved).toHaveLength(2))
    file = stale

    expect(placeOf(await reconcileMailStateFile(SLUG, readMailState(SLUG)), 'r')).toBe('mailbox')
    expect(placeOf((await mirrorMailStateFile(SLUG)) ?? EMPTY_MAIL_STATE, 'r')).toBe('mailbox')
  })

  it('mirrors every iNFT localStorage holds, once per session', async () => {
    const files = new Map<string, unknown>()
    const loads: string[] = []

    Object.assign(window, {
      hermesDesktop: {
        icloneAcp: {
          emailState: {
            load: async (slug: string) => (loads.push(slug), { ok: true, value: files.get(slug) ?? null }),
            save: async (slug: string, value: Record<string, unknown>) => (files.set(slug, value), { ok: true, value })
          }
        }
      }
    })
    localStorage.setItem(mailStateKey('inft-a'), serializeMailState(purged, 1))
    localStorage.setItem(mailStateKey('inft-b'), serializeMailState(moveMail(EMPTY_MAIL_STATE, 'trash', ['t'], 5), 6))
    resetMailStateMirror()

    await mirrorAllMailStateFiles()
    await mirrorAllMailStateFiles()

    await vi.waitFor(() => expect([...files.keys()].sort()).toEqual(['inft-a', 'inft-b']))
    expect(loads.sort()).toEqual(['inft-a', 'inft-b'])
    expect(Object.keys((files.get('inft-b') as { trashed: object }).trashed)).toEqual(['t'])
  })

  it('a transient load failure is retried at the next warm-up — R3d r3', async () => {
    const files = new Map<string, unknown>()
    let down = true

    Object.assign(window, {
      hermesDesktop: {
        icloneAcp: {
          emailState: {
            load: async () => {
              if (down) {
                throw new Error('bridge not ready')
              }

              return { ok: true, value: null }
            },
            save: async (slug: string, value: Record<string, unknown>) => (files.set(slug, value), { ok: true, value })
          }
        }
      }
    })
    localStorage.setItem(mailStateKey('inft-old'), serializeMailState(purged, 1))
    resetMailStateMirror()

    await mirrorAllMailStateFiles()
    expect(files.size).toBe(0)
    down = false
    await mirrorAllMailStateFiles()

    await vi.waitFor(() => expect([...files.keys()]).toEqual(['inft-old']))
    expect(Object.keys((files.get('inft-old') as { purged: object }).purged).sort()).toEqual(['gone-1', 'gone-2'])
    await mirrorAllMailStateFiles()
    expect(files.size).toBe(1)
  })

  it('a file with a key this build does not know still contributes every tombstone — R3d r3', async () => {
    const five = ['f1', 'f2', 'f3', 'f4', 'f5']
    file = { ...mailStateRecord(moveMail(EMPTY_MAIL_STATE, 'purge', five, 50), 60), labels: { f1: 'work' } }
    localStorage.setItem(mailStateKey(SLUG), serializeMailState(moveMail(EMPTY_MAIL_STATE, 'purge', ['l1'], 70), 80))

    const merged = await mirrorMailStateFile(SLUG)

    expect([...(merged?.purged.keys() ?? [])].sort()).toEqual([...five, 'l1'])
    await vi.waitFor(() => expect(saved).toHaveLength(1))
    expect(Object.keys(saved[0].purged as object).sort()).toEqual([...five, 'l1'])
  })

  it('the partition holds after the round trip: Inbox ∪ Archive ∪ Trash ∪ Purged == server inbound', async () => {
    const server = ['s1', 's2', 's3', 's4', 's5'].map(id => row(id))
    let state = moveMail(EMPTY_MAIL_STATE, 'archive', ['s2'], 1)
    state = moveMail(state, 'trash', ['s3'], 2)
    state = moveMail(state, 'purge', ['s4'], 3)
    writeMailState(SLUG, state, 10)
    await vi.waitFor(() => expect(saved).toHaveLength(1))
    localStorage.clear()

    const back = await reconcileMailStateFile(SLUG, readMailState(SLUG))

    const shown = (['inbox', 'archive', 'trash'] as const).flatMap(f =>
      folderRows(back, { base: server }, f).map(r => r.id)
    )

    expect([...shown, ...back.purged.keys()].sort()).toEqual(server.map(r => r.id))
  })
})

// U1p2-T2 — mail deleted forever on this device is still on the service: the
// folders count it, and Recover brings it back for good.
describe('deleted forever, counted and recovered', () => {
  const base = [row('in1'), row('in2', { isRead: false }), row('out1', { direction: 'outbound' })]
  const spam = [row('sp1')]
  const all = ['in1', 'in2', 'out1', 'sp1']
  const purgedAll = moveMail(EMPTY_MAIL_STATE, 'purge', all, 10)

  it('each folder counts the loaded rows it hides; Trash counts all of them, Archive none', () => {
    const pools = { base, spam }

    expect(ids(folderRows(purgedAll, pools, 'inbox'))).toEqual([])
    expect(ids(purgedRows(purgedAll, pools, 'inbox'))).toEqual(['in1', 'in2'])
    expect(ids(purgedRows(purgedAll, pools, 'unread'))).toEqual(['in2'])
    expect(ids(purgedRows(purgedAll, pools, 'sent'))).toEqual(['out1'])
    expect(ids(purgedRows(purgedAll, pools, 'spam'))).toEqual(['sp1'])
    expect(ids(purgedRows(purgedAll, pools, 'trash')).sort()).toEqual(all)
    expect(purgedRows(purgedAll, pools, 'archive')).toEqual([])
    expect(purgedRows(EMPTY_MAIL_STATE, pools, 'inbox')).toEqual([])
  })

  it('Recover returns the rows to their folders, and Undo puts the purge back', () => {
    const back = moveMail(purgedAll, 'recover', ['in1', 'in2'], 20)

    expect(ids(folderRows(back, { base, spam }, 'inbox'))).toEqual(['in1', 'in2'])
    expect(placeOf(back, 'out1')).toBe('purged')
    expect(moveMail(back, 'recover', ['in1'], 30)).toBe(back)

    const undone = revertMarks(back, purgedAll, ['in1', 'in2'])

    expect(all.map(id => placeOf(undone, id))).toEqual(all.map(() => 'purged'))
    expect(undone.recovered.size).toBe(0)
  })

  it('a recovery outlives an older copy that still says purged; a later purge wins again', () => {
    const at = (state: MailState, writtenAt: null | number) => ({ state, writtenAt })
    const back = moveMail(purgedAll, 'recover', ['in1'], 20)

    expect(placeOf(mergeMailStates(at(purgedAll, 10), at(back, 20)), 'in1')).toBe('mailbox')
    expect(placeOf(mergeMailStates(at(back, null), at(purgedAll, null)), 'in1')).toBe('mailbox')

    const again = moveMail(back, 'purge', ['in1'], 30)

    expect(again.recovered.has('in1')).toBe(false)
    expect(placeOf(mergeMailStates(at(back, 20), at(again, 30)), 'in1')).toBe('purged')
  })

  it('the stored copy keeps the recovery, and an untouched state keeps its old shape', () => {
    const back = moveMail(purgedAll, 'recover', ['in1'], 20)
    const parsed = parseMailState(JSON.parse(serializeMailState(back)))

    expect(placeOf(parsed, 'in1')).toBe('mailbox')
    expect(placeOf(parsed, 'in2')).toBe('purged')
    expect(JSON.parse(serializeMailState(purgedAll))).not.toHaveProperty('recovered')
    // A copy that holds both words for one id keeps only the later one.
    expect(placeOf(parseMailState({ v: 1, purged: { x: 5 }, recovered: { x: 4 } }), 'x')).toBe('purged')
    expect(placeOf(parseMailState({ v: 1, purged: { x: 5 }, recovered: { x: 6 } }), 'x')).toBe('mailbox')
  })
})

/** UF2B1-c2-01: the R3d harness probes (RESUME/run/gates/R3d/extra) read this symbol off the module. */
describe('parseStampedMailState stays public', () => {
  it('is exported and reads the stamp beside the marks', async () => {
    const mod: Record<string, unknown> = await import('./email-state')
    expect(typeof mod.parseStampedMailState).toBe('function')
    const parse = mod.parseStampedMailState as (raw: unknown) => { writtenAt: number | null }
    const at = Date.now() - 1_000
    expect(parse(null).writtenAt).toBeNull()
    expect(parse({ w: at }).writtenAt).toBe(at)
  })
})
