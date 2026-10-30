import type { TranslationOverrides } from '../define-locale'

export const ui: TranslationOverrides['ui'] = {
  search: {
    clear: '清除搜尋'
  },
  pagination: {
    label: '分頁',
    previous: '上一頁',
    previousAria: '前往上一頁',
    next: '下一頁',
    nextAria: '前往下一頁'
  },
  sidebar: {
    title: '側邊欄',
    description: '顯示行動裝置側邊欄。',
    toggle: open => `${open ? '顯示' : '隱藏'}側邊欄`
  }
}
