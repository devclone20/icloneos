/**
 * Messaging — OUR page (E3 decision #8, 2026-10-18): the rail, the detail, the
 * states and every control are our own (`../profiles/ic-page.tsx` on the
 * `--ic-*` tokens). What it reuses is logic only: the Hermes platform/pairing
 * calls, the live-sync stores, the credential-removal path and the route hooks.
 *
 * Three things the page it replaces did not do:
 * - a failed load is an inline error with a retry, not a toast over a spinner;
 * - no platforms at all reads as an empty state instead of a blank column;
 * - a half-filled setup form survives a reload (`env-draft.ts`) — except a
 *   secret, which is deliberately never written to disk.
 *
 * Since front K5 (2026-10-20) this page has exactly ONE home: the Messaging
 * topic inside Settings. `frame="bare"` is therefore permanent rather than a
 * concession to the old overlay wrapper — the Settings card is the only card,
 * and it owns Esc and the ✕ — and the view takes no props at all.
 *
 * THE SETUP DRAFT SURVIVES THE MOVE (front K5, the question K3 had to answer
 * for the profiles store). `env-draft.ts` persists a half-filled form under
 * `hermes.desktop.messaging.envDrafts.v1`, keyed by profile + platform + field
 * and NEVER holding a secret. Nothing outside this folder reads that key
 * (`readEnvDrafts` / `writeEnvDraft` / `clearEnvDraft` have no other caller),
 * it is keyed by the data and not by the route, and this component is the same
 * component in its new home — so a draft written from the old overlay is read
 * back verbatim in the pane, and `clearEnvDraft` still fires on a successful
 * save. Retiring `/messaging` therefore strands nothing. The one thing a reader
 * must not infer: the key is NOT swept here, so a draft for a platform the user
 * abandoned outlives the move, exactly as it outlived a reload before it.
 */
import { useStore } from '@nanostores/react'
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  approvePairing,
  getMessagingPlatforms,
  getPairing,
  type MessagingPlatformInfo,
  type PairingUser,
  revokePairing,
  updateMessagingPlatform
} from '@/hermes'
import { useI18n } from '@/i18n'
import { Save } from '@/lib/icons'
import { normalize } from '@/lib/text'
import { $changeEventsAvailable, $pairingChangeTick, $platformsChangeTick } from '@/store/live-sync'
import { notify, notifyError } from '@/store/notifications'
import { $settingsRequestProfile } from '@/store/settings-scope'
import { runGatewayRestart } from '@/store/system-actions'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import {
  IcConfirmDialog,
  IcDot,
  IcPage,
  IcPageBody,
  IcPageButton,
  IcPageDetail,
  IcPagePill,
  IcPageRail,
  IcPageState,
  IcSwitch
} from '../profiles/ic-page'
import { runRemoval } from '../settings/credential-removal'
import { SettingsProfileScope } from '../settings/profile-scope'

import { messagingFault } from './dev-fault'
import { clearEnvDraft, draftKey, readEnvDrafts, readEnvDraftSnapshot, writeEnvDraft } from './env-draft'
import { IcPlatformAvatar } from './ic-platform-avatar'
import { PlatformDetail } from './platform-detail'
import { pairingKey, pairingLabel, secretKeysOf, stateTone } from './platform-state'

type EditMap = Record<string, Record<string, string>>

type Load = { kind: 'error'; message: string } | { kind: 'loading' } | { kind: 'ready' }

const trimEdits = (edits: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(edits)
      .map(([k, v]) => [k, v.trim()])
      .filter(([, v]) => v)
  )

/** Group pairing rows by platform id so a detail pane can slice its own. */
function byPlatform(rows: PairingUser[]): Record<string, PairingUser[]> {
  const grouped: Record<string, PairingUser[]> = {}

  for (const row of rows) {
    ;(grouped[row.platform] ||= []).push(row)
  }

  return grouped
}

export function MessagingView() {
  const { t } = useI18n()
  const m = t.messaging
  // Shared settings "Applies to" scope, request-shaped (undefined → follow
  // the active profile; the API helpers treat null as "target primary").
  const scopeProfile = useStore($settingsRequestProfile)
  // Both save/toggle toasts offer the same one-click restart.
  const restartGatewayAction = { label: t.commandCenter.restartGateway, onClick: () => void runGatewayRestart() }
  const [platforms, setPlatforms] = useState<MessagingPlatformInfo[] | null>(null)
  const [load, setLoad] = useState<Load>({ kind: 'loading' })

  const [pairing, setPairing] = useState<{ approved: PairingUser[]; pending: PairingUser[] }>({
    approved: [],
    pending: []
  })

  const [approving, setApproving] = useState<null | string>(null)
  const [pendingRevoke, setPendingRevoke] = useState<null | PairingUser>(null)
  // Seeded from the stored drafts, so a reload mid-setup costs nothing.
  const [seed] = useState(readEnvDraftSnapshot)
  const [edits, setEdits] = useState<EditMap>(seed.edits)
  // The slots whose drafts actually CAME BACK, read once from that same seed.
  // "The user typed something" is a different question: on a fresh form it is
  // true although nothing was lost, which is what used to decide whether the
  // dropped-secret notice appeared (critic r3, E3d2-M1). The slots come from
  // the seed and not from the keys of `edits`, because a slot can come back
  // with no values at all — a form where only the token was typed keeps a
  // marker row (critic r4, E3d2-M3). Drafts are keyed by (scope, platform) and
  // the seed holds every scope, so a later scope switch needs no second read.
  const [restoredSlots] = useState<ReadonlySet<string>>(() => new Set(seed.slots))
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const platformIds = useMemo(() => platforms?.map(p => p.id) ?? [], [platforms])
  const [selectedId, setSelectedId] = useRouteEnumParam('platform', platformIds, platformIds[0] ?? '')

  const refreshPlatforms = useCallback(
    async (silent = false) => {
      try {
        // Dev-only (see ./dev-fault): the only way a lab probe can reach the
        // two branches below, which the frozen preload bridge puts out of
        // reach. Always undefined in a production build.
        const fault = messagingFault()

        if (fault === 'error') {
          throw new Error(m.loadFailed)
        }

        const result = fault === 'empty' ? { platforms: [] } : await getMessagingPlatforms(scopeProfile)

        setPlatforms(result.platforms)
        setLoad({ kind: 'ready' })
      } catch (err) {
        if (!silent) {
          // Inline and retryable: a toast over an endless spinner left the user
          // with no way back into the page.
          setLoad({ kind: 'error', message: err instanceof Error ? err.message : m.loadFailed })
          notifyError(err, m.loadFailed)
        }
      }
    },
    [m, scopeProfile]
  )

  // Pairing has its own signal. platforms.changed tracks connect/disconnect
  // health via gateway_state.json, which a new pairing request never moves —
  // riding it would leave a pending row invisible until something unrelated
  // reconnected. Failures stay silent: an older backend without the endpoint
  // should show no rows, not an error banner over a working page.
  const refreshPairing = useCallback(async () => {
    try {
      const result = await getPairing(scopeProfile)
      setPairing({ approved: result.approved ?? [], pending: result.pending ?? [] })
    } catch {
      // Leave the last known rows in place rather than blanking them.
    }
  }, [scopeProfile])

  const refreshAll = useCallback(
    async (silent = false) => {
      await Promise.all([refreshPlatforms(silent), refreshPairing()])
    },
    [refreshPairing, refreshPlatforms]
  )

  useRefreshHotkey(() => void refreshAll())

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  // Scope switch: the mounted list still shows the PREVIOUS profile's
  // platforms/pairing while the new fetch is in flight — blank it so stale
  // rows can't be toggled against the wrong backend. Drafts are keyed by scope,
  // so the new scope's own saved drafts come back with it.
  const scopeSeenRef = useRef(scopeProfile)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (scope-change guard)
  useEffect(() => {
    if (scopeSeenRef.current === scopeProfile) {
      return
    }

    scopeSeenRef.current = scopeProfile
    setPlatforms(null)
    setLoad({ kind: 'loading' })
    setPairing({ approved: [], pending: [] })
    setEdits(readEnvDrafts())
  }, [scopeProfile])

  const changeEventsAvailable = useStore($changeEventsAvailable)
  const platformsChangeTick = useStore($platformsChangeTick)
  const pairingChangeTick = useStore($pairingChangeTick)

  // A new pending request (or a grant from another surface) moves the pairing
  // store on disk; the change watcher turns that into pairing.changed.
  useEffect(() => {
    if (!changeEventsAvailable || pairingChangeTick === 0 || globalThis.document.hidden) {
      return
    }

    void refreshPairing()
  }, [changeEventsAvailable, pairingChangeTick, refreshPairing])

  // Connection status updates without a manual "check" click. platforms.changed
  // (the gateway persisting connect/disconnect/health to gateway_state.json)
  // drives the refresh on event-capable backends — no timer; older backends
  // keep the legacy visible-tab poll.
  useEffect(() => {
    if (!changeEventsAvailable || platformsChangeTick === 0 || globalThis.document.hidden) {
      return
    }

    void refreshPlatforms(true)
  }, [changeEventsAvailable, platformsChangeTick, refreshPlatforms])

  useEffect(() => {
    if (changeEventsAvailable) {
      return
    }

    let cancelled = false

    function tick() {
      if (cancelled || globalThis.document.hidden) {
        return
      }

      void refreshAll(true)
    }

    const id = globalThis.setInterval(tick, 6000)

    return () => {
      cancelled = true
      globalThis.clearInterval(id)
    }
  }, [changeEventsAvailable, refreshAll])

  const selected = useMemo(() => {
    if (!platforms) {
      return null
    }

    return platforms.find(platform => platform.id === selectedId) || platforms[0] || null
  }, [platforms, selectedId])

  const pendingByPlatform = useMemo(() => byPlatform(pairing.pending), [pairing.pending])
  const approvedByPlatform = useMemo(() => byPlatform(pairing.approved), [pairing.approved])

  const visiblePlatforms = useMemo(() => {
    if (!platforms) {
      return []
    }

    const q = normalize(query)

    if (!q) {
      return platforms
    }

    return platforms.filter(platform =>
      [platform.id, platform.name, platform.description, platform.state]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(q))
    )
  }, [platforms, query])

  /** One writer for the edit map: React state and the stored draft together. */
  const recordEdit = useCallback(
    (platform: MessagingPlatformInfo, key: string, value: string) => {
      setEdits(current => {
        const fields = { ...(current[draftKey(scopeProfile, platform.id)] || {}), [key]: value }

        writeEnvDraft(draftKey(scopeProfile, platform.id), fields, secretKeysOf(platform))

        return { ...current, [draftKey(scopeProfile, platform.id)]: fields }
      })
    },
    [scopeProfile]
  )

  async function handleToggle(platform: MessagingPlatformInfo, enabled: boolean) {
    setSaving(`enabled:${platform.id}`)

    try {
      await updateMessagingPlatform(platform.id, { enabled }, scopeProfile)
      setPlatforms(
        current =>
          current?.map(row =>
            row.id === platform.id
              ? {
                  ...row,
                  enabled,
                  state: enabled ? (row.configured ? 'pending_restart' : 'not_configured') : 'disabled'
                }
              : row
          ) ?? current
      )
      notify({
        kind: 'success',
        title: enabled ? m.platformEnabled(platform.name) : m.platformDisabled(platform.name),
        message: m.restartToApply,
        action: restartGatewayAction
      })
    } catch (err) {
      notifyError(err, m.failedUpdate(platform.name))
    } finally {
      setSaving(null)
    }
  }

  async function handleSave(platform: MessagingPlatformInfo) {
    const slot = draftKey(scopeProfile, platform.id)
    const env = trimEdits(edits[slot] || {})

    if (Object.keys(env).length === 0) {
      return
    }

    setSaving(`env:${platform.id}`)

    try {
      await updateMessagingPlatform(platform.id, { env }, scopeProfile)
      // The draft has become configuration: drop it from state and from disk.
      setEdits(current => ({ ...current, [slot]: {} }))
      clearEnvDraft(slot)
      await refreshPlatforms()
      notify({
        kind: 'success',
        title: m.setupSaved(platform.name),
        message: m.restartToReconnect,
        action: restartGatewayAction
      })
    } catch (err) {
      notifyError(err, m.failedSave(platform.name))
    } finally {
      setSaving(null)
    }
  }

  async function handleClear(platform: MessagingPlatformInfo, key: string) {
    // Busy starts only after the confirm, so dismissing leaves the card idle.
    const result = await runRemoval(
      {
        id: key,
        kind: 'bot_token',
        label: key,
        perform: () => updateMessagingPlatform(platform.id, { clear_env: [key] }, scopeProfile),
        profile: scopeProfile ?? undefined,
        providerLabel: platform.name,
        surface: 'messaging'
      },
      {
        notice: { message: m.setupUpdated(platform.name), title: m.keyCleared(key) },
        onBusy: busy => setSaving(busy ? `clear:${key}` : null)
      }
    )

    if (!result?.ok) {
      return
    }

    recordEdit(platform, key, '')
    await refreshPlatforms().catch(() => undefined)
  }

  // Approve/revoke paint from a snapshot immediately, then let the
  // authoritative refresh have the last word. A failed write restores the
  // snapshot so the row never silently disappears on an error.
  async function handleApprove(user: PairingUser) {
    if (!user.request_id) {
      return
    }

    const key = pairingKey(user)
    const snapshot = pairing
    setApproving(key)
    setPairing(current => ({
      approved: current.approved,
      pending: current.pending.filter(row => pairingKey(row) !== key)
    }))

    try {
      await approvePairing(user.platform, user.request_id, scopeProfile)
      notify({ kind: 'success', title: m.approvedUser(pairingLabel(user)), message: m.approvedHint })
      await refreshPairing()
    } catch (err) {
      setPairing(snapshot)
      // 429 is the code path's brute-force lockout — a distinct condition the
      // operator can only wait out, so it gets its own message.
      const lockedOut = err instanceof Error && err.message.includes('429')
      notifyError(err, lockedOut ? m.pairingLockedOut : m.failedApprove(pairingLabel(user)))
    } finally {
      setApproving(null)
    }
  }

  // IcConfirmDialog owns the pending → done → close beat and shows an inline
  // error when onConfirm throws, so this rethrows instead of swallowing.
  async function handleRevoke(user: PairingUser) {
    const key = pairingKey(user)
    const snapshot = pairing
    setPairing(current => ({
      approved: current.approved.filter(row => pairingKey(row) !== key),
      pending: current.pending
    }))

    try {
      await revokePairing(user.platform, user.user_id, scopeProfile)
      notify({ kind: 'success', title: m.revokedUser(pairingLabel(user)), message: user.platform })
      await refreshPairing()
    } catch (err) {
      setPairing(snapshot)
      throw err
    }
  }

  const selectedEdits = selected ? edits[draftKey(scopeProfile, selected.id)] || {} : {}
  const selectedResuming = selected ? restoredSlots.has(draftKey(scopeProfile, selected.id)) : false
  const hasEdits = Object.keys(trimEdits(selectedEdits)).length > 0

  return (
    <IcPage
      actions={
        selected ? (
          <>
            {hasEdits ? <span className="icpg__dim">{m.unsavedChanges}</span> : null}
            <IcSwitch
              checked={selected.enabled}
              disabled={saving === `enabled:${selected.id}`}
              label={selected.enabled ? m.disableAria(selected.name) : m.enableAria(selected.name)}
              onChange={enabled => void handleToggle(selected, enabled)}
            />
            <IcPageButton
              disabled={!hasEdits || saving === `env:${selected.id}`}
              onClick={() => void handleSave(selected)}
              tone="accent"
            >
              <Save aria-hidden="true" size={13} />
              {saving === `env:${selected.id}` ? m.saving : m.saveChanges}
            </IcPageButton>
            {/* Room for the overlay scroll rail, so Save is never drawn under it at large text. */}
            <span aria-hidden="true" className="w-3 shrink-0" data-messaging-rail-inset="" />
          </>
        ) : undefined
      }
      frame="bare"
      title={t.sidebar.nav.messaging}
    >
      {/* Which profile's gateway this page configures (hidden for
          single-profile users). REQUEST (handoff): this control belongs to the
          Settings rebuild — it is the one shared chrome this page still calls.
          Marked as foreign so our own probes measure OUR markup and report
          this subtree BY NAME (it still paints `--ui-*`) instead of either
          blaming this front for it or going quiet about it. The wrapper is
          `display: contents`, so it changes no layout; it goes away with the
          control's rebase. */}
      <div className="pe-3" data-messaging-rail-inset="">
        <div className="icpg__foreign" data-ic-foreign="app/settings/profile-scope.tsx">
          <SettingsProfileScope />
        </div>
      </div>

      {load.kind === 'loading' && !platforms ? (
        <IcPageState kind="loading" title={m.loading} />
      ) : load.kind === 'error' && !platforms ? (
        <IcPageState
          action={
            <IcPageButton onClick={() => void refreshAll()} tone="accent">
              {t.common.retry}
            </IcPageButton>
          }
          description={load.message}
          kind="error"
          title={m.loadFailed}
        />
      ) : (platforms?.length ?? 0) === 0 ? (
        // No platforms at all is not evidence of a stopped gateway: the page
        // cannot know why the list is empty, and "gateway stopped" asserted a
        // cause (critic r3, E3d2-M2). The per-platform signal the page DOES
        // have (`platform.gateway_running`) keeps that copy.
        <IcPageState
          action={
            <IcPageButton onClick={() => void refreshAll()} tone="accent">
              {t.common.retry}
            </IcPageButton>
          }
          kind="empty"
          title={m.noPlatforms}
        />
      ) : (
        <IcPageBody>
          <IcPageRail
            label={t.sidebar.nav.messaging}
            search={{ label: m.search, onChange: setQuery, placeholder: m.search, value: query }}
          >
            {/* The `common` search hint reads "Try <what you just typed>" — the
                opposite of what happened (critic r2, E3d2-T3). `messaging.noMatch`
                says it truthfully, in all five locales. */}
            {visiblePlatforms.length === 0 ? <li className="icpg__rail-note">{m.noMatch(query)}</li> : null}
            {visiblePlatforms.map(platform => (
              <PlatformRow
                active={selected?.id === platform.id}
                key={platform.id}
                onSelect={() => setSelectedId(platform.id)}
                pendingCount={pendingByPlatform[platform.id]?.length ?? 0}
                platform={platform}
              />
            ))}
          </IcPageRail>

          {selected ? (
            <IcPageDetail label={selected.name}>
              <PlatformDetail
                approved={approvedByPlatform[selected.id] ?? []}
                approving={approving}
                edits={selectedEdits}
                onApprove={user => void handleApprove(user)}
                onClear={key => void handleClear(selected, key)}
                onEdit={(key, value) => recordEdit(selected, key, value)}
                onRevoke={setPendingRevoke}
                pending={pendingByPlatform[selected.id] ?? []}
                platform={selected}
                resuming={selectedResuming}
                saving={saving}
              />
            </IcPageDetail>
          ) : null}
        </IcPageBody>
      )}

      <IcConfirmDialog
        busyLabel={m.revoking}
        cancelLabel={t.common.cancel}
        confirmLabel={m.revoke}
        description={pendingRevoke ? m.revokeDesc(pairingLabel(pendingRevoke)) : null}
        doneLabel={t.common.done}
        errorFallback={t.errors.genericFailure}
        onClose={() => setPendingRevoke(null)}
        onConfirm={() => (pendingRevoke ? handleRevoke(pendingRevoke) : undefined)}
        open={Boolean(pendingRevoke)}
        title={m.revokeTitle}
        tone="danger"
      />
    </IcPage>
  )
}

function PlatformRow({
  active,
  onSelect,
  pendingCount,
  platform
}: {
  active: boolean
  onSelect: () => void
  pendingCount: number
  platform: MessagingPlatformInfo
}) {
  const { t } = useI18n()

  return (
    <li>
      <button aria-current={active} className="icpg__row" data-ic-row={platform.id} onClick={onSelect} type="button">
        <span className="icpg__row-lead">
          <IcPlatformAvatar platformId={platform.id} platformName={platform.name} />
        </span>
        <span className="icpg__row-text">
          <span className="icpg__row-title">{platform.name}</span>
        </span>
        <span className="icpg__row-trailing">
          {/* Someone is waiting to be let in — the only way this page tells
              you so before you open the platform. */}
          {pendingCount > 0 ? (
            <IcPagePill tone="warn">
              <span aria-label={t.messaging.pendingAria(pendingCount)}>{pendingCount}</span>
            </IcPagePill>
          ) : null}
          <IcDot tone={stateTone(platform)} />
        </span>
      </button>
    </li>
  )
}
