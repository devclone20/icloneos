import type { TranslationOverrides } from '../define-locale'

export const contextMenu: TranslationOverrides['contextMenu'] = {
  title: 'قائمة السياق',
  link: {
    openInApp: 'فتح في متصفح التطبيق',
    openExternal: 'فتح في المتصفح الخارجي',
    copyUrl: 'نسخ الرابط',
    copyResolvedUrl: 'نسخ الرابط المُحلَّل'
  },
  image: {
    copyImage: 'نسخ الصورة',
    copyImageAddress: 'نسخ عنوان الصورة',
    saveImageAs: 'حفظ الصورة باسم…'
  },
  edit: {
    cut: 'قص',
    paste: 'لصق',
    selectAll: 'تحديد الكل',
    addToDictionary: 'إضافة إلى القاموس'
  },
  page: {
    copyPageUrl: 'نسخ رابط الصفحة',
    inspectElement: 'فحص العنصر'
  }
}
