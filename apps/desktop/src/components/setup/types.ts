// Renderer view of electron/iclone-setup.ts (V3-ON): main reads macOS and picks every action; these are its IPC shapes.

export {
  SETUP_SECTIONS,
  type SetupChoice,
  type SetupDecisions,
  type SetupSection
} from '@/iclone-shared/setup-decisions'

export type SetupSystemItem = 'microphone' | 'notifications' | 'screen'
export type SetupSystemStatus =
  'declined' | 'denied' | 'granted' | 'notDetermined' | 'notSetUp' | 'restricted' | 'unknown'
export type SetupSystemAction = 'none' | 'openSettings' | 'request'

export interface SetupSystemRow {
  id: SetupSystemItem
  status: SetupSystemStatus
  action: SetupSystemAction
  restartToApply?: true
}

export type SetupPackageState = 'failed' | 'installed' | 'installing' | 'skipped'

export interface SetupPackage {
  id: string
  name: string
  bytes: number | null
  state: SetupPackageState
  progress: number | null
}

export interface IcloneSetupBridge {
  system: () => Promise<SetupSystemRow[] | null>
  act: (input: { item: SetupSystemItem; title?: string; body?: string }) => Promise<SetupSystemRow[] | null>
}
