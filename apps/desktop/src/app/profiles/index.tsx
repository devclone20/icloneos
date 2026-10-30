/**
 * Profiles — OUR page (E3 decision #8, 2026-10-18): written on our own chassis
 * (`ic-page.tsx`, the `--ic-*` tokens) and not on the old Hermes overlay
 * vocabulary. What it reuses is the logic: the profile store, the three shared
 * profile dialogs (one create/rename/delete flow for the rail and for this
 * page) and the pure helpers.
 *
 * Since front K3 (2026-10-19) this page has exactly ONE home: the Profiles
 * topic inside Settings. It therefore takes no props and has no floating
 * mode left to render in — the Settings shell draws the card and owns Esc
 * and the ✕, so the page draws no second frame and no close control.
 *
 * Two things the page it replaces did not do, both provable:
 * - a failed list load is an inline error with a retry, not a toast over a
 *   spinner that never ends;
 * - the SOUL.md editor keeps a draft, so a reload mid-edit costs nothing
 *   (`soul-draft.ts`).
 */
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'

import { IcTip } from '@/components/ic/ic-system'
import { useI18n } from '@/i18n'
import { displayPath } from '@/lib/display-path'
import { Pencil, Plus, Trash2 } from '@/lib/icons'
import { resolveProfileColor } from '@/lib/profile-color'
import { normalize } from '@/lib/text'
import { $profileColors, profileLabel, refreshProfiles } from '@/store/profile'
import type { ProfileInfo } from '@/types/hermes'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'

import { CreateProfileDialog } from './create-profile-dialog'
import { DeleteProfileDialog } from './delete-profile-dialog'
import {
  IcHiddenLabel,
  IcPage,
  IcPageBody,
  IcPageButton,
  IcPageDetail,
  IcPageMeta,
  IcPagePill,
  IcPageRail,
  IcPageState
} from './ic-page'
import { RenameProfileDialog } from './rename-profile-dialog'
import { SoulEditor } from './soul-editor'

type Load = { kind: 'error'; message: string } | { kind: 'loading' } | { kind: 'ready'; profiles: ProfileInfo[] }

/**
 * The ids of the two hidden verb labels the rows point at. A row button's
 * accessible name is "<verb> <row title>", composed by `aria-labelledby` from
 * the verb and the row's own title — never by gluing two translated strings
 * together, which no language guarantees reads that way (E3d2-T3).
 */
interface RowVerbIds {
  delete: string
  rename: string
}

/** Pure: the rows a query leaves, by name or by model. */
function matchProfiles(profiles: ProfileInfo[], query: string): ProfileInfo[] {
  const q = normalize(query)

  if (!q) {
    return profiles
  }

  return profiles.filter(
    profile => profile.name.toLowerCase().includes(q) || (profile.model ?? '').toLowerCase().includes(q)
  )
}

/** Pure: which row stays selected after a list change. */
function nextSelection(profiles: ProfileInfo[], current: null | string): null | string {
  if (current && profiles.some(profile => profile.name === current)) {
    return current
  }

  return profiles.find(profile => profile.is_default)?.name ?? profiles[0]?.name ?? null
}

export function ProfilesView() {
  const { t } = useI18n()
  const p = t.profiles
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [selectedName, setSelectedName] = useState<null | string>(null)
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [pendingRename, setPendingRename] = useState<null | ProfileInfo>(null)
  const [pendingDelete, setPendingDelete] = useState<null | ProfileInfo>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await refreshProfiles()

      setLoad({ kind: 'ready', profiles: list })
      setSelectedName(current => nextSelection(list, current))
    } catch (err) {
      setLoad({ kind: 'error', message: err instanceof Error ? err.message : p.failedLoad })
    }
  }, [p])

  useRefreshHotkey(refresh)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const profiles = useMemo(() => (load.kind === 'ready' ? load.profiles : []), [load])

  const selected = useMemo(
    () => profiles.find(profile => profile.name === selectedName) ?? profiles[0] ?? null,
    [profiles, selectedName]
  )

  const visible = useMemo(() => matchProfiles(profiles, query), [profiles, query])
  const verbBase = useId()
  const verbs = useMemo<RowVerbIds>(() => ({ delete: `${verbBase}-delete`, rename: `${verbBase}-rename` }), [verbBase])

  // The dialogs own the create/rename/delete calls; the page only re-selects
  // and re-pulls, so every entry point behaves the same.
  const selectAndRefresh = useCallback(
    async (name: string) => {
      setSelectedName(name)
      await refresh()
    },
    [refresh]
  )

  return (
    <IcPage frame="bare" subtitle={load.kind === 'ready' ? p.count(profiles.length) : undefined} title={p.title}>
      <IcHiddenLabel id={verbs.rename}>{p.rename}</IcHiddenLabel>
      <IcHiddenLabel id={verbs.delete}>{t.common.delete}</IcHiddenLabel>

      {load.kind === 'loading' ? (
        <IcPageState kind="loading" title={p.loading} />
      ) : load.kind === 'error' ? (
        <IcPageState
          action={
            <IcPageButton onClick={() => void refresh()} tone="accent">
              {t.common.retry}
            </IcPageButton>
          }
          description={load.message}
          kind="error"
          title={p.failedLoad}
        />
      ) : profiles.length === 0 ? (
        <IcPageState
          action={
            <IcPageButton onClick={() => setCreateOpen(true)} tone="accent">
              {p.newProfile}
            </IcPageButton>
          }
          description={p.createDesc}
          kind="empty"
          title={p.noProfiles}
        />
      ) : (
        <IcPageBody>
          <IcPageRail
            footer={
              <IcPageButton block onClick={() => setCreateOpen(true)}>
                <Plus aria-hidden="true" size={13} />
                {p.newProfile}
              </IcPageButton>
            }
            label={p.title}
            search={{ label: p.search, onChange: setQuery, value: query }}
          >
            {visible.length === 0 ? (
              // A search that matches nothing must say so: an empty rail with a
              // live query reads as a broken list. `profiles.noMatch` is this
              // page's own key — reading another page's `settings.config.noResults`
              // was the E3d2-T3 defect.
              <li className="icpg__rail-note">{p.noMatch(query)}</li>
            ) : null}
            {visible.map(profile => (
              <ProfileRow
                active={selected?.name === profile.name}
                key={profile.name}
                onDelete={profile.is_default ? undefined : () => setPendingDelete(profile)}
                onRename={() => setPendingRename(profile)}
                onSelect={() => setSelectedName(profile.name)}
                profile={profile}
                verbs={verbs}
              />
            ))}
          </IcPageRail>

          {selected ? (
            <ProfileDetail key={selected.name} profile={selected} />
          ) : (
            <IcPageState kind="empty" title={p.selectPrompt} />
          )}
        </IcPageBody>
      )}

      <RenameProfileDialog
        currentName={pendingRename?.name ?? ''}
        isDefault={pendingRename?.is_default ?? false}
        onClose={() => setPendingRename(null)}
        onRenamed={selectAndRefresh}
        open={pendingRename !== null}
      />

      <CreateProfileDialog
        onClose={() => setCreateOpen(false)}
        onCreated={selectAndRefresh}
        open={createOpen}
        profiles={profiles}
      />

      <DeleteProfileDialog
        onClose={() => setPendingDelete(null)}
        onDeleted={async () => {
          setSelectedName(null)
          await refresh()
        }}
        open={pendingDelete !== null}
        profile={pendingDelete}
      />
    </IcPage>
  )
}

function ProfileRow({
  active,
  onDelete,
  onRename,
  onSelect,
  profile,
  verbs
}: {
  active: boolean
  onDelete?: () => void
  onRename: () => void
  onSelect: () => void
  profile: ProfileInfo
  verbs: RowVerbIds
}) {
  const colors = useStore($profileColors)
  const label = profileLabel(profile)
  const titleId = useId()

  return (
    <li className="icpg__row-head">
      <button aria-current={active} className="icpg__row" data-ic-row={profile.name} onClick={onSelect} type="button">
        <span className="icpg__row-lead">
          <ProfileInitial
            isDefault={profile.is_default}
            label={label}
            tint={resolveProfileColor(profile.name, colors)}
          />
        </span>
        <span className="icpg__row-text">
          <span className="icpg__row-title" id={titleId}>
            {label}
          </span>
          {profile.model ? <span className="icpg__row-meta">{profile.model}</span> : null}
        </span>
      </button>
      <span className="icpg__row-actions">
        <button
          aria-labelledby={`${verbs.rename} ${titleId}`}
          className="icpg__icon-btn"
          onClick={onRename}
          type="button"
        >
          <Pencil aria-hidden="true" size={13} />
        </button>
        {onDelete ? (
          <button
            aria-labelledby={`${verbs.delete} ${titleId}`}
            className="icpg__icon-btn icpg__icon-btn--danger"
            onClick={onDelete}
            type="button"
          >
            <Trash2 aria-hidden="true" size={13} />
          </button>
        ) : null}
      </span>
    </li>
  )
}

/** Our glyph: the profile's initial on its own tint — no upstream avatar. */
function ProfileInitial({ isDefault, label, tint }: { isDefault: boolean; label: string; tint: null | string }) {
  return (
    <span
      aria-hidden="true"
      className={isDefault ? 'icpg__glyph icpg__glyph--default' : 'icpg__glyph'}
      style={tint ? { color: tint } : undefined}
    >
      {[...label.trim()][0] ?? '?'}
    </span>
  )
}

function ProfileDetail({ profile }: { profile: ProfileInfo }) {
  const { t } = useI18n()
  const p = t.profiles

  return (
    <IcPageDetail label={profileLabel(profile)}>
      <header className="icpg__detail-head">
        <div className="icpg__detail-titles">
          <h3 className="icpg__detail-title">
            {profileLabel(profile)}
            {profile.is_default ? <IcPagePill tone="good">{p.defaultBadge}</IcPagePill> : null}
            {profile.has_env ? <IcPagePill>{p.ownKeysBadge}</IcPagePill> : null}
          </h3>
          <IcTip label={displayPath(profile.path)}>
            <p className="icpg__listrow-hint">{p.ownSpaceHint}</p>
          </IcTip>
        </div>

        <IcPageMeta
          rows={[
            {
              label: p.modelLabel,
              value: profile.model ? (
                <span className="icpg__mono">
                  {profile.model}
                  {profile.provider ? <span className="icpg__dim"> · {profile.provider}</span> : null}
                </span>
              ) : (
                <span className="icpg__dim">{p.notSet}</span>
              )
            },
            { label: p.skillsLabel, value: profile.skill_count }
          ]}
        />
      </header>

      <SoulEditor profileName={profile.name} />
    </IcPageDetail>
  )
}
