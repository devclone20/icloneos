import type { TranslationOverrides } from '../define-locale'

export const ui: TranslationOverrides['ui'] = {
  search: {
    clear: '検索をクリア'
  },
  pagination: {
    label: 'ページング',
    previous: '前へ',
    previousAria: '前のページへ',
    next: '次へ',
    nextAria: '次のページへ'
  },
  sidebar: {
    title: 'サイドバー',
    description: 'モバイルサイドバーを表示します。',
    toggle: open => `サイドバーを${open ? '表示' : '非表示'}`
  }
}
