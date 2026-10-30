interface ModeOptionCopy {
  label: string
  description: string
}

export type SettingsMachineTranslations = {
  /** RTB-6/7: Settings > Machine > Agent runtime — install status, packages, Install again. */
  agentRuntime: {
    title: string
    blurb: string
    installed: string
    incomplete: string
    notInstalled: string
    installing: string
    incompleteWhat: (what: string) => string
    notInstalledWhat: (what: string) => string
    installAgain: string
    installAgainHint: string
    packages: string
    noPackages: string
    skipped: string
    lastFailure: string
  }
  plugins: {
    title: string
    blurb: string
    count: (n: number) => string
    openFolder: string
    rescan: string
    reveal: string
    enable: string
    disable: string
    failed: string
    empty: string
    kinds: { bundled: string; disk: string; runtime: string }
    /** Plain hints for the plugins that ship with the app, keyed by plugin id; the manifest text is the en source. */
    bundledDescriptions: Record<string, string>
    agent: {
      title: string
      blurb: string
      appliesTo: string
      empty: string
      loadFailed: string
      portable: string
      search: string
      noMatches: string
      toggleFailed: (name: string) => string
      updateBackendToManage: string
      sources: Record<string, string>
    }
    installModal: {
      title: string
      description: string
      repoLabel: string
      includesHeading: string
      agentLabel: string
      desktopLabel: string
      agentTargetLocal: (profile: string) => string
      agentTargetRemote: (profile: string) => string
      desktopTarget: string
      desktopOnlyNote: string
      insecureWarning: string
      securityHeading: string
      securityIntro: string
      sourceHeading: string
      viewRepository: string
      viewPluginFiles: string
      gitCloneLabel: string
      enableAgent: string
      forceReinstall: string
      install: string
      installing: string
      probing: string
      probeUnavailable: string
      desktopUnavailable: string
      selectComponent: string
      agentSuccess: (name: string) => string
      desktopSuccess: (name: string) => string
      agentFailed: string
      desktopFailed: string
      missingEnv: (vars: string) => string
    }
    appRowTitle: string
    agentRowTitle: string
    searchTitle: string
  }
  notifications: {
    title: string
    intro: string
    enableAll: string
    enableAllDesc: string
    focusedHint: string
    kinds: Record<
      'approval' | 'backgroundDone' | 'credits' | 'input' | 'plugin' | 'turnDone' | 'turnError',
      { label: string; description: string }
    >
    test: string
    testTitle: string
    testBody: string
    testSent: string
    testUnsupported: string
    completionSoundTitle: string
    completionSoundDesc: string
    completionSoundPreview: string
  }
  modeOptions: Record<'light' | 'dark' | 'system', ModeOptionCopy>
  appearance: {
    textSizeTitle: string
    languageTitle: string
    title: string
    intro: string
    colorMode: string
    colorModeDesc: string
    toolViewTitle: string
    toolViewDesc: string
    reasoningCollapsedTitle: string
    reasoningCollapsedDesc: string
    uiScaleTitle: string
    uiScaleDesc: (percent: number) => string
    sessionDensityTitle: string
    sessionDensityDesc: string
    sessionDensityCompact: string
    sessionDensityComfortable: string
    sessionDensityDetailed: string
    terminalFontTitle: string
    terminalFontDesc: string
    terminalFontPlaceholder: string
    terminalFontPreview: string
    terminalFontReset: string
    translucencyTitle: string
    translucencyDesc: string
    translucencyGlassDesc: string
    translucencyModeClear: string
    translucencyModeGlass: string
    translucencyTintTitle: string
    translucencyFadeTitle: string
    translucencyFrostTitle: string
    translucencyFrost: {
      'under-window': string
      popover: string
      titlebar: string
      header: string
    }
    translucencyScopeTitle: string
    translucencyScope: {
      window: string
      sidebar: string
    }
    backdropTitle: string
    backdropDesc: string
    introSplashTitle: string
    introSplashDesc: string
    dockWindowSizeTitle: string
    dockWindowSizeDesc: string
    dockWindowSizeMaximized: string
    dockWindowSizeNormal: string
    reactionsTitle: string
    reactionsDesc: string
    composerPopoutTitle: string
    composerPopoutDesc: string
    vibeHeartsTitle: string
    vibeHeartsDesc: string
    embedsTitle: string
    embedsDesc: string
    embedsAsk: string
    embedsAlways: string
    embedsOff: string
    embedsReset: (count: number) => string
    product: string
    technical: string
    themeTitle: string
    themeDesc: string
    themeProfileNote: (profile: string) => string
    removeTheme: string
    pet: {
      title: string
      intro: string
      on: string
      off: string
      scaleTitle: string
      scaleDesc: string
      scaleValue: (scale: number) => string
      roamTitle: string
      roamDesc: string
      popOutTitle: string
      popOutDesc: string
      popOut: string
      popIn: string
      chooseTitle: string
      chooseDesc: string
      searchTitle: string
      searchPlaceholder: string
      noMatch: (query: string) => string
      count: (n: number) => string
      legions: { play: string; death: string; god: string }
      choose: (name: string) => string
      chooseAction: string
      chosen: string
      remove: string
      needsPet: string
    }
    themeSearchTitle: string
    themeSearchPlaceholder: string
    themeNoMatch: (query: string) => string
    marketplaceHeading: string
  }
  hud: {
    introTitle: string
    introHint: string
    openNowHint: string
    openTitle: string
    openHint: string
    open: string
    reset: string
    resetTitle: string
    holdTitle: string
    holdHint: (seconds: string) => string
    holdAria: string
    frostTitle: string
    frostHint: string
    clickThroughTitle: string
    clickThroughHint: string
    keysHeading: string
    keys: Record<'toggle' | 'snap' | 'exit' | 'close', { keys: string; title: string }>
    rebind: string
    behaviourHeading: string
    bandTitle: string
    bandHint: string
    handoffTitle: string
    handoffHint: string
    rebindHint: string
    rebindTitle: string
  }
  keybindsPane: {
    introTitle: string
    searchTitle: string
    searchHint: string
    fixedHint: string
  }
  itTerminal: {
    agentHint: string
    agentTitle: string
    commandHint: string
    commandTitle: string
    connectsHint: string
    connectsTitle: string
    cwdHint: string
    cwdTitle: string
    usingHint: string
    usingTitle: string
  }
  about: {
    heading: string
    version: (value: string) => string
    versionUnavailable: string
    bundleOutOfSync: string
    bundleOutOfSyncDesc: string
    bundleOutOfSyncAction: string
    updates: string
    checkNow: string
    checking: string
    seeWhatsNew: string
    updateNow: string
    releaseNotes: string
    onLatest: string
    installing: string
    cantUpdate: string
    cantReach: string
    tapCheck: string
    updateReady: (count: number) => string
    updateReadyUnknown: string
    lastChecked: (age: string) => string
    justNowSuffix: string
    automaticUpdates: string
    automaticUpdatesDesc: string
    branchCommit: (branch: string, commit: string) => string
    never: string
    justNow: string
    minAgo: (count: number) => string
    hoursAgo: (count: number) => string
    daysAgo: (count: number) => string
    runtimeCheckOff: string
    policyTitle: string
    policyHint: string
    policyAck: string
    policyUse: string
    policySaved: string
    policyWrong: string
    dangerTitle: string
    openSourceLine: string
  }
  // v2 multi-connection registry: Settings → Connections.
  connections: {
    title: string
    intro: string
    stagedNote: string
    launchModeTitle: string
    launchModeDesc: string
    searchPlaceholder: string
    noSearchResults: string
    loadFailed: string
    currentPill: string
    primaryPill: string
    managedPill: string
    addConnection: string
    editConnection: string
    removeConnection: string
    removeConfirmTitle: string
    removeConfirmDesc: (label: string) => string
    makePrimary: string
    testConnection: string
    testOk: string
    testFailed: string
    saveFailed: string
    removeFailed: string
    updateAll: string
    updateAllRunning: string
    updateAllDone: string
    updateAllFailed: string
    updateSkippedCloud: string
    kindLocal: string
    kindRemote: string
    kindCloud: string
    kindSsh: string
    kindLocalDesc: string
    kindRemoteDesc: string
    kindCloudDesc: string
    kindSshDesc: string
    labelTitle: string
    labelDesc: string
    labelPlaceholder: string
    urlTitle: string
    sshHostTitle: string
    headersTitle: string
    headersDesc: string
    headerValuePlaceholder: string
    headerValueSaved: string
    headerAdd: string
    headerRemove: string
    duplicateLocal: string
    duplicateUrl: (label: string) => string
    duplicateSsh: (label: string) => string
    sameBackendHint: (label: string) => string
    localAddHint: string
    cloudAddHint: string
    save: string
    saving: string
    cancel: string
    empty: string
    addTitle: string
  }
  managedUpdates: {
    title: string
    intro: string
    sshConnection: string
    update: string
    updating: string
    progress: string
    updated: string
    partial: string
    refused: string
    failed: string
    alreadyRunning: string
    receipt: (id: string, outcome: string) => string
    receiptVersions: (pre: string, post: string) => string
    scopesRestored: (profiles: string) => string
    scopeNotRestored: (profile: string, error: string) => string
  }
  gateway: {
    loading: string
    unavailableTitle: string
    unavailableDesc: string
    title: string
    envOverride: string
    intro: string
    envOverrideTitle: string
    envOverrideDesc: string
    modeTitle: string
    localTitle: string
    localDesc: string
    remoteTitle: string
    remoteDesc: string
    remoteAuthHint: string
    cloudTitle: string
    cloudDesc: string
    cloudSignInTitle: string
    cloudSignIn: string
    cloudSignedIn: string
    cloudNeedsSignIn: string
    cloudSignedInDesc: string
    cloudAgentsTitle: string
    cloudOrgPickerTitle: string
    cloudOrgSelect: string
    cloudOrgChange: string
    cloudOrgRole: (role: string) => string
    cloudLoadingAgents: string
    cloudNoAgents: { before: string; linkText: string; after: string }
    cloudRefresh: string
    cloudConnect: string
    cloudConnecting: string
    cloudDiscoverFailed: string
    cloudConnectFailed: string
    cloudSignInFailed: string
    cloudSignedOutTitle: string
    cloudSignedOutMessage: string
    cloudConnectedTitle: string
    cloudConnectedPill: string
    cloudConnectedTo: (name: string) => string
    cloudAgentProvisioning: string
    cloudStatusLabel: (status: string) => string
    remoteUrlTitle: string
    remoteUrlDesc: string
    probing: string
    probeError: string
    signedIn: string
    signIn: string
    signOut: string
    signInWith: (provider: string) => string
    authTitle: string
    authSignedInPassword: string
    authSignedInOauth: string
    authNeedsPassword: string
    authNeedsOauth: (provider: string) => string
    tokenTitle: string
    tokenDesc: string
    existingToken: (value: string) => string
    savedToken: string
    pasteSessionToken: string
    plainTextConfirmTitle: string
    plainTextConfirmDesc: string
    plainTextConfirmAction: string
    plainTextStoredTitle: string
    plainTextStoredDesc: string
    keychainEncryptionTitle: string
    keychainEncryptionDesc: string
    keychainEncryptionFailed: string
    testRemote: string
    saveForRestart: string
    saveAndReconnect: string
    diagnostics: string
    diagnosticsDesc: string
    openLogs: string
    incompleteTitle: string
    incompleteSignIn: string
    incompleteToken: string
    incompleteSignInTest: string
    incompleteTokenTest: string
    enterUrlFirst: string
    restartingTitle: string
    savedTitle: string
    restartingMessage: string
    savedMessage: string
    connectedTo: (baseUrl: string, version?: string) => string
    reachableTitle: string
    signedOutTitle: string
    signedOutMessage: string
    failedLoad: string
    signInFailed: string
    signOutFailed: string
    testFailed: string
    applyFailed: string
    saveFailed: string
    sshTitle: string
    sshDesc: string
    sshTrustHint: string
    sshHostTitle: string
    sshHostDesc: string
    sshHostPick: string
    sshHostPickTitle: string
    sshHostPickDesc: string
    sshHostCustom: string
    sshUserTitle: string
    sshUserDesc: string
    sshUserPlaceholder: string
    sshPortTitle: string
    sshPortDesc: string
    sshKeyTitle: string
    sshKeyDesc: string
    sshHermesPathTitle: string
    sshHermesPathDesc: string
    sshHermesPathPlaceholder: string
    sshTestConnection: string
    sshConnect: string
    sshButtonsHint: string
    sshReachable: (host: string, platform: string) => string
    sshIncompleteHost: string
    sshErrUnreachable: string
    sshErrAuth: string
    sshErrHostKey: string
    sshErrNotInstalled: string
    sshErrPlatform: string
    sshErrTimeout: string
    sshErrUpdateRequired: string
    sshErrUnknown: string
    applyTitle: string
  }
}
