// iclone os — V3-F permission modes: Settings › Agent › Permissions and the permission ask on the consent sheet.
// Every locale fills this shape (PermissionsCopy); main decides, these words only explain.
import { FUNCTION_COPY } from '@/iclone-shared/permission-function-copy'
import type { ActionClass, PermissionMode } from '@/iclone-shared/permissions'

import { PRODUCT_NAME } from './enConsent'

// `short` is the composer menu's one line (at most four words); `summary` is the full account
// Settings › Agent › Permissions shows.
type PerMode = Record<PermissionMode, { name: string; short: string; summary: string }>
type PerClass = Record<ActionClass, string>

const modes: PerMode = {
  ignore: {
    name: 'Ignore permissions',
    short: 'Never asks',
    // L5-01: the menu now carries one line; this summary and the system alert keep the full account, the
    // Seatbelt's limits included.
    summary:
      'Asks about nothing, spending, moving iNFTs, sending keys, your admin password and its own permissions included. Apart from confinement while it is on, five checks stay: destroying the whole disk, home folder or system, a recursive delete whose whole target is a variable or command output it cannot read, or a recursive delete it can read as aimed at the disk, a home folder or the system, also when a variable left empty would make it so, or by a command whose name it cannot read, or a recursive delete whose targets or options it cannot fully read, a call too unreadable to check (a patch whose files it cannot name, a write that names no file, or arguments it cannot read), deny rules you wrote, and the file tools on the runtime’s own stores (writes to state.db, sessions, tokens, pairing, vault, the browser profile and the runtime’s own .env; reads of tokens, vault, the browser profile, auth.json, auth.lock, that .env and webhook subscriptions). Computer use, screen recording and the browser run outside the Seatbelt, and the file tools write files in your home folder outside it one file at a time.'
  },
  manual: {
    name: 'Manual',
    short: 'Asks before acting',
    summary:
      'Asks before every write outside its own iNFT profile (SOUL, memories, its folder) and before every command, network call, message, install and deletion. Reading in the project does not ask, a file elsewhere in your home folder can, and a confined command reads a folder only when it runs in it.'
  },
  automatic: {
    name: 'Automatic',
    short: 'Edits, runs safe commands',
    summary: 'Writes in the project, runs safe commands and uses the web on its own. Asks for the rest.'
  },
  plan: {
    name: 'Plan',
    short: 'Reads and plans',
    summary: 'Reads and plans in the chat. It changes nothing but its own iNFT profile (SOUL, memories, its folder).'
  },
  acceptEdits: {
    name: 'Accept edits',
    short: 'Edits without asking',
    summary: 'Edits files in the project on its own. Asks for everything else.'
  }
}

const classes: PerClass = {
  R: 'read files',
  Wp: 'write a file in the project',
  Wo: 'write a file outside the project',
  X: 'run a command',
  N: 'use the network',
  $: 'spend money',
  M: 'send a message',
  S: 'control another app or use a system permission',
  I: 'install software',
  D: 'delete files'
}

const effects: PerClass = {
  R: 'It will read this and change nothing.',
  Wp: 'It will create or change this file inside the project.',
  Wo: "It will create or change this file outside the project. While the Seatbelt is on, this app's own files stay shut, and the agent is told to use a shell command, which you read in full first.",
  X: 'It will run this command on this Mac.',
  N: 'It will send this request over the internet.',
  $: 'It will move this amount from your wallet or card.',
  M: 'It will send this message in your name.',
  S: 'It will do exactly this, once, through a macOS permission you granted in System Settings.',
  I: 'It will install this software for your user.',
  D: 'It will delete this.'
}

export const enPermissions = {
  title: 'Permissions',
  lead: `What your agent may do on this Mac without asking you. A mode changes from a click in this app, not from the agent's request or an update; in Ignore permissions, with computer use on, the agent can click too.`,
  enforcement: {
    enforced: 'Enforced: every tool call your agent makes passes these rules first.',
    starting: 'Starting: checking that the permission gate is loaded in your agent.',
    'not-enforced':
      'Not enforced: the permission gate is not answering, so your agent’s tools are refused until it restarts.',
    'no-agent': 'Your agent is not running.',
    degraded:
      'The system keychain could not protect the record’s key: a mode you choose lasts until icloneOS quits, then it is Manual again, and the record cannot be verified across restarts.',
    // FX-2 r1b: the degraded state's cause when the owner's Keychain setting is off, and the fix.
    'keychain-off':
      'A mode you choose lasts until icloneOS quits, then it is Manual again: the Keychain setting is off, so it cannot be saved protected. To keep it, turn on Keychain in Settings › Machine › Gateways › “Keep saved passwords in the system keychain”.',
    // V3-FX M1: turned on while the app runs — payments and the ACP tools follow at once, the modes after a restart.
    'keychain-restart':
      'Keychain is on. The permission key is sealed when icloneOS starts: restart icloneOS to keep a mode across restarts. Payments and the ACP tools already use it.'
  },
  // r3/r4: the button beside the modes' restart line (the Keychain turned on since launch), and what it says
  // when main refuses the relaunch.
  restartNow: 'Restart now',
  restartRefused: 'icloneOS could not restart now. Quit and open it again to use the modes.',
  modes,
  // L5-11: the Message bar's per-chat menu, in every locale. Owner 11-10: the menu changes this chat only; the
  // default lives in Settings. The Ignore note is one line (DECISOES_LEAD 11-10); the full account is the
  // Ignore summary above and main's system alert.
  menu: {
    title: 'This chat',
    trigger: (mode: string) => `Permission mode for this chat: ${mode}`,
    triggerNotInForce: (inForce: string, chosen: string) =>
      `Permission mode for this chat: ${inForce}. ${chosen} is chosen, not in force`,
    appliesToSession: 'Only this chat, from the next message. Default in Settings › Agent › Permissions.',
    appliesToNewChat: 'Only this new chat. Default in Settings › Agent › Permissions.',
    ignoreNote: {
      confined: 'Five checks still refuse. Details in Settings.',
      unconfined: 'Seatbelt off: five app checks only.'
    }
  },
  classes,
  current: 'In use',
  chosenNotInForce: 'Chosen, not in force',
  choose: 'Use',
  scope: {
    label: 'Applies to',
    standing: 'Default for new sessions',
    standingNote:
      "An open chat with its own mode keeps it; change that in its Message bar. A chat with no mode of its own or its project's follows this default.",
    project: (path: string) => `This project · ${path}`,
    noProject: 'Open a project to give it its own mode.'
  },
  refused: {
    gesture: 'The mode changes only from your own click or key in this app.',
    invalid: 'This mode cannot be chosen here.',
    unavailable: `Permission modes need the ${PRODUCT_NAME} desktop app.`
  },
  floor: {
    title: 'What stays checked',
    items: [
      'In every mode, Ignore permissions included, it refuses to wipe the disk, your home folder or system folders, or to format a drive.',
      'Outside Ignore permissions, it cannot move an iNFT, send your keys, type your administrator password or change its own permissions without your answer, and no grant lifts that.',
      'In Ignore permissions nothing asks, so it can do all of those.',
      'These are checks in the app, not a wall in the kernel: a program can get round them.'
    ]
  },
  // V3-F2: the Functions matrix (shared with main's native raise confirm).
  functions: FUNCTION_COPY.en,
  // FX-6: what confinement really does (on by default, V3-G); the pane picks the line for the live state.
  shellNote: {
    on: 'Confinement is on, and you can turn it off. Agent commands run confined (Seatbelt) in every mode, Ignore permissions included: they write only in the project and a scratch folder, and reach the network only when the mode or a grant allows it. A shell command you approve runs once outside it.',
    off: 'Confinement is off: commands run as you, in every mode, and can read and change anything you can.',
    // V3-FX M2: main's live verdict is red (on but not working), or not read yet.
    red: 'Confinement is not working right now (Containers shows why): until it is, a command in any mode could read and change anything you can.',
    pending: 'Reading the confinement state…'
  },
  grants: {
    title: 'Permissions you gave',
    empty: 'None. When you allow something for longer than once, it appears here.',
    scope: { session: 'this chat', project: 'this project', standing: 'everywhere' },
    revoke: 'Revoke',
    folderTitle: 'Folder you allowed',
    folderHint: 'commands may write here when a mode allows it',
    removeFolder: 'Remove'
  },
  // A-1: a permission state file main refused or could not verify at launch (store.ts `integrity`): what happened and
  // what is in force instead, one line each. The two grant files share the `grants` wording.
  integrity: {
    mode: {
      tampered: `The permission mode on disk was changed or damaged outside ${PRODUCT_NAME} and is not in force: Manual everywhere until you choose a mode again.`,
      unverified:
        'The permission mode was saved by an earlier version or while the Keychain was off, so it could not be verified: Manual everywhere until you choose a mode again.',
      missing: 'The permission mode file is missing: Manual everywhere until you choose a mode again.'
    },
    functions: {
      tampered: `The function levels on disk were changed or damaged outside ${PRODUCT_NAME} and are not in force: every function is Manual until you choose it again.`,
      unverified:
        'The function levels were saved by an earlier version or while the Keychain was off, so they could not be verified: the levels marked pending below stay Manual until you confirm them.',
      missing: 'The function levels file is missing: every function is Manual until you choose it again.'
    },
    grants: {
      tampered: `The permissions you gave were changed or damaged outside ${PRODUCT_NAME} and are not in force: allow them again when asked.`,
      unverified:
        'The permissions you gave were saved by an earlier version or while the Keychain was off, so they could not be verified and are not in force: allow them again when asked.',
      missing: 'The file of permissions you gave is missing; none is in force: allow them again when asked.'
    }
  },
  audit: {
    title: 'Activity',
    empty: 'Nothing recorded yet.',
    chainOk: (count: number) => `${count.toLocaleString()} records · intact`,
    chainBroken: `The record has a gap or was changed outside ${PRODUCT_NAME}.`,
    chainVerifying: 'Checking records…',
    otherKind: 'Permission record',
    kinds: {
      use: 'Allowed',
      refuse: 'Refused',
      ask: 'Asked you',
      answer: 'You answered',
      timeout: 'No answer',
      mode_set: 'Mode changed',
      mode_refused: 'Change refused',
      grant: 'Permission given',
      revoke: 'Permission revoked',
      gap: 'Gap',
      restart: `${PRODUCT_NAME} started`,
      fn_level_set: 'Level changed',
      fn_level_refused: 'Level change refused'
    } as Record<string, string>,
    details: {
      denied: 'You refused it',
      busy: 'Too many permission requests were already waiting',
      withdrawn: 'Withdrawn before you answered',
      noGesture: 'Not from your own click',
      notConfirmed: 'Not confirmed on the system dialog',
      standingIgnore: 'Refused by an earlier version: Ignore permissions could not be the default then',
      invalid: 'Not a valid change',
      raced: 'The level changed while the dialog was open',
      gateNotStarted: (pid: string | null) =>
        pid
          ? `The permission gate in the agent runtime (pid ${pid}) never started; its tool calls are refused`
          : 'The permission gate in the agent runtime never started; its tool calls are refused',
      gateStopped: (pid: string | null) =>
        pid
          ? `The permission gate in the agent runtime (pid ${pid}) stopped answering`
          : 'The permission gate in the agent runtime stopped answering',
      unverified: (count: number) =>
        count === 1
          ? `${count} line from the agent runtime could not be verified and was not recorded`
          : `${count} lines from the agent runtime could not be verified and were not recorded`,
      missedEvents: (count: number) =>
        count === 1
          ? `${count} event from the permission gate never arrived`
          : `${count} events from the permission gate never arrived`,
      confinementBurst: (count: number) =>
        count === 1
          ? `${count} more confinement refusal that minute is kept in Containers › Refusals only`
          : `${count} more confinement refusals that minute are kept in Containers › Refusals only`,
      confined: 'Blocked by confinement',
      gap: 'Something could not be recorded',
      payment: {
        settled: 'Payment settled',
        pending: 'Settlement still pending',
        failed: 'The payment did not complete',
        ledger: 'The payments record does not verify',
        limit: 'Over a limit in Economy › Payments',
        stopped: 'Hard stop: every payment is refused',
        payee: 'Payee or site not allowed',
        mandate: 'No valid mandate',
        denied: 'You refused it on the permission sheet',
        setting: 'A change to Economy › Payments',
        service: 'Refused by the payments service',
        other: 'A payment',
        unrecorded: 'A payment that is not in the payments record',
        uncertain: 'Outcome unknown: check the payments record',
        stopOff: 'Hard stop cleared',
        mandateIssued: 'Mandate issued',
        mandateRevoked: 'Mandate revoked',
        mandateChange: 'A change to the mandates'
      }
    }
  },
  ask: {
    eyebrow: (who: string) => (who ? `Permission request · ${who}` : 'Permission request'),
    title: (what: string) => `Your agent wants to ${what}`,
    targetLabel: 'Exactly this',
    folderLabel: 'In folder',
    expand: 'Show all',
    collapse: 'Show less',
    reasonLabel: 'Why, in your agent’s words',
    effects,
    heldFile:
      'This is a file your shell, git or launchd runs from, or it holds keys. What the agent writes there may run later with your access. Read the path before you allow.',
    outsideFilePatch:
      'Allowing reads this one file, then writes it, outside the Seatbelt. The agent sees the lines it changes:',
    mode: (name: string) => `Mode: ${name}`,
    scopeLabel: 'Allow for',
    scopes: { once: 'Just this once', session: 'This chat', project: 'This project', standing: 'Everywhere' },
    laterConfined:
      'Only this command goes outside. The following commands that no check stops run with no ask and stay inside the Seatbelt, so one that needs more is refused. Revoke this in Settings › Agent › Permissions to be asked again.',
    heldRead:
      'This file or folder holds keys or tokens, or runs from your shell. With the Seatbelt off nothing else stands in the way: allowing gives the agent all of it, and what it reads goes to the model.',
    covers: {
      session: (what: string) => `Allows every request to ${what} in this chat, not only this one.`,
      project: (what: string) => `Allows every request to ${what} in this project, not only this one.`,
      standing: (what: string) => `Allows every request to ${what}, everywhere, until you revoke it.`
    },
    deny: 'Deny',
    allow: 'Allow',
    expires: 'No answer within two minutes counts as Deny.'
  },
  // CF4 (B2-m1): a mode the sealed launch put back because its audit record was missing; shown once, calmly.
  modeReset: {
    standing: (mode: string) => `Your default went back to ${mode} because its record was missing. Choose it again.`,
    project: (mode: string | null) =>
      mode === null
        ? "A project's own mode was removed because its record was missing. Choose it again."
        : `A project's mode went back to ${mode} because its record was missing. Choose it again.`,
    session: (mode: string | null) =>
      mode === null
        ? "A chat's own mode was removed because its record was missing. Choose it again."
        : `A chat's mode went back to ${mode} because its record was missing. Choose it again.`,
    dismiss: 'Dismiss'
  },
  approvalPointer: 'Waiting for your permission — answer on the sheet at the top.'
}

export type PermissionsCopy = typeof enPermissions
