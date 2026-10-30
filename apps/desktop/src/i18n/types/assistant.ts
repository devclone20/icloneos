export type ToolTitleKey =
  | 'browser_click'
  | 'browser_fill'
  | 'browser_navigate'
  | 'browser_snapshot'
  | 'browser_take_screenshot'
  | 'browser_type'
  | 'clarify'
  | 'cronjob'
  | 'edit_file'
  | 'execute_code'
  | 'image_generate'
  | 'list_files'
  | 'memory'
  | 'patch'
  | 'read_file'
  | 'search_files'
  | 'session_search_recall'
  | 'terminal'
  | 'todo'
  | 'vision_analyze'
  | 'web_extract'
  | 'web_search'
  | 'write_file'

interface ToolTitleCopy {
  done: string
  pending: string
  pendingAction: string
}

export type AssistantTranslations = {
  thread: {
    loadingSession: string
    showEarlier: string
    loadingResponse: string
    resumeWhenBackgroundDone: (count: number) => string
    thinking: string
    thought: string
    thoughtBriefly: string
    thoughtFor: (duration: string) => string
    turnDuration: (duration: string) => string
    today: (time: string) => string
    yesterday: (time: string) => string
    copy: string
    refresh: string
    moreActions: string
    branchNewChat: string
    react: string
    dismissError: string
    /** Layer titles for the structured error card (agent/error_surface.py).
     *  `generic` is the fallback when the backend sent no descriptor. */
    errorLayers: {
      auth: string
      billing: string
      disk: string
      endpoint: string
      gateway: string
      generic: string
      provider: string
      runtime: string
      streaming: string
    }
    errorRetry: string
    errorSwitchProvider: string
    errorOpenLogs: string
    errorOpenLogsFailed: string
    errorOpenDesktopLogs: string
    errorCopyDiagnostics: string
    errorSendDiagnostics: string
    filesChanged: (count: number) => string
    readAloudFailed: string
    preparingAudio: string
    stopReading: string
    readAloud: string
    editMessage: string
    expandMessage: string
    scrollToBottom: string
    stop: string
    restorePrevious: string
    restoreCheckpoint: string
    restoreFromHere: string
    restoreTitle: string
    restoreBody: string
    restoreConfirm: string
    restoreNext: string
    goForward: string
    sendEdited: string
    attachingFile: string
  }
  approval: {
    command: string
    jumpToApproval: string
  }
  clarify: {
    notReady: string
    gatewayDisconnected: string
    sendFailed: string
    loadingQuestion: string
    other: string
    placeholder: string
    skip: string
    skipped: string
    continueLabel: string
    confirmAndContinueLabel: string
    answeredBadge: string
    questionProgress: (answered: number, total: number) => string
    lateAnswer: (question: string, choice: string) => string
    lateAnswerTip: string
    lateAnswerHint: string
  }
  mcpSetup: {
    installTitle: (server: string) => string
    enableTitle: (server: string) => string
    authorizeTitle: (server: string) => string
    installAction: string
    enableAction: string
    authorizeAction: string
    decline: string
    declined: string
    installed: (server: string) => string
    enabled: (server: string) => string
    authorized: (server: string) => string
    failed: (server: string) => string
    unanswered: string
    toolCount: (count: number) => string
    notInCatalog: (server: string) => string
    catalogSource: string
    envRequired: string
    sendFailed: string
    reloadFailed: string
    gatewayDisconnected: string
  }
  tool: {
    copyCode: string
    renderingImage: string
    copyOutput: string
    copyCommand: string
    copyContent: string
    copyUrl: string
    copyResults: string
    copyQuery: string
    copyFile: string
    copyPath: string
    outputAlt: string
    rawResponse: string
    copyActivity: string
    recoveredOne: string
    recoveredMany: (count: number) => string
    failedOne: string
    failedMany: (count: number) => string
    statusRunning: string
    statusError: string
    statusRecovered: string
    statusDone: string
    /** Over-budget / rejected memory write title — not "Saved to memory". */
    memoryWriteNoted: string
    actions: {
      read: string
      reading: string
      opened: string
      opening: string
      failedToOpen: string
      searched: string
      searching: string
      ran: string
      running: string
      ranCode: string
      runningCode: string
    }
    prefixes: {
      browser: string
      web: string
    }
    titleTemplates: {
      actionCommand: (action: string, command: string) => string
      actionQuoted: (action: string, value: string) => string
      actionTarget: (action: string, target: string) => string
      prefixedDone: (prefix: string, action: string) => string
      runningPrefixedTool: (prefix: string, action: string) => string
      runningTool: (action: string) => string
    }
    titles: Record<ToolTitleKey, ToolTitleCopy>
  }
}
