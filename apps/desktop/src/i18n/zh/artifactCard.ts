import type { Translations } from '../types'

export const artifactCard: Translations['artifactCard'] = {
  kind: { code: '代码', html: '交互页面', svg: '图形' },
  generating: lines => `生成中… ${lines} 行`,
  versionBadge: count => `${count} 个版本`,
  open: '打开'
}
