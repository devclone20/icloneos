export type StarmapTranslations = {
  title: string
  subtitle: (nodes: number, clusters: number) => string
  close: string
  refresh: string
  memory: string
  filterAll: string
  filterUsed: string
  filterLearned: string
  viewGraph: string
  loadFailed: string
  loading: string
  emptyTitle: string
  emptyDesc: string
  share: string
  shareHint: string
  shareTitle: string
  sharePlaceholder: string
  copy: string
  copied: string
  importMap: string
  importBtn: string
  importEmpty: string
  importSuccess: (nodes: number) => string
  importedBadge: string
  resetToMine: string
}
