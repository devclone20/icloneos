import type { TranslationOverrides } from '../define-locale'

export const starmap: TranslationOverrides['starmap'] = {
  title: 'Grafo de memória',
  subtitle: (nodes, clusters) => `${nodes} competências em ${clusters} categorias`,
  close: 'Fechar o grafo de memória',
  refresh: 'Atualizar',
  memory: 'Memória',
  filterAll: 'Todas',
  filterUsed: 'Usadas',
  filterLearned: 'Aprendidas',
  viewGraph: 'Grafo',
  loadFailed: 'Não foi possível carregar o grafo de memória',
  loading: 'A carregar…',
  emptyTitle: 'Ainda nada aprendido',
  emptyDesc: 'À medida que o agente cria competências e memórias para o seu trabalho, estas aparecem aqui.',
  share: 'Partilhar mapa',
  shareHint:
    'Copie o código para partilhar este mapa, ou cole um para o carregar. Inclui apenas a disposição, não o texto da sua memória nem das competências.',
  shareTitle: 'Importar / exportar mapa',
  sharePlaceholder: 'Cole um código de mapa…',
  copy: 'Copiar código do mapa',
  copied: 'Copiado!',
  importMap: 'Importar um mapa',
  importBtn: 'Carregar',
  importEmpty: 'Cole um código de mapa para o carregar.',
  importSuccess: nodes => `Carregado um mapa com ${nodes} ${nodes === 1 ? 'nó' : 'nós'}.`,
  importedBadge: 'mapa importado',
  resetToMine: 'Voltar ao meu mapa'
}
