export type ArtifactsTranslations = {
  search: string
  refresh: string
  refreshing: string
  indexing: string
  tabAll: string
  tabImages: string
  tabFiles: string
  tabLinks: string
  noArtifactsTitle: string
  noArtifactsDesc: string
  failedLoad: string
  openFailed: string
  itemsImage: string
  itemsLink: string
  itemsFile: string
  itemsGeneric: string
  zero: string
  rangeOf: (start: number, end: number, total: number) => string
  goToPage: (itemLabel: string, page: number) => string
  colTitleLink: string
  colTitleFile: string
  colTitleDefault: string
  colLocationLink: string
  colLocationFile: string
  colLocationDefault: string
  colSession: string
  kindImage: string
  kindFile: string
  kindLink: string
  chat: string
  copyUrl: string
  copyPath: string
}
