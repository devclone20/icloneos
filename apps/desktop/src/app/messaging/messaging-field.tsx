/**
 * Messaging — one env-var field of the setup form, and the copy rules that say
 * where it belongs. Split out of `index.tsx` in r5: the page was 930 lines,
 * over this plan's 900-line ceiling, and the field is the one part of it that
 * knows nothing about the page (critic r4, minor 1).
 */

import { type MessagingEnvVarInfo } from '@/hermes'
import { type Translations, useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { ExternalLink, Trash2 } from '@/lib/icons'

import { IcPageButton, IcPagePill, IcTextInput } from '../profiles/ic-page'
import { SettingRow } from '../settings/setting-row'

const FIELD_COPY: Record<string, { advanced?: boolean }> = {
  TELEGRAM_PROXY: { advanced: true },
  DISCORD_REPLY_TO_MODE: { advanced: true },
  DISCORD_ALLOW_ALL_USERS: { advanced: true },
  DISCORD_HOME_CHANNEL: { advanced: true },
  DISCORD_HOME_CHANNEL_NAME: { advanced: true },
  BLUEBUBBLES_ALLOW_ALL_USERS: { advanced: true },
  MATTERMOST_ALLOW_ALL_USERS: { advanced: true },
  MATTERMOST_HOME_CHANNEL: { advanced: true },
  QQ_ALLOW_ALL_USERS: { advanced: true },
  QQBOT_HOME_CHANNEL: { advanced: true },
  QQBOT_HOME_CHANNEL_NAME: { advanced: true },
  WHATSAPP_ENABLED: { advanced: true },
  WHATSAPP_MODE: { advanced: true }
}

export function fieldCopy(field: MessagingEnvVarInfo, m: Translations['messaging']) {
  const copy = FIELD_COPY[field.key] || {}
  const localized = m.fieldCopy[field.key] || {}

  return {
    // Words come from the catalogue only (ruling S27.1): the backend's prompt and description are English
    // and name the runtime, so a field the catalogue misses gets a neutral sentence and no help at all.
    label: localized.label || m.fieldFallbackLabel,
    // The title is a whole sentence; notices and the empty field use the short noun instead.
    name: localized.name || m.fieldFallbackName,
    help: localized.help || '',
    placeholder: localized.placeholder || localized.name || '',
    advanced: Boolean(copy.advanced || field.advanced)
  }
}

export function MessagingField({
  edits,
  field,
  onClear,
  onEdit,
  saving
}: {
  edits: Record<string, string>
  field: MessagingEnvVarInfo
  onClear: (key: string) => void
  onEdit: (key: string, value: string) => void
  saving: string | null
}) {
  const { t } = useI18n()
  const m = t.messaging
  const copy = fieldCopy(field, m)
  const fieldId = `messaging-field-${field.key}`
  const docsUrl = field.url

  return (
    <SettingRow
      control={
        <div className="flex w-full min-w-0 items-center gap-1">
          <IcTextInput
            id={fieldId}
            onValueChange={value => onEdit(field.key, value)}
            placeholder={field.is_set ? field.redacted_value || m.replaceValue : copy.placeholder}
            secret={field.is_password}
            value={edits[field.key] || ''}
          />
          {docsUrl ? (
            <IcPageButton onClick={() => openExternalLink(docsUrl)} tone="quiet">
              <span aria-label={m.openDocs}>
                <ExternalLink aria-hidden="true" size={13} />
              </span>
            </IcPageButton>
          ) : null}
          {field.is_set ? (
            <IcPageButton disabled={saving === `clear:${field.key}`} onClick={() => onClear(field.key)} tone="danger">
              <span aria-label={m.clearField(field.key)}>
                <Trash2 aria-hidden="true" size={13} />
              </span>
            </IcPageButton>
          ) : null}
        </div>
      }
      field
      hint={copy.help}
      title={
        <>
          <label htmlFor={fieldId}>{copy.label}</label>
          {field.is_set ? <IcPagePill tone="good">{m.saved}</IcPagePill> : null}
        </>
      }
    />
  )
}
