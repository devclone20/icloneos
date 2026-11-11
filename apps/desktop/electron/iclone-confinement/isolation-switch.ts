/**
 * F41 — the owner's switch for isolation (Seatbelt confinement). One state, main's signed settings file; one door, the
 * `iclone:confinement:set-isolation` channel this module answers. Off takes the user's own click on the marked control
 * (the V3-F lock, seen by the preload and by main) and then a native dialog main shows itself, with Cancel as the
 * default. On takes the click only. A Hermes cannot change the confinement it was started with, so the change restarts
 * what is running: the runtime never keeps a state the pane no longer describes.
 *
 * Nothing the runtime reaches comes here: no socket verb, no config key, no env. A renderer call without the three
 * gesture facts is refused, and the runtime profile denies the settings file (isolation-switch.test.ts).
 */
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron'

import type { IsolationSetResultView } from '../../src/iclone-shared/confinement'
import { gestureOf, permissionGestureOk } from '../iclone-permissions/gesture'

/** What restarting did: restarted the agent, or found none running, so the next start applies the state. */
export type IsolationRestart = 'done' | 'nothing-running'

interface IsolationSwitchDeps {
  layer: {
    settings: () => { enabled: boolean }
    setEnabled: (enabled: boolean) => void
    settingsPersist: () => boolean
  }
  platform: NodeJS.Platform
  /** When main last saw real input reach this IPC sender. Absent: no gesture counts. */
  lastInputAt?: (event: unknown) => number
  /** The native dialog. Absent: isolation cannot be turned off from here. */
  confirmOff?: (event: unknown, persists: boolean) => Promise<boolean>
  /** Stops the agent backends and starts the primary again. Absent: nothing is running to restart. */
  restartAgent?: () => Promise<IsolationRestart>
  /** One row in the permission audit chain for every change of state. */
  record: (entry: { kind: 'use'; reason: string }) => void
  /** Tells the windows to read the state again. */
  changed: () => void
  now?: () => number
}

/** A Hermes cannot change the confinement it started with: every backend stops and the primary, if there was one, starts
 *  again. The window always hears, and hears a restart and not a new connection, so the conversation carries on. */
export async function restartAgentInPlace(deps: {
  running: () => boolean
  stop: () => Promise<unknown>
  start: () => Promise<unknown>
  restarted: () => void
}): Promise<IsolationRestart> {
  const running = deps.running()

  try {
    await deps.stop()

    if (!running) {
      return 'nothing-running'
    }

    await deps.start()

    return 'done'
  } finally {
    deps.restarted()
  }
}

export function createIsolationSwitch(deps: IsolationSwitchDeps) {
  let busy = false

  return async (event: unknown, input: unknown): Promise<IsolationSetResultView> => {
    const asked = (input as Record<string, unknown> | null)?.enabled
    const on = deps.layer.settings().enabled

    if (typeof asked !== 'boolean') {
      return { ok: false, on, reason: 'invalid' }
    }

    if (deps.platform !== 'darwin') {
      return { ok: false, on, reason: 'unsupported' }
    }

    const gestureOk = permissionGestureOk({
      payload: gestureOf(input),
      lastInputAt: deps.lastInputAt?.(event) ?? 0,
      now: (deps.now ?? Date.now)()
    })

    if (!gestureOk) {
      return { ok: false, on, reason: 'no-gesture' }
    }

    if (busy) {
      return { ok: false, on, reason: 'busy' }
    }

    if (asked === on) {
      return { ok: true, on, restart: 'nothing-running' }
    }

    busy = true

    try {
      if (!asked && !(await deps.confirmOff?.(event, deps.layer.settingsPersist()))) {
        return { ok: false, on, reason: 'cancelled' }
      }

      deps.layer.setEnabled(asked)
      deps.record({
        kind: 'use',
        reason: asked ? 'isolation turned on by the user' : 'isolation turned off by the user, after the native dialog'
      })

      try {
        const restart = (await deps.restartAgent?.()) ?? 'nothing-running'

        return { ok: true, on: asked, restart }
      } catch (error) {
        return {
          ok: true,
          on: asked,
          restart: 'failed',
          error: error instanceof Error ? error.message : String(error)
        }
      }
    } finally {
      busy = false
      deps.changed()
    }
  }
}

interface DialogLike {
  showMessageBox: {
    (window: BrowserWindow, options: MessageBoxOptions): Promise<MessageBoxReturnValue>
    (options: MessageBoxOptions): Promise<MessageBoxReturnValue>
  }
}

/** What the code makes conditional on confinement (profiles.ts, runtime profile, host_lane.py), in plain words. */
export const ISOLATION_OFF_STOPS: readonly string[] = [
  'They can change or delete any file you can, not only your project.',
  'They can read your SSH, cloud and package tokens, your keychain files, this app\u2019s data and the agent\u2019s own keys.',
  'They can read what your other programs were started with and their environment, this app\u2019s runtime included. Those can hold secrets.',
  'They can reach the network in every mode.',
  'They can change a repository\u2019s git config and hooks.',
  'MCP servers, scheduled scripts, installs of plugins, skills and packages, and your hooks run with no sandbox too.'
]

/** What the code does not make conditional on confinement, and how far that goes. */
export const ISOLATION_OFF_STAYS: readonly string[] = [
  'Your permission mode still decides. In Ignore permissions nothing asks.',
  'Payment signing stays in the app. In Ignore permissions the agent can still spend without asking.',
  'These are checks in the app, not the kernel: a determined program can go round them.'
]

/** The dialog's opening paragraph and its after-thought paragraph: exported so a test compares the real text. */
export const ISOLATION_OFF_LEAD =
  'Your agent\u2019s commands will run as you, with no sandbox around them. Other processes on this Mac can read what they write, and they can read other apps\u2019 files.'

export const ISOLATION_OFF_AFTER =
  'Turning it back on does not undo this. A program started while it was off can keep running, and what it did stays: changed files, copied secrets, things left to run later.'

/** Cancel is the default and the Escape answer; only a click on the second button returns true. */
export async function confirmIsolationOffNatively(
  dialog: DialogLike,
  parent: BrowserWindow | null,
  persists: boolean
): Promise<boolean> {
  const options: MessageBoxOptions = {
    type: 'warning',
    buttons: ['Cancel', 'Turn isolation off'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: 'Turn isolation off?',
    detail: [
      ISOLATION_OFF_LEAD,
      '',
      'What you lose:',
      ...ISOLATION_OFF_STOPS.map(item => `\u2022 ${item}`),
      '',
      'What stays:',
      ...ISOLATION_OFF_STAYS.map(item => `\u2022 ${item}`),
      '',
      ISOLATION_OFF_AFTER,
      '',
      `The agent restarts now and what it is doing stops; your conversation stays. ${
        persists ? 'Isolation stays off until you turn it on.' : 'Isolation comes back on when you quit the app.'
      }`
    ].join('\n')
  }

  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)

  return response === 1
}
