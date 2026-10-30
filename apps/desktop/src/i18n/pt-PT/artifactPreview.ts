import type { TranslationOverrides } from '../define-locale'

export const artifactPreview: TranslationOverrides['artifactPreview'] = {
  versionOf: (current, total) => `v${current} de ${total}`,
  olderVersion: 'Versão anterior',
  newerVersion: 'Versão seguinte',
  latest: 'Mais recente',
  copyContent: 'Copiar conteúdo',
  download: 'Transferir',
  openInBrowser: 'Abrir no navegador',
  openInBrowserFailed: 'Não foi possível abrir no navegador',
  missingTitle: 'Artefacto indisponível',
  missingBody: 'Este artefacto já não está no registo local.'
}
