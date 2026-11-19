/**
 * v0.0.9 F3 — the words of the boot-failure card's cause line, the "agent stopped" banner and Settings › Diagnostics ›
 * Repair kit. English only (the app ships English); imported directly by those surfaces.
 */
import { type BootCause, type BootCauseCode, missingModuleOf } from '../../../electron/boot-cause'
import type { RepairClassId, RepairFindingStatus } from '../../../electron/repair-kit/types'

/** One sentence that says what failed, and one that says what fixes it. Null: the card keeps its generic copy. */
export const f3Causes: Record<BootCauseCode, null | { cause: string; remedy: string }> = {
  'install-state-not-writable': {
    cause:
      'The agent could not write its install record: an older record of this runtime sits in ~/.hermes/installs, a folder the sandbox never lets the agent write.',
    remedy:
      'Repair install moves that record aside to ~/.hermes/installs-aside-<date>. Nothing is deleted, and Settings › Diagnostics can undo it.'
  },
  'gate-not-loaded': {
    cause: 'The permission gate did not load, so the agent was not started.',
    remedy:
      "Repair install turns the app's plugins back on if config.yaml turned them off; otherwise it reinstalls the runtime, and the gate with it."
  },
  'port-in-use': {
    cause: 'A port or socket the agent needs is held by something left over.',
    remedy:
      "Repair install stops the app's own leftover processes and moves dead sockets aside. A program that is not the app's is left alone."
  },
  'python-import': {
    cause: 'The agent runtime could not load its own modules: its environment is broken or from another version.',
    // r3-n3: the record moves only when the kit finds it broken; an intact one is left where it is (nothing to undo).
    remedy:
      'Repair install reinstalls the runtime. If its environment record is broken, that record is moved aside first, never deleted.'
  },
  'runtime-env-broken': {
    cause: "The agent's environment is broken: its Python interpreter is gone.",
    remedy:
      'Repair reinstalls the agent. The broken environment is moved aside, nothing is deleted, and you are not asked to set up again.'
  },
  'exit-nonzero': {
    cause: 'The agent stopped before it was ready.',
    remedy:
      'Retry starts it again. Repair install restarts it, and reinstalls it if it keeps failing. The logs have the details.'
  },
  timeout: {
    cause: 'The agent did not become ready in time.',
    remedy: 'Retry starts it again. If it keeps happening, open the logs.'
  },
  unknown: null
}

/**
 * v0.0.9 r2 (m-r2-3): the cause line for THIS failure. A missing package the runtime named gets its own sentence
 * ("A part of the agent is missing (fastapi). Repair reinstalls it."); every other cause keeps its code's copy.
 */
export function f3CauseCopy(cause: BootCause | null | undefined): null | { cause: string; remedy: string } {
  if (!cause) {
    return null
  }

  const missing = missingModuleOf(cause)

  if (missing) {
    return {
      cause: `A part of the agent is missing (${missing}). Repair reinstalls it.`,
      // v0.0.9 r3-n3: a missing package is a reinstall. The r3 proof ran 0 kit steps and wrote no manifest, so the old
      // promise ("moved aside first … Settings › Diagnostics can undo it") described a move that never happened.
      remedy: 'Nothing of yours is moved or deleted.'
    }
  }

  return f3Causes[cause.code]
}

/**
 * v0.0.9 G-1 (design G): the stopped banner's cause line. The card's missing-package sentence ends "Repair reinstalls
 * it." because the card renders Repair; the banner names no verb of its own — what it can do is on its buttons.
 */
export function f3BannerCause(cause: BootCause | null | undefined): null | string {
  const missing = missingModuleOf(cause)

  if (missing) {
    return `A part of the agent is missing (${missing}).`
  }

  return f3CauseCopy(cause)?.cause ?? null
}

export const f3Card = {
  /** v0.0.9 r4 (design r3 N3): the local card's settings button — the agent's, never "Gateway settings". */
  agentSettings: 'Agent settings',
  close: 'Close — open the app without the agent',
  /** v0.0.9 r3 (design N6): the card's sentence when no cause is recognised — "the agent", never "gateway". */
  description: "The agent didn't come up. Nothing here deletes your chats or settings.",
  /** One disclosure for the engine's own text, the recent log and the log folder. */
  details: 'Details',
  hideDetails: 'Hide details',
  openLogFolder: 'Open log folder',
  /** The cause is not one the app knows (critic M2: still a sentence, never the raw error under a progress bar). */
  unknownCause: 'The agent hit a problem while starting. The failure screen shows what happened.'
}

export const f3Banner = {
  title: 'The agent is not running',
  // r4d (design r4 F2-1): one verb for starting the agent again, the crash toast's own.
  retry: 'Restart agent',
  // r5 (design R5-2): one label for the one disclosure, across the banner, the centre and the toast.
  details: 'Details',
  /** For the composer, which stays disabled while the agent is stopped. */
  composerReason: 'The agent is not running. Restart it from the banner at the top of the window.'
}

export const f3Kit = {
  title: 'Repair kit',
  intro:
    'Checks the known reasons an agent will not start. A repair stops the agent, moves what it changes aside — nothing is deleted — and can be undone below.',
  check: 'Check',
  checking: 'Checking…',
  notChecked: 'Not checked yet.',
  allClear: 'Nothing to repair.',
  preview: 'Preview',
  repair: 'Repair',
  undo: 'Undo',
  restart: 'Restart the agent',
  classes: {
    'stale-install-record': 'Old install record in ~/.hermes/installs',
    'runtime-venv': 'Agent runtime environment',
    'plugins-disabled': 'App plugins switched off in config.yaml',
    'root-permissions': 'Folder permissions',
    'gate-not-starting': 'Permission gate',
    'port-busy': 'Ports and sockets',
    'orphan-processes': 'Leftover agent processes'
  } satisfies Record<RepairClassId, string>,
  status: {
    found: 'Can be repaired',
    manual: 'Needs you',
    ok: 'OK',
    skipped: 'Not used here'
  } satisfies Record<RepairFindingStatus, string>,
  planned: (count: number) =>
    count === 1 ? 'The repair would make 1 change:' : `The repair would make ${count} changes:`,
  nothingToDo: 'Nothing to change.',
  repaired: (folder: string) => `Repaired. The record of what changed is in ${folder}.`,
  repairedNextStart: 'Repaired. It is checked again when the agent next starts.',
  refusedGesture: 'Not repaired: a repair runs only from your own click on its button.',
  refusedBusy: 'Another repair is running. Try again in a moment.',
  failed: (error: string) => `Not repaired: ${error}`,
  history: 'Past repairs',
  historyEmpty: 'No repairs yet.',
  undone: 'Undone',
  undoDone: (count: number) => (count === 1 ? 'Put 1 change back.' : `Put ${count} changes back.`),
  undoSkipped: (count: number) =>
    count === 1
      ? '1 change was left as it is (it changed since, or cannot be undone).'
      : `${count} changes were left as they are (they changed since, or cannot be undone).`,
  unavailable: 'The repair kit needs this release of the app (its bridge is not available in this window).'
}
