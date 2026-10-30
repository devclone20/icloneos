export type UpdatesTranslations = {
  stages: Record<string, string>
  checking: string
  checkFailedTitle: string
  tryAgain: string
  notAvailableTitle: string
  unsupportedMessage: string
  connectionRetry: string
  latestBody: string
  latestBodyBackend: string
  allSetTitle: string
  availableTitle: string
  availableBody: string
  availableTitleBackend: string
  availableBodyBackend: string
  availableBodyNoChangelog: string
  updateNow: string
  maybeLater: string
  moreChanges: (count: number) => string
  manualTitle: string
  manualBody: string
  manualPickedUp: string
  /** GUI/backend skew (#45205): backend updated but the running desktop app
   *  package (AppImage/.deb/.rpm) was not changed and must be reinstalled. */
  guiSkewTitle: string
  guiSkewBody: string
  copy: string
  copied: string
  done: string
  applyingBody: string
  applyingBodyBackend: string
  applyingClose: string
  errorTitle: string
  errorBody: string
  blockerTitle: string
  blockerBody: string
  foreignBlockerTitle: string
  foreignBlockerBody: string
  mixedBlockerBody: string
  closePreviewsAndUpdate: string
  closePreviewsAndCheckAgain: string
  localPreview: string
  portLabel: (port: number) => string
  pidLabel: (pid: number) => string
  technicalDetails: string
  notNow: string
  /** Multi-target update flow: client nudge after a backend update, and
   *  per-row fan-out outcomes when updating every registered instance. */
  clientAlsoBehindTitle: string
  clientAlsoBehindMessage: string
  clientAlsoBehindAction: string
  everythingDispatched: string
  everythingSkipped: string
  everythingRowFailed: string
  everythingFanoutFailedTitle: string
  applyStatus: {
    preparing: string
    pulling: string
    restarting: string
    notAvailable: string
    failed: string
    noReturn: string
  }
}
