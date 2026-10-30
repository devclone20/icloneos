import { useEffect, useState } from 'react'

import type { ProfileScope } from '@/api/client'
import { renameProfile } from '@/hermes'
import { useI18n } from '@/i18n'
import { slug } from '@/lib/sanitize'
import { retireLocalProfileGateways } from '@/store/gateway'

import { isValidProfileName } from './create-profile-dialog'
import { type IcActionState, IcDialog, IcField, IcTextInput } from './ic-page'
import { ProfileDialogFooter } from './profile-dialog-footer'

// Display names are free text (Unicode fine) — no slug sanitizing.
const identity = (raw: string) => raw

// Self-contained rename (owns the renameProfile call) so every caller just
// reacts via onRenamed. Unchanged name is a no-op close.
export function RenameProfileDialog({
  currentName,
  isDefault = false,
  onClose,
  onRenamed,
  open,
  scope
}: {
  currentName: string
  /** Default profile: sets a presentation-only display name (Unicode ok);
   *  the canonical id stays "default" and no backend teardown is needed. */
  isDefault?: boolean
  onClose: () => void
  onRenamed?: (name: string) => Promise<void> | void
  open: boolean
  /** Explicit (connection, profile) owner for a remote-gateway profile: the
   *  rename executes there and no local backend is retired. */
  scope?: ProfileScope
}) {
  const { t } = useI18n()
  const p = t.profiles
  const [name, setName] = useState(currentName)
  const [status, setStatus] = useState<IcActionState>('idle')
  const [error, setError] = useState<null | string>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    // Display-name mode starts blank — "default" is the id, not a name.
    setName(isDefault ? '' : currentName)
    setError(null)
    setStatus('idle')
  }, [currentName, isDefault, open])

  const trimmed = name.trim()
  const unchanged = !isDefault && trimmed === currentName
  const invalid = trimmed !== '' && !unchanged && !isDefault && !isValidProfileName(trimmed)
  const busy = status === 'saving' || status === 'done'

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    if (unchanged) {
      onClose()

      return
    }

    if (!trimmed || invalid) {
      setError(invalid ? p.invalidName(p.nameHint) : p.nameRequired)

      return
    }

    setStatus('saving')
    setError(null)

    try {
      // A retained renderer socket for the old name would treat the rename's
      // backend teardown as a transient drop and redial, resurrecting the
      // old-name backend whose ensure_hermes_home() recreates the directory
      // the rename just moved (same class as the delete path, #88638).
      if (!isDefault && scope == null) {
        retireLocalProfileGateways(currentName)
      }

      await (scope == null ? renameProfile(currentName, trimmed) : renameProfile(currentName, trimmed, scope))
      await onRenamed?.(trimmed)
      setStatus('done')
      globalThis.setTimeout(onClose, 800)
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : p.failedRename)
    }
  }

  return (
    <IcDialog
      busy={busy}
      description={
        isDefault ? (
          p.displayNameDesc
        ) : (
          <>
            {p.renameDescPrefix}
            <span className="icpg__code">~/.local/bin</span>
            {p.renameDescSuffix}
          </>
        )
      }
      footer={
        <ProfileDialogFooter
          busy={busy}
          error={error}
          labels={{ busy: p.renaming, done: p.renamed, idle: p.rename }}
          onClose={onClose}
          status={status}
          submitDisabled={busy || invalid || unchanged}
        />
      }
      onClose={onClose}
      onSubmit={handleSubmit}
      open={open}
      title={isDefault ? p.displayNameTitle : p.renameOf(currentName)}
    >
      <IcField
        hint={isDefault ? undefined : p.nameHint}
        hintError={invalid}
        htmlFor="rename-profile-name"
        label={isDefault ? p.displayNameLabel : p.newNameLabel}
      >
        <IcTextInput
          firstFocus
          id="rename-profile-name"
          invalid={invalid}
          onValueChange={setName}
          sanitize={isDefault ? identity : slug}
          value={name}
        />
      </IcField>
    </IcDialog>
  )
}
