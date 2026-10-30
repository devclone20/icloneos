import type { TranslationOverrides } from '../define-locale'

export const artifactCard: TranslationOverrides['artifactCard'] = {
  kind: { code: '程式碼', html: '互動頁面', svg: '圖形' },
  generating: lines => `產生中… ${lines} 行`,
  versionBadge: count => `${count} 個版本`,
  open: '開啟'
}
