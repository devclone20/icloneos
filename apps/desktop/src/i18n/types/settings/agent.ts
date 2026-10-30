import type { enEngine } from '../../en/enEngine'
import type { PermissionsCopy } from '../../en/enPermissions'

interface AuxTaskCopy {
  /** The task in a word or two, for lists (the stale-assignment warning). */
  name?: string
  label: string
  hint: string
}

export type SettingsAgentTranslations = {
  mcp: {
    loading: string
    failedLoad: string
    nameRequiredTitle: string
    nameRequiredMessage: string
    objectRequired: string
    invalidJson: string
    saveFailed: string
    removeFailed: string
    gatewayUnavailableTitle: string
    gatewayUnavailableMessage: string
    reloadedTitle: string
    reloadedMessage: string
    reloadFailed: string
    savedTitle: string
    savedMessage: (name: string) => string
    newServer: string
    reload: string
    reloading: string
    emptyTitle: string
    emptyDesc: string
    disabled: string
    editServer: string
    name: string
    serverJson: string
    remove: string
    saveServer: string
    test: string
    testing: string
    testOk: (count: number) => string
    testFailed: string
    enableServer: (name: string) => string
    disableServer: (name: string) => string
    serverEnabled: (name: string) => string
    serverDisabled: (name: string) => string
    toggleFailed: (name: string, enabled: boolean) => string
    tabServers: string
    tabCatalog: string
    catalogLoading: string
    catalogLoadFailed: string
    catalogEmpty: string
    catalogInstalled: string
    catalogEnabled: string
    catalogNeedsInstall: string
    catalogInstall: string
    catalogInstalling: string
    catalogInstallStarted: (name: string) => string
    catalogInstallFailed: (name: string) => string
    catalogEnvPrompt: (name: string) => string
    catalogEnvRequired: string
    capabilitySummary: (tools: number, prompts: number, resources: number) => string
    costTokens: (tokens: string) => string
    usage30d: (uses: string) => string
    unusedPill: string
    statusConnecting: string
    statusNeedsAuth: string
    statusError: string
    statusOff: string
    allServers: string
    authenticatedTitle: string
    authenticatedMessage: (server: string, count: number) => string
    waitingForBrowser: string
    authenticate: string
    unsavedConnect: string
    enableTool: (tool: string) => string
    disableTool: (tool: string) => string
    noOutput: string
    deepLinkTitle: string
    deepLinkDescription: string
    deepLinkStdioWarning: string
    deepLinkConfirm: string
    deepLinkNameInvalid: string
    deepLinkNameConflict: (name: string) => string
    deepLinkErrorTitle: string
    deepLinkErrorName: string
    deepLinkErrorConfig: string
    deepLinkErrorShape: string
    deepLinkErrorUrl: string
    deepLinkErrorTooLarge: string
    importButton: string
    importPlaceholder: string
    importNoMatch: string
    importConfirm: string
    importConfirmMany: (count: number) => string
  }
  engine: typeof enEngine
  permissions: PermissionsCopy
  sessionsBots: {
    newChatHintUnbound: string
    title: string
    hint: string
    sessionsHeading: string
    botsHeading: string
    botsUnavailable: string
    botsUnavailableHint: string
    sessions: ReadonlyArray<readonly [string, string]>
    bots: ReadonlyArray<readonly [string, string]>
  }
  model: {
    restartTitle: string
    mainProviderTitle: string
    mainProviderHint: string
    mainModelTitle: string
    mainModelHint: string
    reasoningTitle: string
    reasoningHint: string
    fastTitle: string
    fastHint: string
    activate: string
    activating: string
    setUp: (name: string) => string
    pasteKey: (name: string) => string
    needsKey: (name: string) => string
    signsIn: (name: string) => string
    providerFallback: string
    staleAux: (count: number, names: string, provider: string) => string
    otherProviders: string
    auxiliarySentence: string
    moaTitle: string
    moaSentence: string
    moaDesc: string
    moaEnabled: string
    moaPresetTitle: string
    moaPresetPlaceholder: string
    moaSetDefault: string
    moaDelete: string
    moaNewTitle: string
    moaNewPlaceholder: string
    moaAdd: string
    moaRemove: string
    moaAddReference: string
    moaAddReferenceTitle: string
    moaAggregatorTitle: string
    moaAggregatorHint: string
    moaReference: (n: number) => string
    moaReferenceToggle: (n: number) => string
    provider: string
    model: string
    applying: string
    reasoningOff: string
    defaultsFailed: string
    loadFailed: string
    restartRequired: string
    restartBackend: string
    restartingBackend: string
    restartFailed: string
    auxiliaryTitle: string
    resetAllToMain: string
    auxiliaryDesc: string
    setToMain: string
    change: string
    autoUseMain: string
    providerDefault: string
    fallbackAdd: string
    fallbackEmpty: string
    tasks: Record<string, AuxTaskCopy>
  }
  sessions: {
    archivedTitle: string
    archivedIntro: string
    emptyArchivedTitle: string
    unarchive: string
    deletePermanently: string
    messages: (count: number) => string
    restored: string
    deleteConfirm: (title: string) => string
    autoArchiveTitle: string
    autoArchiveDesc: string
    autoArchiveDaysLabel: string
    autoArchiveDaysUnit: string
    autoArchiveFailed: string
    defaultDirTitle: string
    defaultDirDesc: string
    defaultDirUpdated: string
    change: string
    choose: string
    clear: string
    failedLoad: string
    unarchiveFailed: string
    deleteFailed: string
    updateDirFailed: string
    clearDirFailed: string
  }
  toolsets: {
    loadingConfig: string
    savedTitle: string
    savedMessage: (key: string) => string
    removedTitle: string
    removedMessage: (key: string) => string
    failedSave: (key: string) => string
    failedRemove: (key: string) => string
    failedReveal: (key: string) => string
    removeConfirm: (key: string) => string
    set: string
    notSet: string
    selectedTitle: string
    selectedMessage: (provider: string) => string
    failedSelect: (provider: string) => string
    failedLoad: string
    noProviders: string
    ready: string
    needsSignIn: string
    needsSetup: string
    activeBackend: string
    activeBackendHint: string
    useBackend: string
    nousIncluded: string
    nousAuthNeededTitle: string
    nousAuthNeededMessage: (provider: string) => string
    nousAuthSignIn: string
    nousAuthDoneTitle: string
    nousAuthDoneMessage: string
    nousAuthFailed: string
    noApiKeyRequired: string
    postSetupHint: (step: string) => string
    postSetupInstalledHint: string
    postSetupRun: string
    postSetupRerun: string
    postSetupInstalled: string
    postSetupRunning: string
    postSetupStarting: string
    postSetupCompleteTitle: string
    postSetupCompleteMessage: (step: string) => string
    postSetupErrorTitle: string
    postSetupErrorMessage: (step: string) => string
    postSetupFailed: (step: string) => string
    webSearchActive: (backend: string) => string
    webExtractActive: (backend: string) => string
    webCapabilityUnset: string
    webUseForSearch: string
    webUseForExtract: string
    webUsedForSearch: string
    webUsedForExtract: string
    webCapabilitySelectedMessage: (provider: string, capability: string) => string
    failedSelectCapability: (provider: string) => string
    loadingModels: string
    modelSectionTitle: string
    modelCount: (count: number) => string
    modelInUse: string
    modelDefault: string
    modelInactiveHint: string
    modelSelectedTitle: string
    modelSelectedMessage: (model: string) => string
    failedSelectModel: (model: string) => string
    terminalBackend: {
      sectionTitle: string
      loading: string
      failedLoad: string
      ready: string
      needsSetup: string
      unavailable: string
      inUse: string
      selectedTitle: string
      selectedMessage: (backend: string) => string
      failedSelect: (backend: string) => string
      needsSetupHint: string
    }
  }
}
