import type { TranslationOverrides } from '../define-locale'

export const bank: TranslationOverrides['bank'] = {
  card: {
    cardholder: 'حامل البطاقة',
    tapToFlip: 'انقر للقلب',
    spendLimit: 'حد الإنفاق',
    lastSpendLimit: 'آخر حد للإنفاق',
    spent: 'المُنفَق',
    status: 'الحالة',
    funding: 'التمويل',
    active: 'نشطة',
    locked: 'مقفلة',
    notSignedUp: 'غير مسجّلة',
    signedOut: 'تم تسجيل الخروج',
    showFront: 'إظهار وجه البطاقة',
    showBack: 'إظهار ظهر البطاقة'
  },
  gate: {
    notSetUpLabel: 'AgentCard — غير مُعدّة',
    signedOutLabel: 'AgentCard — تم تسجيل الخروج',
    signInRequiredLabel: 'AgentCard — يلزم تسجيل الدخول',
    noCardTitle: 'لا توجد بطاقة بعد',
    noCardHint: agentName =>
      `أعدّ AgentCard مرة واحدة وسيتمكن ${agentName} من الدفع مقابل مشترياته — أنت توافق على الحد، وهو يتولى الدفع.`,
    stepSignUp: 'التسجيل',
    stepSignUpHint: 'ينشئ حساب AgentCard الخاص بالوكيل.',
    stepVerify: 'التحقق',
    stepVerifyHint: 'يصل رابط تسجيل الدخول إلى صندوق بريد الوكيل نفسه.',
    stepPayment: 'طريقة الدفع',
    stepPaymentHint: 'اربط بطاقة أو محفظة لتمويله.',
    stepLimit: 'الحد',
    stepLimitHint: 'حدّد المبلغ الذي يمكنه إنفاقه دون أن يسألك.',
    openSetup: 'فتح الإعداد',
    signInRequired: 'يلزم تسجيل الدخول',
    useCardAgain: 'سجّل الدخول إلى Virtuals مرة أخرى لاستخدام البطاقة',
    readCardAgain: 'سجّل الدخول إلى Virtuals مرة أخرى لقراءة AgentCard',
    signInAgain: 'سجّل الدخول مرة أخرى',
    linkSentAgo: ago => `أُرسل ${ago}`,
    resendLink: 'إعادة إرسال الرابط',
    resendIn: seconds => `إعادة الإرسال خلال ${seconds} ث`,
    agentInbox: agentName => `صندوق بريد ${agentName}`,
    linkSentCardKnown: 'سجّل الدخول إلى AgentCard مرة أخرى — أُرسل رابط تسجيل الدخول إلى {target}',
    linkSent: 'أُرسل رابط تسجيل الدخول إلى {target} — افتح تطبيق البريد، وانقر على الرابط، ثم تابع الإعداد.',
    askFetchLink: agentName => `اطلب من ${agentName} جلب الرابط`,
    otherPath:
      'هناك طريقتان لإعداد AgentCard: الإعداد هنا لبطاقة هذا الوكيل عبر Virtuals ‏(acp card)؛ أو حسابك الخاص في AgentCard من الطرفية — نفّذ agentcard signup، ثم agentcard setup و agentcard identity للتحقق من الهوية (KYC). هما حسابان منفصلان.',
    agentcardAccount: {
      signedOut: 'حسابك الخاص في AgentCard غير مسجَّل الدخول.',
      kycRequired: 'حسابك الخاص في AgentCard يحتاج إلى التحقق من الهوية (KYC).',
      ready: 'حسابك الخاص في AgentCard جاهز.'
    },
    linkNotRecorded: 'لم يُرسل شيء — تعذّر حفظ السجل قبل الإرسال'
  },
  notice: {
    tryAgain: 'أعد المحاولة'
  },
  account: {
    label: 'الحساب',
    unavailable: reason => `الملف الشخصي غير متاح — ${reason}`,
    onFileHidden: 'الملف الشخصي مسجّل — التفاصيل غير معروضة.',
    noName: 'لا يوجد اسم بعد',
    noPhone: 'لا يوجد هاتف بعد',
    needsNamePhone: 'يحتاج AgentCard إلى اسم ورقم هاتف قبل الدفع.',
    changeInSetup: 'التغيير في الإعداد'
  },
  stats: {
    reading: 'جارٍ القراءة…',
    notSet: 'لم يُحدَّد بعد',
    limitLeft: (left, total) => `متبقٍّ ${left} من ${total}`,
    openRequests: 'الطلبات المفتوحة',
    reviewFirst: 'راجع الأول',
    nothingWaiting: 'لا شيء في الانتظار',
    codesWaiting: 'رموز 3DS المنتظرة',
    codesLive: 'نشطة — دقائق متبقية'
  },
  toolbar: {
    changeLimit: 'تغيير الحد',
    issueCard: 'إصدار بطاقة لعملية شراء',
    readOnly: agentName => `AgentCard · للقراءة فقط — الإصدار يتم عبر ${agentName}`
  },
  requests: {
    title: 'طلبات الإنفاق',
    tabOpen: 'مفتوحة',
    tabAll: 'الكل',
    showAll: 'إظهار الكل',
    nothingOpenTitle: 'لا شيء مفتوح',
    nothingOpenHint: agentName => `تمت تسوية كل ما طلبه ${agentName} — لا شيء ينتظرك.`,
    emptyTitle: 'لا توجد طلبات إنفاق بعد',
    emptyHint: (agentName, action) =>
      `عندما يدفع ${agentName} مقابل شيء ما، يظهر طلبه هنا. ابدأ واحدًا عبر «${action}».`,
    colRequest: 'الطلب',
    colCaptured: 'المُحصَّل',
    colStatus: 'الحالة',
    colIssued: 'الإصدار',
    colExpires: 'الانتهاء',
    expires: ago => `ينتهي ${ago}`,
    updated: ago => `حُدِّث ${ago}`
  },
  detail: {
    title: 'طلب إنفاق',
    close: 'إغلاق الطلب',
    request: 'الطلب',
    amount: 'المبلغ',
    status: 'الحالة',
    created: 'الإنشاء',
    issued: 'الإصدار',
    captured: 'المُحصَّل',
    capturedAt: 'وقت التحصيل',
    expires: 'الانتهاء',
    card: 'البطاقة'
  },
  codes: {
    title: 'رموز 3DS',
    active: count => `${count} نشطة`,
    none: 'لا توجد رموز 3DS الآن — يظهر الرمز هنا لنحو خمس دقائق بعد أن يبدأ وكيلك عملية دفع.',
    left: time => `متبقٍّ ${time}`,
    expired: 'منتهية',
    amountNotGiven: 'المبلغ غير محدد'
  },
  checking: 'جارٍ التحقق من البطاقة…',
  agentFallback: 'وكيلك'
}
