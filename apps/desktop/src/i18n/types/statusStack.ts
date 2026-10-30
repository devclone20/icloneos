export type StatusStackTranslations = {
  agents: string
  background: (count: number) => string
  goalActive: string
  goalDone: string
  goalPaused: string
  goalWaiting: string
  subagents: (count: number) => string
  todos: (done: number, total: number) => string
  running: string
  stop: string
  dismiss: string
  exit: (code: number) => string
  coding: {
    title: string
    noBranch: string
    detached: string
    clean: string
    changed: (count: number) => string
    ahead: (count: number) => string
    behind: (count: number) => string
    review: string
    close: string
    openChanges: string
    openFile: string
    stage: string
    unstage: string
    stageAll: string
    viewAsTree: string
    viewAsList: string
    revert: string
    revertAll: string
    revertConfirm: string
    revertAllConfirm: string
    staged: string
    noChanges: string
    notRepo: string
    noDiff: string
    scopeUncommitted: string
    scopeBranch: string
    scopeLastTurn: string
    commit: string
    commitAndPush: string
    commitPlaceholder: (shortcut: string) => string
    generateCommitMessage: string
    stopGenerating: string
    createPr: string
    openPr: string
    ghMissing: string
    agentShip: string
    agentShipUnavailable: string
    agentShipPrompt: string
    newBranch: string
    branchOffFrom: (base: string) => string
    switchTo: (branch: string) => string
    switchFailed: (branch: string) => string
    worktrees: string
  }
}
