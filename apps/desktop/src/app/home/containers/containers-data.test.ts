import { describe, expect, it } from 'vitest'

import { confinement as arConf } from '@/i18n/ar/confinement'
import { confinement as enConf } from '@/i18n/en/confinement'
import { confinement as jaConf } from '@/i18n/ja/confinement'
import { confinement as ptConf } from '@/i18n/pt-PT/confinement'
import { confinement as zhHantConf } from '@/i18n/zh-hant/confinement'
import { confinement as zhConf } from '@/i18n/zh/confinement'
import { REFUSALS_LISTED, type RefusalView } from '@/iclone-shared/confinement'

import { CONFINEMENT_COPY } from './containers-copy'
import {
  backendTone,
  confinedGroups,
  couldNotEnter,
  counts,
  endedSince,
  failedMeaning,
  filterCounts,
  filterRuns,
  firstLine,
  folderToOffer,
  groupRuns,
  homeRelative,
  HOUSEKEEPING_LIVE_MAX_S,
  isFoldedHousekeeping,
  isHousekeeping,
  macFaults,
  mergeActions,
  moveSelection,
  narrowedKey,
  operationKind,
  originCounts,
  phaseLabel,
  phasesOf,
  refusalGroups,
  refusalKinds,
  refusalsOf,
  runSeconds,
  sayOperation,
  sayReason,
  sayWhy,
  splitHousekeeping,
  splitScope,
  tally,
  timeline,
  unfoldedBecause,
  whyCounts
} from './containers-data'
import { FIXTURE_AT, FIXTURE_REFUSALS, FIXTURE_RUNS, fixtureState } from './containers-fixtures'

const copy = CONFINEMENT_COPY.en
const L = copy.ledger
const R = FIXTURE_RUNS

describe('fx23', () => {
  const ended = { ...R.exited, backgroundEnded: true }

  it('proof6 F1: a background that ended states no status in its label or sentence', () => {
    expect(phaseLabel(L, ended)).toBe('Background ended')
    expect(phaseLabel(L, { ...R.failed, backgroundEnded: true })).toBe('Background ended')
    expect(failedMeaning(L, ended)).not.toMatch(/status \d/)
    expect(failedMeaning(L, ended)).toMatch(/not how it ended/)
    expect(failedMeaning(L, { ...R.failed, backgroundEnded: true })).toBe(failedMeaning(L, ended))
    expect(phaseLabel(L, R.exited)).toBe('Exited 0')
  })

  it('proof6 F2: a live background run counts from its start, and its lifecycle is live', () => {
    const live = { ...R.background, startedAt: '2026-11-01T10:00:00.000Z', endedAt: '2026-11-01T10:00:00.500Z' }

    expect(runSeconds(live, '2026-11-01T10:00:37.000Z')).toBe(37)
    expect(timeline(live, [], '2026-11-01T10:00:37.000Z').at(-1)).toEqual({ kind: 'live', seconds: 37 })
    expect(runSeconds({ ...live, phase: 'exited' }, '2026-11-01T10:00:37.000Z')).toBe(0)
  })

  it('proof6 F3: a run that could not enter its folder through a link did not run, and no Allow is offered', () => {
    const link = {
      ...R.exited,
      narrowed: true,
      narrowedWhy: 'unlisted-folder' as const,
      cwd: '/h/sib4',
      cwdLink: true,
      projectRoot: '/h/sib4',
      phase: 'failed' as const,
      exitCode: 126
    }

    expect(couldNotEnter(link)).toBe(true)
    expect(narrowedKey(link)).toBe('could-not-enter')
    expect(L.narrowed.lead[narrowedKey(link)]).toBe('Did not run.')
    expect(folderToOffer(link, [link])).toBeNull()
    // In its own folder, or with another status, it ran: the note and the offer stay.
    expect(couldNotEnter({ ...link, cwdLink: undefined })).toBe(false)
    expect(couldNotEnter({ ...link, exitCode: 1 })).toBe(false)
    expect(folderToOffer({ ...link, exitCode: 1 }, [])).toBe('/h/sib4')
  })
})

describe('fx24: a switch nobody decided is the reason, when it is', () => {
  it('names the switch, in the note and the refusal, never the mode', () => {
    expect(L.narrowed.why['needs-file-writing']).toMatch(/File writing is undecided in Settings/)
    expect(L.narrowed.why['needs-file-writing']).not.toMatch(/choose a mode/)
    expect(L.narrowed.why['needs-web-browsing']).toMatch(/Web browsing & network calls is undecided in Settings/)
    expect(narrowedKey({ narrowed: true, narrowedWhy: 'needs-file-writing', exitCode: 1 })).toBe('needs-file-writing')
  })
})

describe('fx24: refusals by what they are', () => {
  const row = (over: Partial<RefusalView>): RefusalView => ({
    ts: '2026-11-04T10:00:00.000Z',
    pid: 1,
    process: 'bash',
    operation: 'file-read-metadata',
    target: '/h/sib',
    sessionId: null,
    run: 'r',
    shellLook: true,
    ...over
  })

  it('a cd of one folder is one kind with its count; another path or process is never merged into it', () => {
    const kinds = refusalKinds([
      row({ pid: 1 }),
      row({ pid: 2, operation: 'file-read-data' }),
      row({ pid: 3 }),
      row({ pid: 4, target: '/h/.ssh' }),
      row({ pid: 5, process: 'zsh' })
    ])

    expect(kinds.map(kind => [kind.refusal.process, kind.refusal.target, kind.count])).toEqual([
      ['bash', '/h/sib', 3],
      ['bash', '/h/.ssh', 1],
      ['zsh', '/h/sib', 1]
    ])
  })

  it('the timeline says a kind once, with its count', () => {
    const nodes = timeline(
      { ...R.exited },
      [
        row({ ts: R.exited.startedAt }),
        row({ pid: 2, ts: R.exited.startedAt }),
        row({ pid: 3, target: '/h/.ssh', ts: R.exited.startedAt })
      ],
      R.exited.startedAt
    )

    const refused = nodes.filter(node => node.kind === 'refusal')

    expect(
      refused.map(node => [node.kind === 'refusal' && node.refusal.target, node.kind === 'refusal' && node.count])
    ).toEqual([
      ['/h/sib', 2],
      ['/h/.ssh', undefined]
    ])
  })

  it('without the look mark the operation keeps two kinds apart, and every refusal stays in a count', () => {
    const rows = [
      row({ shellLook: undefined }),
      row({ shellLook: undefined, operation: 'file-write-create' }),
      row({ shellLook: undefined })
    ]

    expect(refusalKinds(rows).map(kind => kind.count)).toEqual([2, 1])
    expect(refusalKinds(rows).reduce((sum, kind) => sum + kind.count, 0)).toBe(rows.length)
  })
})

describe('run phases and times', () => {
  it('words every phase; a failure names its code, or the signal that ended it', () => {
    expect(phaseLabel(L, R.running)).toBe('Running')
    expect(phaseLabel(L, R.background)).toBe('Background')
    expect(phaseLabel(L, R.exited)).toBe('Exited 0')
    expect(phaseLabel(L, R.failed)).toBe('Failed · code 101')
    expect(phaseLabel(L, { ...R.failed, exitCode: null, signal: 11 })).toBe('Failed · signal 11')
    expect(phaseLabel(L, { ...R.failed, exitCode: null })).toBe('Failed')
    expect(phaseLabel(L, R.stopped)).toBe('Stopped by you')
    expect(phaseLabel(L, { ...R.stopped, stoppedByOwner: undefined })).toBe('Stopped')
    expect(phaseLabel(L, R.refused)).toBe('Refused before start')
    expect(phaseLabel(L, R.unknown)).toBe('Exit status unknown')
  })

  it('measures against main’s clock: open runs to state.at, ended runs to their end', () => {
    expect(runSeconds(R.running, FIXTURE_AT)).toBe(12)
    expect(runSeconds(R.exited, FIXTURE_AT)).toBe(1)
    expect(runSeconds(R.failed, FIXTURE_AT)).toBe(66)
    expect(runSeconds({ startedAt: 'garbage', endedAt: null }, FIXTURE_AT)).toBe(0)
  })

  it('durations and relative times read in whole units', () => {
    expect(L.duration(12)).toBe('12 s')
    // A sub-second run is not a run of no time.
    expect(L.duration(0)).toBe('<1 s')
    expect(L.duration(0.6)).toBe('<1 s')
    expect(L.duration(66)).toBe('1 min 6 s')
    expect(L.duration(120)).toBe('2 min')
    expect(L.duration(3720)).toBe('1 h 2 min')
    expect(L.ago(2)).toBe('just now')
    expect(L.ago(40)).toBe('40 s ago')
    expect(L.ago(184)).toBe('3 min ago')
  })

  it('the row shows the first non-empty line of a multi-line command', () => {
    expect(firstLine(R.failed.command)).toBe('cd crates/core')
    expect(firstLine('\n\n  ls -la  \n')).toBe('ls -la')
  })
})

describe('grouping, filters and search', () => {
  const runs = Object.values(R)

  it('Running holds running + background; Recent holds every other phase', () => {
    const { recent, running } = groupRuns(runs)

    expect(running.map(run => run.phase)).toEqual(['running', 'background'])
    expect(recent.map(run => run.phase)).toEqual(['exited', 'failed', 'stopped', 'refused', 'unknown', 'exited'])
  })

  it('filters: Running = live, Failed = failed or ended unknown, Refused = refused before start or with refusals', () => {
    expect(filterRuns(runs, 'running', '').map(run => run.id)).toEqual([R.running.id, R.background.id])
    expect(filterRuns(runs, 'failed', '').map(run => run.id)).toEqual([R.failed.id, R.unknown.id])
    expect(filterRuns(runs, 'refused', '').map(run => run.id)).toEqual([R.running.id, R.failed.id, R.refused.id])
    expect(filterCounts(runs)).toEqual({ all: 8, running: 2, failed: 2, refused: 3 })
  })

  it('search matches every word against the command and the project, in any case', () => {
    expect(filterRuns(runs, 'all', 'CARGO release').map(run => run.id)).toEqual([R.failed.id])
    expect(filterRuns(runs, 'all', 'atlas').length).toBe(8)
    expect(filterRuns(runs, 'running', 'cargo')).toEqual([])
  })

  it('the runtime’s housekeeping is split from the agent’s commands by who issued it, never by its words', () => {
    const { listed, folded } = splitHousekeeping(runs, FIXTURE_AT)

    expect(folded.map(run => run.id)).toEqual([R.housekeeping.id])
    expect(listed).toHaveLength(7)
    expect(isHousekeeping({ origin: 'runtime' })).toBe(true)
    // The same text, issued by the agent, is the agent's.
    expect(isHousekeeping({ ...R.housekeeping, origin: 'agent' })).toBe(false)
  })

  it('a claim of housekeeping folds a run only while every fact the runtime cannot choose says it was uneventful', () => {
    const h = R.housekeeping
    const at = FIXTURE_AT
    const secondsAgo = (seconds: number) => new Date(Date.parse(at) - seconds * 1000).toISOString()

    // Folded: ended (any status: the command's own word decides nothing), or running and young, with no refusal.
    expect(isFoldedHousekeeping(h, at)).toBe(true)
    expect(isFoldedHousekeeping({ ...h, phase: 'failed' }, at)).toBe(true)
    expect(isFoldedHousekeeping({ ...h, phase: 'running', endedAt: null, startedAt: secondsAgo(2) }, at)).toBe(true)

    // Listed: one kernel refusal, still running past the window, processes left behind, stopped by the owner, no end.
    expect(isFoldedHousekeeping({ ...h, refusals: 1 }, at)).toBe(false)
    expect(
      isFoldedHousekeeping(
        { ...h, phase: 'running', endedAt: null, startedAt: secondsAgo(HOUSEKEEPING_LIVE_MAX_S) },
        at
      )
    ).toBe(false)
    expect(isFoldedHousekeeping({ ...h, phase: 'background' }, at)).toBe(false)
    expect(isFoldedHousekeeping({ ...h, phase: 'stopped' }, at)).toBe(false)
    expect(isFoldedHousekeeping({ ...h, phase: 'unknown' }, at)).toBe(false)
    // The agent's own run is never folded, however quiet.
    expect(isFoldedHousekeeping({ ...h, origin: 'agent' }, at)).toBe(false)

    const eventful = { ...h, id: 'run-hk-refused', refusals: 3 }
    const { listed, folded } = splitHousekeeping([...runs, eventful], at)

    expect(listed.map(run => run.id)).toContain(eventful.id)
    expect(folded.map(run => run.id)).toEqual([h.id])
  })

  it('the tally says what it counts: the agent’s live commands, live housekeeping, and what was blocked in the last hour', () => {
    expect(tally(fixtureState())).toEqual({
      running: 2,
      housekeeping: 0,
      blockedLastHour: 6,
      blockedByRuntime: 0,
      blockedMore: false
    })

    const state = fixtureState()
    const liveHousekeeping = { ...R.housekeeping, phase: 'running' as const, endedAt: null, live: 1 }

    expect(
      tally({ ...state, runs: [...state.runs.filter(run => run.id !== R.housekeeping.id), liveHousekeeping] })
    ).toEqual({
      running: 2,
      housekeeping: 1,
      blockedLastHour: 6,
      blockedByRuntime: 0,
      blockedMore: false
    })
    expect(L.tally.running(2)).toBe('2 agent commands running')
    expect(L.tally.running(1)).toBe('1 agent command running')
    expect(L.tally.housekeeping(1)).toBe('1 housekeeping')
    expect(L.tally.blocked(0)).toBe('Nothing blocked in the last hour')
    expect(L.tally.blocked(1)).toBe('Blocked 1 attempt in the last hour')
    expect(L.tally.blocked(100)).toBe('Blocked 100 attempts in the last hour')
  })

  it('the runtime’s own blocked attempts are a part of the blocked count, said apart, never the agent’s', () => {
    const state = fixtureState()
    const listing = { ...R.housekeeping, id: 'run-hk-list', command: 'list a folder', refusals: 1 }
    const refusedSetup = { ...R.refused, id: 'run-hk-refused', origin: 'runtime' as const }
    const ofListing = { ...FIXTURE_REFUSALS[0], run: listing.id }

    const counted = tally({
      ...state,
      runs: [...state.runs, listing, refusedSetup],
      refusals: [...state.refusals, ofListing]
    })

    // 5 kernel refusals + 1 refused run before, now + 1 refusal of the listing + 1 runtime run refused before start.
    expect(counted.blockedLastHour).toBe(8)
    expect(counted.blockedByRuntime).toBe(2)
    // The agent's share is what is left: the numbers add up.
    expect(counted.blockedLastHour - counted.blockedByRuntime).toBe(6)
    expect(L.tally.blockedByRuntime(2)).toBe('2 marked by the runtime')
    expect(L.tally.blockedByRuntime(2, true)).toBe('2+ marked by the runtime')
  })

  it('a runtime command that is listed says which fact kept it out of the fold; the fold rule itself is unchanged', () => {
    const h = R.housekeeping
    const at = FIXTURE_AT
    const secondsAgo = (seconds: number) => new Date(Date.parse(at) - seconds * 1000).toISOString()

    expect(unfoldedBecause(h, at)).toBeNull()
    expect(unfoldedBecause({ ...h, origin: 'agent', refusals: 2 }, at)).toBeNull()
    expect(unfoldedBecause({ ...h, refusals: 1 }, at)).toBe('refused')
    expect(unfoldedBecause({ ...h, phase: 'refused' }, at)).toBe('refused')
    expect(unfoldedBecause({ ...h, phase: 'stopped' }, at)).toBe('stopped')
    expect(unfoldedBecause({ ...h, phase: 'background' }, at)).toBe('outlived')
    expect(unfoldedBecause({ ...h, phase: 'unknown' }, at)).toBe('no-end')
    expect(
      unfoldedBecause({ ...h, phase: 'running', endedAt: null, startedAt: secondsAgo(HOUSEKEEPING_LIVE_MAX_S) }, at)
    ).toBe('long')
    expect(unfoldedBecause({ ...h, phase: 'running', endedAt: null, startedAt: secondsAgo(2) }, at)).toBeNull()
    // The words name the same window the fold uses.
    expect(L.housekeeping.listedBecause.long).toContain(`${HOUSEKEEPING_LIVE_MAX_S} s or more`)

    // Every run it explains is one the fold lists, and every run it leaves silent is folded or the agent's.
    for (const run of [
      h,
      { ...h, refusals: 1 },
      { ...h, phase: 'stopped' as const },
      { ...h, phase: 'unknown' as const }
    ]) {
      expect(unfoldedBecause(run, at) !== null).toBe(!isFoldedHousekeeping(run, at))
    }
  })

  it('a full list of refusals still inside the hour makes the blocked count a floor, and the head says so', () => {
    const state = fixtureState()
    const at = Date.parse(state.at)

    const rows = (count: number, spacingS: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...FIXTURE_REFUSALS[0],
        ts: new Date(at - index * spacingS * 1000).toISOString()
      }))

    const noRefused = state.runs.filter(run => run.phase !== 'refused')

    const full = tally({ ...state, runs: noRefused, refusals: rows(REFUSALS_LISTED, 10) })

    expect(full).toMatchObject({ blockedLastHour: REFUSALS_LISTED, blockedMore: true })
    expect(L.tally.blocked(full.blockedLastHour, full.blockedMore)).toBe('Blocked 100+ attempts in the last hour')
    // A full list whose oldest row is older than the hour holds every one of the hour: an exact count.
    expect(tally({ ...state, runs: noRefused, refusals: rows(REFUSALS_LISTED, 60) })).toMatchObject({
      blockedLastHour: 61,
      blockedMore: false
    })
    expect(tally({ ...state, runs: noRefused, refusals: rows(REFUSALS_LISTED - 1, 10) }).blockedMore).toBe(false)
  })
})

describe('how a failed run is explained', () => {
  it('a plain non-zero status is the command’s own failure, with its code', () => {
    expect(failedMeaning(L, { phase: 'failed', exitCode: 1, signal: null, refusals: 0 })).toBe(
      'Ended with status 1: the command itself reported a failure.'
    )
    expect(failedMeaning(L, { ...R.failed, refusals: 0 })).toBe(
      'Ended with status 101: the command itself reported a failure.'
    )
  })

  it('a status after its profile refused the run something leads with the refusal, never with the command’s own failure', () => {
    expect(failedMeaning(L, R.failed)).toBe(
      'Ended with status 101 after its profile refused one attempt: the reason is below.'
    )
    expect(failedMeaning(L, { phase: 'failed', exitCode: 1, signal: null, refusals: 3 })).toBe(
      'Ended with status 1 after its profile refused 3 attempts: the reason is below.'
    )

    // 126 no longer guesses "if its profile blocked it": the pane knows it did.
    for (const exitCode of [1, 2, 126, 127, 137, 255]) {
      const said = failedMeaning(L, { phase: 'failed', exitCode, signal: null, refusals: 1 })

      expect(said).toMatch(/after its profile refused one attempt/)
      expect(said).not.toMatch(/the command itself reported|If its profile blocked it/)
    }

    // A real signal is still the signal: nobody's refusal sends one.
    expect(failedMeaning(L, { phase: 'failed', exitCode: null, signal: 11, refusals: 1 })).toBe(
      'Ended by signal 11, which this app did not send.'
    )
  })

  it('fx32p: the scope line says each command has its own profile', () => {
    expect(copy.scope).toContain('each inside its own profile.')
  })

  it('fx32p: the sentence goes by the signal, since the runtime and the launcher send the common ones', () => {
    const ended = (signal: number) => failedMeaning(L, { phase: 'failed', exitCode: null, signal, refusals: 0 })

    for (const signal of [1, 2, 3, 15]) {
      expect(ended(signal)).toBe(
        `Ended by signal ${signal}: the agent's runtime stops a command this way when it times out or is interrupted.`
      )
    }

    expect(ended(9)).toBe(
      'Ended by signal 9: the runtime or the launcher stopped it, or something else on this Mac did.'
    )
    expect(ended(6)).toBe('Ended by signal 6, which this app did not send.')
  })

  it('a real signal keeps the signal wording; neither known reads as another status', () => {
    expect(failedMeaning(L, { phase: 'failed', exitCode: null, signal: 11, refusals: 0 })).toBe(
      'Ended by signal 11, which this app did not send.'
    )
    expect(failedMeaning(L, { phase: 'failed', exitCode: null, signal: null, refusals: 0 })).toBe(
      'Ended with another status.'
    )
  })

  it('126 and 127 are the shell saying it could not run or find the command; 128+n is a program ended by signal n', () => {
    const said = (exitCode: number) => failedMeaning(L, { phase: 'failed', exitCode, signal: null, refusals: 0 })

    expect(said(126)).toBe(
      'Ended with status 126: the command was found but could not be run. If its profile blocked it, Refusals lists the attempt.'
    )
    expect(said(127)).toBe('Ended with status 127: the command was not found.')
    expect(said(137)).toBe(
      'Ended with status 137, the status a shell gives when a program it ran is ended by signal 9.'
    )
    expect(said(130)).toBe(
      'Ended with status 130, the status a shell gives when a program it ran is ended by signal 2.'
    )
    // Outside 129…159 nothing is a signal: 128 and 255 are the command's own status.
    expect(said(128)).toBe('Ended with status 128: the command itself reported a failure.')
    expect(said(255)).toBe('Ended with status 255: the command itself reported a failure.')

    for (const code of [126, 127, 137]) {
      expect(said(code)).not.toMatch(/the command itself reported/)
    }
  })

  it('every other phase keeps its one sentence', () => {
    expect(failedMeaning(L, R.exited)).toBe('Ended with status 0.')
    expect(failedMeaning(L, R.stopped)).toBe('Ended after you pressed Stop.')
    expect(failedMeaning(L, R.running)).toBe('In progress.')
  })

  it('g18: a stop nobody knows the owner made never says the owner made it', () => {
    const sentence = failedMeaning(L, { ...R.stopped, stoppedByOwner: undefined })

    expect(sentence).toBe('Stopped before it finished.')
    expect(L.housekeeping.listedBecause.stopped).toBe(
      'Listed with your agent’s commands because it was stopped; the runtime’s quiet housekeeping is folded under Runtime housekeeping.'
    )
    expect(L.housekeeping.hint).toBe(
      'Commands the runtime ran for itself that ended quietly, confined like the rest: the shell session set-up and its probes. One the sandbox refused, one that keeps running or one that was stopped is listed with the rest.'
    )
  })

  it('g18: a command outside the Seatbelt has no profile, so the live sentences name none', () => {
    expect(L.phaseMeaning.running).not.toMatch(/profile/)
    expect(L.phaseMeaning.background).toBe('The command exited, but processes it started are still alive.')
  })
})

describe('refusals, attributed and explained', () => {
  const state = fixtureState()

  it('a run’s refusals are the ones main attributed to it, oldest first', () => {
    expect(refusalsOf(state, R.running.id).map(refusal => refusal.why)).toEqual([
      'outside-roots',
      'never-list',
      'network-not-granted'
    ])
  })

  it('names the operation in plain words', () => {
    expect(operationKind('file-read-data')).toBe('read')
    expect(operationKind('file-write-create')).toBe('write')
    expect(operationKind('network-outbound')).toBe('network')
    expect(operationKind('process-exec*')).toBe('exec')
    expect(operationKind('mach-lookup')).toBe('service')
    expect(sayOperation(L, 'file-read-data')).toBe('Reading a file')
    expect(sayOperation(L, 'sysctl-write')).toBe('Operation sysctl-write')
  })

  it('names the rule, with the run’s profile when its class is known', () => {
    expect(sayWhy(copy, { why: 'outside-roots' }, 'project')).toBe(
      'The Project profile reads only the places listed under Profiles; this path is not one of them.'
    )
    expect(sayWhy(copy, { why: 'never-list' }, 'project')).toBe(
      'This path is on the never list: refused in every profile and every mode.'
    )
    expect(sayWhy(copy, { why: 'network-never' }, 'offline')).toBe(
      'The Offline profile never opens the network, whatever the grant.'
    )
    expect(sayWhy(copy, { why: 'outside-roots' }, null)).toMatch(/^Its profile reads only/)
    expect(sayWhy(copy, {}, 'project')).toBe(L.why.other(''))
  })

  it('groups refusals by run in ledger order, the unattributed last, and filters by rule', () => {
    expect(refusalGroups(state, 'all').map(group => group.runId)).toEqual([R.running.id, R.failed.id, null])
    expect(refusalGroups(state, 'never-list').map(group => group.refusals.length)).toEqual([1])
    expect(whyCounts(state).find(entry => entry.why === 'system-service')?.count).toBe(1)
  })
})

describe('who issued what was refused', () => {
  it('Refusals filters by the issuer of each refusal’s run; an unattributed refusal stays under All only', () => {
    const state = fixtureState()
    const listing = { ...R.housekeeping, id: 'run-hk-list', refusals: 1 }
    const ofListing = { ...FIXTURE_REFUSALS[0], run: listing.id }
    const withRuntime = { ...state, runs: [...state.runs, listing], refusals: [...state.refusals, ofListing] }

    const ids = (origin: 'agent' | 'all' | 'runtime') =>
      refusalGroups(withRuntime, 'all', origin).map(group => group.runId)

    expect(ids('runtime')).toEqual([listing.id])
    expect(ids('agent')).toEqual([R.running.id, R.failed.id])
    expect(ids('all')).toEqual([R.running.id, R.failed.id, listing.id, null])
    expect(originCounts(withRuntime)).toEqual({ agent: 4, runtime: 1 })
    expect(originCounts(state)).toEqual({ agent: 4, runtime: 0 })
  })

  it('a never-list path is said from the home folder, display only', () => {
    expect(homeRelative('/Users/owner/.ssh')).toBe('~/.ssh')
    expect(homeRelative('/Users/owner')).toBe('~')
    expect(homeRelative('/Library/Keychains')).toBe('/Library/Keychains')
  })
})

describe('the lifecycle timeline', () => {
  it('a live run: Started → each refusal → running for N s', () => {
    const nodes = timeline(R.running, FIXTURE_REFUSALS.slice(0, 3), FIXTURE_AT)

    expect(nodes.map(node => node.kind)).toEqual(['start', 'refusal', 'refusal', 'refusal', 'live'])
    expect(nodes.at(-1)).toEqual({ kind: 'live', seconds: 12 })
  })

  it('an ended run closes with its end and duration; one with no end says so; a refused one is one node', () => {
    expect(timeline(R.failed, [], FIXTURE_AT).at(-1)).toEqual({ kind: 'end', ts: R.failed.endedAt, seconds: 66 })
    expect(timeline(R.unknown, [], FIXTURE_AT).map(node => node.kind)).toEqual(['start', 'no-end'])
    expect(timeline(R.refused, [], FIXTURE_AT)).toEqual([{ kind: 'refused', ts: R.refused.endedAt }])
  })
})

describe('selection, announcements and faults', () => {
  it('Up/Down move in the visible order and stop at either end', () => {
    expect(moveSelection(['a', 'b', 'c'], null, 1)).toBe('a')
    expect(moveSelection(['a', 'b', 'c'], null, -1)).toBe('c')
    expect(moveSelection(['a', 'b', 'c'], 'b', 1)).toBe('c')
    expect(moveSelection(['a', 'b', 'c'], 'c', 1)).toBe('c')
    expect(moveSelection(['a', 'b', 'c'], 'a', -1)).toBe('a')
    expect(moveSelection([], 'a', 1)).toBeNull()
  })

  it('a run that was live and is not now is ended since the last read; a new or still-live run is not', () => {
    const before = phasesOf([R.running, R.background])
    const after = [{ ...R.running, phase: 'exited' as const }, R.background, R.exited]

    expect(endedSince(before, after).map(run => run.id)).toEqual([R.running.id])
  })

  it('This Mac is red for a broken runtime, a launcher down, or a broken backend', () => {
    const state = fixtureState()

    expect(macFaults(state)).toBe(0)
    expect(macFaults({ ...state, runtime: { ...state.runtime, state: 'broken', launcher: 'down' } })).toBe(2)
  })

  it('the two new reasons have their own sentences', () => {
    expect(sayReason(copy, { code: 'runtime-not-confined', pid: 900 })).toBe(
      'The agent runtime (900) runs, but macOS does not hold it in the runtime profile'
    )
    expect(sayReason(copy, { code: 'launcher-down' })).toMatch(/launcher is not answering/)
  })

  it('a runtime that withholds the agent’s commands is said with its own reason, as the runtime’s word', () => {
    expect(
      sayReason(copy, {
        code: 'agent-commands-unavailable',
        reason: 'the launcher is not answering',
        reportedBy: 'runtime'
      })
    ).toBe('Agent commands are unavailable: the launcher is not answering (reported by the agent runtime)')
  })

  it('backend tone and process counts are unchanged', () => {
    expect(backendTone('broken')).toBe('down')
    expect(backendTone('installed')).toBe('muted')
    expect(counts(fixtureState())).toEqual({ inside: 1, outside: 0 })
    expect(confinedGroups(fixtureState()).length).toBe(1)
  })
})

describe('F45b: the scope sentence splits at its own labels, and identical rows merge', () => {
  it.each([
    ['en', enConf],
    ['ja', jaConf],
    ['zh', zhConf],
    ['zh-hant', zhHantConf],
    ['ar', arConf],
    ['pt-PT', ptConf]
  ])('%s: two labelled parts, no word lost, MCP on the off side', (_locale, conf) => {
    const parts = splitScope(conf.scope)

    expect(parts.length).toBe(2)
    expect(parts[0].label.length).toBeGreaterThan(0)
    expect(parts[1].text).toContain('MCP')
    expect(parts.map(part => part.label + part.text).join('').length).toBeGreaterThan(conf.scope.length * 0.95)
  })

  it('a wording with no labels stays whole', () => {
    expect(splitScope('No labels here')).toEqual([{ label: '', text: 'No labels here' }])
  })

  it('only identical neighbours merge', () => {
    const a = { kind: 'refuse', target: 'x', tool: 't' }
    const b = { kind: 'use', target: 'x', tool: 't' }

    expect(mergeActions([a, { ...a }, b, a]).map(row => row.count)).toEqual([2, 1, 1])
  })
})
