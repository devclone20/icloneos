export type SidebarTranslations = {
  nav: Record<string, string>
  searchAria: string
  searchPlaceholder: string
  clearSearch: string
  noMatch: (query: string) => string
  results: string
  pinned: string
  sessions: string
  cronJobs: string
  groupAriaGrouped: string
  groupAriaUngrouped: string
  showProjects: string
  showSessions: string
  groupTitleGrouped: string
  groupTitleUngrouped: string
  allPinned: string
  shiftClickHint: string
  noWorkspace: string
  projectEmpty: string
  noSessions: string
  noFilterMatches: string
  projects: {
    sectionLabel: string
    home: string
    newButton: string
    createTitle: string
    createDesc: string
    renameTitle: string
    addFolderTitle: string
    namePlaceholder: string
    foldersLabel: string
    ideaLabel: string
    ideaPlaceholder: string
    ideaGenerate: string
    ideaGenerating: string
    ideaShuffle: string
    noFolders: string
    addFolder: string
    primaryBadge: string
    removeFolder: string
    create: string
    menu: string
    menuRename: string
    menuAppearance: string
    noColor: string
    menuAddFolder: string
    menuSetActive: string
    menuDelete: string
    moveToProject: string
    movedTo: (name: string) => string
    moveFailed: string
    moveNoFolder: string
    moveNoProjects: string
    reveal: string
    copyPath: string
    removeFromSidebar: string
    createFailed: string
    staleBackend: string
    deleteConfirm: string
    startWork: string
    newWorktreeTitle: string
    newWorktreeDesc: string
    branchPlaceholder: string
    branchOff: () => { after: string; before: string }
    baseBranchPlaceholder: string
    baseBranchNone: string
    startWorkFailed: string
    worktreeStaleBackend: string
    worktreeProjectLabel: string
    worktreeProjectPlaceholder: string
    worktreeProjectNone: string
    convertBranch: string
    convertBranchTitle: string
    convertBranchDesc: string
    convertBranchPlaceholder: string
    convertBranchInstead: string
    branchOpenExisting: string
    branchSwitchHome: string
    branchCreateWorktree: string
    branchTrackRemote: string
    branchesLoading: string
    noBranches: string
    removeWorktree: string
    removeWorktreeFailed: string
    removeWorktreeConfirm: string
    removeWorktreeDirty: string
    forceRemove: string
    enter: (label: string) => string
    reorder: (label: string) => string
    toggle: (label: string, open: boolean) => string
    back: string
  }
  newSessionIn: (label: string) => string
  showMoreIn: (count: number, label: string) => string
  loading: string
  loadMore: string
  loadCount: (step: number) => string
  messageCount: (count: number) => string
  toolCallCount: (count: number) => string
  row: {
    pin: string
    unpin: string
    markUnread: string
    markRead: string
    unreadFailed: string
    copyId: string
    export: string
    branchFrom: string
    rename: string
    archive: string
    newWindow: string
    openInTerminal: string
    /** V3-S r2: the toast when the permission gate refuses a Hermes outside icloneOS (no key can reach it). */
    openInTerminalGateRefused: string
    hideTabBar: string
    openInNewTab: string
    openInSplit: string
    copyIdFailed: string
    sessionActions: string
    sessionRunning: string
    needsInput: string
    waitingForAnswer: string
    finishedUnread: string
    backgroundRunning: string
    draftSession: string
    handoffOrigin: (platform: string) => string
    ownedByProfile: (profile: string) => string
    renamed: string
    renameFailed: string
    renameTitle: string
    renameDesc: string
    untitledPlaceholder: string
    deleteTitle: string
    deleteDesc: (title: string) => string
    deleting: string
    deleted: string
    untitledChat: (id: string) => string
    messageCount: (count: number) => string
    todoProgress: string
    ageNow: string
    ageDay: string
    ageHour: string
    ageMin: string
  }
  dateDivider: {
    today: string
    yesterday: string
    thisWeek: string
    lastWeek: string
    thisMonth: string
  }
  statusDivider: {
    working: string
    done: string
  }
  markAllRead: string
}
