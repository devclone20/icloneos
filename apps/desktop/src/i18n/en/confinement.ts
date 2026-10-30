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
  OutsideKind
} from '@/iclone-shared/confinement'

/** One sentence per reason code, given that reason's own fields. */
type ReasonCopy = {
  [K in ConfinementReason['code']]: (reason: Extract<ConfinementReason, { code: K }>) => string
}

export interface ConfinementCopy {
  title: string
  tile: string
  unavailable: string
  loading: string
  verdict: Record<ConfinementVerdict, { label: string; hint: string }>
  tabs: { live: string; agents: string; profiles: string; refusals: string; backends: string }
  inside: string
  outside: string
  col: { pid: string; profile: string; session: string; time: string; command: string; kind: string }
  kinds: Record<OutsideKind, string>
  kill: string
  killTip: (pid: number) => string
  killed: (count: number) => string
  /** Kill failed: the count is the processes still alive (survivors), else 0. */
  killFailed: Record<KillFailure, (count: number) => string>
  why: string
  follow: string
  following: (pid: number) => string
  stopFollowing: string
  empty: { inside: string; outside: string; agents: string; refusals: string }
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
  refusal: { operation: string; target: string; process: string }
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
    /** One line (T4): the package caches a Build command may fill are not scanned for hard links. */
    cachesUnscanned: string
  }
}

export const confinement: ConfinementCopy = {
  title: 'Containers',
  tile: 'Containers',
  unavailable: 'Containers run in the desktop app, where your agent runs its commands.',
  loading: 'Reading what runs on this Mac…',
  verdict: {
    green: {
      label: 'Confined',
      hint: 'Every agent command runs inside its profile. While confined, MCP servers, scheduled job scripts, plugin, skill and package installs, computer use, file copies before edits, code checks after edits, delegated work copies and your hooks are off; This Mac turns them back on.'
    },
    red: { label: 'Not confined', hint: 'Confinement is not verified. The reasons are below.' },
    off: {
      label: 'Off',
      hint: 'You chose This Mac: agent commands run unconfined, and MCP servers, scheduled job scripts, installs, computer use, file copies before edits, code checks after edits, delegated work copies and your hooks run again.'
    }
  },
  tabs: { live: 'Live', agents: 'Agents', profiles: 'Profiles', refusals: 'Refusals', backends: 'Backends' },
  inside: 'Inside',
  outside: 'Outside',
  col: { pid: 'PID', profile: 'Profile', session: 'Session', time: 'Time', command: 'Command', kind: 'What' },
  kinds: { hermes: 'Hermes', 'agent-command': 'Agent command, not confined', tool: 'Tool (MCP server, helper)' },
  kill: 'Kill',
  killTip: pid => `Stop ${pid} and everything it started`,
  killed: count => (count === 1 ? 'Stopped 1 process' : `Stopped ${count} processes`),
  killFailed: {
    survivors: count => (count === 1 ? 'Could not stop 1 process' : `Could not stop ${count} processes`),
    unverified: () => 'Stopped what it could see, but could not ask macOS whether anything else of it survives',
    'not-confined': () => 'Not a confined process: nothing was stopped',
    invalid: () => 'Not a process: nothing was stopped'
  },
  why: 'Why',
  follow: 'Follow',
  following: pid => `Following ${pid}`,
  stopFollowing: 'Stop following',
  empty: {
    inside: 'No agent command is running.',
    outside: 'Nothing of your agent runs outside.',
    agents: 'No agent activity yet.',
    refusals: 'Nothing refused yet.'
  },
  scope:
    'Confined: the terminal, code execution, the file tools, and the browser and media helpers Hermes runs, each inside the same sandbox. Off while confined: MCP servers, scheduled job scripts, plugin, skill and package installs, computer use, keychain imports and local speech commands.',
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
  refusal: { operation: 'Refused', target: 'Target', process: 'Process' },
  unattributed: 'Unattributed',
  noSession: 'No session',
  insideCount: count => `${count} inside`,
  outsideCount: count => `${count} outside`,
  elapsed: seconds =>
    seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`,
  reasons: 'Why it is red',
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
    'membership-unverified': () =>
      'macOS could not be asked which processes are confined: a process that left its tree may not be counted',
    'hardlink-appeared': ({ path, pid, root }) =>
      `A hard link to a file outside ${root} appeared during run ${pid} (${path}): it could only be found after the run, which may have reached it; the next run there is refused until you allow it`,
    'settings-ignored': () =>
      'The confinement settings file on disk was not signed by this app, so it was ignored: confinement stays on, with its defaults'
  },
  notes: 'Note',
  backendDetail: {
    enforcing: 'Enforcing: a control profile denied its canary.',
    'not-enforcing': 'Runs but does not enforce: the control profile did not deny its canary.',
    'cannot-run': 'Cannot run a profile.',
    'binary-missing': 'sandbox-exec is missing: nothing can be confined.',
    'macos-only': 'Seatbelt exists on macOS only.',
    'needs-apple-silicon': 'Apple container needs Apple silicon and macOS 26 or later.',
    'no-version': 'Installed, but it did not answer a version check: the install looks broken.',
    'not-installed': 'Not installed. Installing it is your step, with your admin password, once:',
    'not-wired': 'Not used in this version: icloneOS confines commands with Seatbelt only.',
    'probe-failed': 'The check itself failed.',
    'probe-timeout': 'The check did not finish in time: this Mac may have been busy. It runs again shortly.'
  },
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
    cachesUnscanned:
      'Package caches (npm, pip, cargo, pnpm…) are not scanned for hard links: a Build command may read and fill them anyway.'
  }
}
