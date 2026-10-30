/**
 * Messaging — the detail column of OUR page: one platform's state, its pairing
 * requests, its setup form and the hint under its title. Split out of
 * `index.tsx` in r5 (the page was 930 lines, over the plan's 900) — behaviour
 * unchanged, which its tests in `index.test.tsx` still prove through the page.
 */

import { useState } from 'react'

import { type MessagingPlatformInfo, type PairingUser } from '@/hermes'
import { useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { ExternalLink } from '@/lib/icons'

import { IcAlert, IcDisclosure, IcDot, IcPageButton, IcPagePill, IcPageSection } from '../profiles/ic-page'
import { SettingRow } from '../settings/setting-row'

import { secretKeysDropped } from './env-draft'
import { IcPlatformAvatar } from './ic-platform-avatar'
import { fieldCopy, MessagingField } from './messaging-field'
import { introCopy, summaryCopy } from './platform-intro'
import { pairingKey, pairingLabel, secretKeysOf, stateLabel, stateTone } from './platform-state'

export function PlatformDetail({
  approved,
  approving,
  edits,
  onApprove,
  onClear,
  onEdit,
  onRevoke,
  pending,
  platform,
  resuming,
  saving
}: {
  approved: PairingUser[]
  approving: null | string
  edits: Record<string, string>
  onApprove: (user: PairingUser) => void
  onClear: (key: string) => void
  onEdit: (key: string, value: string) => void
  onRevoke: (user: PairingUser) => void
  pending: PairingUser[]
  platform: MessagingPlatformInfo
  /** This platform's draft came back from storage — see the notice below. */
  resuming: boolean
  saving: string | null
}) {
  const { t } = useI18n()
  const m = t.messaging
  const [showAdvanced, setShowAdvanced] = useState(false)

  const requiredFields = platform.env_vars.filter(field => field.required)
  const optionalFields = platform.env_vars.filter(field => !field.required && !fieldCopy(field, m).advanced)
  const advancedFields = platform.env_vars.filter(field => !field.required && fieldCopy(field, m).advanced)
  // A secret never reaches the draft store, so after a reload its field is
  // empty while the rest of the form came back. Name the FIELDS by their own
  // localized labels — never the env id, and never "unsaved changes", which
  // says the opposite of what happened (critic r2, E3d2-T3) — each with its
  // own true status: the backend still holds a saved one (retype it to change
  // it), an unset one is simply empty. A SET secret belongs in the list: a
  // user who retyped a stored token and reloaded is the one who really lost
  // typed work, and used to be told nothing (critic r3, E3d2-M1). A secret
  // typed in THIS session has a value on screen, so it is excluded: that is
  // what `secretKeysDropped` reports.
  const typedSecrets = new Set(secretKeysDropped(edits, secretKeysOf(platform)))

  const valuelessSecrets = platform.env_vars
    .filter(field => field.is_password && !typedSecrets.has(field.key))
    .map(field => `${fieldCopy(field, m).name}: ${field.is_set ? m.replaceValue : t.common.notSet}`)

  return (
    // One column that never shrinks below its content: the detail pane scrolls instead, so at large text a
    // section's note cannot paint over the next section. Section labels read as sentences, not capitals
    // (important: the chassis stylesheet is unlayered, so a layered utility alone loses to it).
    <div
      className="flex shrink-0 flex-col gap-4.5 [&_section_h3]:tracking-normal! [&_section_h3]:normal-case!"
      data-messaging-detail=""
    >
      <header className="icpg__detail-head">
        <h3 className="icpg__detail-title">
          <IcPlatformAvatar platformId={platform.id} platformName={platform.name} />
          {platform.name}
          <IcPagePill tone={stateTone(platform)}>
            <IcDot tone={stateTone(platform)} />
            {stateLabel(platform.state, m)}
          </IcPagePill>
          {/* Resting states earn no pill — only actionable ones. */}
          {!platform.configured ? <IcPagePill>{m.needsSetup}</IcPagePill> : null}
          {!platform.gateway_running ? <IcPagePill>{m.gatewayStopped}</IcPagePill> : null}
        </h3>
        {summaryCopy(platform, m) ? <p className="icpg__listrow-hint">{summaryCopy(platform, m)}</p> : null}
        <PlatformHint platform={platform} />
      </header>

      {platform.error_message ? <IcAlert>{platform.error_message}</IcAlert> : null}

      {/* A secret in a draft would be a credential on disk, so it is kept in
          memory only. Saying which field is still empty beats losing one field
          out of four in silence — but only once there is restored work to
          explain, never as permanent chrome on an untouched platform. */}
      {resuming && valuelessSecrets.length > 0 ? (
        <p aria-live="polite" className="icpg__listrow-hint">
          {m.draftSecretNotKept} {valuelessSecrets.join(' · ')}
        </p>
      ) : null}

      {/* Pending pairing requests. Rendered only when someone is actually
          waiting — an empty-state card here would be permanent chrome on a
          page that is usually about credentials, not approvals. */}
      {pending.length > 0 ? (
        <IcPageSection label={m.pendingRequests(pending.length)}>
          <div className="icpg__stack">
            {pending.map(user => {
              const busy = approving === pairingKey(user)
              const waited = typeof user.age_minutes === 'number' ? m.waitingSince(user.age_minutes) : null

              return (
                <SettingRow
                  control={
                    <IcPageButton disabled={busy || !user.request_id} onClick={() => onApprove(user)}>
                      {busy ? m.approving : m.approve}
                    </IcPageButton>
                  }
                  // An unnamed requester is only a user id — showing it as
                  // both title and description just repeats itself.
                  hint={[user.user_name ? user.user_id : null, waited].filter(Boolean).join(' · ')}
                  key={pairingKey(user)}
                  title={pairingLabel(user)}
                />
              )
            })}
          </div>
        </IcPageSection>
      ) : null}

      {approved.length > 0 ? (
        <IcPageSection label={m.approvedUsers(approved.length)}>
          <div className="icpg__stack">
            {approved.map(user => (
              <SettingRow
                control={
                  <IcPageButton onClick={() => onRevoke(user)} tone="quiet">
                    <span aria-label={m.revokeAria(pairingLabel(user))}>{m.revoke}</span>
                  </IcPageButton>
                }
                hint={user.user_name ? user.user_id : undefined}
                key={pairingKey(user)}
                title={pairingLabel(user)}
              />
            ))}
          </div>
        </IcPageSection>
      ) : null}

      <IcPageSection label={m.getCredentials} note={introCopy(platform, m)}>
        {platform.docs_url ? (
          <IcPageButton
            onClick={() => {
              // Route through the validated external opener instead of an
              // anchor: a packaged build's empty/relative href resolves to the
              // app's own index.html path, which shell.openPath then fails to
              // open. Plugin platforms ship no docs_url, so the guard above
              // keeps the control from ever pointing at a local bundle path.
              openExternalLink(platform.docs_url)
            }}
          >
            {m.openSetupGuide}
            <ExternalLink aria-hidden="true" size={13} />
          </IcPageButton>
        ) : null}
      </IcPageSection>

      <IcPageSection label={m.required}>
        <div className="icpg__stack">
          {requiredFields.length > 0 ? (
            requiredFields.map(field => (
              <MessagingField
                edits={edits}
                field={field}
                key={field.key}
                onClear={onClear}
                onEdit={onEdit}
                saving={saving}
              />
            ))
          ) : (
            <p className="icpg__listrow-hint">{m.noTokenNeeded}</p>
          )}
        </div>
      </IcPageSection>

      {optionalFields.length > 0 ? (
        <IcPageSection label={m.recommended}>
          <div className="icpg__stack">
            {optionalFields.map(field => (
              <MessagingField
                edits={edits}
                field={field}
                key={field.key}
                onClear={onClear}
                onEdit={onEdit}
                saving={saving}
              />
            ))}
          </div>
        </IcPageSection>
      ) : null}

      {advancedFields.length > 0 ? (
        <IcDisclosure
          label={m.advanced(advancedFields.length)}
          onToggle={() => setShowAdvanced(value => !value)}
          open={showAdvanced}
        >
          {advancedFields.map(field => (
            <MessagingField
              edits={edits}
              field={field}
              key={field.key}
              onClear={onClear}
              onEdit={onEdit}
              saving={saving}
            />
          ))}
        </IcDisclosure>
      ) : null}
    </div>
  )
}

function PlatformHint({ platform }: { platform: MessagingPlatformInfo }) {
  const { t } = useI18n()

  if (!platform.enabled || platform.state === 'connected') {
    return null
  }

  const hint =
    platform.state === 'pending_restart'
      ? t.messaging.hintPendingRestart
      : platform.gateway_running
        ? null
        : t.messaging.hintGatewayStopped

  return hint ? <p className="icpg__listrow-hint">{hint}</p> : null
}
