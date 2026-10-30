export type ZonesTranslations = {
  showTabStrip: string
  hideTabStrip: string
  showStripTab: (title: string) => string
  hideStripTab: (title: string) => string
  lastTabKeptTitle: string
  lastTabKeptBody: string
  toggleStripTab: (title: string) => string
  minimize: string
  restore: string
  closeRunningTitle: string
  closeRunningBody: string
  closeRunningConfirm: string
  reload: string
  closeOthers: string
  closeToRight: string
  closeAll: string
  newSessionTab: string
  newTab: string
  pluginDisabled: (pluginId: string) => string
  pluginDisabledBody: string
  missingPane: (paneId: string) => string
  editTitle: string
  editHint: string
  reset: string
  templates: string
  custom: string
  newGridLayout: string
  saveCurrentAs: string
  nameLayoutPlaceholder: string
  deletePreset: (name: string) => string
  zoneEditorTitle: string
  editorHintPre: string
  editorHintPost: string
  templateColumns: string
  templateRows: string
  templateGrid: string
  templatePriority: string
  zoneTag: (index: number) => string
  mergeZones: (count: number) => string
  customZoneName: (count: number) => string
  layoutNamePlaceholder: (fallback: string) => string
  saveApply: string
  notExpressible: string
  zoneCount: (count: number) => string
  tabCount: (count: number) => string
}
