import type { TranslationOverrides } from '../define-locale'

export const titlebar: TranslationOverrides['titlebar'] = {
  hideSidebar: 'إخفاء الشريط الجانبي',
  showSidebar: 'إظهار الشريط الجانبي',
  search: 'بحث',
  searchTitle: 'البحث في الجلسات والعروض والإجراءات',
  swapSidebarSides: 'تبديل جانبي الأشرطة',
  hideRightSidebar: 'إخفاء الشريط الأيمن',
  showRightSidebar: 'إظهار الشريط الأيمن',
  unreadSessions: count => (count === 1 ? 'جلسة واحدة غير مقروءة' : `${count} جلسات غير مقروءة`),
  muteHaptics: 'كتم الاهتزازات',
  unmuteHaptics: 'تفعيل الاهتزازات',
  openSettings: 'فتح الإعدادات',
  openStarmap: 'فتح خريطة الذاكرة',
  enterHud: 'وضع HUD',
  exitHud: 'إنهاء وضع HUD',
  resetHudLayout: 'إعادة تعيين حجم HUD وموضعه',
  layoutEditor: 'محرر التخطيط',
  layoutEditorTitle: modifier => `محرر التخطيط — انقر مع ${modifier} لإعادة ضبط التخطيط`
}
