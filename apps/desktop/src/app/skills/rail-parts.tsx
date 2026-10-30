import type { ReactNode } from 'react'

import { useI18n } from '@/i18n'

import { IcPageButton, IcSwitch } from '../profiles/ic-page'

/**
 * The empty note of a Capabilities rail — one piece, used by both lists.
 *
 * It lives apart from the two tabs because the note is the only part of the
 * rail that is identical in both: the list keeps its search box when nothing
 * matches, so the note has to distinguish "your filter matches nothing" from
 * "there is nothing installed", and that distinction must read the same on
 * Skills and on Tools.
 */
export function SkillsRailNote({ label, query }: { label: string; query: string }) {
  const { t } = useI18n()
  const term = query.trim()

  return (
    <li className="icpg__rail-note">
      {term ? t.skills.emptyNothingMatches(term) : t.skills.emptyNoneAvailable(label)}
    </li>
  )
}

/**
 * The footer strip of a Capabilities rail — the sort flip and the "all" group.
 *
 * Both lists carry exactly this strip; only the trailing extras differ (Skills
 * adds "disable unused"), so they arrive as children of the group instead of
 * being duplicated around it.
 */
export function SkillsRailStrip({
  allEnabled,
  busy,
  children,
  onBulkToggle,
  onFlipSort,
  sortDesc
}: {
  allEnabled: boolean
  busy: boolean
  children?: ReactNode
  onBulkToggle: (enabled: boolean) => void
  onFlipSort: () => void
  sortDesc: boolean
}) {
  const { t } = useI18n()

  return (
    <div className="icsk__strip">
      <IcPageButton onClick={onFlipSort} tone="quiet">
        {sortDesc ? t.skills.sortMostUsedDesc : t.skills.sortLeastUsedAsc}
      </IcPageButton>
      <div className="icsk__strip-group">
        <span>{t.skills.all}</span>
        <IcSwitch checked={allEnabled} disabled={busy} label={t.skills.all} onChange={onBulkToggle} />
        {children}
      </div>
    </div>
  )
}
