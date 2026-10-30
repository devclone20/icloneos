// iclone os — V3-F permission modes: Settings › Agent › Permissions and the permission ask on the consent sheet.
// Every locale fills this shape (PermissionsCopy); main decides, these words only explain.
import { FUNCTION_COPY } from '@/iclone-shared/permission-function-copy'
import type { ActionClass, PermissionMode } from '@/iclone-shared/permissions'

import { PRODUCT_NAME } from './enConsent'

type PerMode = Record<PermissionMode, { name: string; summary: string }>
type PerClass = Record<ActionClass, string>

const modes: PerMode = {
  ignore: {
    name: 'Ignore permissions',
    summary: 'Works without asking, except to spend money or request a system permission. Never the default.'
  },
  manual: {
    name: 'Manual',
    summary: 'Asks before every write, command, network call, message, install and deletion. Reading is free.'
  },
  automatic: {
    name: 'Automatic',
    summary: 'Writes in the project, runs safe commands and reads the web on its own. Asks for the rest.'
  },
  plan: {
    name: 'Plan',
    summary: 'Read-only. Your agent reads and writes its plan in the chat; it changes nothing.'
  },
  acceptEdits: {
    name: 'Accept edits',
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
  S: 'request a system permission',
  I: 'install software',
  D: 'delete files'
}

const effects: PerClass = {
  R: 'It will read this and change nothing.',
  Wp: 'It will create or change this file inside the project.',
  Wo: 'It will create or change this file outside the project.',
  X: 'It will run this command on this Mac.',
  N: 'It will send this request over the internet.',
  $: 'It will move this amount from your wallet or card.',
  M: 'It will send this message in your name.',
  S: 'It will ask macOS for this permission; you grant it in System Settings.',
  I: 'It will install this software for your user.',
  D: 'It will delete this.'
}

export const enPermissions = {
  title: 'Permissions',
  lead: `What your agent may do on this Mac without asking you. Only your own click here changes it — never the agent, never an update.`,
  enforcement: {
    enforced: 'Enforced: every tool call your agent makes passes these rules first.',
    starting: 'Starting: checking that the permission gate is loaded in your agent.',
    'not-enforced':
      'Not enforced: the permission gate is not answering, so your agent’s tools are refused until it restarts.',
    'no-agent': 'Your agent is not running.',
    degraded:
      'The system keychain could not protect the record’s key: Manual only, and the record cannot be verified across restarts.',
    // FX-2 r1b: the degraded state's cause when the owner's Keychain setting is off, and the fix.
    'keychain-off':
      'Manual only: the Keychain setting is off, so the other modes cannot be protected. Turn on Keychain in Settings › Machine › Gateways › “Keep saved passwords in the system keychain” to use Automatic, Plan and the other modes.',
    // V3-FX M1: turned on while the app runs — payments and the ACP tools follow at once, the modes after a restart.
    'keychain-restart':
      'Keychain is on. The permission key is sealed when icloneOS starts: restart icloneOS to use Automatic, Plan and the other modes. Payments and the ACP tools already use it.'
  },
  // r3/r4: the button beside the modes' restart line (the Keychain turned on since launch), and what it says
  // when main refuses the relaunch.
  restartNow: 'Restart now',
  restartRefused: 'icloneOS could not restart now. Quit and open it again to use the modes.',
  modes,
  classes,
  current: 'In use',
  choose: 'Use',
  scope: {
    label: 'Applies to',
    standing: 'Everywhere',
    project: (path: string) => `This project · ${path}`,
    noProject: 'Open a project to give it its own mode.'
  },
  ignoreConfirm: {
    standingOnly: 'Ignore permissions is never the default for everything: choose it for one project.'
  },
  refused: {
    gesture: 'The mode changes only from your own click.',
    invalid: 'This mode cannot be chosen here.',
    unavailable: `Permission modes need the ${PRODUCT_NAME} desktop app.`
  },
  floor: {
    title: 'Never, in any mode or at any level',
    items: [
      'Wipe the disk, your home folder or system folders, format a drive, or shut the Mac down',
      'Change its own permissions, this mode, or the record of what it did',
      'Read your keys, passwords, wallet seeds or tokens to send them anywhere',
      `Stop ${PRODUCT_NAME}, its agent runtime or this permission gate`,
      'Type your administrator password or turn on a system permission for itself',
      'Transfer an iNFT or sign an approval for one'
    ]
  },
  // V3-F2: the Functions matrix (shared with main's native raise confirm).
  functions: FUNCTION_COPY.en,
  // FX-6: what confinement really does (on by default, V3-G); the pane picks the line for the live state.
  shellNote: {
    on: 'Agent commands run confined by default (Seatbelt), in every mode, Ignore permissions included: they write only in the project and a scratch folder, and reach the network only when the mode or a grant allows it. You can turn this off in Containers by choosing This Mac.',
    off: 'Confinement is off (you chose This Mac in Containers): in Ignore permissions and Automatic, a command can write outside the project.',
    // V3-FX M2: main's live verdict is red (on but not working), or not read yet.
    red: 'Confinement is not working right now (Containers shows why): until it is, in Ignore permissions and Automatic a command could write outside the project.',
    pending: 'Reading the confinement state…'
  },
  grants: {
    title: 'Permissions you gave',
    empty: 'None. When you allow something for longer than once, it appears here.',
    scope: { session: 'this chat', project: 'this project', standing: 'everywhere' },
    revoke: 'Revoke'
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
    chainOk: (count: number) => `${count} records · intact`,
    chainBroken: `The record has a gap or was changed outside ${PRODUCT_NAME}.`,
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
      standingIgnore: 'Ignore permissions cannot be the default everywhere',
      invalid: 'Not a valid change',
      raced: 'The level changed while the dialog was open',
      gateNotStarted: (pid: string | null) =>
        pid
          ? `The permission gate in Hermes (pid ${pid}) never started; its tool calls are refused`
          : 'The permission gate in Hermes never started; its tool calls are refused',
      gateStopped: (pid: string | null) =>
        pid
          ? `The permission gate in Hermes (pid ${pid}) stopped answering`
          : 'The permission gate in Hermes stopped answering',
      unverified: (count: number) =>
        count === 1
          ? `${count} line from Hermes could not be verified and was not recorded`
          : `${count} lines from Hermes could not be verified and were not recorded`,
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
    eyebrow: (who: string) => `Permission request · ${who}`,
    title: (what: string) => `Your agent wants to ${what}`,
    targetLabel: 'Exactly this',
    expand: 'Show all',
    collapse: 'Show less',
    reasonLabel: 'Why, in your agent’s words',
    effects,
    mode: (name: string) => `Mode: ${name}`,
    scopeLabel: 'Allow for',
    scopes: { once: 'Just this once', session: 'This chat', project: 'This project', standing: 'Everywhere' },
    covers: {
      session: (what: string) => `Allows every request to ${what} in this chat, not only this one.`,
      project: (what: string) => `Allows every request to ${what} in this project, not only this one.`,
      standing: (what: string) => `Allows every request to ${what}, everywhere, until you revoke it.`
    },
    deny: 'Deny',
    allow: 'Allow',
    expires: 'No answer within two minutes counts as Deny.'
  },
  approvalPointer: 'Waiting for your permission — answer on the sheet at the top.'
}

export type PermissionsCopy = typeof enPermissions
