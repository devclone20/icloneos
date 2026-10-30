import type { TranslationOverrides } from '../define-locale'

export const artifactPreview: TranslationOverrides['artifactPreview'] = {
  versionOf: (current, total) => `الإصدار ${current} من ${total}`,
  olderVersion: 'إصدار أقدم',
  newerVersion: 'إصدار أحدث',
  latest: 'الأحدث',
  copyContent: 'نسخ المحتوى',
  download: 'تنزيل',
  openInBrowser: 'فتح في المتصفح',
  openInBrowserFailed: 'تعذّر الفتح في المتصفح',
  missingTitle: 'الناتج غير متاح',
  missingBody: 'لم يعد هذا الناتج موجودًا في السجل المحلي.'
}
