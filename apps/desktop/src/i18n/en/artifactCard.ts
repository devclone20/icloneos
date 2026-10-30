import type { Translations } from '../types'

export const artifactCard: Translations['artifactCard'] = {
  kind: { code: 'Code', html: 'Interactive page', svg: 'Graphic' },
  generating: lines => `Generating… ${lines} lines`,
  versionBadge: count => `${count} versions`,
  open: 'Open'
}
