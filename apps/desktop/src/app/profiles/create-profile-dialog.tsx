import { useEffect, useState } from 'react'

import { createProfile, updateProfileSoul } from '@/hermes'
import { useI18n } from '@/i18n'
import { slug } from '@/lib/sanitize'
import type { ProfileInfo } from '@/types/hermes'

import { type IcActionState, IcDialog, IcField, IcSelect, IcTextarea, IcTextInput } from './ic-page'
import { ProfileDialogFooter } from './profile-dialog-footer'

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

const CLONE_FROM_NONE = '__none__'

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name.trim())
}

// Self-contained create flow (name + clone toggle + optional SOUL.md). Owns the
// createProfile/updateProfileSoul calls so every caller just refreshes/selects
// via onCreated. SOUL left blank keeps the cloned/blank persona untouched.
export function CreateProfileDialog({
  onClose,
  onCreated,
  open,
  profiles = []
}: {
  onClose: () => void
  onCreated?: (name: string) => Promise<void> | void
  open: boolean
  profiles?: ProfileInfo[]
}) {
  const { t } = useI18n()
  const p = t.profiles
  const [name, setName] = useState('')
  const [cloneFrom, setCloneFrom] = useState<null | string>('default')
  const [soul, setSoul] = useState('')
  const [status, setStatus] = useState<IcActionState>('idle')
  const [error, setError] = useState<null | string>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    setName('')
    setCloneFrom('default')
    setSoul('')
    setError(null)
    setStatus('idle')
  }, [open])

  const trimmed = name.trim()
  const invalid = trimmed !== '' && !isValidProfileName(trimmed)
  const busy = status === 'saving' || status === 'done'

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    if (!trimmed || invalid) {
      setError(invalid ? p.invalidName(p.nameHint) : p.nameRequired)

      return
    }

    setStatus('saving')
    setError(null)

    try {
      await createProfile({ name: trimmed, clone_from: cloneFrom })

      if (soul.trim()) {
        await updateProfileSoul(trimmed, soul)
      }

      await onCreated?.(trimmed)
      setStatus('done')
      globalThis.setTimeout(onClose, 800)
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : p.failedCreate)
    }
  }

  return (
    <IcDialog
      busy={busy}
      description={p.createDesc}
      footer={
        <ProfileDialogFooter
          busy={busy}
          error={error}
          labels={{ busy: p.creating, done: p.created, idle: p.createAction }}
          onClose={onClose}
          status={status}
          submitDisabled={busy || !trimmed || invalid}
        />
      }
      onClose={onClose}
      onSubmit={handleSubmit}
      open={open}
      title={p.newProfile}
    >
      <IcField hint={p.nameHint} hintError={invalid} htmlFor="new-profile-name" label={p.nameLabel}>
        <IcTextInput
          firstFocus
          id="new-profile-name"
          invalid={invalid}
          onValueChange={setName}
          placeholder="my-profile"
          sanitize={slug}
          value={name}
        />
      </IcField>

      <IcField hint={p.cloneFromDesc} htmlFor="new-profile-clone-from" label={p.cloneFrom}>
        <IcSelect
          id="new-profile-clone-from"
          onValueChange={value => setCloneFrom(value === CLONE_FROM_NONE ? null : value)}
          options={[
            { label: p.cloneFromNone, value: CLONE_FROM_NONE },
            ...profiles.map(profile => ({ label: profile.name, value: profile.name }))
          ]}
          value={cloneFrom ?? CLONE_FROM_NONE}
        />
      </IcField>

      <IcField htmlFor="new-profile-soul" label={p.soulLabel} optionalLabel={p.soulOptional}>
        <IcTextarea
          compact
          id="new-profile-soul"
          onValueChange={setSoul}
          placeholder={p.soulPlaceholder(cloneFrom ? p.soulPlaceholderCloned : p.soulPlaceholderEmpty)}
          value={soul}
        />
      </IcField>
    </IcDialog>
  )
}
