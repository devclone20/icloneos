import type { Translations } from '../types'

export const contextMenu: Translations['contextMenu'] = {
  title: '上下文菜单',
  link: {
    openInApp: '在应用内浏览器中打开',
    openExternal: '在外部浏览器中打开',
    copyUrl: '复制 URL',
    copyResolvedUrl: '复制解析后的 URL'
  },
  image: {
    copyImage: '复制图片',
    copyImageAddress: '复制图片地址',
    saveImageAs: '图片另存为…'
  },
  edit: {
    cut: '剪切',
    paste: '粘贴',
    selectAll: '全选',
    addToDictionary: '添加到词典'
  },
  page: {
    copyPageUrl: '复制页面 URL',
    inspectElement: '检查元素'
  }
}
