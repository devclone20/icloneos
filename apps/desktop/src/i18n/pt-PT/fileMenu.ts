import type { TranslationOverrides } from '../define-locale'

export const fileMenu: TranslationOverrides['fileMenu'] = {
  revealFinder: 'Mostrar no Finder',
  revealExplorer: 'Mostrar no Explorador de Ficheiros',
  revealFileManager: 'Abrir pasta de origem',
  revealInSidebar: 'Mostrar na árvore de ficheiros',
  copyPath: 'Copiar caminho',
  copyRelativePath: 'Copiar caminho relativo',
  download: 'Transferir',
  downloadSaved: 'Guardado',
  downloadFailed: 'A transferência falhou',
  rename: 'Mudar o nome…',
  delete: 'Eliminar',
  renameTitle: 'Mudar o nome',
  renameLabel: 'Novo nome',
  deleteTitle: name => `Eliminar ${name}?`,
  deleteBody: 'Será movido para o Lixo — pode restaurá-lo a partir daí.',
  pathCopied: 'Caminho copiado'
}
