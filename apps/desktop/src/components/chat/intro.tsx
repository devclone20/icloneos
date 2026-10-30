/**
 * The empty-conversation intro of the Message window. One small line, the
 * owner's own words: "Your Imagination is the Limit". The wordmark
 * lives only on the empty home stage; the window names itself in its head
 * like every Dock window.
 */
import './intro.css'

import { useI18n } from '@/i18n'

export function Intro() {
  const { t } = useI18n()

  return (
    <div
      className="pointer-events-none flex w-full min-w-0 flex-col items-center justify-center px-0.5 py-6 text-center sm:px-6 lg:px-8"
      data-slot="aui_intro"
    >
      <p className="ic-intro-line">{t.desktop.home.introLine}</p>
    </div>
  )
}
