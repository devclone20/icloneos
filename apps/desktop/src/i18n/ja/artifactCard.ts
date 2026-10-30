import type { TranslationOverrides } from '../define-locale'

export const artifactCard: TranslationOverrides['artifactCard'] = {
  kind: { code: 'コード', html: 'インタラクティブページ', svg: 'グラフィック' },
  generating: lines => `生成中… ${lines} 行`,
  versionBadge: count => `${count} 個のバージョン`,
  open: '開く'
}
