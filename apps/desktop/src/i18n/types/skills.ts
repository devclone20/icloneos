export type SkillsTranslations = {
  tabSkills: string
  tabToolsets: string
  configuringProfile: string
  tabMcp: string
  all: string
  searchSkills: string
  searchToolsets: string
  refresh: string
  refreshing: string
  loading: string
  noSkillsTitle: string
  noSkillsDesc: string
  noToolsetsTitle: string
  noToolsetsDesc: string
  noDescription: string
  configured: string
  needsKeys: string
  visionModelHint: string
  visionModelLink: string
  toolsetsEnabled: (enabled: number, total: number) => string
  configureToolset: (label: string) => string
  toggleToolset: (label: string, enabled: boolean) => string
  skillsLoadFailed: string
  toolsetsRefreshFailed: string
  skillEnabled: string
  skillDisabled: string
  toolsetEnabled: string
  toolsetDisabled: string
  appliesToNewSessions: (name: string) => string
  failedToUpdate: (name: string) => string
  sortMostUsed: string
  sortAlpha: string
  sortMostUsedDesc: string
  sortLeastUsedAsc: string
  enableAll: string
  disableAll: string
  disableUnused: string
  bulkUpdated: (count: number) => string
  bulkNoChange: string
  usageCount: (count: number | string) => string
  provenance: Record<'agent' | 'bundled' | 'hub', string>
  emptyNoneFound: (noun: string) => string
  emptyNothingMatches: (query: string) => string
  emptyNoneAvailable: (noun: string) => string
  changesApplyNewSessions: string
  skillUpdated: string
  edit: string
  archive: string
  skillArchivedTitle: string
  skillArchivedMessage: string
  hub: {
    searchPlaceholder: string
    search: string
    searching: string
    connectingHubs: string
    connectedHubs: string
    featured: string
    landingHint: string
    noResults: string
    resultCount: (count: number, ms: number | null) => string
    timedOut: (sources: string) => string
    installed: string
    install: string
    installing: string
    uninstall: string
    uninstalling: string
    updateAll: string
    updating: string
    preview: string
    scan: string
    scanning: string
    close: string
    files: string
    noReadme: string
    trust: Record<string, string>
    verdictSafe: string
    verdictCaution: string
    verdictDangerous: string
    policyAllow: string
    policyAsk: string
    policyBlock: string
    findings: (count: number) => string
    noFindings: string
    installStarted: (name: string) => string
    uninstallStarted: (name: string) => string
    updateStarted: string
    actionFailed: string
    actionLog: string
    alreadyInstalled: (name: string) => string
    pickerTitle: string
    pickerBrowse: string
    pickerHide: string
    pickerHint: string
    loadFailed: string
    previewFailed: string
    scanFailed: string
    searchFailed: string
  }
}
