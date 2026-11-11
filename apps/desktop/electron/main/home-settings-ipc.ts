/**
 * The settings-file judgement as data for the recovery surfaces. Electron turns a rejected invoke into a prefixed message
 * and nothing else, so the renderer asks here instead of reading that message. The renderer names a profile and one of
 * the known files, never a path: main builds every path it touches.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import {
  HOME_SETTINGS_FILES,
  type HomeSettingsFile,
  type HomeSettingsRefusal,
  type HomeSettingsReplaceResult
} from '../../src/iclone-shared/home-settings'
import {
  type HomeSettingsCopyGuard,
  homeSettingsRefusalView,
  judgeHomeSettings,
  replaceLinkWithCopy,
  setHomeSettingsCopyGuard
} from '../home-settings-files'
import { profileHermesHome } from '../update-runtime-align'

interface HomeSettingsIpcDeps {
  /** Where no settings link may lead, in every judgement of this process (home-settings-files.ts). */
  copyGuard: () => HomeSettingsCopyGuard
  /** The copy hands the agent a file from outside its home, so only the owner's own click on the button counts. */
  gestureOk: (event: IpcMainInvokeEvent, input: unknown) => boolean
  hermesHome: string
  /** Read per call: the same flag prepareHermesSpawn reads, so this answers what a start would do now. */
  isConfined: () => boolean
  isTrustedSender: (event: IpcMainInvokeEvent, channel: string) => boolean
  log: (line: string) => void
  primaryProfile: () => null | string
}

const PROFILE_NAME = /^[A-Za-z0-9][\w-]{0,63}$/

const isSettingsFile = (value: unknown): value is HomeSettingsFile =>
  HOME_SETTINGS_FILES.includes(value as HomeSettingsFile)

const CHECK = 'hermes:home-settings:check'
const WARNINGS = 'hermes:home-settings:warnings'
const REPLACE = 'hermes:home-settings:replace-with-copy'

export function registerHomeSettingsIpc({
  copyGuard,
  gestureOk,
  hermesHome,
  isConfined,
  isTrustedSender,
  log,
  primaryProfile
}: HomeSettingsIpcDeps): void {
  const warnedAlready = new Set<string>()

  setHomeSettingsCopyGuard(copyGuard)

  /** Null: the profile the primary agent runs on. A name that is not a profile's answers undefined, and nothing is read. */
  const homeOf = (profile: unknown): string | undefined => {
    if (profile === null || profile === undefined) {
      return profileHermesHome(hermesHome, primaryProfile())
    }

    return typeof profile === 'string' && PROFILE_NAME.test(profile) ? profileHermesHome(hermesHome, profile) : undefined
  }

  const checkOf = (doing: unknown = 'start') => ({
    doing: doing === 'install' ? ('install' as const) : ('start' as const),
    linksOutsideRefused: isConfined(),
    root: hermesHome
  })

  ipcMain.handle(CHECK, (event, profile: unknown, doing: unknown): HomeSettingsRefusal | null => {
    const home = isTrustedSender(event, CHECK) ? homeOf(profile) : undefined

    return home === undefined ? null : homeSettingsRefusalView(home, checkOf(doing))
  })

  ipcMain.handle(WARNINGS, (event, profile: unknown): string[] => {
    const home = isTrustedSender(event, WARNINGS) ? homeOf(profile) : undefined

    if (home === undefined) {
      return []
    }

    const fresh = judgeHomeSettings(home, checkOf())
      .warned.map(finding => finding.message)
      .filter(message => !warnedAlready.has(message))

    fresh.forEach(message => {
      warnedAlready.add(message)
      log(`[home-settings] ${message}`)
    })

    return fresh
  })

  ipcMain.handle(REPLACE, (event, payload: unknown): HomeSettingsReplaceResult => {
    const refused: HomeSettingsReplaceResult = { ok: false, reason: 'not-eligible', refusal: null }

    if (!isTrustedSender(event, REPLACE) || typeof payload !== 'object' || payload === null || !gestureOk(event, payload)) {
      return refused
    }

    const { doing, file, gesture: _gesture, profile, target, ...unknownFields } = payload as Record<string, unknown>
    const home = homeOf(profile)

    if (home === undefined || !isSettingsFile(file) || typeof target !== 'string' || Object.keys(unknownFields).length > 0) {
      return refused
    }

    const result = replaceLinkWithCopy(home, file, target, checkOf(doing))

    log(`[home-settings] replace ${file} with a copy of ${target}: ${result.ok ? 'done' : result.reason}`)

    return result
  })
}
