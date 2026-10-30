import type { Translations } from '../types'

export const titlebar: Translations['titlebar'] = {
  hideSidebar: '隐藏侧边栏',
  showSidebar: '显示侧边栏',
  search: '搜索',
  searchTitle: '搜索会话、视图与操作',
  swapSidebarSides: '交换侧边栏位置',
  hideRightSidebar: '隐藏右侧栏',
  showRightSidebar: '显示右侧栏',
  unreadSessions: count => (count === 1 ? '1 个未读会话' : `${count} 个未读会话`),
  muteHaptics: '关闭触感反馈',
  unmuteHaptics: '开启触感反馈',
  openSettings: '打开设置',
  openStarmap: '打开记忆图谱',
  enterHud: 'HUD 模式',
  exitHud: '退出 HUD 模式',
  resetHudLayout: '重置 HUD 大小和位置',
  layoutEditor: '布局编辑器',
  layoutEditorTitle: mod => `布局编辑器 — ${mod} 点击重置布局`
}
