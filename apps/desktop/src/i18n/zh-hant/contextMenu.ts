import type { TranslationOverrides } from '../define-locale'

export const contextMenu: TranslationOverrides['contextMenu'] = {
  title: '快捷選單',
  link: {
    openInApp: '在應用程式內瀏覽器中開啟',
    openExternal: '在外部瀏覽器中開啟',
    copyUrl: '複製 URL',
    copyResolvedUrl: '複製解析後的 URL'
  },
  image: {
    copyImage: '複製圖片',
    copyImageAddress: '複製圖片位址',
    saveImageAs: '圖片另存為…'
  },
  edit: {
    cut: '剪下',
    paste: '貼上',
    selectAll: '全選',
    addToDictionary: '新增至字典'
  },
  page: {
    copyPageUrl: '複製頁面 URL',
    inspectElement: '檢查元素'
  }
}
