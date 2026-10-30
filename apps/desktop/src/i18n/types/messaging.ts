export type MessagingTranslations = {
  search: string
  loading: string
  loadFailed: string
  states: Record<string, string>
  unknown: string
  hintPendingRestart: string
  hintGatewayStopped: string
  credentialsSet: string
  needsSetup: string
  gatewayStopped: string
  getCredentials: string
  openSetupGuide: string
  required: string
  recommended: string
  advanced: (count: number) => string
  noTokenNeeded: string
  enabled: string
  disabled: string
  unsavedChanges: string
  saving: string
  saveChanges: string
  saved: string
  replaceValue: string
  openDocs: string
  clearField: (key: string) => string
  enableAria: (name: string) => string
  disableAria: (name: string) => string
  platformEnabled: (name: string) => string
  platformDisabled: (name: string) => string
  restartToApply: string
  setupSaved: (name: string) => string
  restartToReconnect: string
  keyCleared: (key: string) => string
  setupUpdated: (name: string) => string
  failedUpdate: (name: string) => string
  failedSave: (name: string) => string
  failedClear: (key: string) => string
  pendingRequests: (count: number) => string
  pendingAria: (count: number) => string
  approvedUsers: (count: number) => string
  approve: string
  approving: string
  revoke: string
  revoking: string
  revokeAria: (name: string) => string
  revokeTitle: string
  revokeDesc: (name: string) => string
  approvedUser: (name: string) => string
  approvedHint: string
  revokedUser: (name: string) => string
  failedApprove: (name: string) => string
  failedRevoke: (name: string) => string
  pairingLockedOut: string
  waitingSince: (minutes: number) => string
  /** Title of a field the catalogue does not know (ruling S27.1: never the backend prompt or the variable name). */
  fieldFallbackLabel: string
  /** How a notice names a field the catalogue does not know. */
  fieldFallbackName: string
  /** label = the row's one-sentence title; name = the short noun notices and the empty field use. */
  fieldCopy: Record<string, { label?: string; name?: string; help?: string; placeholder?: string }>
  /** How to get a platform's sign-in details, shown above its fields; a platform without one shows none. */
  platformIntro: Record<string, string>
  /** One sentence under a platform's name: what connecting it lets you do. */
  platformSummary: Record<string, string>
  noPlatforms: string
  noMatch: (query: string) => string
  draftSecretNotKept: string
}
