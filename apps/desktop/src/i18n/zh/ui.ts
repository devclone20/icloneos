import type { Translations } from '../types'

export const ui: Translations['ui'] = {
  search: {
    clear: '清除搜索'
  },
  pagination: {
    label: '分页',
    previous: '上一页',
    previousAria: '前往上一页',
    next: '下一页',
    nextAria: '前往下一页'
  },
  sidebar: {
    title: '侧边栏',
    description: '显示移动端侧边栏。',
    toggle: open => `${open ? '显示' : '隐藏'}侧边栏`
  }
}
