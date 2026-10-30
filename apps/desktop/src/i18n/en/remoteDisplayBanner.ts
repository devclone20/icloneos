import type { Translations } from '../types'

export const remoteDisplayBanner: Translations['remoteDisplayBanner'] = {
  message: reason =>
    `Software rendering active — remote display detected (${reason}). GPU acceleration is disabled to prevent flickering.`
}
