export type DesktopTranslations = {
  audioReadFailed: string
  sessionUnavailable: string
  createSessionFailed: string
  promptFailed: string
  providerCredentialRequired: string
  emptySlashCommand: string
  desktopCommands: string
  skillCommandsAvailable: (count: number) => string
  warningLine: (message: string) => string
  profileStatus: (current: string) => string
  unknownProfile: string
  noProfileNamed: (target: string, available: string) => string
  newChatsProfile: (name: string) => string
  setProfileFailed: string
  sttDisabled: string
  stopFailed: string
  regenerateFailed: string
  editFailed: string
  editTurnUnavailable: string
  resumeFailed: string
  readOnlyTranscriptTitle: string
  readOnlyTranscriptBody: string
  readOnlyTranscriptSendBlocked: string
  resumeStrandedTitle: string
  resumeStrandedBody: string
  resumeRetry: string
  nothingToBranch: string
  branchNeedsChat: string
  sessionBusy: string
  branchStopCurrent: string
  branchNoText: string
  branchTitle: (n: number) => string
  branchFailed: string
  deleteFailed: string
  archived: string
  archiveFailed: string
  cwdChangeFailed: string
  cwdStagedTitle: string
  cwdStagedMessage: string
  modelSwitchFailed: string
  hydrationSyncing: (profile: string) => string
  sessionExported: string
  sessionExportFailed: string
  imageSaved: string
  downloadStarted: string
  restartToUseSaveImage: string
  restartToSaveImages: string
  imageDownloadFailed: string
  openImage: string
  downloadImage: string
  savingImage: string
  imagePreviewFailed: string
  imageAttach: string
  imageWriteFailed: string
  imageAttachFailed: string
  attachImages: string
  clipboard: string
  noClipboardImage: string
  clipboardPasteFailed: string
  dropFiles: string
  handoff: {
    pickPlatform: string
    success: (platform: string) => string
    systemNote: (platform: string) => string
    failed: (error: string) => string
    timedOut: string
  }
  home: {
    region: string
    dock: string
    message: string
    taglineRestoring: string
    taglineRestoringWallet: string
    taglineSummon: string
    taglineConnect: string
    taglineSignedOutByUpdate: string
    connectWallet: string
    recommended: string
    openingSignIn: string
    dismissInft: string
    couldNotSummon: (name: string) => string
    tryAgain: string
    /** K143: the Privy sign-in window was refused (title of the toast, then the reason). */
    signInCouldNotOpen: string
    signInPortInUse: (port: number) => string
    signInUnavailable: string
    signInFailed: string
    leaveStage: string
    introLine: string
    windowTools: string
    windowLabel: (title: string) => string
    closeWindow: (title: string) => string
    expandWindow: (title: string) => string
    retractWindow: (title: string) => string
    windowOpacity: (title: string) => string
    readingAgent: string
    setupNeeded: string
    agentOnline: string
    myAgent: string
    msgClose: string
    msgExpand: string
    msgRetract: string
    msgOpacity: string
    contextUsage: string
    conversations: string
    showConversations: string
    hideConversations: string
    messageViews: string
    viewMessage: string
    newConversation: string
    newItSession: string
    scheduledJobs: string
    archived: string
    delete: string
    itExitHint: string
    inftCollection: string
    itTerminal: string
    itTerminalInput: string
    itNewTab: string
    itCloseTab: (title: string) => string
    itClosePane: string
    itSplitRight: string
    itSplitRightTip: string
    itSplitRightSmall: string
    itSplitDown: string
    itSplitDownTip: string
    itSplitDownSmall: string
    itZoom: string
    itZoomTip: string
    itDefaultTitle: string
    itBusyShells: (n: number) => string
    itCloseAnyway: (pane: boolean) => string
    itClose: string
    tile: {
      email: string
      wallet: string
      bank: string
      hyperliquid: string
      acp: string
    }
    gate: {
      signingIn: string
      signingInHint: (label: string) => string
      connectWallet: string
      signedOut: string
      signedOutHint: (label: string) => string
      connectTitle: string
      connectHint: (label: string) => string
      summonTitle: string
      summonHint: (label: string) => string
      openInfts: string
      setupTitle: string
      setupHint: (name: string) => string
      openSetup: string
      liveOffTitle: string
      liveOffHint: string
      openSettings: string
      thisInft: string
    }
    tools: {
      walletBalances: string
      walletSignIn: string
      browserOff: string
      browserOn: string
      browserUnknown: string
      browserWorking: string
      recordOff: string
      recordOn: string
      recordUnknown: string
      recordWorking: string
      themeCycle: (natural: string, dark: string, light: string) => string
      themeNatural: string
      themeDark: string
      themeLight: string
    }
  }
}
