export type ContextMenuTranslations = {
  /** Accessible name of the app-wide right-click menu card (E3d4 r4: the focused card had none). */
  title: string
  link: {
    openInApp: string
    openExternal: string
    copyUrl: string
    copyResolvedUrl: string
  }
  image: {
    copyImage: string
    copyImageAddress: string
    saveImageAs: string
  }
  edit: {
    cut: string
    paste: string
    selectAll: string
    addToDictionary: string
  }
  page: {
    copyPageUrl: string
    inspectElement: string
  }
}
