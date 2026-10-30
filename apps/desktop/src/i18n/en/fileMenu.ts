import type { Translations } from '../types'

export const fileMenu: Translations['fileMenu'] = {
  revealFinder: 'Reveal in Finder',
  revealExplorer: 'Reveal in File Explorer',
  revealFileManager: 'Open Containing Folder',
  revealInSidebar: 'Reveal in filetree',
  copyPath: 'Copy Path',
  copyRelativePath: 'Copy Relative Path',
  download: 'Download',
  downloadSaved: 'Saved',
  downloadFailed: 'Download failed',
  rename: 'Rename…',
  delete: 'Delete',
  renameTitle: 'Rename',
  renameLabel: 'New name',
  deleteTitle: name => `Delete ${name}?`,
  deleteBody: 'It will be moved to the Trash — you can restore it from there.',
  pathCopied: 'Path copied'
}
