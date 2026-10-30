/** The app updater's wire contract; the single source is electron/app-update-ipc.ts (import-free). */
export type {
  AppUpdateLogEntry,
  AppUpdatePhase,
  AppUpdateProgress,
  AppUpdateRestartResult,
  AppUpdateState
} from '../../electron/app-update-ipc'
