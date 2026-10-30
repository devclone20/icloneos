import type { TranslationOverrides } from '../define-locale'

export const boot: TranslationOverrides['boot'] = {
  ready: 'iclone os جاهز',
  desktopBootFailedWithMessage: message => `فشل تشغيل سطح المكتب: ${message}`,
  steps: {
    connectingGateway: 'جار الاتصال ببوابة سطح المكتب',
    preparingAgentDependencies: 'جارٍ تجهيز اعتماديات الوكيل…',
    loadingSettings: 'جارٍ تحميل الإعدادات',
    loadingSessions: 'جار تحميل الجلسات الأخيرة',
    retryingRemoteBackend: 'جارٍ إعادة الاتصال بخلفية الوكيل البعيدة…',
    startingDesktopConnection: 'جار بدء اتصال سطح المكتب',
    startingHermesDesktop: 'جارٍ تشغيل iclone os...'
  },
  errors: {
    backgroundExited: 'خرجت عملية الوكيل الخلفية.',
    backgroundExitedDuringStartup: 'خرجت عملية الوكيل الخلفية أثناء بدء التشغيل.',
    backendStopped: 'توقف الخلفية',
    desktopBootFailed: 'فشل تشغيل سطح المكتب',
    gatewayConnectionLost: 'انقطع الاتصال بالبوابة',
    gatewayConnectionLostDetail:
      'Still retrying in the background. You can keep reading and drafting — open Gateway settings if this persists.',
    gatewaySignInRequired: 'تسجيل الدخول للبوابة مطلوب',
    ipcBridgeUnavailable: 'جسر IPC لسطح المكتب غير متاح.'
  },
  failure: {
    title: 'تعذّر تشغيل الوكيل',
    description: 'لم تعمل البوابة الخلفية. جرب إحدى خطوات الاسترداد أدناه. لن يحذف ذلك محادثاتك أو إعداداتك.',
    remoteTitle: 'تسجيل الدخول للبوابة البعيدة مطلوب',
    remoteDescription: 'انتهت جلسة البوابة البعيدة. سجل الدخول مرة أخرى لإعادة الاتصال.',
    retry: 'إعادة المحاولة',
    repairInstall: 'إصلاح التثبيت',
    useLocalGateway: 'استخدام البوابة المحلية',
    cloudDownTitle: 'وكيلك السحابي معطّل',
    cloudDownDescription:
      'يعيد الوكيل السحابي المُدار الذي تتصل به هذه البوابة خطأً من الخادم. لا يمكن إعادة تشغيله من هنا — تحقق من حالته، أو بدّل إلى البوابة المحلية، أو احصل على الدعم.',
    cloudDownHint: 'تفتح الأزرار أدناه Nous Portal (حالة المثيل وعناصر التحكم) أو Discord للحصول على الدعم.',
    gateTitle: 'بوابة الأذونات غير مفعّلة',
    gateDescription:
      'لم يشغّل icloneOS الوكيل: تعذّر تثبيت بوابة الأذونات أو تحميلها في بيئة تشغيل هذا الوكيل، لذلك لن يُفحص أي أمر. لا شيء هنا يحذف محادثاتك أو إعداداتك.',
    gateHint:
      'تعيد «إعادة المحاولة» فحص البوابة. يعيد «إصلاح التثبيت» تثبيت بيئة تشغيل الوكيل ثم البوابة. إذا ذكر المربع أعلاه أن البوابة معطّلة في الإعدادات، فأزل أولًا iclone-permissions وiclone-confinement من plugins.disabled في ملف config.yaml الخاص بـ Hermes، ثم أعد المحاولة.',
    gateHintUnmanaged:
      'لم يثبّت icloneOS بيئة تشغيل هذا الوكيل (مثل نسخة git الخاصة بك من Hermes)، لذلك يفحصها icloneOS فقط ولا يغيّرها أبدًا. يُعدّ «إصلاح التثبيت» نسخة icloneOS الموثّقة في مجلد التطبيق، ويبقى مجلدك كما هو.',
    cloudDownCheckPortal: 'التحقق من حالة البوابة',
    cloudDownDiscord: 'الحصول على مساعدة عبر Discord',
    openLogs: 'فتح السجلات',
    repairHint: 'يعيد الإصلاح تشغيل المثبت وقد يستغرق بضع دقائق على جهاز جديد.',
    remoteSignInHint: signInLabel =>
      `يسجّل الخروج من جلسة المتصفح البعيدة المحفوظة، ثم يفتح ${signInLabel}. استخدم البوابة المحلية للتبديل إلى الخلفية المضمنة.`,
    signOutAndSignIn: 'تسجيل الخروج وإعادة تسجيل الدخول',
    hideRecentLogs: 'إخفاء السجلات الأخيرة',
    showRecentLogs: 'إظهار السجلات الأخيرة',
    signedInTitle: 'تم تسجيل الدخول',
    signedInMessage: 'جار إعادة الاتصال بالبوابة البعيدة...',
    signInIncompleteTitle: 'تسجيل الدخول غير مكتمل',
    signInIncompleteMessage: 'أغلقت نافذة تسجيل الدخول قبل اكتمال المصادقة.',
    signInFailed: 'فشل تسجيل الدخول',
    signInToRemoteGateway: 'تسجيل الدخول للبوابة البعيدة',
    signInWithProvider: provider => `تسجيل الدخول عبر ${provider}`,
    identityProvider: 'مزود الهوية',
    gatewaySettings: 'إعدادات البوابة',
    back: 'رجوع',
    remoteFailureHint: 'تحقق من URL البوابة وتسجيل الدخول في إعدادات البوابة، أو انتقل إلى البوابة المحلية.'
  }
}
