import type { Translations } from '../types'

export const contextMenu: Translations['contextMenu'] = {
  title: 'Context menu',
  link: {
    openInApp: 'Open in in-app browser',
    openExternal: 'Open in external browser',
    copyUrl: 'Copy URL',
    copyResolvedUrl: 'Copy resolved URL'
  },
  image: {
    copyImage: 'Copy image',
    copyImageAddress: 'Copy image address',
    saveImageAs: 'Save image as…'
  },
  edit: {
    cut: 'Cut',
    paste: 'Paste',
    selectAll: 'Select all',
    addToDictionary: 'Add to dictionary'
  },
  page: {
    copyPageUrl: 'Copy page URL',
    inspectElement: 'Inspect element'
  }
}
