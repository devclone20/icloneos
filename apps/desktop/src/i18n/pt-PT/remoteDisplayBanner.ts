import type { TranslationOverrides } from '../define-locale'

export const remoteDisplayBanner: TranslationOverrides['remoteDisplayBanner'] = {
  message: reason =>
    `Renderização por software ativa — ecrã remoto detetado (${reason}). A aceleração por GPU está desativada para evitar cintilação.`
}
