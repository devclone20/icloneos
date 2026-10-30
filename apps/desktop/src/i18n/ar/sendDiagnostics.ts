import type { TranslationOverrides } from '../define-locale'

export const sendDiagnostics: TranslationOverrides['sendDiagnostics'] = {
  title: 'حفظ تقرير التشخيص',
  lead: 'لا يغادر شيءٌ هذا الـ Mac: يكتب icloneOS التقرير في ملف تختاره أنت. تُزال الأسرار والمفاتيح والرموز وعناوين البريد الإلكتروني ومجلدك الشخصي أولًا. يحتوي على:',
  parts: {
    context: 'ما الذي فشل',
    logs: 'سجل التطبيق الأخير',
    report: 'آخر تقرير تشخيص'
  },
  lines: count => (count === 1 ? 'سطر واحد' : `${count} سطرًا`),
  preview: 'عرض التقرير',
  loading: 'جارٍ تجهيز التقرير…',
  save: 'حفظ في ملف…',
  saving: 'جارٍ الحفظ…',
  cancel: 'إلغاء',
  close: 'إغلاق',
  savedTitle: 'حُفظ التقرير',
  savedDescription: name => `حُفظ باسم ${name}. يبقى على هذا الـ Mac؛ أرفقه بمشكلة فقط إن أردت.`,
  failedTitle: 'لم يُحفظ التقرير',
  reportIssue: 'الإبلاغ عن مشكلة',
  reportIssueHint: 'يفتح مشكلة جديدة على GitHub بعنوان فقط. لا يُرسل أي شيء من التقرير؛ أرفق الملف بنفسك إن أردت.',
  issueTitle: 'تقرير مشكلة من icloneOS'
}
