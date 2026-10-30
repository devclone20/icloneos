import type { TranslationOverrides } from '../define-locale'

export const ui: TranslationOverrides['ui'] = {
  search: {
    clear: 'مسح البحث'
  },
  pagination: {
    label: 'ترقيم الصفحات',
    previous: 'السابق',
    previousAria: 'الصفحة السابقة',
    next: 'التالي',
    nextAria: 'الصفحة التالية'
  },
  sidebar: {
    title: 'الشريط الجانبي',
    description: 'تنقل التطبيق',
    toggle: open => `${open ? 'إظهار' : 'إخفاء'} الشريط الجانبي`
  }
}
