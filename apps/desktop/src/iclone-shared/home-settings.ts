/**
 * The agent's settings files as main judges them. The refusal crosses IPC as data: Electron prefixes a rejected invoke's
 * message and drops everything else on the error, so nothing in the renderer may key on the words of that message.
 */
export const HOME_SETTINGS_NOT_STARTED = 'so the agent was not started.'
export const HOME_SETTINGS_INSTALL_STOPPED = 'so the install did not finish.'
export const HOME_SETTINGS_RETRY = 'then try again:'

export const HOME_SETTINGS_REFUSED = 'home-settings-refused'

export const HOME_SETTINGS_FILES = ['config.yaml', '.env', '.op.env'] as const

export type HomeSettingsFile = (typeof HOME_SETTINGS_FILES)[number]

export type HomeSettingsFindingKind =
  | 'folder-locked'
  | 'link-dangling'
  /** A link to a secret or into a folder the agent can write: no copy is offered, by button or by command. */
  | 'link-guarded'
  | 'link-outside'
  | 'special'
  | 'unreadable'

export interface HomeSettingsFinding {
  command: string
  file: HomeSettingsFile
  kind: HomeSettingsFindingKind
  /** The whole sentence with its command: what the desktop log and the installer's output carry. */
  message: string
  path: string
  /** The sentence without the command, for a surface that shows the command on its own. */
  reason: string
  /** Where a link really leads. Null when it is not a link, or leads nowhere. */
  target: null | string
}

export interface HomeSettingsRefusal {
  code: typeof HOME_SETTINGS_REFUSED
  findings: HomeSettingsFinding[]
}

export type HomeSettingsReplaceFailure =
  | 'changed'
  | 'hard-link'
  | 'not-a-link'
  | 'not-eligible'
  | 'not-plain'
  | 'not-written'
  | 'too-large'
  | 'unreadable'

export type HomeSettingsReplaceResult =
  | { ok: false; reason: HomeSettingsReplaceFailure; refusal: HomeSettingsRefusal | null }
  | { ok: true; refusal: HomeSettingsRefusal | null }
