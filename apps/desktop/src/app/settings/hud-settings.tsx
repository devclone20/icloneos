/**
 * HUD — the dedicated Settings pane for the floating HUD window (owner rule:
 * "o hud mode é a melhor coisa que tem, aprimore ele… uma definição
 * perfeita no settings dedicado").
 *
 * The HUD is the app with its frame removed: a Spotlight-style bar that
 * floats above every app, always on top, with the reply band fading in
 * above it. This pane explains it, launches it, and owns its knobs — reply
 * band hold, native frost, click-through — all live even while a HUD is
 * open (prefs sync cross-window).
 */
import { useStore } from '@nanostores/react'
import type { JSX } from 'react'

import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { Command, Keyboard } from '@/lib/icons'
import { canUseHud, resetHudLayout, toggleHud } from '@/store/hud'

import { hudTargetSessionId } from '../hud/handoff'
import {
  $hudClickThroughEnabled,
  $hudFrostEnabled,
  $hudHoldMs,
  HUD_HOLD_MAX_MS,
  HUD_HOLD_MIN_MS,
  setHudClickThroughEnabled,
  setHudFrostEnabled,
  setHudHoldMs
} from '../hud/prefs'

import { SectionHeading, SettingsContent } from './primitives'
import { SettingRow } from './setting-row'

const KEY_ORDER = ['toggle', 'snap', 'exit', 'close'] as const

export function HudSettings({ navigate }: { navigate: (route: string) => void }): JSX.Element {
  const { t } = useI18n()
  const copy = t.settings.hud
  const holdMs = useStore($hudHoldMs)
  const frost = useStore($hudFrostEnabled)
  const clickThrough = useStore($hudClickThroughEnabled)

  return (
    <SettingsContent>
      <SettingRow hint={copy.introHint} title={copy.introTitle} />
      <SettingRow
        control={
          <Button disabled={!canUseHud()} onClick={() => toggleHud(hudTargetSessionId())} size="sm" variant="secondary">
            {copy.open}
          </Button>
        }
        hint={copy.openNowHint}
        title={copy.openTitle}
      />
      <SettingRow
        control={
          <Button onClick={() => resetHudLayout()} size="sm" variant="ghost">
            {copy.reset}
          </Button>
        }
        hint={copy.openHint}
        title={copy.resetTitle}
      />
      <SettingRow
        control={
          <input
            aria-label={copy.holdAria}
            className="w-40 accent-(--dt-midground)"
            max={HUD_HOLD_MAX_MS}
            min={HUD_HOLD_MIN_MS}
            onChange={event => setHudHoldMs(Number(event.target.value))}
            step={100}
            type="range"
            value={holdMs}
          />
        }
        hint={copy.holdHint(String(Math.round(holdMs / 100) / 10))}
        title={copy.holdTitle}
      />
      <SettingRow
        control={<Switch aria-label={copy.frostTitle} checked={frost} onCheckedChange={setHudFrostEnabled} />}
        hint={copy.frostHint}
        title={copy.frostTitle}
      />
      <SettingRow
        control={
          <Switch
            aria-label={copy.clickThroughTitle}
            checked={clickThrough}
            onCheckedChange={setHudClickThroughEnabled}
          />
        }
        hint={copy.clickThroughHint}
        title={copy.clickThroughTitle}
      />

      <SectionHeading icon={Keyboard} title={copy.keysHeading} />
      <SettingRow
        control={
          <Button onClick={() => navigate('/settings?tab=keybinds')} size="sm" variant="ghost">
            {copy.rebind}
          </Button>
        }
        hint={copy.rebindHint}
        title={copy.rebindTitle}
      />
      {KEY_ORDER.map(id => (
        <SettingRow control={<Kbd>{copy.keys[id].keys}</Kbd>} key={id} title={copy.keys[id].title} />
      ))}

      <SectionHeading icon={Command} title={copy.behaviourHeading} />
      <SettingRow hint={copy.bandHint} title={copy.bandTitle} />
      <SettingRow hint={copy.handoffHint} title={copy.handoffTitle} />
    </SettingsContent>
  )
}
