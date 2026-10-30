export type BootTranslations = {
  ready: string
  desktopBootFailedWithMessage: (message: string) => string
  steps: {
    connectingGateway: string
    preparingAgentDependencies: string
    loadingSettings: string
    loadingSessions: string
    retryingRemoteBackend: string
    startingDesktopConnection: string
    startingHermesDesktop: string
  }
  errors: {
    backgroundExited: string
    backgroundExitedDuringStartup: string
    backendStopped: string
    desktopBootFailed: string
    gatewayConnectionLost: string
    gatewayConnectionLostDetail: string
    gatewaySignInRequired: string
    ipcBridgeUnavailable: string
  }
  failure: {
    title: string
    description: string
    remoteTitle: string
    remoteDescription: string
    retry: string
    repairInstall: string
    useLocalGateway: string
    gatewaySettings: string
    back: string
    openLogs: string
    repairHint: string
    remoteSignInHint: (signInLabel: string) => string
    signOutAndSignIn: string
    remoteFailureHint: string
    cloudDownTitle: string
    cloudDownDescription: string
    cloudDownHint: string
    gateTitle: string
    gateDescription: string
    gateHint: string
    gateHintUnmanaged: string
    cloudDownCheckPortal: string
    cloudDownDiscord: string
    hideRecentLogs: string
    showRecentLogs: string
    signedInTitle: string
    signedInMessage: string
    signInIncompleteTitle: string
    signInIncompleteMessage: string
    signInFailed: string
    signInToRemoteGateway: string
    signInWithProvider: (provider: string) => string
    identityProvider: string
  }
}
