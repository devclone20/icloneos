import type { TranslationOverrides } from '../define-locale'

export const commandCenter: TranslationOverrides['commandCenter'] = {
  close: 'إغلاق',
  paletteTitle: 'لوحة الأوامر',
  back: 'رجوع',
  searchPlaceholder: 'ابحث عن أمر أو إعداد...',
  goTo: 'انتقال إلى',
  goToSession: 'الانتقال إلى الجلسة',
  branches: 'الفروع',
  startInBranch: branch => `محادثة جديدة في ${branch}`,
  commandCenter: 'مركز الأوامر',
  appearance: 'المظهر',
  settings: 'الإعدادات',
  changeTheme: 'تغيير الثيم',
  changeColorMode: 'تغيير نمط الألوان',
  pets: {
    title: 'الحيوانات الأليفة',
    label: name => `الحيوان الأليف ${name}`,
    openApp: 'افتح التطبيق',
    popIn: 'انقر مع Shift لإعادة الحيوان الأليف',
    promptLabel: 'راسل الجلسة الحالية',
    promptPlaceholder: 'اكتب رسالة…',
    promptRefused: {
      command: 'الأوامر تُكتب في مربع الرسائل',
      noSession: 'افتح محادثة أولًا',
      notSent: 'لم تُرسَل — حاول مجددًا'
    },
    promptMaybeSent: 'ربما أُرسلت — راجع المحادثة',
    bubble: {
      run: ['يعمل…', 'على ذلك…', 'يعالج…', 'يجرّب…', 'يطبخ…', 'يوصل الأسلاك…'],
      review: ['يفكر…', 'يقرأ…', 'يراجع…', 'يتأمل…', 'يربط النقاط…', 'همم…'],
      failed: ['تعثّر', 'هذا تعطّل', 'أوه', 'علِق'],
      waiting: ['دورك', 'كلّه لك', 'إليك', 'بانتظار الأوامر']
    }
  },
  installTheme: {
    unavailable: 'البحث عن السمات في السوق متاح فقط في تطبيق سطح المكتب.',
    title: 'تثبيت سمة...',
    placeholder: 'البحث في VS Code Marketplace...',
    loading: 'جار البحث في Marketplace...',
    error: 'تعذّر الوصول إلى Marketplace.',
    empty: 'لا توجد سمات مطابقة.',
    install: 'تثبيت',
    installing: 'جار التثبيت...',
    installed: 'مثبّت',
    installs: count => `${count} عملية تثبيت`,
    pageTitle: 'تثبيت سمة'
  },
  settingsFields: 'حقول الإعدادات',
  mcpServers: 'خوادم MCP',
  archivedChats: 'المحادثات المؤرشفة',
  commands: 'الأوامر',
  sections: {
    sessions: 'الجلسات',
    system: 'النظام',
    usage: 'الاستخدام',
    maintenance: 'الصيانة'
  },
  sectionDescriptions: {
    sessions: 'البحث في الجلسات وإدارتها',
    system: 'الحالة والسجلات وإجراءات النظام',
    usage: 'نشاط الرموز والتكلفة والمهارات عبر الزمن',
    maintenance: 'التشخيص والنسخ الاحتياطية وفحص المهارات وبيانات الذاكرة'
  },
  nav: {
    newChat: {
      title: 'جلسة جديدة',
      detail: 'بدء جلسة جديدة'
    },
    settings: {
      title: 'الإعدادات',
      detail: 'تكوين iclone os'
    },
    skills: {
      title: 'المهارات والأدوات',
      detail: 'تفعيل المهارات ومجموعات الأدوات والمزوّدين'
    },
    messaging: {
      title: 'المراسلة',
      detail: 'إعداد Telegram وSlack وDiscord والمزيد'
    },
    artifacts: {
      title: 'العناصر',
      detail: 'استعراض المخرجات المولّدة'
    }
  },
  sectionEntries: {
    sessions: {
      title: 'لوحة الجلسات',
      detail: 'البحث في الجلسات وتثبيتها وإدارتها'
    },
    system: {
      title: 'لوحة النظام',
      detail: 'حالة البوابة والسجلات وإعادة التشغيل/التحديث'
    },
    usage: {
      title: 'لوحة الاستخدام',
      detail: 'نشاط الرموز والتكلفة والمهارات'
    }
  },
  providerNavigate: 'فتح المزود',
  providerSessions: 'جلسات المزود',
  refresh: 'تحديث',
  refreshing: 'جار التحديث...',
  noResults: 'لا توجد نتائج',
  pinSession: 'تثبيت الجلسة',
  unpinSession: 'إلغاء تثبيت الجلسة',
  exportSession: 'تصدير الجلسة',
  deleteSession: 'حذف الجلسة',
  noSessions: 'لا توجد جلسات',
  gatewayRunning: 'البوابة تعمل',
  gatewayStopped: 'البوابة متوقفة',
  hermesActiveSessions: (version, count) => `الوكيل ${version} · الجلسات النشطة ${count}`,
  restartGateway: 'إعادة تشغيل البوابة',
  openBrowser: 'فتح المتصفح',
  gatewayRestartFailed: 'فشل إعادة تشغيل البوابة.',
  updateHermes: 'تحديث الوكيل',
  reloadWindow: 'إعادة تحميل النافذة',
  actionRunning: 'الإجراء قيد التشغيل',
  actionDone: 'اكتمل الإجراء',
  actionFailed: 'فشل الإجراء',
  actionStartedWaiting: 'بدأ الإجراء، جار الانتظار...',
  loadingStatus: 'جار تحميل الحالة',
  recentLogs: 'السجلات الأخيرة',
  noLogs: 'لا توجد سجلات',
  days: count => `${count} يوم`,
  statSessions: 'الجلسات',
  statApiCalls: 'نداءات API',
  statTokens: 'الرموز',
  statCost: 'التكلفة',
  actualCost: cost => `التكلفة الفعلية ${cost}`,
  loadingUsage: 'جار تحميل الاستخدام',
  noUsage: period => `لا يوجد استخدام خلال ${period} يوم`,
  retry: 'إعادة المحاولة',
  dailyTokens: 'الرموز اليومية',
  input: 'إدخال',
  output: 'إخراج',
  noDailyActivity: 'لا يوجد نشاط يومي',
  topModels: 'أكثر النماذج استخداما',
  noModelUsage: 'لا يوجد استخدام نماذج',
  topSkills: 'أكثر المهارات استخداما',
  noSkillActivity: 'لا يوجد نشاط مهارات',
  actions: count => `${count} إجراء`,
  projects: 'المشاريع',
  openFolder: 'فتح مجلد كمشروع…',
  openFolderAt: path => `فتح مجلد كمشروع — ${path}`,
  newSessionInProject: project => `جلسة جديدة في ${project}`,
  logFile: 'ملف السجل',
  logLevel: 'المستوى',
  logSearchPlaceholder: 'تصفية أسطر السجل...',
  maintenance: {
    runOps: 'التشخيص',
    doctor: 'تشغيل الفحص',
    doctorDesc: 'فحص سلامة التثبيت والإعدادات والمزوّدين',
    securityAudit: 'تدقيق أمني',
    securityAuditDesc: 'فحص الإعدادات والمهارات بحثًا عن إعدادات خطرة',
    backup: 'إنشاء نسخة احتياطية',
    backupDesc: 'ضغط الإعدادات والذكريات والمهارات والجلسات في ملف zip',
    // FX-7: saved to a file the owner chooses, never uploaded.
    diagnosticsReport: 'تقرير التشخيص',
    diagnosticsReportDesc: 'احفظ تقريرًا منقّحًا والسجل الأخير في ملف تختاره. لا يُرفع أي شيء.',
    curator: 'فاحص المهارات',
    curatorDesc: 'مراجعة في الخلفية تؤرشف المهارات القديمة التي أنشأها الوكيل',
    curatorPaused: 'متوقف مؤقتًا',
    curatorActive: 'نشط',
    curatorDisabled: 'معطّل',
    curatorLastRun: when => `آخر تشغيل ${when}`,
    curatorNeverRan: 'لم يعمل بعد',
    pause: 'إيقاف مؤقت',
    resume: 'استئناف',
    runNow: 'تشغيل الآن',
    memoryData: 'بيانات الذاكرة',
    memoryDataDesc: 'ملفات الذاكرة المضمّنة التي تُضاف إلى كل جلسة',
    memoryProvider: name => `المزوّد النشط: ${name}`,
    builtinMemory: 'مضمّنة',
    memoryFile: 'ذاكرة الوكيل (MEMORY.md)',
    userFile: 'ملف المستخدم (USER.md)',
    bytes: size => size,
    empty: 'فارغ',
    resetMemory: 'إعادة ضبط الذاكرة',
    resetUser: 'إعادة ضبط الملف',
    resetAll: 'إعادة ضبط الاثنين',
    resetConfirm: target => `حذف ${target}؟ لا يمكن التراجع عن هذا.`,
    resetDone: files => `تم حذف ${files}.`,
    resetFailed: 'فشلت إعادة ضبط الذاكرة',
    actionStarted: name => `بدأ ${name} — جار متابعة السجل...`,
    actionFailed: name => `تعذّر بدء ${name}`,
    running: 'جار التشغيل...',
    viewLog: 'سجل الإجراء'
  }
}
