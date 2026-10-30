import type { TranslationOverrides } from '../define-locale'

export const titlebar: TranslationOverrides['titlebar'] = {
  hideSidebar: '隱藏側邊欄',
  showSidebar: '顯示側邊欄',
  search: '搜尋',
  searchTitle: '搜尋工作階段、檢視和動作',
  swapSidebarSides: '交換側邊欄位置',
  hideRightSidebar: '隱藏右側邊欄',
  showRightSidebar: '顯示右側邊欄',
  unreadSessions: count => (count === 1 ? '1 個未讀工作階段' : `${count} 個未讀工作階段`),
  muteHaptics: '靜音觸感回饋',
  unmuteHaptics: '開啟觸感回饋',
  openSettings: '開啟設定',
  openStarmap: '開啟記憶圖譜',
  enterHud: 'HUD 模式',
  exitHud: '結束 HUD 模式',
  resetHudLayout: '重設 HUD 大小和位置',
  layoutEditor: '版面編輯器',
  layoutEditorTitle: mod => `版面編輯器：按住 ${mod} 並按一下即可重設版面`
}
