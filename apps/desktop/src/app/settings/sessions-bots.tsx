import type { JSX } from 'react'

import { ContribRender } from '@/contrib/react/boundary'
import { useContributions } from '@/contrib/react/use-contributions'
/**
 * Sessions & Bots — the old left sidebar, re-homed as a Settings pane
 * (owner rule: "sessions, bots devem ficar dentro das definições, bem
 * detalhado com todas as suas funções").
 *
 * ZERO duplication: the SESSIONS surface embedded below IS the real sidebar
 * surface (`<WiredPane part="sidebar" />` — same wiring, same stores, every
 * verb intact), and the BOTS surface is the hermes-bots plugin's own pane
 * contribution rendered in place. This file only adds the frame and the
 * function-by-function documentation around them.
 */
import { useI18n } from '@/i18n'
import { MessageCircle, Users } from '@/lib/icons'
import { useKeybindHint } from '@/lib/keybinds/use-keybind-hint'

import { WiredPane } from '../contrib/context'

import { SectionHeading, SettingsContent } from './primitives'
import { SettingRow } from './setting-row'

export function SessionsBotsSettings(): JSX.Element {
  const panes = useContributions('panes')
  const c = useI18n().t.settings.sessionsBots
  const botsPane = panes.find(pane => pane.id === 'hermes-bots:pane')
  // The user's real binding: a rebind shows the new keys, an unbind drops the shortcut from the hint.
  const newChatCombo = useKeybindHint('session.new')

  const sessionHint = (description: string) =>
    description.includes('{shortcut}')
      ? newChatCombo
        ? description.replace('{shortcut}', newChatCombo)
        : c.newChatHintUnbound
      : description

  return (
    <SettingsContent>
      <SettingRow hint={c.hint} title={c.title} />

      <SectionHeading icon={MessageCircle} title={c.sessionsHeading} />
      <div className="h-[52vh] min-h-72 overflow-hidden rounded-xl border border-(--dt-border) bg-(--dt-secondary)/40">
        <WiredPane part="sidebar" />
      </div>
      {c.sessions.map(([title, description]) => (
        <SettingRow hint={sessionHint(description)} key={title} title={title} />
      ))}

      <SectionHeading icon={Users} title={c.botsHeading} />
      {botsPane?.render ? (
        <div className="h-[46vh] min-h-64 overflow-hidden rounded-xl border border-(--dt-border) bg-(--dt-secondary)/40">
          <ContribRender render={botsPane.render} />
        </div>
      ) : (
        <SettingRow hint={c.botsUnavailableHint} title={c.botsUnavailable} />
      )}
      {c.bots.map(([title, description]) => (
        <SettingRow hint={description} key={title} title={title} />
      ))}
    </SettingsContent>
  )
}
