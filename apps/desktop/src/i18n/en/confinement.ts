// iclone os — V3-G confinement: the Dock's Containers pane. Every locale fills this shape (ConfinementCopy); main
// folds the state, these words only explain it.
import type {
  ActivityClass,
  BackendDetail,
  BackendStatus,
  ConfinementBackendId,
  ConfinementReason,
  ConfinementVerdict,
  HardlinkAckFailure,
  KillFailure,
  OutsideKind,
  RefusalWhy,
  RunNarrowedWhy,
  RunOrigin,
  RunPhase,
  RunRefusalCode,
  RuntimeConfinementView
} from '@/iclone-shared/confinement'

/** One sentence per reason code, given that reason's own fields. */
type ReasonCopy = {
  [K in ConfinementReason['code']]: (reason: Extract<ConfinementReason, { code: K }>) => string
}

export interface ConfinementCopy {
  title: string
  tile: string
  unavailable: string
  verdict: Record<ConfinementVerdict, { label: string; hint: string }>
  kinds: Record<OutsideKind, string>
  killed: (count: number) => string
  /** Kill failed: the count is the processes still alive (survivors), else 0. */
  killFailed: Record<KillFailure, (count: number) => string>
  scope: string
  backendName: Record<ConfinementBackendId, string>
  backendStatus: Record<BackendStatus, string>
  active: string
  network: { grant: string; never: string }
  reads: string
  writes: string
  never: (count: number) => string
  classes: Record<ActivityClass, { name: string; summary: string }>
  defaultClass: (name: string) => string
  unattributed: string
  noSession: string
  insideCount: (count: number) => string
  outsideCount: (count: number) => string
  elapsed: (seconds: number) => string
  reasons: string
  reason: ReasonCopy
  /** Said even when green: something the layer could not check this time. */
  notes: string
  backendDetail: Record<BackendDetail, string>
  /** The enforcing check's result while isolation is off: what the test showed, and no claim that anything is held. */
  backendEnforcingOff: string
  /** The first hard-link scan of a project, while a confined command waits for it: calm, with the folders counted so far. */
  firstScan: (dirs: number) => string
  /** F7: a project confinement will not start in, and the owner's answer, one gesture per directory group (T2). */
  hardlinks: {
    /** One sentence; `paths` holds up to three, `count` is every such file. */
    blocked: (root: string, paths: readonly string[], count: number) => string
    /** One sentence (T1): directories inside the project could not be listed, so nothing can be proven. */
    cannotScan: (root: string, paths: readonly string[], count: number) => string
    /** The group line: "the N files under <dir> — hard links to outside the project". */
    group: (dir: string, count: number) => string
    /** The button, inside the confirm lock: "Allow N files". */
    allow: (count: number) => string
    allowTip: string
    allowed: (count: number) => string
    ackFailed: Record<HardlinkAckFailure, string>
    /** CF4 (B2-n4): the toggle under a group whose files are more than the three listed. */
    showAll: (count: number) => string
    /** CF5 (B3-n2): under a group past the 1 000 names main sends at once: the next page. */
    showMore: (left: number) => string
    showFewer: string
    /** One line (T4): the package caches a Build command may fill are not scanned for hard links. */
    cachesUnscanned: string
  }
  /** The run ledger: every confined command from its start to its end, and the runtime's own confinement. */
  ledger: LedgerCopy
}

/** Why a command the runtime issued for itself is listed with the agent's rather than folded (isFoldedHousekeeping). */
export type UnfoldReason = 'long' | 'no-end' | 'outlived' | 'refused' | 'stopped'

/** Where a refused operation was going, read from the kernel's operation name. */
export type OperationKind = 'exec' | 'network' | 'other' | 'read' | 'service' | 'write'

/** The run ledger (Activity, the inspector, Refusals, Backends' runtime rows). English in every locale for now. */
export interface LedgerCopy {
  /** `machine` names the runtime and sandbox status view, never "This Mac": that unconfined mode still exists in
   *  settings; its control is the isolation row inside this tab and in Settings › Agent › Permissions. */
  tabs: { activity: string; refusals: string; profiles: string; agents: string; machine: string }
  /** The header's quiet tally, each part saying what it counts: the agent's commands running now, the runtime's
   *  housekeeping running now (when any), and what the sandbox blocked in the last hour of main's clock. */
  tally: {
    running: (agentCommands: number) => string
    /** What the head says when the last read cannot be vouched for: the count, never as a live claim. */
    runningAtLastRead: (agentCommands: number) => string
    /** The narrow head's short forms: same numbers, same meaning, fewer words. */
    housekeeping: (count: number) => string
    /** Blocked attempts in the last hour; a calm fact, since blocking is the sandbox doing its job. `more`: the count
     *  is a floor (more were blocked than the pane holds). */
    blocked: (count: number, more?: boolean) => string
    /** How many of the blocked attempts belong to runs the runtime marked as its own (part of the blocked count, never
     *  added to it). Said as the runtime's claim: the mark is its own word. */
    blockedByRuntime: (count: number, more?: boolean) => string
    blockedTip: string
  }
  /** Who issued a run: the agent, or the runtime for itself. */
  origin: Record<RunOrigin, string>
  /** The quiet mark on a row the runtime issued for itself. */
  runtimeBadge: string
  /** The runtime's own commands, kept out of the default list behind one quiet disclosure. */
  housekeeping: {
    /** The disclosure's label with the count it hides or shows. */
    toggle: (count: number) => string
    show: string
    hide: string
    hint: string
    /** Said in the inspector of a runtime command that is listed rather than folded: which fact kept it listed. */
    listedBecause: Record<UnfoldReason, string>
  }
  filter: Record<'all' | 'failed' | 'refused' | 'running', string>
  filterLabel: string
  /** Names what the filters count: commands, where Refusals counts attempts. */
  search: string
  listLabel: string
  groups: { running: string; recent: string; outside: string }
  /** Short phase words for rows; a failure names its code or its signal. */
  phase: Record<Exclude<RunPhase, 'failed'>, string> & {
    failed: string
    failedCode: (code: number) => string
    backgroundEnded: string
    failedSignal: (signal: number) => string
  }
  /** One sentence per phase: exactly what the state means. A failure's sentence depends on how it ended. */
  phaseMeaning: Record<Exclude<RunPhase, 'failed'>, string>
  backgroundEndedMeaning: string
  /** fx29: a background row whose live count is a process with no run record. */
  orphanLiveMeaning: string
  /** The failed sentence: only a real signal reads as a signal; a status after the profile refused the run something
   *  leads with that refusal (the real cause, listed below); 126 and 127 are the shell saying the command could not
   *  be run or found; 128+n (n a signal number) is the shell reporting a program it ran ended by signal n; any other
   *  non-zero status is the command's own failure, with its code; neither known reads as another status. */
  failedMeaning: (run: { exitCode: number | null; signal: number | null; refusals: number }) => string
  /** The row's short word for that stop. */
  /** Phase `stopped` with no Stop press on record: the agent's process tool, or the launcher at quit. */
  phaseStopped: string
  stoppedMeaning: string
  phaseStoppedByModes: string
  /** Replaces the stopped sentence when the modes changed under a run, which the owner did not press. */
  stoppedByModes: string
  /** A run given less than it asked for: a short lead and a sentence per reason (`unknown`: a reason this app does not
   *  know), the button that lists its folder, what the button does and how it went. */
  narrowed: {
    lead: Record<RunNarrowedWhy | 'could-not-enter' | 'unknown', string>
    why: Record<RunNarrowedWhy | 'could-not-enter' | 'unknown', string>
    allow: string
    allowMeans: string
    allowed: string
    allowedAsks: string
    allowedPlan: string
    allowFailed: string
  }
  /** What to do when git could not write this repository's config: said beside the refusal. */
  gitInstead: { title: string; push: string; identity: string }
  kind: Record<'program' | 'shell', string>
  duration: (seconds: number) => string
  runningFor: (duration: string) => string
  ago: (seconds: number) => string
  processes: (count: number) => string
  refusedBadge: (count: number) => string
  stop: string
  stopTip: string
  stopping: string
  stopNotRunning: string
  stopUnavailable: string
  /** The Stop call itself failed: nobody can say what stopped. */
  stopNoAnswer: string
  /** The last read failed, so what the pane shows is the last one that worked. */
  /** The one sentence under a subtopic's name, beside its verdict pill; the whole verdict is in its Tip. */
  headLine: Record<ConfinementVerdict | 'stale', string>
  stale: {
    label: string
    hint: string
    note: (clock: string) => string
    /** The Running group's title while no read vouches for it. */
    group: string
    atLastRead: (said: string) => string
  }
  /** No read has worked yet. */
  noRead: { title: string; hint: string; retry: string }
  /** The list stops short of what the ledger still holds. */
  runsCut: (shown: number, cut: number) => string
  /** The Agents view's words for an audited action; `other` for a kind this release does not know. */
  actionKind: { use: string; refuse: string; other: string }
  /** The tool ids the runtime audits under, in words. A program name is printed as it is. */
  toolName: Record<string, string>
  /** An agent with no iNFT: named as what it is, its session id behind a Tip. */
  agentSession: string
  inspector: {
    label: string
    close: string
    lifecycle: string
    facts: string
    why: string
    whyNone: string
    whyMore: (count: number) => string
    notStarted: string
    /** The summary's first sentence for a command the runtime marked as its own: said as its claim, never as fact. */
    runtimeLead: string
    /** A refusal the runtime itself recorded before any request reached the launcher. */
    reportedByRuntime: string
    gone: string
  }
  timeline: {
    started: string
    ended: (phase: string, duration: string) => string
    refused: string
    noEnd: string
    refusedBeforeStart: string
  }
  facts: {
    kind: string
    issuedBy: string
    profile: string
    project: string
    network: string
    writes: string
    agent: string
    rootPid: string
    alive: string
    granted: string
    notGranted: string
    allowed: string
    readOnly: string
    none: string
  }
  operation: Record<Exclude<OperationKind, 'other'>, string> & { other: (operation: string) => string }
  /** The rule that refused it; `profile` is the class name, or '' when the run's class is not known. */
  why: Record<RefusalWhy, (profile: string) => string>
  whyName: Record<RefusalWhy, string>
  refusedCode: Record<RunRefusalCode, string>
  remedy: { reviewHardlinks: string; openMachine: string }
  refusals: {
    looked: (count: number) => string
    times: (count: number) => string
    shellLook: string
    all: string
    unattributed: string
    /** A group whose run has left the list: never its raw token. */
    evicted: string
    /** Commands refused before they started: nothing ran, so no kernel refusal exists for them. */
    beforeStart: string
    inspect: string
    /** The origin line under a group the runtime marked as its own: said as its claim, never as fact. */
    byRuntime: string
    originLabel: string
    origin: Record<RunOrigin, string>
    /** L4-02: today's record grew past one file; the list shows the newest, the count stays every refusal of the day. */
    olderInParts: (today: number, older: number) => string
  }
  empty: {
    runs: string
    runsHint: string
    filtered: string
    filteredHint: string
    refusals: string
    refusalsHint: string
    agents: string
    agentsHint: string
  }
  agentRuns: (count: number) => string
  runtime: {
    title: string
    summary: string
    state: Record<RuntimeConfinementView['state'], string>
    stateMeaning: Record<RuntimeConfinementView['state'], string>
    launcher: string
    launcherState: Record<RuntimeConfinementView['launcher'], string>
    launcherMeaning: Record<RuntimeConfinementView['launcher'], string>
    off: string
    never: string
    showAll: (count: number) => string
    showFewer: string
  }
  machine: {
    sandboxes: string
    runtime: string
    held: string
    processes: string
    processesEmpty: string
    caches: string
  }
  /** Said politely to a screen reader when a command ends: its first line and how it ended. */
  announce: (command: string, phase: string) => string
}

const plural = (count: number, one: string, many: string) => (count === 1 ? `1 ${one}` : `${count} ${many}`)

const duration = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds))

  if (s === 0) {
    return '<1 s'
  }

  if (s < 60) {
    return `${s} s`
  }

  if (s < 3600) {
    return s % 60 === 0 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 60)} min ${s % 60} s`
  }

  const minutes = Math.floor((s % 3600) / 60)

  return minutes === 0 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 3600)} h ${minutes} min`
}

/** The highest signal number on macOS (SIGUSR2): a shell reports a program ended by signal n as status 128 + n. */
const SIGNAL_MAX = 31

/** fx32p: the launcher forwards the stub's own stop signals to the group, and kills the group when the stub goes. */
const endedBySignal = (signal: number): string =>
  signal === 1 || signal === 2 || signal === 3 || signal === 15
    ? `Ended by signal ${signal}: the agent's runtime stops a command this way when it times out or is interrupted.`
    : signal === 9
      ? 'Ended by signal 9: the runtime or the launcher stopped it, or something else on this Mac did.'
      : `Ended by signal ${signal}, which this app did not send.`

const profileOf = (profile: string) => (profile ? `The ${profile} profile` : 'Its profile')

const ledger: LedgerCopy = {
  tabs: { activity: 'Activity', refusals: 'Refusals', profiles: 'Profiles', agents: 'Agents', machine: 'Backends' },
  orphanLiveMeaning: "A process whose run record is gone is alive; it may be this command's. Stop ends it.",
  tally: {
    running: count => (count === 1 ? '1 agent command running' : `${count} agent commands running`),
    runningAtLastRead: count =>
      count === 1 ? '1 agent command running at the last read' : `${count} agent commands running at the last read`,
    housekeeping: count => `${count} housekeeping`,
    blocked: (count, more = false) =>
      more
        ? `Blocked ${count}+ attempts in the last hour`
        : count === 0
          ? 'Nothing blocked in the last hour'
          : count === 1
            ? 'Blocked 1 attempt in the last hour'
            : `Blocked ${count} attempts in the last hour`,
    blockedByRuntime: (count, more = false) => `${count}${more ? '+' : ''} marked by the runtime`,
    blockedTip:
      'Attempts in the last hour that the sandbox refused. Refusals counts every attempt still listed; the filters under Commands count commands. Open Refusals.'
  },
  origin: { agent: 'The agent', runtime: 'The runtime, for itself' },
  runtimeBadge: 'Runtime',
  housekeeping: {
    toggle: count => (count === 1 ? 'Runtime housekeeping · 1' : `Runtime housekeeping · ${count}`),
    show: 'Show',
    hide: 'Hide',
    hint: 'Commands the runtime ran for itself that ended quietly, confined like the rest: the shell session set-up and its probes. One the sandbox refused, one that keeps running or one that was stopped is listed with the rest.',
    listedBecause: {
      refused:
        'Listed with your agent’s commands because the sandbox refused it something; the runtime’s quiet housekeeping is folded under Runtime housekeeping.',
      stopped:
        'Listed with your agent’s commands because it was stopped; the runtime’s quiet housekeeping is folded under Runtime housekeeping.',
      long: 'Listed with your agent’s commands because it has run for 30 s or more; the runtime’s quiet housekeeping is folded under Runtime housekeeping.',
      outlived:
        'Listed with your agent’s commands because processes it started are still alive; the runtime’s quiet housekeeping is folded under Runtime housekeeping.',
      'no-end':
        'Listed with your agent’s commands because no end was recorded for it; the runtime’s quiet housekeeping is folded under Runtime housekeeping.'
    }
  },
  filter: { all: 'All', running: 'Running', failed: 'Problems', refused: 'Commands with refusals' },
  filterLabel: 'Show',
  search: 'Search commands',
  listLabel: 'Confined commands',
  groups: { running: 'Running', recent: 'Recent', outside: 'Outside confinement' },
  phase: {
    running: 'Running',
    background: 'Background',
    backgroundEnded: 'Background ended',
    exited: 'Exited 0',
    failed: 'Failed',
    failedCode: code => `Failed · code ${code}`,
    failedSignal: signal => `Failed · signal ${signal}`,
    stopped: 'Stopped by you',
    refused: 'Refused before start',
    unknown: 'Exit status unknown'
  },
  phaseStopped: 'Stopped',
  stoppedMeaning: 'Stopped before it finished.',
  phaseStoppedByModes: 'Stopped by modes',
  stoppedByModes: 'The run was stopped: the modes changed and no longer allow what it was started with.',
  narrowed: {
    lead: {
      'unlisted-folder': 'Ran read-only.',
      'needs-allow': 'Ran read-only.',
      'needs-file-writing': 'Ran read-only.',
      'needs-web-browsing': 'Ran without the network.',
      'needs-network': 'Ran without the network.',
      'could-not-enter': 'Did not run.',
      unknown: 'Ran with less than it asked for.'
    },
    why: {
      'unlisted-folder':
        'This command had no project writes: this folder is not listed now. It was not opened with Open folder…, typed in the palette or listed with Allow this folder, and no allow for it was in effect. Until a later command there has project writes, this command’s details offer Allow this folder.',
      'needs-file-writing':
        'File writing is undecided in Settings, and your mode writes without asking only when it is on. Turn File writing on in Settings, or allow the next ask.',
      'needs-web-browsing':
        'Web browsing & network calls is undecided in Settings, and your mode reaches the network without asking only when it is on. Turn it on in Settings, or allow the next ask.',
      'needs-allow':
        'Your mode asks before project writes, and no allow for this folder was in effect. A one-time allow lasts two minutes. Allow the next ask, or choose a mode that allows project writes.',
      'needs-network':
        'Your mode asks before network access, and no allow was in effect for this project. Allow the next ask, or choose a mode that allows the network.',
      'could-not-enter':
        'Its folder is a link to another folder, and a confined command cannot enter a folder through a link. None of the command ran; any refusal counted here is the shell trying to enter that folder. Give that folder itself as the working folder.',
      unknown: 'The details show what it could do.'
    },
    allow: 'Allow this folder',
    allowMeans: 'Lets the agent write in this folder. Your mode still decides whether each write asks you first.',
    allowed: 'Allowed. The agent can write in this folder from its next command, as your mode lets it.',
    allowedAsks:
      'Allowed. Your mode decides each write here: where it asks, allow the ask and the write lands; where it does not, the write lands with no ask; in Plan writes stay off.',
    allowedPlan: 'Allowed. In Plan, writes stay off until you choose another mode.',
    allowFailed: 'Could not allow this folder. Nothing changed.'
  },
  gitInstead: {
    title: 'What to do instead',
    push: 'git push origin <branch>',
    identity: 'git -c user.name=… -c user.email=… commit'
  },
  backgroundEndedMeaning:
    'What this command left running has ended. The launcher sees when the last process leaves, not how it ended, so no exit status is shown.',
  phaseMeaning: {
    running: 'In progress.',
    background: 'The command exited, but processes it started are still alive.',
    exited: 'Ended with status 0.',
    stopped: 'Ended after you pressed Stop.',
    refused: 'Never started: it was refused before the sandbox was asked.',
    unknown: 'No end was recorded and none of its processes is alive: the app or the launcher quit while it ran.'
  },
  failedMeaning: ({ exitCode, refusals, signal }) =>
    signal !== null
      ? endedBySignal(signal)
      : exitCode === null
        ? 'Ended with another status.'
        : refusals > 0
          ? `Ended with status ${exitCode} after its profile refused ${refusals === 1 ? 'one attempt' : `${refusals} attempts`}: the reason is below.`
          : exitCode === 126
            ? 'Ended with status 126: the command was found but could not be run. If its profile blocked it, Refusals lists the attempt.'
            : exitCode === 127
              ? 'Ended with status 127: the command was not found.'
              : exitCode > 128 && exitCode <= 128 + SIGNAL_MAX
                ? `Ended with status ${exitCode}, the status a shell gives when a program it ran is ended by signal ${exitCode - 128}.`
                : `Ended with status ${exitCode}: the command itself reported a failure.`,
  kind: { shell: 'Agent’s terminal', program: 'App helper' },
  duration,
  runningFor: time => `Running for ${time}`,
  ago: seconds =>
    seconds < 5
      ? 'just now'
      : seconds < 60
        ? `${Math.floor(seconds)} s ago`
        : seconds < 3600
          ? `${Math.floor(seconds / 60)} min ago`
          : seconds < 86_400
            ? `${Math.floor(seconds / 3600)} h ago`
            : `${Math.floor(seconds / 86_400)} d ago`,
  processes: count => plural(count, 'process', 'processes'),
  refusedBadge: count => `${count} refused`,
  stop: 'Stop',
  stopTip: 'Stop this command and every process it started',
  stopping: 'Stopping…',
  stopNotRunning: 'It had already ended: nothing was stopped',
  stopUnavailable: 'Stop is not available here: nothing was stopped',
  stopNoAnswer: 'Could not stop it: the app did not answer. It may still be running',
  headLine: {
    green: 'Every agent command runs inside its profile, bar approved shell.',
    red: 'Confinement is not verified. The reasons are below.',
    off: 'Confinement is off: agent commands run unconfined.',
    stale: 'The latest read did not come back: this is not live.'
  },
  stale: {
    label: 'Not verified',
    hint: 'The latest read did not come back, so this is not a live answer.',
    note: clock => `Could not read the current state. What you see is from ${clock} and may be out of date.`,
    group: 'Running at the last read',
    atLastRead: said => `${said}, at the last read`
  },
  noRead: {
    title: 'Could not read what is confined',
    hint: 'The app keeps trying. If this stays, restart the app.',
    retry: 'Try again'
  },
  runsCut: (shown, cut) =>
    `Showing the newest ${shown} commands. ${cut === 1 ? '1 older command is' : `${cut} older commands are`} not listed.`,
  actionKind: { use: 'Used', refuse: 'Refused', other: 'Other' },
  toolName: {
    terminal: 'Terminal',
    execute_code: 'Code execution',
    file: 'Files',
    browser: 'Browser',
    web: 'Web'
  },
  agentSession: 'Agent session',
  inspector: {
    label: 'Command details',
    close: 'Close details',
    lifecycle: 'Lifecycle',
    facts: 'Facts',
    why: 'Why it was refused',
    whyNone: 'No refusal to list.',
    whyMore: count =>
      count === 1
        ? '1 more refusal was attributed to this run but is no longer in the recent list.'
        : `${count} more refusals were attributed to this run but are no longer in the recent list.`,
    notStarted: 'Why it did not start',
    runtimeLead: 'Marked by the runtime as its own.',
    reportedByRuntime: 'Reported by the runtime, not by the launcher.',
    gone: 'This command is no longer in the recent list.'
  },
  timeline: {
    started: 'Started',
    ended: (phase, time) => `${phase} · after ${time}`,
    refused: 'Refused',
    noEnd: 'No end recorded',
    refusedBeforeStart: 'Refused before start'
  },
  facts: {
    kind: 'Kind',
    issuedBy: 'Issued by',
    profile: 'Profile',
    project: 'Project',
    network: 'Network',
    writes: 'Project writes',
    agent: 'Agent',
    rootPid: 'Root PID',
    alive: 'Processes alive now',
    granted: 'Granted',
    notGranted: 'Not granted',
    allowed: 'Allowed',
    readOnly: 'Read-only',
    none: '—'
  },
  operation: {
    read: 'Reading a file',
    write: 'Writing a file',
    network: 'Opening a network connection',
    exec: 'Starting a program',
    service: 'Reaching a system service',
    other: operation => `Operation ${operation}`
  },
  why: {
    'outside-roots': profile =>
      `${profileOf(profile)} reads only the places listed under Profiles; this path is not one of them.`,
    'never-list': () => 'This path is on the never list: refused in every profile and every mode.',
    'not-writable': profile =>
      `${profileOf(profile)} writes only the folders listed under Profiles; this path is not one of them.`,
    'project-read-only': () =>
      'The project is read-only for this run: the permission mode did not allow project writes.',
    'narrowed-unlisted-folder': () =>
      'This command had no project writes: this folder is not listed now. It was not opened with Open folder…, typed in the palette or listed with Allow this folder, and no allow for it was in effect. Until a later command there has project writes, this command’s details offer Allow this folder.',
    'narrowed-needs-file-writing': () =>
      'This command had no project writes: File writing is undecided in Settings, and your mode writes without asking only when it is on.',
    'narrowed-needs-allow': () =>
      'This command had no project writes: your mode asks first, and no allow for this folder was in effect. A one-time allow lasts two minutes, so a later command needs a new one.',
    'narrowed-needs-network': () =>
      'This command had no network: your mode asks first, and no allow was in effect for this project.',
    'protected-file': () => 'This file is protected even inside the project (the agent’s own settings).',
    'git-config': () =>
      'This repository’s git config and hooks can name programs that git runs outside the sandbox, so no confined command changes them. To push: git push origin <branch>; git push -u sends the commits but cannot save the upstream. Commits carry the name and e-mail of your own git config; for another identity: git -c user.name=…, or git config --global, which lasts for this session only. For anything else, run this git command yourself in a terminal.',
    'network-not-granted': profile =>
      `${profileOf(profile)} opens the network only with a grant, and this session had none.`,
    'network-never': profile => `${profileOf(profile)} never opens the network, whatever the grant.`,
    'program-refused': () =>
      'This program is outside the readable places, or refused by name (launchctl, osascript, open, security…).',
    'system-service': () => 'Confined commands cannot reach this system service (credential stores, other apps).',
    'hard-link': () =>
      'A hard link to a file outside the project appeared during this run: it was found after the run, not prevented.',
    other: () => 'The profile refused it; no more specific rule was identified.'
  },
  whyName: {
    'outside-roots': 'Not readable',
    'never-list': 'Never list',
    'not-writable': 'Not writable',
    'project-read-only': 'Project read-only',
    'narrowed-unlisted-folder': 'Folder not allowed',
    'narrowed-needs-allow': 'Needs an allow',
    'narrowed-needs-file-writing': 'File writing undecided',
    'narrowed-needs-network': 'Network needs an allow',
    'protected-file': 'Protected file',
    'git-config': 'Git config',
    'network-not-granted': 'No network grant',
    'network-never': 'Network never',
    'program-refused': 'Program refused',
    'system-service': 'System service',
    'hard-link': 'Hard link',
    other: 'Other'
  },
  refusedCode: {
    'hard-links':
      'The project has hard links to files outside it, so the command was not started. Allow them by folder at the top of Activity, or remove them.',
    'cannot-scan': 'A hard link in the project could not be ruled out, so the command was not started.',
    'launcher-unavailable':
      'The launcher that starts confined commands was not answering, so the command was not started. Backends shows whether it answers now.',
    'no-profile': 'No profile was generated for this command, so it was not started.',
    'profile-unknown': 'The command asked for a profile this app did not generate, so it was not started.',
    'bad-request': 'The request to start it was malformed, so it was not started.',
    'cwd-gone':
      'Its working folder is not there any more, so it was not started. Move the folder back, or give a folder that exists.',
    'cwd-spelling':
      'Its working folder was given through a link, or with .. or a doubled or trailing slash, so it was not started. Give the folder itself as the working folder.',
    policy: 'The modes and switches set on this Mac do not allow what this command asked for, so it was not started.',
    other: 'It was refused before it started.'
  },
  remedy: { reviewHardlinks: 'Review the hard links', openMachine: 'Open Backends' },
  refusals: {
    shellLook:
      'A shell looked at this folder, as a cd or a wildcard does. The sandbox refused it, so nothing was read.',
    looked: count => (count === 1 ? 'Looked once' : `Looked ${count} times`),
    times: count => `${count} times`,
    all: 'All',
    unattributed: 'Not attributed to a command',
    evicted: 'A command no longer listed',
    beforeStart: 'Before start',
    inspect: 'Details',
    byRuntime: 'Marked by the runtime as its own.',
    originLabel: 'Issued by',
    origin: { agent: 'Agent', runtime: 'Runtime' },
    olderInParts: (today, older) =>
      `${today.toLocaleString('en')} refused today. The newest are listed here; the ${older.toLocaleString('en')} oldest are kept in earlier parts of today’s record.`
  },
  empty: {
    runs: 'No confined command yet',
    runsHint:
      'Each command your agent runs appears here when it starts: its profile, its live time and processes, every refusal, and how it ended.',
    filtered: 'No command matches',
    filteredHint: 'Clear the search, or show All.',
    refusals: 'Nothing refused yet',
    refusalsHint:
      'When a profile refuses a read, a write, the network or a program, it appears here with the rule that refused it.',
    agents: 'No agent activity yet.',
    agentsHint: 'Each agent session appears here with its commands and what it was refused.'
  },
  agentRuns: count => plural(count, 'command', 'commands'),
  runtime: {
    title: 'Runtime',
    summary:
      'The agent runtime and the interpreter children it starts run inside this profile. Confined commands are started outside it, by the launcher, each in its own profile.',
    state: { on: 'On', broken: 'Not held', stopped: 'Not running', off: 'Off' },
    stateMeaning: {
      on: 'macOS holds the agent runtime in the runtime profile.',
      broken: 'Confinement is on, but macOS does not hold the agent runtime in the runtime profile.',
      stopped:
        "Confinement is on, but this window's agent runtime is not running: its commands wait until it starts. A background runtime may still run commands, confined.",
      off: 'No runtime profile: confinement is off.'
    },
    launcher: 'Launcher',
    launcherState: { up: 'Ready', down: 'Not answering', off: 'Off' },
    launcherMeaning: {
      up: 'Starts each confined command in its own profile, outside the runtime profile.',
      down: 'Every confined command is refused until the launcher answers again.',
      off: 'No launcher runs while confinement is off.'
    },
    off: 'The agent runtime runs without a runtime profile.',
    never: 'Never',
    showAll: count => `Show all ${count}`,
    showFewer: 'Show fewer'
  },
  machine: {
    sandboxes: 'Sandboxes',
    runtime: 'Runtime confinement',
    caches: 'Package caches',
    held: 'Held in the runtime profile',
    processes: 'Processes outside the command sandboxes',
    processesEmpty: 'Nothing else of your agent runs on this Mac.'
  },
  announce: (command, phase) => `${command}: ${phase}`
}

export const confinement: ConfinementCopy = {
  title: 'Containers',
  tile: 'Containers',
  unavailable: 'Containers run in the desktop app, where your agent runs its commands.',
  verdict: {
    green: {
      label: 'Confined',
      hint: 'Every agent command runs inside its profile, except a shell command you approve, which runs once outside it. What a confined command tries outside is blocked and listed under Refusals. While confined, MCP servers, scheduled job scripts, plugin, skill and package installs, file copies before edits, code checks after edits, delegated work copies and your hooks are off. Computer use, once you grant it, runs outside the profile through the signed driver, and asks in every mode but Ignore permissions. You can turn isolation off in Backends or in Settings › Agent › Permissions; the app asks first.'
    },
    red: { label: 'Not confined', hint: 'Confinement is not verified. The reasons are below.' },
    off: {
      label: 'Off',
      hint: 'Confinement is off: agent commands run unconfined, and MCP servers, scheduled job scripts, installs, file copies before edits, code checks after edits, delegated work copies and your hooks run again.'
    }
  },
  kinds: {
    hermes: 'Agent runtime',
    'agent-command': 'Agent command, not confined',
    tool: 'Tool (MCP server, helper)',
    runtime: 'Runtime child'
  },
  killed: count => (count === 1 ? 'Stopped 1 process' : `Stopped ${count} processes`),
  killFailed: {
    survivors: count =>
      count === 1 ? '1 process still running. Try Stop again.' : `${count} processes still running. Try Stop again.`,
    unverified: () => 'Stopped what it could see, but could not ask macOS whether anything else of it survives',
    'not-confined': () => 'Not a confined process: nothing was stopped',
    invalid: () => 'Not a process: nothing was stopped'
  },
  scope:
    'Confined: the terminal, code execution, the file tools and media helpers, each inside its own profile. Off while confined: MCP servers, scheduled job scripts, plugin, skill and package installs, keychain imports and local speech commands. Computer use, once you grant it, runs outside the profile through the signed driver, and asks in every mode but Ignore permissions. The browser and screen recording run outside the profile too, when your mode lets them run. With Web browsing on, the browser asks in Manual and Accept edits, runs with no ask in Automatic, and in Plan opens and reads pages with no ask. With its switch on, screen recording asks in every mode but Plan, which refuses it. In Ignore permissions neither asks.',
  backendName: { seatbelt: 'Seatbelt (macOS)', container: 'Apple container' },
  backendStatus: {
    ready: 'Ready',
    'not-installed': 'Not installed',
    installed: 'Installed',
    unsupported: 'Not on this Mac',
    broken: 'Not working',
    unknown: 'Could not check'
  },
  active: 'Active',
  network: { grant: 'Network only with a grant', never: 'Network never' },
  reads: 'Reads',
  writes: 'Writes',
  never: count => `Never: ${count} secret and app paths, the keychain`,
  classes: {
    research: { name: 'Research', summary: 'Reads the project, writes its scratch only.' },
    project: { name: 'Project', summary: 'Writes the project and its scratch.' },
    build: { name: 'Build', summary: 'The project plus the package caches.' },
    offline: { name: 'Offline', summary: 'The project, never the network.' },
    media: { name: 'Media', summary: 'Reads the inputs, writes one output folder.' }
  },
  defaultClass: name => `Default: ${name}`,
  unattributed: 'Unattributed',
  noSession: 'No session',
  insideCount: count => `${count} running inside`,
  outsideCount: count => `${count} running outside`,
  elapsed: seconds =>
    seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`,
  reasons: 'Why it is not confined',
  reason: {
    'backend-not-confining': ({ backend, detail }) =>
      backend === 'container'
        ? 'Apple container is not confining yet'
        : detail === 'probe-timeout'
          ? 'Seatbelt could not be checked in time: confinement is not verified right now'
          : detail === 'probe-failed'
            ? 'Seatbelt could not be checked: the check itself failed, so confinement is not verified right now'
            : 'Seatbelt is not confining on this Mac',
    'plugin-not-loaded': () =>
      'Shell blocked: confinement not loaded. Your agent’s commands are refused until it loads.',
    'profile-changed': ({ cls }) => `The ${cls} profile was changed on disk`,
    'widened-profile': ({ pid }) => `Process ${pid} runs under a widened profile`,
    'unknown-profile': ({ pid }) => `Process ${pid} runs under a profile this app did not make`,
    'agent-command-outside': ({ pid }) => `Agent command ${pid} runs outside confinement`,
    'forged-marker': ({ pid }) => `Process ${pid} claims to be confined, but macOS says it is not`,
    'agent-config-unreadable': () =>
      'config.yaml could not be read, so any terminal.backend in it was not applied. Commands still run in the sandbox. Fix the file and restart.',
    'membership-unverified': () =>
      'macOS could not be asked which processes are confined: a process that left its tree may not be counted',
    'hardlink-appeared': ({ path, pid, root }) =>
      `A hard link to a file outside ${root} appeared during run ${pid} (${path}): it could only be found after the run, which may have reached it; the next run there is refused until you allow it`,
    'runtime-not-confined': ({ pid }) =>
      `The agent runtime (${pid}) runs, but macOS does not hold it in the runtime profile`,
    'runtime-not-running': () =>
      "The agent runtime is not running: this window's commands wait until it starts. A background runtime may still run commands, confined.",
    'launcher-down': () => 'The launcher is not answering: confined commands are refused until it answers again',
    'agent-commands-unavailable': ({ reason }) =>
      `Agent commands are unavailable: ${reason} (reported by the agent runtime)`,
    'settings-ignored': () =>
      'The confinement settings file on disk was not signed by this app, so it was ignored: confinement stays on, with its defaults'
  },
  notes: 'Note',
  backendEnforcingOff: 'A test profile was refused, as expected.',
  backendDetail: {
    enforcing: 'Enforcing: a test profile was refused, as expected.',
    'not-enforcing': 'Runs but does not enforce: the control profile did not deny its canary.',
    'cannot-run': 'Cannot run a profile.',
    'binary-missing': 'sandbox-exec is missing: nothing can be confined.',
    'macos-only': 'Seatbelt exists on macOS only.',
    'needs-apple-silicon': 'Apple container needs Apple silicon and macOS 26 or later.',
    'no-version': 'Installed, but it did not answer a version check: the install looks broken.',
    'not-installed': 'Not installed. Installing it is your step, with your admin password, once:',
    'not-wired':
      'Not used in this version: it refuses every command until a spike proves it can run them, so icloneOS confines commands with Seatbelt only.',
    'probe-failed': 'The check itself failed.',
    'probe-timeout': 'The check did not finish in time: this Mac may have been busy. It runs again shortly.'
  },
  firstScan: dirs =>
    dirs === 1
      ? 'Checking the project folder… 1 folder'
      : `Checking the project folder… ${dirs.toLocaleString('en')} folders`,
  hardlinks: {
    blocked: (root, paths, count) =>
      `Confinement will not start in ${root}: ${paths.join(', ')}${count > paths.length ? ` and ${count - paths.length} more` : ''} ${count === 1 ? 'is a hard link' : 'are hard links'} to a file outside the project, so remove ${count === 1 ? 'it' : 'them'} or allow ${count === 1 ? 'it' : 'them'} below by folder.`,
    cannotScan: (root, paths, count) =>
      `Confinement will not start in ${root}: it cannot list ${paths.join(', ')}${count > paths.length ? ` and ${count - paths.length} more` : ''}, so a hard link could hide there; give ${count === 1 ? 'that folder' : 'those folders'} read permission (chmod u+rx).`,
    group: (dir, count) =>
      `${count === 1 ? 'The 1 file' : `The ${count} files`} under ${dir} — hard links to outside the project`,
    allow: count => (count === 1 ? 'Allow this file' : `Allow ${count} files`),
    allowTip:
      'Commands may read and write exactly these files, as they are now, and through them the outside files they are linked to; a new link asks again',
    allowed: count =>
      count === 1 ? 'Allowed: this 1 file, as it is now' : `Allowed: these ${count} files, as they are now`,
    ackFailed: {
      'no-gesture': 'Not allowed: click the button yourself',
      'not-in-project': 'Not allowed: the folder is not in that project',
      'nothing-to-allow': 'Nothing to allow: no hard link is left under that folder',
      changed: 'Not allowed: the files under that folder changed since they were shown; read them again',
      invalid: 'Not allowed: the folder is gone'
    },
    showAll: (count: number) => `Show all ${count.toLocaleString('en-US')}`,
    showMore: (left: number) => `Show ${left.toLocaleString('en-US')} more`,
    showFewer: 'Show fewer',
    cachesUnscanned:
      'Package caches (npm, pip, cargo, pnpm…) are not scanned for hard links: a Build command may read and fill them anyway.'
  },
  ledger
}
