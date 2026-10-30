import type { TranslationOverrides } from '../define-locale'

// K21/N5 (V3-K critic r1 m3): counts in this locale's own grouping. CLDR pt-PT groups from five digits on (5000,
// 12 000), so the Book's 5 000 ceiling reads 5000, as a Portuguese reader writes it.
const n = (value: number): string => value.toLocaleString('pt-PT')

export const inftBook: TranslationOverrides['inftBook'] = {
  navLabel: 'iNFT Book',
  keywords: ['inft', 'book', 'livro', 'carteira', 'coleção', 'início'],
  rule: 'O Início mostra apenas os iNFTs que marcar no iNFT Book.',
  openBook: 'Abrir o iNFT Book',
  wallet: address => `Carteira ${address}`,
  count: (total, onHome) => `${n(total)} ${total === 1 ? 'iNFT' : 'iNFTs'} · ${n(onHome)} no Início`,
  rescan: 'Analisar de novo',
  search: 'Pesquisar iNFTs',
  filterCollection: 'Coleção',
  allCollections: 'Todas as coleções',
  filterChain: 'Rede',
  allChains: 'Todas as redes',
  filterState: 'Mostrar',
  stateAll: 'Todos',
  stateChecked: 'No Início',
  stateUnchecked: 'Fora do Início',
  checkShown: 'Marcar todos os visíveis',
  uncheckShown: 'Desmarcar todos os visíveis',
  confirmTitle: count => `Colocar ${n(count)} iNFTs no Início?`,
  confirmBody: 'Uma coleção longa no Início demora mais a percorrer. Pode desmarcar qualquer um deles mais tarde.',
  confirmAction: 'Marcá-los',
  confirmBusy: 'A marcar…',
  confirmDone: 'Marcados',
  confirmError: 'Não foi possível marcá-los. Tente novamente.',
  cancel: 'Cancelar',
  scanning: found => `A analisar a sua carteira… ${n(found)} encontrados até agora`,
  partial: loaded => `Carregados ${n(loaded)} de ? — a análise parou antes do fim.`,
  capped: limit =>
    `A mostrar os primeiros ${n(limit)} iNFTs. Esta carteira tem mais; o iNFT Book lê no máximo ${n(limit)}.`,
  retry: 'Tentar novamente',
  kept: count =>
    count === 1
      ? `Mantivemos no Início ${n(count)} iNFT que já lá estava antes do iNFT Book.`
      : `Mantivemos no Início ${n(count)} iNFTs que já lá estavam antes do iNFT Book.`,
  dismiss: 'Dispensar',
  noWallet: 'Inicie sessão com a sua carteira para ver os seus iNFTs.',
  signIn: 'Iniciar sessão',
  none: 'Ainda não há iNFTs nesta carteira.',
  noMatch: 'Nenhum iNFT corresponde a estes filtros.',
  scanFailed: 'A análise da carteira falhou.',
  scanRefused: 'A análise da carteira foi recusada.',
  showOnHome: name => `Mostrar ${name} no Início`,
  setUp: 'Configurado',
  setupNeeded: 'Configuração necessária',
  homeEmpty: 'Ainda não há nenhum iNFT marcado para o Início.'
}
