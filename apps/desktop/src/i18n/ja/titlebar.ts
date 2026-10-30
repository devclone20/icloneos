import type { TranslationOverrides } from '../define-locale'

export const titlebar: TranslationOverrides['titlebar'] = {
  hideSidebar: 'サイドバーを非表示',
  showSidebar: 'サイドバーを表示',
  search: '検索',
  searchTitle: 'セッション、ビュー、アクションを検索',
  swapSidebarSides: 'サイドバーの向きを切り替え',
  hideRightSidebar: '右サイドバーを非表示',
  showRightSidebar: '右サイドバーを表示',
  unreadSessions: count => (count === 1 ? '未読セッション 1 件' : `未読セッション ${count} 件`),
  muteHaptics: '触覚フィードバックをオフ',
  unmuteHaptics: '触覚フィードバックをオン',
  openSettings: '設定を開く',
  openStarmap: 'メモリグラフを開く',
  resetHudLayout: 'HUD のサイズと位置をリセット',
  enterHud: 'HUD モード',
  exitHud: 'HUD モードを終了',
  layoutEditor: 'レイアウトエディター',
  layoutEditorTitle: mod => `レイアウトエディター — ${mod}-クリックでレイアウトをリセット`
}
