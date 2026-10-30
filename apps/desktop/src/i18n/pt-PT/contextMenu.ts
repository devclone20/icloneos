import type { TranslationOverrides } from '../define-locale'

export const contextMenu: TranslationOverrides['contextMenu'] = {
  title: 'Menu de contexto',
  link: {
    openInApp: 'Abrir no navegador da aplicação',
    openExternal: 'Abrir no navegador externo',
    copyUrl: 'Copiar URL',
    copyResolvedUrl: 'Copiar URL resolvido'
  },
  image: {
    copyImage: 'Copiar imagem',
    copyImageAddress: 'Copiar endereço da imagem',
    saveImageAs: 'Guardar imagem como…'
  },
  edit: {
    cut: 'Cortar',
    paste: 'Colar',
    selectAll: 'Selecionar tudo',
    addToDictionary: 'Adicionar ao dicionário'
  },
  page: {
    copyPageUrl: 'Copiar URL da página',
    inspectElement: 'Inspecionar elemento'
  }
}
