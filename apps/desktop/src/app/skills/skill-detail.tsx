import './skills-page.css'

/**
 * The skill inspector — OUR detail pane (E3 decision #8). Header, pills,
 * actions, the frontmatter table and the SKILL.md body are drawn with
 * `../profiles/ic-page.tsx` and `skills-page.css`; nothing upstream is left.
 * The data lane (the scoped content query) and the frontmatter reader
 * (`skill-logic.ts`) are unchanged.
 */
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useMemo } from 'react'

import { getSkillContent, type ProfileScope, profileScopeKey } from '@/hermes'
import { useI18n } from '@/i18n'
import type { SkillInfo } from '@/types/hermes'

import { IcPageButton, IcPagePill, IcPageState } from '../profiles/ic-page'
import { asText } from '../settings/helpers'

import { parseFrontmatter, skillSubtitleParts } from './skill-logic'

/** Shared inspector header — the same block Skills, Tools and Messaging use. */
export function DetailHeader({
  description,
  pills,
  title
}: {
  description: ReactNode
  pills?: ReactNode
  title: string
}) {
  return (
    <header className="icpg__detail-head">
      <h3 className="icpg__detail-title">
        <span className="icpg__strong">{title}</span>
        {pills}
      </h3>
      <p className="icpg__listrow-hint">{description}</p>
    </header>
  )
}

export function SkillDetail({
  onArchive,
  onEdit,
  profile,
  skill
}: {
  onArchive: () => void
  onEdit: () => void
  profile?: ProfileScope
  skill: SkillInfo
}) {
  const { t } = useI18n()
  // Only learned/local skills are the user's to rewrite or archive — bundled
  // and hub skills are managed by their sources.
  const editable = skill.provenance === 'agent'

  // The FULL skill — frontmatter metadata + complete SKILL.md body — for any
  // provenance, scoped to the Capabilities profile selector. The row list only
  // carries name/description; the pane shows the whole thing.
  const contentQuery = useQuery({
    queryKey: ['skill-content', skill.name, profileScopeKey(profile)],
    queryFn: () => getSkillContent(skill.name, profile),
    staleTime: 60_000
  })

  const parsed = useMemo(
    () => (contentQuery.data ? parseFrontmatter(contentQuery.data.content) : null),
    [contentQuery.data]
  )

  return (
    <>
      <DetailHeader
        description={asText(skill.description) || t.skills.noDescription}
        pills={
          <>
            <IcPagePill>{skillSubtitleParts(skill).category}</IcPagePill>
            {skill.provenance && skill.provenance !== 'bundled' ? (
              <IcPagePill tone={skill.provenance === 'agent' ? 'good' : 'neutral'}>
                {t.skills.provenance[skill.provenance]}
              </IcPagePill>
            ) : null}
          </>
        }
        title={skill.name}
      />
      {editable ? (
        <div className="icsk__actions">
          <IcPageButton onClick={onEdit} tone="quiet">
            {t.skills.edit}
          </IcPageButton>
          <IcPageButton onClick={onArchive} tone="danger">
            {t.skills.archive}
          </IcPageButton>
        </div>
      ) : null}
      {parsed && parsed.meta.length > 0 ? (
        <div className="icsk__meta">
          {parsed.meta.map(([key, value]) => (
            <div className="icsk__meta-row" key={key}>
              <span className="icsk__meta-key">{key}</span>
              <span className="icsk__meta-val">{value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {contentQuery.isLoading ? (
        <IcPageState kind="loading" title={t.skills.loading} />
      ) : parsed ? (
        <pre className="icsk__body" data-selectable-text="true">
          {parsed.body.trim() || t.skills.noDescription}
        </pre>
      ) : null}
    </>
  )
}
