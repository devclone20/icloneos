export type SettingsShellTranslations = {
  closeSettings: string
  exportConfig: string
  importConfig: string
  resetToDefaults: string
  resetConfirm: string
  exportFailed: string
  resetFailed: string
  nav: {
    /** V3-ON: Settings › Machine › Set up (the first-launch choices, any time). */
    setup: string
    privacy: string
    permissions: string
    engine: string
    message: string
    sessionsBots: string
    diagnostics: string
    providers: string
    providerAccounts: string
    providerApiKeys: string
    providerCustomEndpoints: string
    gateway: string
    apiKeys: string
    keybinds: string
    keysTools: string
    keysSettings: string
    mcp: string
    archivedChats: string
    about: string
    billing: string
    notifications: string
    plugins: string
    updates: string
  }
  sections: Record<string, string>
  // Settings nav group headings (Agent & Models, Appearance & Desktop, …).
  // Keyed by SettingsGroupId (app/settings/panes.tsx) — Record<string, string>
  // so a locale can lag the English fallback the same way `sections` does.
  groups: Record<string, string>
  /** The landing's one sentence under each group, by group id. */
  landing: Record<'profile' | 'agent' | 'economy' | 'machine', string>
  fieldLabels: Record<string, string>
  fieldDescriptions: Record<string, string>
  config: {
    memoryProviderSaveFailed: (label: string) => string
    voiceReadiness: {
      title: string
      listening: (engine: string) => string
      speaking: (engine: string, autoSpeak: boolean) => string
      off: string
      auto: string
      direct: string
      relayed: string
      directNote: string
      relayedNote: string
      mic: string
      notes: Record<'free' | 'fastest' | 'premium' | 'offline' | 'cloud', string>
    }
    memoryProviderLoadFailed: string
    memoryProviderLoading: string
    memoryProviderFullConfig: string
    memoryProviderSettings: (label: string) => string
    memoryProviderSecretSet: (label: string) => string
    memoryProviderSecretNotSet: (label: string) => string
    none: string
    noneParen: string
    builtinOnly: string
    notSet: string
    commaSeparated: string
    searchPlaceholder: string
    noResults: string
    systemDefault: string
    emptyTitle: string
    emptyDesc: string
    failedLoad: string
    autosaveFailed: string
    imported: string
    invalidJson: string
    toolsetsWipeConfirm: string
    keepAwakeTitle: string
    keepAwakeDesc: string
    disableF12Title: string
    disableF12Desc: string
    attachmentSizeTitle: string
    attachmentSizeDesc: string
    attachmentSizeUnit: string
    attachmentSizeLabel: string
  }
  quickEntry: {
    enabledTitle: string
    enabledDesc: string
    shortcutTitle: string
    shortcutDesc: string
    active: string
    takenBy: string
    invalidShortcut: string
  }
  /** One hint line under each built-in shortcut row, by action id (U2-p2b-10). Contributed actions have none. */
  keybindHints: Readonly<Record<string, string>>
  search: {
    /** Words (besides the pane's own title) that reach the Keyboard shortcuts pane and every shortcut row. */
    keybindWords: readonly string[]
    placeholder: string
    pill: string
  }
  profileScope: {
    appliesTo: string
    editsProfile: (profile: string) => string
  }
}
