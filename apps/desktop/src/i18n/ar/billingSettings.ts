/** The words of the Billing Settings pane (front I-C, 2026-10-20). */
import type { BillingSettingsCopy } from '../en/billingSettings'

export const arBillingSettings: BillingSettingsCopy = {
  sections: {
    plan: 'خطتك',
    payment: 'طريقة الدفع ورصيدك',
    usage: 'ما لديك وما تنفقه',
    invoices: 'الفواتير'
  },
  providerBilling: {
    title: 'تتم الفوترة لدى مزوّد النماذج الذي ربطته',
    hint: 'يعمل هذا التطبيق بالمفاتيح التي أضفتها، لذا يبقى الاستخدام والتكاليف لدى ذلك المزوّد. يظهر اشتراك Nous Portal وخطته واستخدامه هنا بعد تسجيل الدخول إليه.',
    openProviders: 'افتح المزوّدين'
  },
  empty: {
    title: 'لا يوجد ما يُفوتَر في هذا الاتصال',
    hint: 'تتبع الفوترة حسابًا تستضيفه Nous Portal. يعمل هذا التطبيق بمفاتيحك الخاصة، فلا يوجد هنا ما يُقاس أو يُحتسب؛ يبقى الاستخدام والتكاليف لدى مزوّد النموذج.'
  },
  summary: {
    balance: 'الرصيد',
    plan: 'الخطة',
    refill: 'إعادة الشحن التلقائي',
    enabled: 'مفعّل',
    off: 'متوقف'
  },
  notice: {
    openPortal: 'فتح البوابة ↗',
    noCardTitle: 'لا توجد طريقة دفع مسجلة',
    noCardMessage: 'يبقى شراء الرصيد وإعادة الشحن التلقائي معطلين حتى تُسجَّل بطاقة. أضف واحدة من البوابة.',
    addCard: 'إضافة بطاقة ↗'
  },
  payment: {
    title: 'البطاقة التي تدفع بها',
    hint: 'تُستخدم لإعادة الشحن وتجديد الاشتراك.',
    noneHint: 'لم تُسجَّل أي بطاقة بعد.',
    add: 'إضافة طريقة دفع',
    update: 'تحديث'
  },
  buy: {
    title: 'اشترِ رصيدًا الآن',
    hint: 'خصم واحد من بطاقتك يُضاف إلى رصيدك اليوم.',
    action: 'شراء',
    customAmount: 'مبلغ رصيد مخصص'
  },
  refill: {
    title: 'أعد الشحن تلقائيًا عندما ينخفض رصيدك',
    generic: 'حافظ على رصيدك عندما ينخفض تحت الحد.',
    manage: 'إدارة',
    manageOnPortal: 'أدِر إعادة الشحن التلقائي من البوابة.',
    turnOnPortal: 'فعّل إعادة الشحن التلقائي من البوابة',
    reconcile: 'مطابقة ↗',
    differentCard: 'بطاقة أخرى',
    threshold: 'حد إعادة الشحن التلقائي',
    reloadTo: 'مبلغ إعادة الشحن التلقائي',
    distinctCaption: (card: string) => `تُحتسب إعادة الشحن التلقائي على ${card} — طابِق من البوابة`,
    charges: (reloadTo: string, threshold: string) => `يُحتسب ${reloadTo} تلقائيًا عندما ينخفض رصيدك تحت ${threshold}.`
  },
  plan: {
    currentTitle: (tier: string) => `أنت على خطة ${tier}`,
    free: 'مجاني',
    unavailable: 'تفاصيل الاشتراك غير متاحة؛ لا يزال بإمكانك فتح البوابة.',
    noSubscription: 'لا يوجد اشتراك نشط — تستهلك النماذج المدفوعة رصيد الشحن.',
    change: 'تغيير الخطة',
    view: 'عرض الخطط',
    adjust: 'تعديل الخطة ↗',
    choose: 'اختيار ↗',
    back: 'العودة إلى الفوترة',
    changesTo: (tier: string, when: string) => `تتغير إلى ${tier} في ${when}.`,
    cancels: (when: string) => `يُلغى في ${when}.`,
    renews: (date: string) => `يتجدد في ${date}`
  },
  usage: {
    left: (left: string, total: string) => `تبقى ${left} من ${total}`,
    over: (amount: string) => `تجاوز بمقدار ${amount}`,
    used: (spent: string, limit: string) => `استُخدم ${spent} من ${limit}`,
    subscriptionRemaining: 'رصيد الاشتراك المتبقي',
    subscription: 'الرصيد المتبقي من اشتراكك',
    noExpiry: 'لا تنتهي صلاحيته أبدًا.',
    topup: 'الرصيد الذي اشتريته بنفسك',
    capUsed: 'المستخدم من سقف الإنفاق الشهري',
    defaultCeiling: 'هذا هو الحد الافتراضي لحسابك.',
    monthlyRemote: 'يحسب ما تنفقه من هذا التطبيق كل شهر.',
    cap: 'ما أنفقته من حدك الشهري',
    resets: (date: string) => `يُعاد الضبط في ${date}`
  },
  header: 'الفوترة',
  actions: {
    save: 'حفظ',
    saving: 'جارٍ الحفظ…',
    cancel: 'إلغاء',
    undo: 'تراجع',
    undoing: 'جارٍ التراجع…',
    tryAgain: 'حاول مرة أخرى',
    dismiss: 'إغلاق',
    openPortal: 'افتح البوابة',
    verify: 'تحقّق للمتابعة',
    openVerification: 'افتح صفحة التحقق',
    turnOff: 'إيقاف'
  },
  status: {
    processing: 'جارٍ معالجة الدفعة…',
    added: (amount: string) => `تمت إضافة ${amount}. يجري تحديث رصيدك.`,
    waitingLink: 'بانتظار رابط التحقق…'
  },
  autoRefill: {
    thresholdShort: 'عند النزول تحت',
    reloadToShort: 'اشحن حتى',
    confirmOff: 'هل تريد إيقاف الشحن التلقائي؟',
    updated: 'تم تحديث الشحن التلقائي.',
    turnedOff: 'تم إيقاف الشحن التلقائي.',
    thresholdName: 'الحد الأدنى',
    reloadToName: 'مبلغ الشحن',
    badFormat: (name: string) => `يحتاج ${name} إلى مبلغ بالدولار بخانتين عشريتين على الأكثر.`,
    notPositive: (name: string) => `يجب أن يكون ${name} أكبر من $0.`,
    belowMin: (name: string, min: string) => `يجب ألا يقل ${name} عن ${min}.`,
    aboveMax: (name: string, max: string) => `يجب ألا يزيد ${name} عن ${max}.`,
    order: 'يجب أن يكون مبلغ الشحن أعلى من الحد الأدنى.'
  },
  provenance: {
    autoRefill: 'مستخدمة للشحن التلقائي',
    customerDefault: 'بطاقتك الافتراضية',
    subPin: 'مستخدمة لاشتراكك'
  },
  plans: {
    titleUpgrade: (tier: string) => `الترقية إلى خطة ${tier}`,
    titleDowngrade: (tier: string) => `الانتقال إلى خطة ${tier} الأدنى`,
    titleScheduled: (tier: string) => `ستنتقل إلى خطة ${tier} عند نهاية هذه الفترة`,
    title: 'الخطط',
    empty: 'لا توجد خطة أخرى متاحة الآن.',
    current: 'الخطة الحالية',
    scheduled: 'مجدولة',
    downgrade: 'خفض الخطة',
    checking: 'جارٍ التحقق من هذا التغيير…',
    blocked: 'لا يمكن إجراء هذا التغيير هنا.',
    noOp: (tier: string) => `أنت على ${tier} بالفعل، فلا شيء لتغييره.`,
    scheduledChange: (tier: string, when: string) =>
      `ستنتقل إلى ${tier} في ${when}. لن يُخصم شيء الآن، وتبقى على خطتك الحالية حتى ذلك الحين.`,
    creditsChange: (delta: string) => `يتغير رصيدك الشهري بمقدار ${delta}.`,
    cannotSchedule: 'لا يمكن جدولة هذا التغيير هنا.',
    confirm: 'تأكيد خفض الخطة',
    scheduling: 'جارٍ الجدولة…',
    perMonth: (amount: string) => `${amount} شهريًا`,
    creditsPerMonth: (amount: string) => `رصيد بقيمة ${amount} كل شهر`
  },
  refusal: {
    consentTitle: 'أكّد هذه البطاقة في البوابة',
    consentMessage: 'تحتاج البوابة إلى موافقتك قبل أن يخصم هذا التطبيق من البطاقة.',
    scopeTitle: 'اسمح لهذا الجهاز بالإنفاق أولًا',
    scopeMessage: 'ابدأ عملية شحن للسماح بالإنفاق من هذا الجهاز، ثم حاول مرة أخرى.',
    stoppedTitle: 'تم إيقاف الإنفاق من هذا الجهاز',
    stoppedByAdmin: 'أوقف أحد المسؤولين الإنفاق من هذا الجهاز. سجّل الدخول مجددًا للسماح به.',
    stoppedByYou: 'أوقفت الإنفاق من هذا الجهاز. سجّل الدخول مجددًا للسماح به.',
    sessionTitle: 'تم تسجيل خروجك',
    sessionMessage: 'سجّل الدخول مجددًا لمواصلة استخدام الفوترة.',
    disabledTitle: 'الإنفاق من هذا التطبيق متوقف',
    disabledMessage: 'يمكن لمسؤول الفوترة تشغيله من البوابة.',
    roleTitle: 'لا يضيف الأموال إلا مسؤول',
    roleMessage: 'اطلب ذلك من مسؤول أو مالك مؤسستك، أو أدر الفوترة من البوابة.',
    conflictTitle: 'ابدأ عملية شحن جديدة',
    conflictMessage: 'استُخدمت عملية الشحن هذه بمبلغ مختلف. ابدأ عملية جديدة.',
    noCardTitle: 'احفظ بطاقة في البوابة أولًا',
    noCardMessage: 'شراء الرصيد مرة واحدة لا يحفظ بطاقة قابلة لإعادة الاستخدام. أضف واحدة من البوابة.',
    orgTitle: 'لا يمكنك إدارة هذه المؤسسة',
    orgMessage: 'تسجيل الدخول هذا غير مرتبط بمؤسسة تديرها.',
    capTitle: 'بلغت حد الإنفاق الشهري',
    capMessage: 'ارفع الحد من البوابة، أو انتظر حتى تتم إعادة تعيينه.',
    capRemaining: (amount: string) => `يتبقى ${amount} ضمن حدك الشهري.`,
    busyTitle: 'عمليات خصم كثيرة في الوقت نفسه',
    busyMessage: 'هذا ليس فشلًا في الدفع. انتظر قليلًا ثم حاول مرة أخرى.',
    retryIn: (minutes: number) => `حاول مرة أخرى بعد نحو ${minutes} دقيقة.`,
    paymentServiceTitle: 'تواجه خدمة الدفع مشكلة',
    paymentServiceMessage: 'انتظر قليلًا ثم حاول مرة أخرى.',
    planLimitTitle: 'غيّرت الخطة مرات كثيرة اليوم',
    planLimitMessage: 'حاول مرة أخرى غدًا.',
    unavailableTitle: 'الفوترة غير متاحة هنا',
    unavailableMessage: 'هذا الاتصال لا يوفر الفوترة. حاول لاحقًا.',
    timeoutTitle: 'استغرقت الفوترة وقتًا طويلًا للرد',
    timeoutMessage: 'تحقق من اتصالك ثم حاول مرة أخرى.',
    offlineTitle: 'تعذّر الوصول إلى الفوترة',
    offlineMessage: 'تحقق من اتصالك ثم حاول مرة أخرى.',
    failedTitle: 'تعذّر على الفوترة إتمام هذا الطلب',
    failedMessage: 'حاول مرة أخرى بعد قليل.'
  },
  charge: {
    added: (amount: string) => `تمت إضافة ${amount} إلى رصيدك.`,
    addedGeneric: 'تمت إضافة الرصيد إلى حسابك.',
    failedTitle: 'لم تنجح عملية الدفع',
    bankCheck: 'يحتاج مصرفك إلى التحقق من هذه الدفعة. أكملها من البوابة.',
    expired: 'انتهت صلاحية بطاقتك. حدّثها من البوابة.',
    declined: 'رُفضت بطاقتك. جرّب بطاقة أخرى من البوابة.',
    failedGeneric: 'حاول مرة أخرى، أو استخدم بطاقة أخرى من البوابة.',
    unconfirmedTitle: 'لم تُؤكَّد دفعتك الأخيرة بعد',
    unconfirmed: 'تحقق من رصيدك في البوابة قبل المحاولة مجددًا.',
    checkFailedTitle: 'تعذّر التحقق من الدفعة',
    untrackedTitle: 'لا يمكن تتبع هذه الدفعة',
    untrackedMessage: 'قُبلت الدفعة لكن لا يمكن تتبعها. تحقق من رصيدك في البوابة.',
    slowTitle: 'الدفعة ما زالت قيد المعالجة',
    slowMessage: 'قد تنجح لاحقًا. راجع البوابة قبل المحاولة مجددًا.'
  },
  stepUp: {
    deniedTitle: 'لم تتم الموافقة على التحقق',
    deniedMessage: 'ما زال الإنفاق من هذا الجهاز غير مسموح.',
    doneTitle: 'اكتمل التحقق',
    doneMessage: 'يمكن لهذا الجهاز الآن الإنفاق من حسابك.'
  },
  devFixture: 'بيانات معاينة الفوترة (للتطوير فقط)'
}
