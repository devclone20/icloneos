export type CommandCenterTranslations = {
  close: string
  paletteTitle: string
  back: string
  searchPlaceholder: string
  goTo: string
  goToSession: string
  branches: string
  projects: string
  openFolder: string
  openFolderAt: (path: string) => string
  newSessionInProject: (project: string) => string
  commands: string
  startInBranch: (branch: string) => string
  commandCenter: string
  appearance: string
  settings: string
  changeTheme: string
  changeColorMode: string
  pets: {
    title: string
    /** The pet's accessible name (it is a drawn robot: its number). */
    label: (name: string) => string
    openApp: string
    popIn: string
    /** The popped-out pet's prompt box: its accessible name and its placeholder (it sends to the current session). */
    promptLabel: string
    promptPlaceholder: string
    /** One line above the prompt box when a message is not sent (the text stays): a slash command (the box sends only
     *  normal messages), no session on screen, or a send that did not land. */
    promptRefused: { command: string; noSession: string; notSent: string }
    /** One line above the prompt box when the app went away after it had handed the message on (R4-F2): it may have
     *  been sent, so the text stays and the line says to check the chat before resending. */
    promptMaybeSent: string
    /** The speech bubble's lines per mood (picked at random, never the same twice in a row). */
    bubble: { run: string[]; review: string[]; failed: string[]; waiting: string[] }
  }
  installTheme: {
    /** Shown where the Marketplace search does not exist (the web build). */
    unavailable: string
    title: string
    pageTitle: string
    placeholder: string
    loading: string
    error: string
    empty: string
    install: string
    installing: string
    installed: string
    installs: (count: string) => string
  }
  settingsFields: string
  mcpServers: string
  archivedChats: string
  sections: Record<'maintenance' | 'sessions' | 'system' | 'usage', string>
  sectionDescriptions: Record<'maintenance' | 'sessions' | 'system' | 'usage', string>
  nav: Record<'newChat' | 'settings' | 'skills' | 'messaging' | 'artifacts', { title: string; detail: string }>
  sectionEntries: Record<'sessions' | 'system' | 'usage', { title: string; detail: string }>
  providerNavigate: string
  providerSessions: string
  refresh: string
  refreshing: string
  noResults: string
  pinSession: string
  unpinSession: string
  exportSession: string
  deleteSession: string
  noSessions: string
  gatewayRunning: string
  gatewayStopped: string
  hermesActiveSessions: (version: string, count: number) => string
  restartGateway: string
  openBrowser: string
  gatewayRestartFailed: string
  updateHermes: string
  reloadWindow: string
  actionRunning: string
  actionDone: string
  actionFailed: string
  actionStartedWaiting: string
  loadingStatus: string
  recentLogs: string
  noLogs: string
  days: (count: number) => string
  statSessions: string
  statApiCalls: string
  statTokens: string
  statCost: string
  actualCost: (cost: string) => string
  loadingUsage: string
  noUsage: (period: number) => string
  retry: string
  dailyTokens: string
  input: string
  output: string
  noDailyActivity: string
  topModels: string
  noModelUsage: string
  topSkills: string
  noSkillActivity: string
  actions: (count: string) => string
  logFile: string
  logLevel: string
  logSearchPlaceholder: string
  maintenance: {
    runOps: string
    doctor: string
    doctorDesc: string
    securityAudit: string
    securityAuditDesc: string
    backup: string
    backupDesc: string
    diagnosticsReport: string
    diagnosticsReportDesc: string
    curator: string
    curatorDesc: string
    curatorPaused: string
    curatorActive: string
    curatorDisabled: string
    curatorLastRun: (when: string) => string
    curatorNeverRan: string
    pause: string
    resume: string
    runNow: string
    memoryData: string
    memoryDataDesc: string
    memoryProvider: (name: string) => string
    builtinMemory: string
    memoryFile: string
    userFile: string
    bytes: (size: string) => string
    empty: string
    resetMemory: string
    resetUser: string
    resetAll: string
    resetConfirm: (target: string) => string
    resetDone: (files: string) => string
    resetFailed: string
    actionStarted: (name: string) => string
    actionFailed: (name: string) => string
    running: string
    viewLog: string
  }
}
