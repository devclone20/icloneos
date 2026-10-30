import type { TranslationOverrides } from '../define-locale'

export const titlebar: TranslationOverrides['titlebar'] = {
  hideSidebar: 'Ocultar barra lateral',
  showSidebar: 'Mostrar barra lateral',
  search: 'Pesquisar',
  searchTitle: 'Pesquisar sessões, vistas e ações',
  swapSidebarSides: 'Trocar lados das barras laterais',
  hideRightSidebar: 'Ocultar barra lateral direita',
  showRightSidebar: 'Mostrar barra lateral direita',
  unreadSessions: count => (count === 1 ? '1 sessão por ler' : `${count} sessões por ler`),
  muteHaptics: 'Silenciar resposta háptica',
  unmuteHaptics: 'Ativar resposta háptica',
  openSettings: 'Abrir definições',
  openStarmap: 'Abrir grafo de memória',
  enterHud: 'Modo HUD',
  exitHud: 'Sair do modo HUD',
  resetHudLayout: 'Repor tamanho e posição do HUD',
  layoutEditor: 'Editor de esquemas',
  layoutEditorTitle: mod => `Editor de esquemas — ${mod} + clique repõe o esquema`
}
