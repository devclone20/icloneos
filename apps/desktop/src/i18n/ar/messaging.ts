import type { TranslationOverrides } from '../define-locale'

export const messaging: TranslationOverrides['messaging'] = {
  search: 'بحث',
  loading: 'جار التحميل...',
  loadFailed: 'فشل التحميل',
  states: {
    connected: 'متصل',
    connecting: 'جار الاتصال',
    disabled: 'معطّل',
    fatal: 'خطأ',
    gateway_stopped: 'خدمة المراسلة متوقفة',
    not_configured: 'يحتاج إعدادا',
    pending_restart: 'يلزم إعادة التشغيل',
    retrying: 'جار إعادة المحاولة',
    startup_failed: 'فشل بدء التشغيل'
  },
  unknown: 'غير معروف',
  hintPendingRestart: 'أعد تشغيل خدمة المراسلة من شريط الحالة لتطبيق هذا التغيير.',
  hintGatewayStopped: 'شغّل خدمة المراسلة من شريط الحالة للاتصال.',
  credentialsSet: 'بيانات الاعتماد مضبوطة',
  needsSetup: 'يحتاج إعدادا',
  gatewayStopped: 'خدمة المراسلة متوقفة',
  getCredentials: 'احصل على بيانات تسجيل الدخول',
  openSetupGuide: 'فتح دليل الإعداد',
  required: 'ما يلزم للاتصال',
  recommended: 'ما يُستحسن ضبطه',
  advanced: count => `${count} إعدادات متقدمة`,
  noTokenNeeded: 'لا يحتاج رمز',
  enabled: 'مفعل',
  disabled: 'معطل',
  unsavedChanges: 'تغييرات غير محفوظة',
  saving: 'جار الحفظ...',
  saveChanges: 'حفظ التغييرات',
  saved: 'تم الحفظ',
  replaceValue: 'استبدال القيمة',
  openDocs: 'فتح الوثائق',
  clearField: key => `مسح ${key}`,
  enableAria: name => `تفعيل ${name}`,
  disableAria: name => `تعطيل ${name}`,
  platformEnabled: name => `تم تفعيل ${name}`,
  platformDisabled: name => `تم تعطيل ${name}`,
  restartToApply: 'يسري هذا التغيير بعد إعادة تشغيل خدمة المراسلة.',
  setupSaved: name => `تم حفظ إعداد ${name}`,
  restartToReconnect: 'تسري بيانات تسجيل الدخول الجديدة بعد إعادة تشغيل خدمة المراسلة.',
  keyCleared: key => `تم مسح ${key}`,
  setupUpdated: name => `تم تحديث إعداد ${name}`,
  failedUpdate: name => `فشل تحديث ${name}`,
  failedSave: name => `فشل حفظ ${name}`,
  failedClear: key => `فشل مسح ${key}`,
  fieldFallbackLabel: 'املأ هذا الإعداد',
  fieldFallbackName: 'هذا الإعداد',
  fieldCopy: {
    TELEGRAM_BOT_TOKEN: {
      label: 'الصق رمز البوت',
      name: 'رمز البوت (token)',
      help: 'أنشئ بوتا عبر @BotFather، ثم الصق الرمز الذي يمنحك إياه.',
      placeholder: 'الصق رمز بوت Telegram'
    },
    TELEGRAM_ALLOWED_USERS: {
      label: 'اختر من يمكنه التحدث إلى وكيلك',
      name: 'معرّفات مستخدمي Telegram المسموح بهم',
      help: 'موصى به. معرّفات رقمية مفصولة بفواصل من @userinfobot. بدون ذلك، يمكن لأي شخص مراسلة بوتك مباشرة.'
    },
    TELEGRAM_PROXY: {
      label: 'أدخل رابط الـ Proxy',
      name: 'رابط الـ Proxy',
      help: 'مطلوب فقط على الشبكات التي يكون فيها Telegram محجوبا.'
    },
    DISCORD_BOT_TOKEN: {
      label: 'الصق رمز البوت',
      name: 'رمز البوت (token)',
      help: 'أنشئ تطبيقا في Discord Developer Portal، وأضف بوتا، ثم الصق رمزه.'
    },
    DISCORD_ALLOWED_USERS: {
      label: 'اختر من يمكنه التحدث إلى وكيلك',
      name: 'معرّفات مستخدمي Discord المسموح بهم',
      help: 'موصى به. معرّفات مستخدمي Discord مفصولة بفواصل.'
    },
    DISCORD_REPLY_TO_MODE: {
      label: 'اختر نمط الرد',
      name: 'نمط الرد',
      help: 'first أو all أو off.'
    },
    DISCORD_ALLOW_ALL_USERS: {
      label: 'السماح لكل مستخدمي Discord',
      name: 'السماح لكل مستخدمي Discord',
      help: 'للتطوير فقط. عند التفعيل، يمكن لأي شخص مراسلة البوت مباشرة دون قائمة سماح.'
    },
    DISCORD_HOME_CHANNEL: {
      label: 'أدخل معرّف القناة الرئيسية',
      name: 'معرّف القناة الرئيسية',
      help: 'القناة التي يرسل فيها البوت الرسائل الاستباقية (مخرجات cron، التذكيرات).'
    },
    DISCORD_HOME_CHANNEL_NAME: {
      label: 'أدخل اسم القناة الرئيسية',
      name: 'اسم القناة الرئيسية',
      help: 'الاسم المعروض للقناة الرئيسية في السجلات ومخرجات الحالة.'
    },
    BLUEBUBBLES_ALLOW_ALL_USERS: {
      label: 'السماح لكل مستخدمي iMessage',
      name: 'السماح لكل مستخدمي iMessage',
      help: 'عند التفعيل، يتم تخطي قائمة سماح BlueBubbles.'
    },
    MATTERMOST_ALLOW_ALL_USERS: {
      label: 'السماح لكل مستخدمي Mattermost',
      name: 'السماح لكل مستخدمي Mattermost'
    },
    MATTERMOST_HOME_CHANNEL: {
      label: 'أدخل القناة الرئيسية',
      name: 'القناة الرئيسية'
    },
    QQ_ALLOW_ALL_USERS: {
      label: 'السماح لكل مستخدمي QQ',
      name: 'السماح لكل مستخدمي QQ'
    },
    QQBOT_HOME_CHANNEL: {
      label: 'أدخل قناة QQ الرئيسية',
      name: 'قناة QQ الرئيسية',
      help: 'القناة أو المجموعة الافتراضية لتسليم cron.'
    },
    QQBOT_HOME_CHANNEL_NAME: {
      label: 'أدخل اسم قناة QQ الرئيسية',
      name: 'اسم قناة QQ الرئيسية'
    },
    SLACK_BOT_TOKEN: {
      label: 'الصق رمز بوت Slack',
      name: 'رمز بوت Slack',
      help: 'استخدم رمز البوت من OAuth & Permissions بعد تثبيت تطبيق Slack الخاص بك.',
      placeholder: 'الصق رمز بوت Slack'
    },
    SLACK_APP_TOKEN: {
      label: 'الصق رمز تطبيق Slack',
      name: 'رمز تطبيق Slack',
      help: 'استخدم الرمز على مستوى التطبيق المطلوب لـ Socket Mode.',
      placeholder: 'الصق رمز تطبيق Slack'
    },
    SLACK_ALLOWED_USERS: {
      label: 'اختر من يمكنه التحدث إلى وكيلك',
      name: 'معرّفات مستخدمي Slack المسموح بهم',
      help: 'موصى به. معرّفات مستخدمي Slack مفصولة بفواصل.'
    },
    MATTERMOST_URL: {
      label: 'أدخل رابط الخادم',
      name: 'رابط الخادم',
      placeholder: 'https://mattermost.example.com'
    },
    MATTERMOST_TOKEN: {
      label: 'الصق رمز البوت',
      name: 'رمز البوت (token)'
    },
    MATTERMOST_ALLOWED_USERS: {
      label: 'اختر من يمكنه التحدث إلى وكيلك',
      name: 'معرّفات المستخدمين المسموح بهم',
      help: 'موصى به. معرّفات مستخدمي Mattermost مفصولة بفواصل.'
    },
    MATRIX_HOMESERVER: {
      label: 'أدخل رابط Homeserver',
      name: 'رابط Homeserver',
      placeholder: 'https://matrix.org'
    },
    MATRIX_ACCESS_TOKEN: {
      label: 'الصق رمز الوصول',
      name: 'رمز الوصول'
    },
    MATRIX_USER_ID: {
      label: 'أدخل معرّف مستخدم البوت',
      name: 'معرّف مستخدم البوت',
      placeholder: '@agent:example.org'
    },
    MATRIX_ALLOWED_USERS: {
      label: 'اختر من يمكنه التحدث إلى وكيلك',
      name: 'معرّفات مستخدمي Matrix المسموح بهم',
      help: 'موصى به. معرّفات مستخدمين مفصولة بفواصل بصيغة @user:server.'
    },
    SIGNAL_HTTP_URL: {
      label: 'أدخل رابط جسر Signal',
      name: 'رابط جسر Signal',
      placeholder: 'http://127.0.0.1:8080',
      help: 'رابط جسر signal-cli REST قيد التشغيل.'
    },
    SIGNAL_ACCOUNT: {
      label: 'أدخل رقم الهاتف',
      name: 'رقم الهاتف',
      help: 'الرقم المسجّل مع جسر signal-cli الخاص بك.'
    },
    SIGNAL_ALLOWED_USERS: {
      label: 'اختر من يمكنه التحدث إلى وكيلك',
      name: 'مستخدمو Signal المسموح بهم',
      help: 'موصى به. معرّفات Signal مفصولة بفواصل.'
    },
    WHATSAPP_ENABLED: {
      label: 'تفعيل جسر WhatsApp',
      name: 'تفعيل جسر WhatsApp',
      help: 'يُضبط تلقائيا عبر المفتاح أدناه. اتركه دون تغيير ما لم تكن متأكدا من حاجتك إليه.'
    },
    WHATSAPP_MODE: {
      label: 'اختر وضع الجسر',
      name: 'وضع الجسر'
    },
    WHATSAPP_ALLOWED_USERS: {
      label: 'اختر من يمكنه التحدث إلى وكيلك',
      name: 'مستخدمو WhatsApp المسموح بهم',
      help: 'موصى به. أرقام هواتف أو معرّفات WhatsApp مفصولة بفواصل.'
    },
    A2A_AGENT_NAME: { label: 'أدخل الاسم الذي يراه الوكلاء الآخرون', name: 'الاسم الذي يراه الوكلاء الآخرون' },
    A2A_BEARER_TOKEN: {
      label: 'الصق رمز الوصول الذي يستخدمه الوكلاء الآخرون',
      name: 'رمز الوصول الذي يستخدمه الوكلاء الآخرون'
    },
    A2A_HOST: { label: 'أدخل العنوان الذي يستمع إليه', name: 'العنوان الذي يستمع إليه' },
    A2A_PEER_TOKENS: { label: 'الصق رموز الوكلاء الموثوقين', name: 'رموز الوكلاء الموثوقين' },
    A2A_PORT: { label: 'أدخل المنفذ الذي يستمع إليه', name: 'المنفذ الذي يستمع إليه' },
    API_SERVER_ENABLED: { label: 'شغّله', name: 'شغّله' },
    API_SERVER_HOST: { label: 'أدخل العنوان الذي يستمع إليه', name: 'العنوان الذي يستمع إليه' },
    API_SERVER_KEY: { label: 'الصق مفتاح الوصول', name: 'مفتاح الوصول' },
    API_SERVER_MODEL_NAME: { label: 'أدخل الاسم الذي تراه التطبيقات الأخرى', name: 'الاسم الذي تراه التطبيقات الأخرى' },
    API_SERVER_PORT: { label: 'أدخل المنفذ الذي يستمع إليه', name: 'المنفذ الذي يستمع إليه' },
    BLUEBUBBLES_ALLOWED_USERS: { label: 'اختر من يمكنه التحدث إلى وكيلك', name: 'الأشخاص المسموح لهم بالتحدث إليه' },
    BLUEBUBBLES_PASSWORD: { label: 'الصق كلمة مرور الخادم', name: 'كلمة مرور الخادم' },
    BLUEBUBBLES_SERVER_URL: { label: 'أدخل عنوان الخادم', name: 'عنوان الخادم' },
    BUZZ_ALLOWED_USERS: { label: 'اختر من يمكنه التحدث إلى وكيلك', name: 'الأشخاص المسموح لهم بالتحدث إليه' },
    BUZZ_AUTH_TAG: { label: 'أدخل وسم تسجيل الدخول', name: 'وسم تسجيل الدخول' },
    BUZZ_CHANNELS: { label: 'اختر القنوات التي ينضم إليها', name: 'القنوات التي ينضم إليها' },
    BUZZ_CLI_PATH: { label: 'أدخل مكان برنامج Buzz', name: 'مكان برنامج Buzz' },
    BUZZ_CREDENTIALS_FILE: { label: 'أدخل ملف بيانات الاعتماد', name: 'ملف بيانات الاعتماد' },
    BUZZ_POLL_INTERVAL: { label: 'اضبط عدد مرات التحقق من الرسائل', name: 'عدد مرات التحقق من الرسائل' },
    BUZZ_PRIVATE_KEY: { label: 'الصق المفتاح الخاص', name: 'المفتاح الخاص' },
    BUZZ_RELAY_URL: { label: 'أدخل عنوان الترحيل', name: 'عنوان الترحيل' },
    BUZZ_TRANSPORT: { label: 'اختر طريقة الاتصال', name: 'طريقة الاتصال' },
    DINGTALK_ALLOWED_USERS: { label: 'اختر من يمكنه التحدث إلى وكيلك', name: 'الأشخاص المسموح لهم بالتحدث إليه' },
    DINGTALK_CLIENT_ID: { label: 'أدخل معرّف العميل', name: 'معرّف العميل' },
    DINGTALK_CLIENT_SECRET: { label: 'الصق سرّ العميل', name: 'سرّ العميل' },
    DINGTALK_WEBHOOK_URL: { label: 'أدخل عنوان روبوت المجموعة', name: 'عنوان روبوت المجموعة' },
    EMAIL_ADDRESS: { label: 'أدخل عنوان البريد الإلكتروني', name: 'عنوان البريد الإلكتروني' },
    EMAIL_ALLOWED_USERS: { label: 'اختر العناوين المسموح لها بمراسلته', name: 'العناوين المسموح لها بمراسلته' },
    EMAIL_IMAP_HOST: { label: 'أدخل خادم البريد الوارد', name: 'خادم البريد الوارد' },
    EMAIL_PASSWORD: { label: 'الصق كلمة مرور صندوق البريد', name: 'كلمة مرور صندوق البريد' },
    EMAIL_SMTP_HOST: { label: 'أدخل خادم البريد الصادر', name: 'خادم البريد الصادر' },
    EMAIL_SMTP_PORT: { label: 'أدخل منفذ البريد الصادر', name: 'منفذ البريد الصادر' },
    FEISHU_ALLOWED_USERS: { label: 'اختر من يمكنه التحدث إلى وكيلك', name: 'الأشخاص المسموح لهم بالتحدث إليه' },
    FEISHU_APP_ID: { label: 'أدخل معرّف التطبيق', name: 'معرّف التطبيق' },
    FEISHU_APP_SECRET: { label: 'الصق سرّ التطبيق', name: 'سرّ التطبيق' },
    FEISHU_DOMAIN: { label: 'اختر Feishu أو Lark', name: 'Feishu أو Lark' },
    FEISHU_ENCRYPT_KEY: { label: 'الصق مفتاح تشفير الأحداث', name: 'مفتاح تشفير الأحداث' },
    FEISHU_VERIFICATION_TOKEN: { label: 'الصق رمز التحقق من الأحداث', name: 'رمز التحقق من الأحداث' },
    GOOGLE_CHAT_ALLOWED_USERS: { label: 'اختر من يمكنه التحدث إلى وكيلك', name: 'الأشخاص المسموح لهم بالتحدث إليه' },
    GOOGLE_CHAT_HTTP_EVENTS_AUDIENCE: {
      label: 'أدخل الجهة التي تُرسل إليها الأحداث',
      name: 'الجهة التي تُرسل إليها الأحداث'
    },
    GOOGLE_CHAT_HTTP_EVENTS_SERVICE_ACCOUNT_EMAIL: {
      label: 'أدخل حساب الخدمة الذي يرسل الأحداث',
      name: 'حساب الخدمة الذي يرسل الأحداث'
    },
    GOOGLE_CHAT_HTTP_EVENTS_URL: {
      label: 'أدخل العنوان الذي يرسل إليه Google Chat الأحداث',
      name: 'العنوان الذي يرسل إليه Google Chat الأحداث'
    },
    GOOGLE_CHAT_PROJECT_ID: { label: 'أدخل معرّف مشروع Google Cloud', name: 'معرّف مشروع Google Cloud' },
    GOOGLE_CHAT_SERVICE_ACCOUNT_JSON: { label: 'أدخل ملف حساب الخدمة', name: 'ملف حساب الخدمة' },
    GOOGLE_CHAT_SUBSCRIPTION_NAME: { label: 'أدخل اشتراك Pub/Sub', name: 'اشتراك Pub/Sub' },
    HASS_TOKEN: { label: 'الصق رمز وصول طويل الأمد', name: 'رمز وصول طويل الأمد' },
    HASS_URL: { label: 'أدخل عنوان Home Assistant', name: 'عنوان Home Assistant' },
    IRC_ALLOWED_USERS: { label: 'اختر من يمكنه التحدث إلى وكيلك', name: 'الأشخاص المسموح لهم بالتحدث إليه' },
    IRC_CHANNEL: { label: 'أدخل القناة التي ينضم إليها', name: 'القناة التي ينضم إليها' },
    IRC_NICKNAME: { label: 'أدخل الاسم المستعار', name: 'الاسم المستعار' },
    IRC_NICKSERV_PASSWORD: { label: 'الصق كلمة مرور الاسم المستعار', name: 'كلمة مرور الاسم المستعار' },
    IRC_PORT: { label: 'أدخل منفذ الخادم', name: 'منفذ الخادم' },
    IRC_SERVER: { label: 'أدخل عنوان الخادم', name: 'عنوان الخادم' },
    IRC_SERVER_PASSWORD: { label: 'الصق كلمة مرور الخادم', name: 'كلمة مرور الخادم' },
    IRC_USE_TLS: { label: 'استخدم اتصالًا مشفّرًا', name: 'استخدم اتصالًا مشفّرًا' },
    LINE_ALLOWED_GROUPS: {
      label: 'اختر المجموعات المسموح لها بالتحدث إليه',
      name: 'المجموعات المسموح لها بالتحدث إليه'
    },
    LINE_ALLOWED_ROOMS: { label: 'اختر الغرف المسموح لها بالتحدث إليه', name: 'الغرف المسموح لها بالتحدث إليه' },
    LINE_ALLOWED_USERS: { label: 'اختر من يمكنه التحدث إلى وكيلك', name: 'الأشخاص المسموح لهم بالتحدث إليه' },
    LINE_CHANNEL_ACCESS_TOKEN: { label: 'الصق رمز الوصول إلى القناة', name: 'رمز الوصول إلى القناة' },
    LINE_CHANNEL_SECRET: { label: 'الصق سرّ القناة', name: 'سرّ القناة' },
    LINE_HOST: { label: 'أدخل العنوان الذي يستمع إليه', name: 'العنوان الذي يستمع إليه' },
    LINE_PORT: { label: 'أدخل المنفذ الذي يستمع إليه', name: 'المنفذ الذي يستمع إليه' },
    LINE_PUBLIC_URL: { label: 'أدخل العنوان العام الذي يرسل إليه LINE', name: 'العنوان العام الذي يرسل إليه LINE' },
    LINE_SLOW_RESPONSE_THRESHOLD: {
      label: 'اضبط الثواني قبل أن يقول إنه لا يزال يعمل',
      name: 'الثواني قبل أن يقول إنه لا يزال يعمل'
    },
    MATRIX_DEVICE_ID: { label: 'أدخل معرّف الجهاز', name: 'معرّف الجهاز' },
    MATRIX_PASSWORD: { label: 'الصق كلمة المرور', name: 'كلمة المرور' },
    MATRIX_RECOVERY_KEY: { label: 'الصق مفتاح الاسترداد للغرف المشفّرة', name: 'مفتاح الاسترداد للغرف المشفّرة' },
    NTFY_ALLOWED_USERS: { label: 'اختر من يمكنه التحدث إلى وكيلك', name: 'الأشخاص المسموح لهم بالتحدث إليه' },
    NTFY_MARKDOWN: { label: 'نسّق الردود باستخدام Markdown', name: 'نسّق الردود باستخدام Markdown' },
    NTFY_PUBLISH_TOPIC: { label: 'أدخل الموضوع الذي يرد عليه', name: 'الموضوع الذي يرد عليه' },
    NTFY_SERVER_URL: { label: 'أدخل عنوان الخادم', name: 'عنوان الخادم' },
    NTFY_TOKEN: { label: 'الصق رمز الوصول', name: 'رمز الوصول' },
    NTFY_TOPIC: { label: 'أدخل الموضوع الذي يستمع إليه', name: 'الموضوع الذي يستمع إليه' },
    PHOTON_ALLOWED_USERS: { label: 'اختر من يمكنه التحدث إلى وكيلك', name: 'الأشخاص المسموح لهم بالتحدث إليه' },
    PHOTON_DASHBOARD_HOST: { label: 'أدخل عنوان لوحة التحكم', name: 'عنوان لوحة التحكم' },
    PHOTON_MARKDOWN: { label: 'نسّق الردود باستخدام Markdown', name: 'نسّق الردود باستخدام Markdown' },
    PHOTON_MENTION_PATTERNS: { label: 'اختر الكلمات التي تستدعيه في مجموعة', name: 'الكلمات التي تستدعيه في مجموعة' },
    PHOTON_NODE_BIN: { label: 'أدخل مكان Node.js', name: 'مكان Node.js' },
    PHOTON_PROJECT_ID: { label: 'أدخل معرّف المشروع', name: 'معرّف المشروع' },
    PHOTON_PROJECT_SECRET: { label: 'الصق سرّ المشروع', name: 'سرّ المشروع' },
    PHOTON_REACTIONS: { label: 'تفاعل مع الرسائل', name: 'تفاعل مع الرسائل' },
    PHOTON_SIDECAR_AUTOSTART: { label: 'شغّل البرنامج المساعد تلقائيًا', name: 'شغّل البرنامج المساعد تلقائيًا' },
    PHOTON_SIDECAR_PORT: { label: 'أدخل منفذ البرنامج المساعد', name: 'منفذ البرنامج المساعد' },
    PHOTON_SPECTRUM_HOST: { label: 'أدخل عنوان Spectrum', name: 'عنوان Spectrum' },
    PHOTON_TELEMETRY: { label: 'شارك بيانات الاستخدام مع Photon', name: 'شارك بيانات الاستخدام مع Photon' },
    QQ_ALLOWED_USERS: { label: 'اختر من يمكنه التحدث إلى وكيلك', name: 'الأشخاص المسموح لهم بالتحدث إليه' },
    QQ_APP_ID: { label: 'أدخل معرّف التطبيق', name: 'معرّف التطبيق' },
    QQ_CLIENT_SECRET: { label: 'الصق سرّ العميل', name: 'سرّ العميل' },
    QQ_GROUP_ALLOWED_USERS: {
      label: 'اختر المجموعات المسموح لها بالتحدث إليه',
      name: 'المجموعات المسموح لها بالتحدث إليه'
    },
    QQ_SANDBOX: { label: 'استخدم بيئة الاختبار', name: 'استخدم بيئة الاختبار' },
    RAFT_PROFILE: { label: 'اختر ملف مساحة العمل', name: 'ملف مساحة العمل' },
    SIMPLEX_ALLOWED_USERS: { label: 'اختر من يمكنه التحدث إلى وكيلك', name: 'الأشخاص المسموح لهم بالتحدث إليه' },
    SIMPLEX_AUTO_ACCEPT: { label: 'اقبل جهات الاتصال الجديدة تلقائيًا', name: 'اقبل جهات الاتصال الجديدة تلقائيًا' },
    SIMPLEX_GROUP_ALLOWED: { label: 'اسمح له بالرد في المجموعات', name: 'اسمح له بالرد في المجموعات' },
    SIMPLEX_WS_URL: { label: 'أدخل عنوان برنامج SimpleX', name: 'عنوان برنامج SimpleX' },
    TEAMS_ALLOWED_USERS: { label: 'اختر من يمكنه التحدث إلى وكيلك', name: 'الأشخاص المسموح لهم بالتحدث إليه' },
    TEAMS_CLIENT_ID: { label: 'أدخل معرّف العميل', name: 'معرّف العميل' },
    TEAMS_CLIENT_SECRET: { label: 'الصق سرّ العميل', name: 'سرّ العميل' },
    TEAMS_HOST: { label: 'أدخل العنوان الذي يستمع إليه', name: 'العنوان الذي يستمع إليه' },
    TEAMS_PORT: { label: 'أدخل المنفذ الذي يستمع إليه', name: 'المنفذ الذي يستمع إليه' },
    TEAMS_TENANT_ID: { label: 'أدخل معرّف المستأجر', name: 'معرّف المستأجر' },
    TWILIO_ACCOUNT_SID: { label: 'أدخل معرّف الحساب', name: 'معرّف الحساب (SID)' },
    TWILIO_AUTH_TOKEN: { label: 'الصق رمز المصادقة', name: 'رمز المصادقة' },
    TWILIO_PHONE_NUMBER: { label: 'أدخل رقم الهاتف الذي يرسل الرسائل', name: 'رقم الهاتف الذي يرسل الرسائل' },
    WEBHOOK_ENABLED: { label: 'شغّله', name: 'شغّله' },
    WEBHOOK_PORT: { label: 'أدخل المنفذ الذي يستمع إليه', name: 'المنفذ الذي يستمع إليه' },
    WEBHOOK_SECRET: { label: 'الصق سرّ التوقيع', name: 'سرّ التوقيع' },
    WECOM_BOT_ID: { label: 'الصق مفتاح روبوت المجموعة', name: 'مفتاح روبوت المجموعة' },
    WECOM_CALLBACK_AGENT_ID: { label: 'أدخل معرّف الوكيل', name: 'معرّف الوكيل' },
    WECOM_CALLBACK_CORP_ID: { label: 'أدخل معرّف المؤسسة', name: 'معرّف المؤسسة' },
    WECOM_CALLBACK_CORP_SECRET: { label: 'الصق سرّ التطبيق', name: 'سرّ التطبيق' },
    WECOM_CALLBACK_ENCODING_AES_KEY: { label: 'الصق مفتاح تشفير الرسائل', name: 'مفتاح تشفير الرسائل' },
    WECOM_CALLBACK_TOKEN: { label: 'الصق رمز رد الاتصال', name: 'رمز رد الاتصال' },
    WECOM_SECRET: { label: 'الصق سرّ التطبيق', name: 'سرّ التطبيق' },
    WEIXIN_ACCOUNT_ID: { label: 'أدخل معرّف الحساب', name: 'معرّف الحساب' },
    WEIXIN_BASE_URL: { label: 'أدخل عنوان الخادم', name: 'عنوان الخادم' },
    WEIXIN_TOKEN: { label: 'الصق رمز الوصول', name: 'رمز الوصول' },
    WHATSAPP_DM_POLICY: { label: 'اختر من يمكنه مراسلته مباشرةً', name: 'من يمكنه مراسلته مباشرةً' }
  },
  platformIntro: {
    api_server: 'اضبط مفتاح وصول، ثم وجّه Open WebUI أو LobeChat أو أي تطبيق متوافق مع OpenAI إلى العنوان المعروض.',
    bluebubbles: 'شغّل BlueBubbles Server على جهاز Mac مسجّل الدخول إلى iMessage. ثم أدخل عنوانه وكلمة مرور الخادم.',
    dingtalk: 'أنشئ تطبيق DingTalk في لوحة المطوّرين. ثم انسخ معرّف العميل وسرّ العميل هنا.',
    discord: 'في بوابة مطوّري Discord، أنشئ تطبيقًا وأضف روبوتًا وانسخ رمزه. ثم ادعُ الروبوت إلى خادمك.',
    email: 'استخدم صندوق بريد مخصصًا لوكيلك. مع Gmail، أنشئ كلمة مرور تطبيق واستخدم خوادم بريد Gmail.',
    feishu: 'أنشئ تطبيق Feishu أو Lark مع تفعيل ميزة الروبوت. ثم انسخ معرّف التطبيق وسرّه ومفاتيح الأحداث.',
    homeassistant: 'في Home Assistant، افتح ملفك الشخصي وأنشئ رمز وصول طويل الأمد. الصقه هنا مع عنوان Home Assistant.',
    matrix: 'سجّل الدخول إلى خادمك الرئيسي بحساب الروبوت. ثم انسخ رمز الوصول ومعرّف المستخدم وعنوان الخادم الرئيسي.',
    mattermost: 'على خادم Mattermost، أنشئ حساب روبوت أو رمز وصول شخصيًا. ثم الصق عنوان الخادم والرمز هنا.',
    qqbot: 'سجّل تطبيقًا على منصة QQ المفتوحة. ثم انسخ معرّف التطبيق وسرّ العميل.',
    signal: 'شغّل جسر Signal في مكان يصل إليه هذا الحاسوب. ثم أدخل عنوانه ورقم الهاتف المسجّل.',
    slack: 'أنشئ تطبيق Slack وفعّل Socket Mode وثبّته في مساحة عملك. ثم انسخ رمز الروبوت ورمز التطبيق.',
    sms: 'في لوحة تحكم Twilio، انسخ معرّف الحساب ورمز المصادقة، واختر رقم هاتف يمكنه إرسال الرسائل.',
    telegram:
      'في Telegram، راسل ‎@BotFather وأنشئ روبوتًا جديدًا وانسخ الرمز الذي يعطيك إياه. ثم احصل على معرّف المستخدم الرقمي من ‎@userinfobot.',
    webhook: 'ترسل الخدمات الأخرى الأحداث إلى العنوان المعروض. استخدم السرّ للتحقق من أن كل حدث أصلي.',
    wecom: 'أضف روبوت مجموعة في WeCom وانسخ مفتاح Webhook الخاص به. يرسل فقط؛ اختر WeCom (تطبيق) للتحدث في الاتجاهين.',
    wecom_callback:
      'أعدّ تطبيق WeCom الخاص بك مع عنوان رد اتصال. ثم أدخل معرّف المؤسسة والسرّ ومعرّف الوكيل ومفتاح AES.',
    weixin: 'فعّل المنصة وأكّد رمز QR بحساب WeChat الشخصي. يُحفظ تسجيل الدخول للمرة القادمة.',
    whatsapp: 'فعّل المنصة وامسح رمز QR بتطبيق WhatsApp عند أول اتصال.'
  },
  platformSummary: {
    a2a: 'اسمح للوكلاء الآخرين بالتحدث إلى وكيلك مباشرةً.',
    api_server: 'اسمح لتطبيقات الدردشة الأخرى باستخدام وكيلك كأنه نموذج من OpenAI.',
    bluebubbles: 'تحدّث إلى وكيلك في iMessage عبر خادم BlueBubbles.',
    buzz: 'تحدّث إلى وكيلك عبر Buzz.',
    dingtalk: 'تحدّث إلى وكيلك في مجموعات DingTalk.',
    discord: 'تحدّث إلى وكيلك في رسائل Discord وقنواته وسلاسله.',
    email: 'راسل وكيلك بالبريد الإلكتروني واستلم ردوده.',
    feishu: 'تحدّث إلى وكيلك داخل Feishu أو Lark.',
    google_chat: 'تحدّث إلى وكيلك في Google Chat.',
    homeassistant: 'اسمح لوكيلك بالتحكم في منزلك الذكي عبر Home Assistant.',
    irc: 'تحدّث إلى وكيلك في قناة IRC أو في الرسائل الخاصة.',
    line: 'تحدّث إلى وكيلك على LINE.',
    matrix: 'تحدّث إلى وكيلك في غرف Matrix ورسائله المباشرة.',
    mattermost: 'تحدّث إلى وكيلك في قنوات Mattermost ورسائله المباشرة.',
    msgraph_webhook: 'اسمح لـ Microsoft 365 بإبلاغ وكيلك بالاجتماعات والرسائل الجديدة.',
    ntfy: 'تحدّث إلى وكيلك عبر إشعارات ntfy.',
    photon: 'تحدّث إلى وكيلك في iMessage عبر خدمة Photon المُدارة.',
    qqbot: 'تحدّث إلى وكيلك عبر روبوت QQ.',
    raft: 'اسمح لوكيلك بالانضمام إلى مساحة عمل Raft.',
    relay: 'اربط وكيلك عبر خدمة ترحيل لا تزال قيد الاختبار.',
    signal: 'تحدّث إلى وكيلك على Signal عبر جسر Signal تديره بنفسك.',
    simplex: 'تحدّث إلى وكيلك بخصوصية على SimpleX Chat.',
    slack: 'تحدّث إلى وكيلك في Slack مع الأعضاء الذين تسمح لهم فقط.',
    sms: 'راسل وكيلك واستلم ردوده برسائل SMS عبر Twilio.',
    teams: 'تحدّث إلى وكيلك في محادثات Microsoft Teams.',
    telegram: 'تحدّث إلى وكيلك في محادثات Telegram ومجموعاته وموضوعاته.',
    webhook: 'اسمح لـ GitHub وGitLab وخدمات أخرى بإرسال الأحداث إلى وكيلك.',
    wecom: 'اسمح لوكيلك بالنشر في مجموعة WeCom من دون ردود.',
    wecom_callback: 'تحدّث إلى وكيلك في الاتجاهين على WeCom عبر تطبيقك الخاص.',
    weixin: 'تحدّث إلى وكيلك من حساب WeChat شخصي.',
    whatsapp: 'تحدّث إلى وكيلك على WhatsApp بعد مسح رمز QR مرة واحدة.',
    whatsapp_cloud: 'تحدّث إلى وكيلك عبر خدمة WhatsApp التي تستضيفها Meta.',
    yuanbao: 'تحدّث إلى وكيلك في Tencent Yuanbao.'
  },
  noPlatforms: 'لا توجد منصات مراسلة',
  noMatch: query => `لا توجد منصة تطابق «${query}»`,
  draftSecretNotKept: 'لم يُحفظ في المسودة — اكتبه مرة أخرى:',
  pendingRequests: count => `الطلبات المعلّقة (${count})`,
  pendingAria: count => (count === 1 ? 'طلب اقتران واحد معلّق' : `${count} طلبات اقتران معلّقة`),
  approvedUsers: count => `المستخدمون المعتمدون (${count})`,
  approve: 'موافقة',
  approving: 'جار الموافقة...',
  revoke: 'سحب الوصول',
  revoking: 'جار سحب الوصول...',
  revokeAria: name => `سحب وصول ${name}`,
  revokeTitle: 'سحب الوصول',
  revokeDesc: (name: string) => `سيفقد ${name} الوصول ولن يُتعرَّف عليه بعد رسالته التالية.`,
  approvedUser: name => `تمت الموافقة على ${name}`,
  approvedHint: 'سيُتعرَّف عليه تلقائيًا في رسالته التالية.',
  revokedUser: name => `تم سحب وصول ${name}`,
  failedApprove: name => `تعذّرت الموافقة على ${name}`,
  failedRevoke: name => `تعذّر سحب وصول ${name}`,
  pairingLockedOut: 'محاولات موافقة فاشلة كثيرة — هذه المنصة مقفلة مؤقتًا. حاول مجددًا لاحقًا.',
  waitingSince: minutes => (minutes < 1 ? 'الآن' : `منذ ${minutes} د`)
}
