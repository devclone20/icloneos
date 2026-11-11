/** fx26b: main's real permissions handlers on a throwaway userData folder, with the real store and policy writer. */
import path from 'node:path'

import { type LauncherPolicyBody, listedProjects } from '../iclone-confinement/launcher-policy'

import type { PermissionAuthority } from './authority'
import { registerPermissions } from './ipc'

export const CLICK = { activation: true, confirm: true }

type Answer = Promise<Record<string, unknown>> | Record<string, unknown>

/** The little of a webContents main reads: its id, and its end. */
export class FakeWindow {
  private readonly ends: (() => void)[] = []
  private gone = false

  constructor(readonly id: number) {}

  isDestroyed = () => this.gone

  once = (_event: 'destroyed', listener: () => void) => void this.ends.push(listener)

  close = () => {
    this.gone = true

    for (const end of this.ends) {
      end()
    }
  }
}

export interface LaunchedMain {
  authority: PermissionAuthority
  home: string
  invoke: (channel: string, input: unknown) => Promise<Record<string, unknown>>
  /** The same handlers, called from one window: S11 ties a choice to the sender that made it. */
  invokeFrom: (sender: FakeWindow, channel: string, input: unknown) => Promise<Record<string, unknown>>
  listedForLauncher: () => string[]
  userDataDir: string
}

/** `launcherBodies` is filled by the test's stand-in for the running confinement layer's publishLauncherPolicy. */
export function launchMain(
  dir: string,
  launcherBodies: LauncherPolicyBody[],
  dialogAnswer: () => string[] = () => [],
  /** The time the handlers' gesture check reads: when main last saw real input reach the window. */
  lastInputAt: () => number = () => Date.now(),
  /** The home folder main knows, when a test's launcher and main must share it. */
  home: string = path.join(dir, 'home'),
  confirmIgnore: () => Promise<boolean> = async () => false
): LaunchedMain {
  const handlers = new Map<string, (event: unknown, input: unknown) => Answer>()
  const userDataDir = path.join(dir, 'ud')

  const authority = registerPermissions({
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, input: unknown) => Answer) =>
        void handlers.set(channel, handler)
    },
    isTrustedSender: () => true,
    userDataDir,
    paths: { hermesHome: path.join(dir, 'hermes'), home, hermesRoot: null },
    door: null,
    consent: () => null,
    lastInputAt: () => lastInputAt(),
    // Null is the ordinary run: the Keychain setting is off by default.
    sealer: null,
    confirmIgnore,
    pickFolderDialog: async () => dialogAnswer()
  })

  const invoke = async (channel: string, input: unknown) => {
    const handler = handlers.get(channel)

    if (!handler) {
      throw new Error(`no handler for ${channel}`)
    }

    return handler({}, input)
  }

  const invokeFrom = async (sender: FakeWindow, channel: string, input: unknown) => {
    const handler = handlers.get(channel)

    if (!handler) {
      throw new Error(`no handler for ${channel}`)
    }

    return handler({ sender }, input)
  }

  /** What the launcher is given: the folders of the last body main published to it, not main's memory. */
  const listedForLauncher = (): string[] => {
    const body = launcherBodies.at(-1)

    return body ? listedProjects(body, []) : []
  }

  return { authority, home, invoke, invokeFrom, listedForLauncher, userDataDir }
}
