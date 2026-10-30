import type { TranslationOverrides } from '../define-locale'

export const assistant: TranslationOverrides['assistant'] = {
  thread: {
    loadingSession: 'جار تحميل الجلسة...',
    showEarlier: 'عرض الرسائل الأقدم',
    loadingResponse: 'الوكيل يحمّل ردًا',
    resumeWhenBackgroundDone: count =>
      count === 1 ? 'سيُستأنف عند انتهاء المهمة الخلفية' : `سيُستأنف عند انتهاء ${count} مهام خلفية`,
    thinking: 'يفكر...',
    thought: 'فكّر',
    thoughtBriefly: 'فكّر قليلاً',
    thoughtFor: duration => `فكّر لمدة ${duration}`,
    turnDuration: duration => `استغرقت هذه الجولة ${duration}`,
    today: time => `اليوم ${time}`,
    yesterday: time => `أمس ${time}`,
    copy: 'نسخ',
    refresh: 'تحديث',
    moreActions: 'إجراءات إضافية',
    branchNewChat: 'تفريع إلى محادثة جديدة',
    react: 'تفاعل',
    dismissError: 'تجاهل الخطأ',
    errorLayers: {
      auth: 'خطأ في المصادقة',
      billing: 'نفاد الرصيد',
      disk: 'القرص ممتلئ',
      endpoint: 'خطأ في نقطة النهاية المخصصة',
      gateway: 'خطأ في البوابة',
      generic: 'فشلت الجولة',
      provider: 'خطأ من المزوّد',
      runtime: 'خطأ في بيئة التشغيل المحلية',
      streaming: 'خطأ في اتصال البث'
    },
    errorRetry: 'إعادة المحاولة',
    errorSwitchProvider: 'تبديل المزوّد',
    errorOpenLogs: 'فتح السجلات',
    errorOpenLogsFailed: 'تعذّر فتح مجلد السجلات',
    errorOpenDesktopLogs: 'فتح سجلات سطح المكتب',
    errorCopyDiagnostics: 'نسخ تفاصيل الخطأ',
    errorSendDiagnostics: 'حفظ التشخيصات',
    filesChanged: count => `${count} ملفات تم تغييرها`,
    readAloudFailed: 'فشلت القراءة بصوت عال',
    preparingAudio: 'جار تجهيز الصوت',
    stopReading: 'إيقاف القراءة',
    readAloud: 'قراءة بصوت عال',
    editMessage: 'تحرير الرسالة',
    scrollToBottom: 'التمرير إلى الأسفل',
    stop: 'إيقاف',
    restorePrevious: 'استعادة السابق',
    restoreCheckpoint: 'استعادة النقطة',
    restoreFromHere: 'استعادة نقطة التحقق — إعادة التشغيل من هذا الموجّه',
    restoreTitle: 'الاستعادة إلى نقطة التحقق هذه؟',
    restoreBody: 'يُزال كل ما يلي هذا الموجّه من المحادثة، ويُعاد تشغيل الموجّه من هنا.',
    restoreConfirm: 'استعادة وإعادة تشغيل',
    restoreNext: 'استعادة التالي',
    goForward: 'تقدم',
    sendEdited: 'إرسال التعديل',
    attachingFile: 'جار إرفاق الملف',
    expandMessage: 'توسيع الرسالة'
  },
  approval: {
    command: 'الأمر',
    jumpToApproval: 'الموافقة مطلوبة'
  },
  clarify: {
    notReady: 'غير جاهز',
    gatewayDisconnected: 'بوابة الوكيل غير متصلة',
    sendFailed: 'فشل الإرسال',
    loadingQuestion: 'جار تحميل السؤال...',
    other: 'غير ذلك',
    placeholder: 'اكتب إجابتك...',
    skip: 'تخطي',
    continueLabel: 'متابعة',
    confirmAndContinueLabel: 'تأكيد ومتابعة',
    answeredBadge: 'تمت الإجابة',
    questionProgress: (answered, total) => `تمت الإجابة على ${answered} من ${total}`,
    skipped: 'تم التخطي',
    lateAnswer: (question, choice) => `بخصوص: «${question}» — إجابتي: ${choice}`,
    lateAnswerTip: 'صياغة هذه الإجابة كرسالة متابعة',
    lateAnswerHint: 'لم يعد هذا السؤال بانتظار إجابة. اختر خيارًا لصياغته كرسالة متابعة.'
  },
  tool: {
    copyCode: 'نسخ الكود',
    renderingImage: 'جار عرض الصورة...',
    copyOutput: 'نسخ الإخراج',
    copyCommand: 'نسخ الأمر',
    copyContent: 'نسخ المحتوى',
    copyUrl: 'نسخ الرابط',
    copyResults: 'نسخ النتائج',
    copyQuery: 'نسخ الاستعلام',
    copyFile: 'نسخ الملف',
    copyPath: 'نسخ المسار',
    outputAlt: 'إخراج الأداة',
    rawResponse: 'الرد الخام',
    copyActivity: 'نسخ النشاط',
    recoveredOne: 'تم الاسترداد',
    recoveredMany: count => `تم استرداد ${count}`,
    failedOne: 'فشل',
    failedMany: count => `فشل ${count}`,
    statusRunning: 'يعمل',
    statusError: 'خطأ',
    statusRecovered: 'تم الاسترداد',
    statusDone: 'تم',
    memoryWriteNoted: 'تم تسجيل كتابة الذاكرة',
    actions: {
      read: 'قراءة',
      reading: 'جار القراءة',
      opened: 'تم الفتح',
      opening: 'جار الفتح',
      searched: 'تم البحث',
      searching: 'جار البحث',
      ran: 'تم التشغيل',
      running: 'جار التشغيل',
      ranCode: 'تم تشغيل الكود',
      runningCode: 'جار البرمجة',
      failedToOpen: 'تعذّر الفتح'
    },
    prefixes: {
      browser: 'المتصفح',
      web: 'الويب'
    },
    titleTemplates: {
      actionCommand: (action, command) => `${action} ${command}`,
      actionQuoted: (action, value) => `${action} “${value}”`,
      actionTarget: (action, target) => `${action} ${target}`,
      prefixedDone: (prefix, action) => `${prefix} ${action}`,
      runningPrefixedTool: (prefix, action) => `جار تشغيل ${prefix.toLowerCase()} ${action.toLowerCase()}`,
      runningTool: action => `جار تشغيل ${action.toLowerCase()}`
    },
    titles: {
      browser_click: {
        done: 'تم النقر على عنصر الصفحة',
        pending: 'جار النقر على عنصر الصفحة',
        pendingAction: 'جار النقر'
      },
      browser_fill: {
        done: 'تم ملء حقل النموذج',
        pending: 'جار ملء حقل النموذج',
        pendingAction: 'جار الملء'
      },
      browser_navigate: {
        done: 'تم فتح الصفحة',
        pending: 'جار فتح الصفحة',
        pendingAction: 'جار الفتح'
      },
      browser_snapshot: {
        done: 'تم التقاط لقطة الصفحة',
        pending: 'جار التقاط لقطة الصفحة',
        pendingAction: 'جار الالتقاط'
      },
      browser_take_screenshot: {
        done: 'تم التقاط لقطة الشاشة',
        pending: 'جار التقاط لقطة الشاشة',
        pendingAction: 'جار الالتقاط'
      },
      browser_type: {
        done: 'تمت الكتابة على الصفحة',
        pending: 'جار الكتابة على الصفحة',
        pendingAction: 'جار الكتابة'
      },
      clarify: {
        done: 'تم طرح سؤال',
        pending: 'جار طرح سؤال',
        pendingAction: 'جار السؤال'
      },
      cronjob: {
        done: 'مهمة مجدولة',
        pending: 'جار جدولة المهمة',
        pendingAction: 'جار الجدولة'
      },
      edit_file: {
        done: 'تم تحرير الملف',
        pending: 'جار تحرير الملف',
        pendingAction: 'جار التحرير'
      },
      execute_code: {
        done: 'تم تشغيل الكود',
        pending: 'جار البرمجة',
        pendingAction: 'جار البرمجة'
      },
      image_generate: {
        done: 'تم إنشاء الصورة',
        pending: 'جار إنشاء الصورة',
        pendingAction: 'جار الإنشاء'
      },
      list_files: {
        done: 'تم سرد الملفات',
        pending: 'جار سرد الملفات',
        pendingAction: 'جار السرد'
      },
      memory: {
        done: 'تم الحفظ في الذاكرة',
        pending: 'جار الحفظ في الذاكرة',
        pendingAction: 'جار الحفظ'
      },
      patch: {
        done: 'تم تصحيح الملف',
        pending: 'جار تصحيح الملف',
        pendingAction: 'جار التصحيح'
      },
      read_file: {
        done: 'تمت قراءة الملف',
        pending: 'جار قراءة الملف',
        pendingAction: 'جار القراءة'
      },
      search_files: {
        done: 'تم البحث في الملفات',
        pending: 'جار البحث في الملفات',
        pendingAction: 'جار البحث'
      },
      session_search_recall: {
        done: 'تم البحث في سجل الجلسة',
        pending: 'جار البحث في سجل الجلسة',
        pendingAction: 'جار البحث'
      },
      terminal: {
        done: 'تم تشغيل الأمر',
        pending: 'جار تشغيل الأمر',
        pendingAction: 'جار التشغيل'
      },
      todo: {
        done: 'تم تحديث المهام',
        pending: 'جار تحديث المهام',
        pendingAction: 'جار التحديث'
      },
      vision_analyze: {
        done: 'تم تحليل الصورة',
        pending: 'جار تحليل الصورة',
        pendingAction: 'جار التحليل'
      },
      web_extract: {
        done: 'تمت قراءة صفحة الويب',
        pending: 'جار قراءة صفحة الويب',
        pendingAction: 'جار القراءة'
      },
      web_search: {
        done: 'تم البحث في الويب',
        pending: 'جار البحث في الويب',
        pendingAction: 'جار البحث'
      },
      write_file: {
        done: 'تم تحرير الملف',
        pending: 'جار تحرير الملف',
        pendingAction: 'جار التحرير'
      }
    }
  },
  mcpSetup: {
    installTitle: server => `إضافة خادم MCP ‏${server}؟`,
    enableTitle: server => `تفعيل خادم MCP ‏${server}؟`,
    authorizeTitle: server => `تخويل خادم MCP ‏${server}؟`,
    installAction: 'تثبيت',
    enableAction: 'تفعيل',
    authorizeAction: 'تخويل',
    decline: 'ليس الآن',
    declined: 'مرفوض',
    installed: server => `تم تثبيت ${server}`,
    enabled: server => `تم تفعيل ${server}`,
    authorized: server => `تم تخويل ${server}`,
    failed: server => `فشل إعداد ${server}`,
    unanswered: 'لا يوجد رد',
    toolCount: count => (count === 1 ? 'أداة واحدة' : `${count} أدوات`),
    notInCatalog: server => `«${server}» غير موجود في كتالوج MCP`,
    catalogSource: 'من الكتالوج المعتمد',
    envRequired: 'املأ بيانات الاعتماد المطلوبة أولًا',
    sendFailed: 'تعذّر إرسال رد إعداد MCP',
    reloadFailed: 'تم حفظ الخادم، لكن فشلت إعادة تحميل أدوات MCP — ستُحمَّل في الجلسة التالية',
    gatewayDisconnected: 'بوابة الوكيل غير متصلة'
  }
}
