import './skills-page.css'

import type { ProfileScope } from '@/hermes'
import { useI18n } from '@/i18n'
/**
 * Capabilities → Skills — OUR list and inspector (E3 decision #8).
 *
 * The rail, the rows, the per-row switch, the list strip and the states are
 * drawn with `../profiles/ic-page.tsx` + `skills-page.css`. Two things the
 * surface it replaces did not do: the search box stays reachable when the
 * filter matches nothing (the rail says so and the detail shows the empty
 * state), and the "changes apply to new sessions" caveat sits with the
 * inspector it qualifies instead of under the list.
 */
import { compactNumber } from '@/lib/format'
import type { SkillInfo } from '@/types/hermes'

import { IcPageBody, IcPageButton, IcPageDetail, IcPageRail, IcPageState, IcSwitch } from '../profiles/ic-page'
import { asText } from '../settings/helpers'

import { SkillsRailNote, SkillsRailStrip } from './rail-parts'
import { SkillDetail } from './skill-detail'
import { skillSubtitleParts, usageOf } from './skill-logic'

interface SkillsTabProps {
  allEnabled: boolean
  busy: boolean
  onArchive: () => void
  onBulkToggle: (enabled: boolean) => void
  onDisableUnused: () => void
  onEdit: () => void
  onFlipSort: () => void
  onQueryChange: (query: string) => void
  onSelect: (name: string) => void
  onToggle: (skill: SkillInfo, enabled: boolean) => void
  profile?: ProfileScope
  query: string
  /** V3-B: per-row facts from the bundle catalog (attribution, needs, an invalid manifest), keyed by name. */
  rowNotes?: ReadonlyMap<string, string>
  selected: null | SkillInfo
  skills: SkillInfo[]
  sortDesc: boolean
}

export function SkillsTab({
  allEnabled,
  busy,
  onArchive,
  onBulkToggle,
  onDisableUnused,
  onEdit,
  onFlipSort,
  onQueryChange,
  onSelect,
  onToggle,
  profile,
  query,
  rowNotes,
  selected,
  skills,
  sortDesc
}: SkillsTabProps) {
  const { t } = useI18n()

  return (
    <IcPageBody>
      <IcPageRail
        footer={
          <SkillsRailStrip
            allEnabled={allEnabled}
            busy={busy}
            onBulkToggle={onBulkToggle}
            onFlipSort={onFlipSort}
            sortDesc={sortDesc}
          >
            <IcPageButton disabled={busy} onClick={onDisableUnused} tone="quiet">
              {t.skills.disableUnused}
            </IcPageButton>
          </SkillsRailStrip>
        }
        label={t.skills.tabSkills}
        search={{
          label: t.skills.searchSkills,
          onChange: onQueryChange,
          placeholder: t.skills.searchSkills,
          value: query
        }}
      >
        {skills.length === 0 ? (
          <SkillsRailNote label={t.skills.tabSkills} query={query} />
        ) : (
          skills.map(skill => {
            const parts = skillSubtitleParts(skill)
            const uses = usageOf(skill)
            const note = rowNotes?.get(skill.name)

            return (
              <li className="icsk__row-wrap" key={skill.name}>
                <button
                  aria-current={selected?.name === skill.name}
                  className="icpg__row"
                  data-ic-row={skill.name}
                  onClick={() => onSelect(skill.name)}
                  type="button"
                >
                  <span className="icpg__row-text">
                    <span className="icpg__row-title">{skill.name}</span>
                    <span className="icpg__row-meta">
                      {parts.category}
                      {parts.badge ? ` · ${t.skills.provenance[parts.badge]}` : ''}
                      {note ? <span data-ic-row-note="">{` · ${note}`}</span> : null}
                    </span>
                  </span>
                  {uses > 0 ? <span className="icpg__row-trailing">×{compactNumber(uses)}</span> : null}
                </button>
                <span className="icsk__row-switch">
                  <IcSwitch
                    checked={skill.enabled}
                    disabled={busy}
                    label={skill.name}
                    onChange={enabled => onToggle(skill, enabled)}
                  />
                </span>
              </li>
            )
          })
        )}
      </IcPageRail>
      <IcPageDetail label={selected?.name}>
        {selected ? (
          <>
            <SkillDetail onArchive={onArchive} onEdit={onEdit} profile={profile} skill={selected} />
            <p className="icpg__dim">{t.skills.changesApplyNewSessions}</p>
          </>
        ) : (
          <IcPageState
            description={asText(query) ? t.skills.emptyNothingMatches(query.trim()) : undefined}
            kind="empty"
            title={t.skills.emptyNoneFound(t.skills.tabSkills)}
          />
        )}
      </IcPageDetail>
    </IcPageBody>
  )
}
