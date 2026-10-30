import type { Translations } from '../types'

export const backgroundTasks: Translations['backgroundTasks'] = {
  doorLabel: (active, died) =>
    `المهام في الخلفية: ${active} قيد التشغيل${died > 0 ? `، و${died} توقفت دون أن يلاحظ أحد` : ''}`,
  title: 'المهام في الخلفية',
  tabs: { tasks: 'المهام', log: 'سجل الأذونات' },
  kinds: { agent: 'وكيل', shell: 'مهمة طرفية', cron: 'تشغيل Cron', pane: 'لوحة iT', action: 'إجراء سطح المكتب' },
  states: {
    running: 'قيد التشغيل',
    waiting: 'بانتظار ردك',
    done: 'اكتملت',
    failed: 'فشلت',
    died: 'توقفت فجأة',
    stopped: 'أُوقفت'
  },
  endedBy: { owner: 'أوقفتَها أنت', rewind: 'أُزيلت بالترجيع', session: 'انتهت الجلسة' },
  startUnknown: 'وقت البدء غير معروف: مصدرها لا يذكره.',
  stop: 'إيقاف',
  stopping: 'جارٍ الإيقاف…',
  didNotStop: detail => (detail ? `لم تتوقف — ${detail}` : 'لم تتوقف'),
  cannotConfirm: 'تعذّر التأكيد',
  retryStop: 'إعادة المحاولة',
  cannotStop: {
    agent: 'لا يمكن إيقاف وكيل فرعي من هنا بعد.',
    shell: 'لا يمكن إيقاف هذه المهمة من هنا.',
    cron: 'لا يمكن إيقاف التشغيل؛ أوقف المهمة مؤقتًا من Cron.',
    pane: 'أوقفها من لوحة iT الخاصة بها.',
    action: 'لا يمكن إيقاف هذا الإجراء من هنا.',
    waiting: 'أجب عنها في الدردشة.'
  },
  dismiss: 'تجاهل',
  showMore: count => `عرض ${count} أخرى`,
  diedBanner: count => `توقفت ${count} من المهام دون أن يلاحظ أحد`,
  exitCode: code => `رمز الخروج ${code}`,
  signal: name => `أُنهيت بـ ${name}`,
  noOutput: 'لا يوجد مخرجات بعد',
  emptyTitle: 'لا شيء في الخلفية',
  emptyText: 'تظهر هنا الوكلاء ومهام الطرفية وتشغيلات Cron التي تعمل بعيدًا عن الأنظار.',
  loading: 'جارٍ قراءة المهام في الخلفية…',
  sourceError: (source, detail) => `تعذرت قراءة ${source}: ${detail}`,
  sources: {
    agent: 'الوكلاء الفرعيون',
    shell: 'مهام الطرفية',
    cron: 'Cron',
    perm: 'سجل الأذونات',
    pane: 'لوحات iT',
    action: 'إجراءات سطح المكتب'
  },
  logEmpty: 'لا توجد قرارات أذونات بعد.',
  logUnavailable: 'سجل الأذونات غير متاح في هذا الإصدار.'
}
