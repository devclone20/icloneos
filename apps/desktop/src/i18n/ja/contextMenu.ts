import type { TranslationOverrides } from '../define-locale'

export const contextMenu: TranslationOverrides['contextMenu'] = {
  title: 'コンテキストメニュー',
  link: {
    openInApp: 'アプリ内ブラウザーで開く',
    openExternal: '外部ブラウザーで開く',
    copyUrl: 'URL をコピー',
    copyResolvedUrl: '解決後の URL をコピー'
  },
  image: {
    copyImage: '画像をコピー',
    copyImageAddress: '画像アドレスをコピー',
    saveImageAs: '画像を名前を付けて保存…'
  },
  edit: {
    cut: '切り取り',
    paste: '貼り付け',
    selectAll: 'すべて選択',
    addToDictionary: '辞書に追加'
  },
  page: {
    copyPageUrl: 'ページの URL をコピー',
    inspectElement: '要素を調査'
  }
}
