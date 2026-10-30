import type { TranslationOverrides } from '../../define-locale'
import type { SettingsProfileTranslations } from '../../types/settings/profile'

export const settingsProfile: Pick<NonNullable<TranslationOverrides['settings']>, keyof SettingsProfileTranslations> = {
  credentials: {
    pasteKey: 'لصق المفتاح',
    pasteLabelKey: label => `لصق مفتاح ${label}`,
    optional: 'اختياري',
    enterValueFirst: 'أدخل قيمة أولا.',
    couldNotSave: 'تعذّر حفظ بيانات الاعتماد.',
    remove: 'إزالة',
    getKey: 'احصل على مفتاح',
    saving: 'جار الحفظ'
  },
  envActions: {
    actions: 'إجراءات',
    docs: 'الوثائق',
    hideValue: 'إخفاء القيمة',
    revealValue: 'إظهار القيمة',
    replace: 'استبدال',
    set: 'ضبط',
    manageInKeys: 'الإدارة في مفاتيح API'
  },
  keys: {
    failedLoad: 'فشل تحميل مفاتيح API',
    empty: 'لا يوجد شيء مضبوط في هذه الفئة بعد.'
  },
  providers: {
    connectAccount: 'ربط حساب',
    haveApiKey: 'لديك مفتاح API بدلاً من ذلك؟',
    intro: 'سجّل الدخول بحساب لديك بالفعل، دون مفتاح لنسخه. يُفتح تسجيل الدخول في متصفحك ويكتمل هنا.',
    connected: 'متصل',
    collapse: 'طي',
    connectAnother: 'ربط مزود آخر',
    otherProviders: 'مزودون آخرون',
    claudeSubscription: 'اشتراك Claude (يتطلب رصيد استخدام إضافيًا)',
    disconnect: 'قطع الاتصال',
    disconnectInTerminal: 'قطع الاتصال (يشغّل أمر الإزالة في الطرفية)',
    removeExternalGeneric: provider => `${provider} يُدار عبر CLI خاص به — أزله من هناك.`,
    removeKeyManaged: provider => `${provider} مُعدّ من مفتاح API. أزله من مفاتيح API.`,
    removeTerminalRunning: provider => `جار تشغيل قطع اتصال ${provider} في الطرفية…`,
    removedTitle: 'تمت إزالة الحساب',
    removedMessage: provider => `تمت إزالة ${provider}.`,
    noProviderKeys: 'لا توجد مفاتيح API متاحة للمزودين.',
    searchKeys: 'البحث عن مزوّدين...',
    noKeysMatch: 'لا يوجد مزوّدون يطابقون بحثك.',
    manage: provider => `إدارة ${provider}`,
    endpoints: {
      heading: 'خوادم النماذج الخاصة بك',
      addHeading: 'إضافة خادم',
      editHeading: 'تعديل هذا الخادم',
      name: 'الاسم الذي تطلقه على هذا الخادم',
      nameHint: 'الاسم الذي ستراه عند اختيار نموذج.',
      providerId: 'معرّف قصير لهذا الخادم',
      providerIdHint: 'أحرف صغيرة وأرقام وشرطات؛ يستخدمه التطبيق للتمييز بين الخوادم.',
      url: 'العنوان الذي يجيب منه الخادم',
      urlHint: 'عنوانه على الويب؛ عادة ما تنتهي الخوادم المتوافقة مع OpenAI بـ ‎/v1.',
      model: 'النموذج الذي يجيب به افتراضيا',
      context: 'كم من المحادثة يستطيع النموذج أن يتذكر',
      contextHint: 'اتركه على «تلقائي» وسيسأل التطبيق الخادم.',
      apiKey: 'المفتاح الذي يطلبه الخادم',
      apiKeyHint: 'فقط إذا طلب الخادم مفتاحا.',
      useForNewChats: 'ابدأ المحادثات الجديدة على هذا الخادم',
      discoverModels: 'اكتشف النماذج التي يقدمها عند اختباره',
      discoverModelsHint: 'تملأ القائمة حقل النموذج أعلاه.'
    },
    featuredPitch: 'اشتراك واحد لأكثر من 300 نموذج رائد.',
    moreFields: count => `إعدادات إضافية (${count})`,
    localEndpoint: {
      title: 'استخدم خادم نماذج خاصا بك',
      description: 'يعمل أي خادم متوافق مع OpenAI، مثل vLLM أو llama.cpp أو Ollama.',
      action: 'إعداد'
    }
  }
}
