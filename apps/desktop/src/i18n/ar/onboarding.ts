import type { TranslationOverrides } from '../define-locale'

export const onboarding: TranslationOverrides['onboarding'] = {
  headerTitle: 'لنُعِدّ لك iclone os',
  headerDesc: 'اربط مزوّد نماذج لبدء المحادثة. معظم الخيارات تتطلب نقرة واحدة.',
  preparingInstall: 'يُكمل الوكيل التثبيت. عادة ما يستغرق ذلك أقل من دقيقة في أول تشغيل.',
  starting: 'جارٍ بدء الوكيل...',
  lookingUpProviders: 'جار البحث عن المزوّدين...',
  collapse: 'طي',
  otherProviders: 'مزودون آخرون',
  haveApiKey: 'لديك مفتاح API',
  chooseLater: 'سأختار مزوّدا لاحقا',
  recommended: 'موصى به',
  connected: 'متصل',
  featuredPitch: 'اشتراك واحد، أكثر من 300 نموذج متقدم — الطريقة الموصى بها لتشغيل الوكيل',
  fireworksPitch: 'نماذج مفتوحة سريعة مع استضافة Fireworks.',
  openRouterPitch: 'مفتاح واحد لمئات النماذج — خيار افتراضي جيد',
  apiKeyOptions: {
    openrouter: {
      short: 'مفتاح واحد، نماذج كثيرة',
      description: 'يستضيف مئات النماذج خلف مفتاح واحد. خيار افتراضي جيد للتثبيتات الجديدة.'
    },
    openai: {
      short: 'نماذج من فئة GPT',
      description: 'وصول مباشر إلى نماذج OpenAI.'
    },
    gemini: {
      short: 'نماذج Gemini',
      description: 'وصول مباشر إلى نماذج Google Gemini.'
    },
    xai: {
      short: 'نماذج Grok',
      description: 'وصول مباشر إلى نماذج xAI Grok.'
    },
    local: {
      short: 'مستضاف ذاتيا',
      description: 'وجّه الوكيل إلى نقطة نهاية محلية أو مستضافة ذاتيا متوافقة مع OpenAI (vLLM، llama.cpp، Ollama، إلخ).'
    },
    fireworks: {
      short: 'API مباشر للنماذج',
      description: 'وصول مباشر إلى النماذج التي تستضيفها Fireworks AI.'
    }
  },
  backToSignIn: 'العودة إلى تسجيل الدخول',
  getKey: 'الحصول على مفتاح',
  replaceCurrent: 'استبدال القيمة الحالية',
  pasteApiKey: 'ألصق مفتاح API',
  localApiKeyPlaceholder: 'مفتاح API (اختياري — فقط إذا كانت نقطة النهاية تتطلبه)',
  couldNotSave: 'تعذر حفظ بيانات الاعتماد.',
  connecting: 'جار الاتصال',
  update: 'تحديث',
  flowSubtitles: {
    pkce: 'يفتح المتصفح لتسجيل الدخول ثم يتابع هنا',
    device_code: 'يفتح صفحة تحقق في المتصفح — يتصل الوكيل تلقائياً',
    loopback: 'يفتح المتصفح لتسجيل الدخول — يتصل الوكيل تلقائياً',
    external: 'سجل الدخول مرة واحدة في الطرفية ثم عد إلى المحادثة'
  },
  startingSignIn: provider => `جار بدء تسجيل الدخول لـ ${provider}...`,
  verifyingCode: provider => `جار التحقق من الرمز عبر ${provider}...`,
  connectedProvider: provider => `تم ربط ${provider}`,
  connectedPicking: provider => `تم ربط ${provider}. جار اختيار نموذج افتراضي...`,
  signInFailed: 'فشل تسجيل الدخول. حاول مرة أخرى.',
  pickDifferentProvider: 'اختر مزوداً آخر',
  signInWith: provider => `تسجيل الدخول عبر ${provider}`,
  openedBrowser: provider => `فتحنا ${provider} في المتصفح.`,
  authorizeThere: 'صرّح للوكيل هناك.',
  copyAuthCode: 'انسخ رمز التفويض وألصقه أدناه.',
  pasteAuthCode: 'ألصق رمز التفويض',
  reopenAuthPage: 'إعادة فتح صفحة التفويض',
  autoBrowser: provider => `فتحنا ${provider} في المتصفح. صرّح للوكيل هناك وسيتم الاتصال تلقائياً دون نسخ أو لصق.`,
  reopenSignInPage: 'إعادة فتح صفحة تسجيل الدخول',
  waitingAuthorize: 'بانتظار التفويض...',
  externalPending: provider =>
    `${provider} يسجل الدخول عبر أداة سطر الأوامر الخاصة به. شغّل هذا الأمر في الطرفية، ثم عد واختر "سجلت الدخول":`,
  signedIn: 'سجلت الدخول',
  deviceCodeOpened: provider => `فتحنا ${provider} في المتصفح. أدخل هذا الرمز هناك:`,
  reopenVerification: 'إعادة فتح صفحة التحقق',
  copy: 'نسخ',
  defaultModel: 'النموذج الافتراضي',
  freeTier: 'الطبقة المجانية',
  pro: 'مدفوع',
  free: 'مجاني',
  price: (input, output) => `${input} إدخال / ${output} إخراج لكل مليون رمز`,
  change: 'تغيير',
  startChatting: 'ابدأ',
  docs: provider => `وثائق ${provider}`
}
