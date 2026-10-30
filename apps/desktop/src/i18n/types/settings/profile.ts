export type SettingsProfileTranslations = {
  credentials: {
    pasteKey: string
    pasteLabelKey: (label: string) => string
    optional: string
    enterValueFirst: string
    couldNotSave: string
    remove: string
    getKey: string
    saving: string
  }
  envActions: {
    actions: string
    manageInKeys: string
    docs: string
    hideValue: string
    revealValue: string
    replace: string
    set: string
  }
  keys: {
    failedLoad: string
    empty: string
  }
  providers: {
    connectAccount: string
    haveApiKey: string
    intro: string
    connected: string
    collapse: string
    connectAnother: string
    otherProviders: string
    claudeSubscription: string
    disconnect: string
    disconnectInTerminal: string
    removeExternalGeneric: (provider: string) => string
    removeKeyManaged: (provider: string) => string
    removeTerminalRunning: (provider: string) => string
    removedTitle: string
    removedMessage: (provider: string) => string
    noProviderKeys: string
    searchKeys: string
    noKeysMatch: string
    manage: (provider: string) => string
    endpoints: {
      heading: string
      addHeading: string
      editHeading: string
      name: string
      nameHint: string
      providerId: string
      providerIdHint: string
      url: string
      urlHint: string
      model: string
      context: string
      contextHint: string
      apiKey: string
      apiKeyHint: string
      useForNewChats: string
      discoverModels: string
      discoverModelsHint: string
    }
    featuredPitch: string
    moreFields: (count: number) => string
    localEndpoint: {
      title: string
      description: string
      action: string
    }
  }
}
