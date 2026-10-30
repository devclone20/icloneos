import type { TranslationOverrides } from '../define-locale'

export const artifactCard: TranslationOverrides['artifactCard'] = {
  kind: { code: 'كود', html: 'صفحة تفاعلية', svg: 'رسم' },
  generating: lines => `جارٍ الإنشاء… ${lines} سطرًا`,
  versionBadge: count => `${count} إصدارات`,
  open: 'فتح'
}
