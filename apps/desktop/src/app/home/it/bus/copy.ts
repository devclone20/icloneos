/**
 * The itPanes catalogue for the display language. A side catalogue (like the
 * V3-F permissions words): it is chosen here, so no locale assembler changes.
 */
import { arItPanes } from '@/i18n/ar/itPanes'
import { enItPanes, type ItPanesCopy } from '@/i18n/en/itPanes'
import { jaItPanes } from '@/i18n/ja/itPanes'
import { ptPtItPanes } from '@/i18n/pt-PT/itPanes'
import type { Locale } from '@/i18n/types'
import { zhHantItPanes } from '@/i18n/zh-hant/itPanes'
import { zhItPanes } from '@/i18n/zh/itPanes'

export const IT_PANES_COPY: Readonly<Record<Locale, ItPanesCopy>> = {
  en: enItPanes,
  ar: arItPanes,
  ja: jaItPanes,
  zh: zhItPanes,
  'zh-hant': zhHantItPanes,
  'pt-PT': ptPtItPanes
}

// Main's refusal code (electron/iclone-pane-bus/pane-env.ts TMUX_REMOTE_OFF); main stays English, the pane speaks the display language.
const TMUX_REMOTE_OFF = 'iclone:tmux-remote-off'

/** The words a pane prints when its shell could not start: the catalogue's, when main gave a known refusal. */
export function paneStartFailure(message: string, locale: Locale): string {
  return message.includes(TMUX_REMOTE_OFF) ? IT_PANES_COPY[locale].tmuxRemoteOff : message
}
