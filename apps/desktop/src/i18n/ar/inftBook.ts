import type { TranslationOverrides } from '../define-locale'

// K21/N5: counts in this locale's own digit grouping (5,000 not 5000); Latin digits, like the rest of the UI.
const n = (value: number): string => value.toLocaleString('ar-u-nu-latn')

export const inftBook: TranslationOverrides['inftBook'] = {
  navLabel: 'iNFT Book',
  keywords: ['inft', 'book', 'كتاب', 'محفظة', 'مجموعة', 'الرئيسية'],
  rule: 'لا تعرض الصفحة الرئيسية إلا رموز iNFT التي تحددها في iNFT Book.',
  openBook: 'افتح iNFT Book',
  wallet: address => `المحفظة ${address}`,
  count: (total, onHome) => `${n(total)} من رموز iNFT · ${n(onHome)} في الرئيسية`,
  rescan: 'إعادة الفحص',
  search: 'ابحث في رموز iNFT',
  filterCollection: 'المجموعة',
  allCollections: 'كل المجموعات',
  filterChain: 'السلسلة',
  allChains: 'كل السلاسل',
  filterState: 'عرض',
  stateAll: 'الكل',
  stateChecked: 'في الرئيسية',
  stateUnchecked: 'ليست في الرئيسية',
  checkShown: 'حدد كل المعروض',
  uncheckShown: 'ألغِ تحديد كل المعروض',
  confirmTitle: count => `هل تضع ${n(count)} من رموز iNFT في الرئيسية؟`,
  confirmBody: 'كلما طالت مجموعة الرئيسية استغرق تصفحها وقتًا أطول. يمكنك إلغاء تحديد أي منها لاحقًا.',
  confirmAction: 'حددها',
  confirmBusy: 'جارٍ التحديد…',
  confirmDone: 'تم التحديد',
  confirmError: 'تعذّر تحديدها. حاول مرة أخرى.',
  cancel: 'إلغاء',
  scanning: found => `جارٍ فحص محفظتك… عُثر على ${n(found)} حتى الآن`,
  partial: loaded => `حُمّل ${n(loaded)} من ؟ — توقف الفحص قبل نهايته.`,
  capped: limit =>
    `تُعرض أول ${n(limit)} من رموز iNFT فقط. في هذه المحفظة المزيد، ويقرأ iNFT Book ${n(limit)} كحدّ أقصى.`,
  retry: 'أعد المحاولة',
  kept: count => `أبقينا ${n(count)} في الرئيسية مما كان قبل iNFT Book.`,
  dismiss: 'إغلاق',
  noWallet: 'سجّل الدخول بمحفظتك لترى رموز iNFT التي تملكها.',
  signIn: 'تسجيل الدخول',
  none: 'لا توجد رموز iNFT في هذه المحفظة بعد.',
  noMatch: 'لا يوجد iNFT يطابق عوامل التصفية هذه.',
  scanFailed: 'فشل فحص المحفظة.',
  scanRefused: 'تم رفض فحص المحفظة.',
  showOnHome: name => `اعرض ${name} في الرئيسية`,
  setUp: 'تم الإعداد',
  setupNeeded: 'يحتاج إلى إعداد',
  homeEmpty: 'لم يُحدَّد أي iNFT للرئيسية بعد.'
}
