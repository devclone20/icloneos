import type { TranslationOverrides } from '../define-locale'

export const fileMenu: TranslationOverrides['fileMenu'] = {
  revealFinder: 'إظهار في Finder',
  revealExplorer: 'إظهار في File Explorer',
  revealFileManager: 'فتح المجلد الحاوي',
  revealInSidebar: 'إظهار في شجرة الملفات',
  copyPath: 'نسخ المسار',
  copyRelativePath: 'نسخ المسار النسبي',
  download: 'تنزيل',
  downloadSaved: 'تم الحفظ',
  downloadFailed: 'فشل التنزيل',
  rename: 'إعادة تسمية...',
  delete: 'حذف',
  renameTitle: 'إعادة تسمية',
  renameLabel: 'الاسم الجديد',
  deleteTitle: name => `حذف ${name}؟`,
  deleteBody: 'سيتم نقله إلى سلة المهملات — يمكنك استعادته من هناك.',
  pathCopied: 'تم نسخ المسار'
}
