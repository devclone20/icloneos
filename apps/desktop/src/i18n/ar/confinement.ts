// iclone os — V3-G العزل: لوحة «الحاويات» في الشريط (العربية).
import type { ConfinementCopy } from '../en/confinement'

export const confinement: ConfinementCopy = {
  title: 'الحاويات',
  tile: 'الحاويات',
  unavailable: 'تعمل الحاويات في تطبيق سطح المكتب، حيث يشغّل وكيلك أوامره.',
  loading: 'جارٍ قراءة ما يعمل على هذا الـ Mac…',
  verdict: {
    green: {
      label: 'معزول',
      hint: 'كل أمر للوكيل يعمل داخل ملفّه التعريفي. أثناء العزل تتوقف خوادم MCP، وسكربتات المهام المجدولة، وتثبيت الإضافات والمهارات والحزم، والتحكم بالحاسوب، ونسخ الملفات قبل التعديل، وفحص الشيفرة بعد التعديل، ونسخ العمل المُفوَّض، وخطافاتك؛ «هذا الـ Mac» يعيد تشغيلها.'
    },
    red: { label: 'غير معزول', hint: 'العزل غير مؤكَّد. الأسباب أدناه.' },
    off: {
      label: 'متوقف',
      hint: 'اخترتَ «هذا الـ Mac»: أوامر الوكيل تعمل دون عزل، وتعود خوادم MCP، وسكربتات المهام المجدولة، والتثبيت، والتحكم بالحاسوب، ونسخ الملفات قبل التعديل، وفحص الشيفرة بعد التعديل، ونسخ العمل المُفوَّض، وخطافاتك إلى العمل.'
    }
  },
  tabs: {
    live: 'مباشر',
    agents: 'الوكلاء',
    profiles: 'الملفات التعريفية',
    refusals: 'الرفض',
    backends: 'الأنظمة الخلفية'
  },
  inside: 'في الداخل',
  outside: 'في الخارج',
  col: { pid: 'PID', profile: 'الملف التعريفي', session: 'الجلسة', time: 'المدة', command: 'الأمر', kind: 'النوع' },
  kinds: { hermes: 'Hermes', 'agent-command': 'أمر وكيل، غير معزول', tool: 'أداة (خادم MCP، مساعد)' },
  kill: 'إيقاف',
  killTip: pid => `أوقف ${pid} وكل ما شغّله`,
  killed: count => (count === 1 ? 'أُوقفت عملية واحدة' : `أُوقفت ${count} عمليات`),
  killFailed: {
    survivors: count => (count === 1 ? 'تعذّر إيقاف عملية واحدة' : `تعذّر إيقاف ${count} عمليات`),
    unverified: () => 'أُوقف ما أمكن رؤيته، لكن تعذّر سؤال macOS إن كان شيء منه ما زال يعمل',
    'not-confined': () => 'ليست عملية معزولة: لم يُوقف شيء',
    invalid: () => 'ليست عملية: لم يُوقف شيء'
  },
  why: 'لماذا',
  follow: 'تتبّع',
  following: pid => `تتبّع ${pid}`,
  stopFollowing: 'إيقاف التتبّع',
  empty: {
    inside: 'لا يعمل أي أمر للوكيل.',
    outside: 'لا شيء من وكيلك يعمل في الخارج.',
    agents: 'لا نشاط للوكيل بعد.',
    refusals: 'لم يُرفض شيء بعد.'
  },
  scope:
    'معزول: الطرفية وتنفيذ الشيفرة وأدوات الملفات، والمتصفح وأدوات الوسائط التي يشغّلها Hermes، كلها داخل الصندوق نفسه. متوقف أثناء العزل: خوادم MCP، وسكربتات المهام المجدولة، وتثبيت الإضافات والمهارات والحزم، والتحكم بالحاسوب، والاستيراد من سلسلة المفاتيح، وأوامر التعرّف على الكلام المحلية.',
  backendName: { seatbelt: 'Seatbelt (macOS)', container: 'Apple container' },
  backendStatus: {
    ready: 'جاهز',
    'not-installed': 'غير مثبّت',
    installed: 'مثبّت',
    unsupported: 'غير متاح على هذا الـ Mac',
    broken: 'لا يعمل',
    unknown: 'تعذّر الفحص'
  },
  active: 'نشِط',
  network: { grant: 'الشبكة بإذن فقط', never: 'الشبكة أبدًا' },
  reads: 'يقرأ',
  writes: 'يكتب',
  never: count => `أبدًا: ${count} من مسارات الأسرار والتطبيق، وسلسلة المفاتيح`,
  classes: {
    research: { name: 'بحث', summary: 'يقرأ المشروع ويكتب في مساحته المؤقتة فقط.' },
    project: { name: 'مشروع', summary: 'يكتب في المشروع ومساحته المؤقتة.' },
    build: { name: 'بناء', summary: 'المشروع مع ذاكرة الحزم المؤقتة.' },
    offline: { name: 'دون اتصال', summary: 'المشروع، ولا شبكة أبدًا.' },
    media: { name: 'وسائط', summary: 'يقرأ المدخلات ويكتب في مجلد إخراج واحد.' }
  },
  defaultClass: name => `الافتراضي: ${name}`,
  refusal: { operation: 'مرفوض', target: 'الهدف', process: 'العملية' },
  unattributed: 'غير منسوب',
  noSession: 'بلا جلسة',
  insideCount: count => `${count} في الداخل`,
  outsideCount: count => `${count} في الخارج`,
  elapsed: seconds =>
    seconds < 60
      ? `${seconds} ث`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)} د`
        : `${Math.floor(seconds / 3600)} س`,
  reasons: 'سبب اللون الأحمر',
  reason: {
    'backend-not-confining': ({ backend, detail }) =>
      backend === 'container'
        ? 'لا يعزل Apple container شيئًا بعد'
        : detail === 'probe-timeout'
          ? 'تعذّر فحص Seatbelt في الوقت المحدد: العزل غير مؤكَّد حاليًا'
          : detail === 'probe-failed'
            ? 'تعذّر فحص Seatbelt: فشل الفحص نفسه، لذا العزل غير مؤكَّد حاليًا'
            : 'لا يعزل Seatbelt شيئًا على هذا الـ Mac',
    'plugin-not-loaded': () => 'الصدفة محجوبة: العزل لم يُحمَّل. تُرفض أوامر وكيلك حتى يُحمَّل.',
    'profile-changed': ({ cls }) => `تغيّر ملف التعريف ${cls} على القرص`,
    'widened-profile': ({ pid }) => `العملية ${pid} تعمل بملف تعريف موسَّع`,
    'unknown-profile': ({ pid }) => `العملية ${pid} تعمل بملف تعريف لم يصنعه هذا التطبيق`,
    'agent-command-outside': ({ pid }) => `أمر الوكيل ${pid} يعمل خارج العزل`,
    'forged-marker': ({ pid }) => `العملية ${pid} تدّعي أنها معزولة، لكن macOS يقول إنها ليست كذلك`,
    'membership-unverified': () => 'تعذّر سؤال macOS عن العمليات المعزولة: قد لا تُحتسب عملية غادرت شجرتها',
    'hardlink-appeared': ({ path, pid, root }) =>
      `ظهر أثناء التشغيل ${pid} رابط صلب إلى ملف خارج ${root} (${path}): لم يُكتشف إلا بعد انتهاء التشغيل، وربما وصل إليه ذلك التشغيل؛ يُرفض التشغيل التالي هناك حتى تسمح به`,
    'settings-ignored': () =>
      'ملف إعدادات العزل على القرص غير موقّع من هذا التطبيق فتم تجاهله: يبقى العزل مفعّلًا بإعداداته الافتراضية'
  },
  notes: 'ملاحظة',
  backendDetail: {
    enforcing: 'يعمل العزل: رفض ملف التعريف الضابط ملفَّ الاختبار.',
    'not-enforcing': 'يعمل لكنه لا يعزل: لم يرفض ملف التعريف الضابط ملفَّ الاختبار.',
    'cannot-run': 'لا يستطيع تشغيل ملف تعريف.',
    'binary-missing': 'الأداة sandbox-exec غير موجودة: لا يمكن عزل شيء.',
    'macos-only': 'Seatbelt موجود في macOS فقط.',
    'needs-apple-silicon': 'يحتاج Apple container إلى شريحة Apple ونظام macOS 26 أو أحدث.',
    'no-version': 'مثبّت، لكنه لم يستجب لفحص الإصدار: يبدو أن التثبيت معطوب.',
    'not-installed': 'غير مثبّت. التثبيت خطوتك أنت، بكلمة مرور المسؤول مرة واحدة:',
    'not-wired': 'غير مستخدم في هذا الإصدار: يعزل icloneOS الأوامر بـ Seatbelt فقط.',
    'probe-failed': 'فشل الفحص نفسه.',
    'probe-timeout': 'لم يكتمل الفحص في الوقت المحدد: ربما كان هذا الـ Mac مشغولًا. سيُعاد الفحص بعد قليل.'
  },
  hardlinks: {
    blocked: (root, paths, count) =>
      `لن يبدأ العزل في ${root}: ${paths.join('، ')}${count > paths.length ? ` و${count - paths.length} غيرها` : ''} ${count === 1 ? 'رابط صلب' : 'روابط صلبة'} إلى ملف خارج المشروع، فاحذفها أو اسمح بها أدناه مجلدًا مجلدًا.`,
    cannotScan: (root, paths, count) =>
      `لن يبدأ العزل في ${root}: تعذّر سرد ${paths.join('، ')}${count > paths.length ? ` و${count - paths.length} غيرها` : ''}، وقد يختبئ فيها رابط صلب، فامنح تلك المجلدات إذن القراءة (chmod u+rx).`,
    group: (dir, count) => `الملفات الـ${count} تحت ${dir} — روابط صلبة إلى خارج المشروع`,
    allow: count => (count === 1 ? 'اسمح بهذا الملف' : `اسمح بـ${count} ملفات`),
    allowTip:
      'يمكن للأوامر قراءة هذه الملفات بعينها كما هي الآن والكتابة فيها، ومن خلالها الملفات الخارجية المرتبطة بها؛ أي رابط جديد يُسأل عنه من جديد',
    allowed: count => `سُمح: بهذه الملفات الـ${count} كما هي الآن`,
    ackFailed: {
      'no-gesture': 'لم يُسمح: انقر الزر بنفسك',
      'not-in-project': 'لم يُسمح: المجلد ليس في ذلك المشروع',
      'nothing-to-allow': 'لا شيء للسماح به: لم يبقَ رابط صلب تحت ذلك المجلد',
      changed: 'لم يُسمح: تغيّرت الملفات تحت ذلك المجلد بعد عرضها؛ اقرأها من جديد',
      invalid: 'لم يُسمح: المجلد لم يعد موجودًا'
    },
    cachesUnscanned:
      'ذاكرات الحزم المؤقتة (npm وpip وcargo وpnpm…) لا تُفحص بحثًا عن روابط صلبة: يمكن لأمر Build قراءتها وملؤها على أي حال.'
  }
}
