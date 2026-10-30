import { useStore } from '@nanostores/react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { COMPLETION_SOUND_VARIANTS, completionSoundName, previewCompletionSound } from '@/lib/completion-sound'
import { triggerHaptic } from '@/lib/haptics'
import { Bell, Play } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $completionSoundVariantId, setCompletionSoundVariantId } from '@/store/completion-sound'
import {
  $nativeNotifyPrefs,
  NATIVE_NOTIFICATION_KINDS,
  sendTestNativeNotification,
  setNativeNotifyEnabled,
  setNativeNotifyKind
} from '@/store/native-notifications'
import { notify } from '@/store/notifications'

import { CONTROL_TEXT } from './constants'
import { SectionHeading, SettingsContent } from './primitives'
import { SettingRow } from './setting-row'

const CAPTION = 'text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)'

function Caption({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn(CAPTION, className)}>{children}</p>
}

export function NotificationsSettings() {
  const { locale, t } = useI18n()
  const prefs = useStore($nativeNotifyPrefs)
  const completionSoundVariantId = useStore($completionSoundVariantId)
  const copy = t.settings.notifications

  const runTest = async () => {
    triggerHaptic('open')
    const ok = await sendTestNativeNotification(copy.testTitle, copy.testBody)
    notify({ kind: ok ? 'info' : 'error', message: ok ? copy.testSent : copy.testUnsupported })
  }

  return (
    <SettingsContent>
      <SectionHeading icon={Bell} title={copy.title} />
      <Caption className="mb-2 leading-(--conversation-caption-line-height)">{copy.intro}</Caption>

      <SettingRow
        control={
          <Switch
            aria-label={copy.enableAll}
            checked={prefs.enabled}
            onCheckedChange={on => {
              triggerHaptic('selection')
              setNativeNotifyEnabled(on)
            }}
          />
        }
        hint={copy.enableAllDesc}
        title={copy.enableAll}
      />

      {NATIVE_NOTIFICATION_KINDS.map(kind => (
        <SettingRow
          control={
            <Switch
              aria-label={copy.kinds[kind].label}
              checked={prefs.enabled && prefs.kinds[kind]}
              disabled={!prefs.enabled}
              onCheckedChange={on => {
                triggerHaptic('selection')
                setNativeNotifyKind(kind, on)
              }}
            />
          }
          disabled={!prefs.enabled}
          hint={copy.kinds[kind].description}
          key={kind}
          title={copy.kinds[kind].label}
        />
      ))}

      <SettingRow
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Select
              onValueChange={value => {
                const variantId = Number.parseInt(value, 10)

                setCompletionSoundVariantId(variantId)
                previewCompletionSound(variantId)
                triggerHaptic('selection')
              }}
              value={String(completionSoundVariantId)}
            >
              <SelectTrigger className={cn('min-w-56', CONTROL_TEXT)}>
                <SelectValue />
              </SelectTrigger>

              <SelectContent>
                {COMPLETION_SOUND_VARIANTS.map(variant => (
                  <SelectItem key={variant.id} value={String(variant.id)}>
                    {completionSoundName(variant, locale)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              className="gap-1.5"
              onClick={() => {
                previewCompletionSound()
                triggerHaptic('crisp')
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              <Play className="size-3.5" />
              {copy.completionSoundPreview}
            </Button>
          </div>
        }
        field
        hint={copy.completionSoundDesc}
        title={copy.completionSoundTitle}
      />

      <SettingRow
        control={
          <Button onClick={() => void runTest()} size="sm" type="button" variant="outline">
            <Bell />
            {copy.test}
          </Button>
        }
        hint={copy.focusedHint}
        title={copy.testTitle}
        wide
      />
    </SettingsContent>
  )
}
