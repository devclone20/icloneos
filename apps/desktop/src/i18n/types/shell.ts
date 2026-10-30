export type ShellTranslations = {
  windowControls: string
  paneControls: string
  appControls: string
  modelMenu: {
    search: string
    noModels: string
    editModels: string
    refreshModels: string
    fast: string
  }
  modelOptions: {
    noOptions: string
    options: string
    thinking: string
    fast: string
    effort: string
    minimal: string
    low: string
    medium: string
    high: string
    xhigh: string
    max: string
    ultra: string
    updateFailed: string
    fastFailed: string
  }
  gatewayMenu: {
    gateway: string
    connected: string
    connecting: string
    offline: string
    inferenceReady: string
    inferenceNotReady: string
    checkingInference: string
    disconnected: string
    reconnectGateway: string
    openSystem: string
    connection: (label: string) => string
    recentActivity: string
    viewAllLogs: string
    messagingPlatforms: string
  }
  approvalMode: {
    title: string
    ariaLabel: (mode: string) => string
    manual: string
    manualDescription: string
    smart: string
    smartDescription: string
    off: string
    offDescription: string
  }
  statusbar: {
    unknown: string
    restart: string
    update: string
    updateInProgress: string
    commitsBehind: (count: number, branch: string) => string
    desktopVersion: (version: string) => string
    backendVersion: (version: string) => string
    clientLabel: (version: string) => string
    connectionSsh: (host: string) => string
    connectionRemote: (host: string) => string
    connectionCloud: (host: string) => string
    connectionCloudTooltip: (host: string) => string
    connectionSshTooltip: (host: string) => string
    connectionRemoteTooltip: (host: string) => string
    backendLabel: (version: string) => string
    commit: (sha: string) => string
    branch: (branch: string) => string
    closeCommandCenter: string
    openCommandCenter: string
    showTerminal: string
    hideTerminal: string
    gateway: string
    gatewayReady: string
    gatewayNeedsSetup: string
    gatewayUnavailable: string
    gatewayChecking: string
    gatewayConnecting: string
    gatewayOffline: string
    gatewayRestarting: string
    gatewayTitle: string
    customizeTitle: string
    hideStatusbar: string
    resetStatusbar: string
    toggleApprovalMode: string
    toggleBackendVersion: string
    toggleCommandCenter: string
    toggleContextUsage: string
    toggleRunningTimer: string
    toggleSessionTimer: string
    toggleTerminal: string
    toggleVersion: string
    toggleWorkspace: string
    agents: string
    closeAgents: string
    openAgents: string
    subagents: (count: number) => string
    failed: (count: number) => string
    running: (count: number) => string
    cron: string
    openCron: string
    webhooks: string
    openWebhooks: string
    starmap: string
    openStarmap: string
    turnRunning: string
    contextUsage: string
    contextUsagePanel: {
      categories: {
        conversation: string
        mcp: string
        memory: string
        rules: string
        skills: string
        subagent_definitions: string
        system_prompt: string
        tool_definitions: string
      }
      empty: string
      loading: string
      percentFull: (percent: number) => string
      title: string
      tokenSummary: (used: string, max: string) => string
    }
    session: string
    yoloOn: string
    yoloOff: string
    modelNone: string
    noModel: string
    switchModel: string
    openModelPicker: string
    effortHint: (level: string) => string
    modelPinned: string
    modelTitle: (provider: string, model: string) => string
    providerModelTitle: (provider: string, model: string) => string
  }
}
