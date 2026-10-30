export type RightSidebarTranslations = {
  aria: string
  panelsAria: string
  files: string
  terminal: string
  noFolderSelected: string
  changeCwdTitle: string
  remotePickerTitle: string
  remotePickerDescription: string
  remotePickerSelect: string
  folderTip: (cwd: string) => string
  openFolder: string
  refreshTree: string
  collapseAll: string
  previewUnavailable: string
  couldNotPreview: (path: string) => string
  noProjectTitle: string
  noProjectBody: string
  noProjectOpen: string
  noDiffs: string
  unreadableTitle: string
  unreadableBody: (error: string) => string
  emptyTitle: string
  emptyBody: string
  treeErrorTitle: string
  treeErrorBody: string
  tryAgain: string
  loadingTree: string
  loadingFiles: string
  terminalHide: string
  terminalsAria: string
  terminalNew: string
  terminalCloseOthers: string
  terminalCloseAll: string
  addToChat: string
}
