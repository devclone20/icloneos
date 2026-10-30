import type { TranslationOverrides } from '../define-locale'

export const remoteDisplayBanner: TranslationOverrides['remoteDisplayBanner'] = {
  message: reason => `العرض البرمجي نشط — تم اكتشاف شاشة بعيدة (${reason}). تم تعطيل تسريع GPU لمنع الوميض.`
}
