import type { TranslationOverrides } from '../define-locale'

export const slash: TranslationOverrides['slash'] = {
  alsoKnownAs: aliases => `أيضا ${aliases}`,
  fromLibrary: 'من مكتبتك',
  needs: names => `يحتاج ${names}`,
  skillsTitle: 'المهارات',
  groupPorted: 'icloneOS · من مكتبتك',
  groupIclone: 'icloneOS',
  groupLearned: 'متعلَّمة',
  groupUpstream: 'الأصل',
  groupHub: 'Hub',
  groupOther: 'المهارات',
  skillsEmpty: 'لم يُعثر على مهارات.',
  skillsFooter: count => `${count} مهارة · اكتب /الاسم لفتح واحدة`,
  skillsRestartNote: 'تصل المهارة المتزامنة حديثا إلى الوكيل بعد إعادة تشغيل خلفيته.',
  skillsUnavailable: count => `${count} مهارة تحتاج شيئا ينقص هذا الجهاز (مذكور أعلاه).`,
  needsSummary: rows => `${rows.length} مهارة من مكتبتك تحتاج شيئا ينقص هذا الجهاز: ${rows.join('؛ ')}.`,
  manifestProblem: message => `ملف manifest.json غير صالح — ${message}`,
  manifestSummary: rows => `${rows.length} مهارة تحمل ملف manifest.json غير صالح: ${rows.join('؛ ')}.`,
  by: (author, license) => `بقلم ${author} (${license})`,
  catalogUnavailable: command => `لم يُرسل ${command}: تعذرت قراءة فهرس الأوامر. حاول مرة أخرى.`
}
