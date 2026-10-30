export type NotificationsTranslations = {
  region: string
  hide: string
  show: string
  more: (count: number) => string
  clearAll: string
  dismiss: string
  details: string
  copyDetail: string
  copyDetailFailed: string
  backendOutOfDateTitle: string
  backendOutOfDateMessage: string
  installMethodUnsupportedTitle: string
  updateHermes: string
  updateReadyTitle: string
  updateReadyMessage: (count: number) => string
  updateReadyMessageUnknown: string
  seeWhatsNew: string
  mcp: {
    needsAuthTitle: string
    needsAuthMessage: (name: string) => string
    errorTitle: string
    errorMessage: (name: string) => string
    signIn: string
    view: string
  }
  errors: {
    elevenLabsNeedsKey: string
    elevenLabsRejectedKey: string
    diskFull: string
    gatewayAuthFailed: string
    methodNotAllowed: string
    microphonePermission: string
    openaiRejectedApiKey: string
    openaiRejectedApiKeyWithStatus: (status: string) => string
    openaiTtsNeedsKey: string
  }
  voice: {
    configureSpeechToText: string
    couldNotStartSession: string
    microphoneAccessDenied: string
    microphoneConstraintsUnsupported: string
    microphoneFailed: string
    microphoneInUse: string
    microphonePermissionDenied: string
    microphoneStartFailed: string
    microphoneUnsupported: string
    noMicrophone: string
    noSpeechDetected: string
    playbackFailed: string
    recordingFailed: string
    sayStopToEnd: (phrase: string) => string
    transcriptionFailed: string
    transcriptionUnavailable: string
    tryRecordingAgain: string
    unavailable: string
  }
  // Native OS notification copy (titles + generic fallback bodies). Dynamic
  // bodies (the agent's reply, a command, an error) are passed through raw.
  native: {
    approvalTitle: string
    inputTitle: string
    inputBody: string
    turnDoneTitle: string
    turnDoneBody: string
    turnErrorTitle: string
    backgroundDoneTitle: string
    backgroundFailedTitle: string
    creditsTitle: string
  }
}
