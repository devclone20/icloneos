export type InstallTranslations = {
  stageStates: Record<string, string>
  oneTimeTitle: string
  unsupportedDesc: (platform: string) => string
  installCommand: string
  copyCommand: string
  viewDocs: string
  installTo: string
  retryAfterRun: string
  setupChoiceTitle: string
  setupChoiceDesc: string
  connectExistingTitle: string
  connectExistingShort: string
  connectExistingDesc: string
  installLocalTitle: string
  installLocalDesc: string
  localStartUnavailable: string
  remoteSetupTitle: string
  remoteSetupDesc: string
  remoteUrlTitle: string
  remoteUrlDesc: string
  remoteUrlPlaceholder: string
  probing: string
  probeError: string
  identityProvider: string
  authTitle: string
  authNeedsOauth: (provider: string) => string
  authSignedIn: string
  connected: string
  signIn: string
  signInWith: (provider: string) => string
  enterUrlFirst: string
  signInIncomplete: string
  tokenTitle: string
  tokenDesc: string
  pasteSessionToken: string
  incompleteSignInTest: string
  incompleteTokenTest: string
  testConnection: string
  testSucceeded: (baseUrl: string, version?: string) => string
  applyRemote: string
  backToSetup: string
  failedTitle: string
  settingUpTitle: string
  finishingTitle: string
  failedDesc: string
  activeDesc: string
  /** K-RT2 (ruling 36): the install overlay's text when the app installs its own runtime beside an existing one. */
  runtimeUpgradeDesc: string
  progress: (completed: number, total: number) => string
  currentStage: (stage: string) => string
  fetchingManifest: string
  error: string
  hideOutput: string
  showOutput: string
  lines: (count: number) => string
  noOutput: string
  cancelling: string
  cancelInstall: string
  transcriptSaved: string
  copiedOutput: string
  copyOutput: string
  reloadRetry: string
  /** RTB-6/7: per-package lines, the failure diagnosis, its one fix, and "Skip for now". */
  recovery: InstallRecoveryTranslations
}

export type InstallFailureClassKey =
  | 'cancelled'
  | 'disk'
  | 'integrity'
  | 'interpreter'
  | 'killed'
  | 'network'
  | 'permission'
  | 'resolver'
  | 'slow'
  | 'stalled'
  | 'unknown'

export type InstallRecoveryTranslations = {
  /** What failed, in plain words, per failure class. */
  diagnosis: Record<InstallFailureClassKey, string>
  /** The package the failure happened in. */
  failedIn: (name: string) => string
  fixRetry: string
  fixRepair: string
  /** Free disk space (opens Storage settings); `needed` is a formatted size or null. */
  fixFreeDisk: (needed: null | string) => string
  fixNetworkSettings: string
  fixRevealFolder: string
  /** After a fix that opened something outside the app: try again. */
  retryNow: string
  skipForNow: string
  skipHint: string
  showDetails: string
  hideDetails: string
  packagesTitle: string
  /** r2: the failed install's subtitle (replaces the old text that talked about Windows). */
  failedDesc: string
  /** r2c: the failed install's subtitle when the one fix is "Repair the install" (it must name that button). */
  failedDescRepair: string
  /** r2: where the full transcript is (replaces a Windows-only path in the footer). */
  transcriptHint: string
  /** r2: plain names for the installer's stages (the technical name stays under Show details). */
  stageNames: Record<string, string>
  /** The display name of PM's Python environment line. */
  pythonEnvironment: string
  packageStates: {
    waiting: string
    downloading: (percent: string, done: string, total: string) => string
    unpacking: string
    installing: string
    done: string
    failed: string
    notNeeded: string
  }
}
