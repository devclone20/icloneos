// iclone os — V3-D سطر كل لوحة في قسم iT من الشريط الجانبي (العربية).
import type { ItPanesCopy } from '@/i18n/en/itPanes'

export const arItPanes: ItPanesCopy = {
  linesLabel: workspace => `لوحات ${workspace}`,
  states: {
    running: 'قيد التشغيل',
    idle: 'خامل',
    'needs-input': 'يحتاجك',
    exited: 'انتهى',
    dead: 'متوقف'
  },
  signals: { attention: 'طلب انتباهك', bell: 'جرس', notification: 'إشعار' },
  ago: age => `منذ ${age}`,
  noBranch: 'بلا git',
  ports: list => `المنافذ ${list}`,
  tmuxRemoteOff: 'tmux عبر ssh معطّل في هذا الإصدار: يعمل على هذا الـ Mac فقط حتى يُثبَت على مضيف تجريبي.'
}
