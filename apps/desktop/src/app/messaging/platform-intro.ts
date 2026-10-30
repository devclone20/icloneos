import type { MessagingPlatformInfo } from '@/hermes'
import type { Translations } from '@/i18n'

/**
 * The words a platform's detail shows, from the catalogue only (ruling S27): never the backend's own
 * description, which is English and names the runtime. A platform the catalogue does not know shows no
 * sentence at all — an empty line beats an English one.
 */
export const introCopy = (platform: MessagingPlatformInfo, m: Translations['messaging']) =>
  m.platformIntro[platform.id] ?? ''

export const summaryCopy = (platform: MessagingPlatformInfo, m: Translations['messaging']) =>
  m.platformSummary[platform.id] ?? ''
