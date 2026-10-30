import './skills-page.css'

/**
 * Capabilities → Tools — OUR list and inspector (E3 decision #8). Same chassis
 * as the Skills tab; what is special here is the per-toolset configuration,
 * which stays on the existing settings panels (pure logic + backend writes we
 * reuse deliberately) under our own header, pills and chips.
 */
import { useNavigate } from 'react-router'

import type { ProfileScope } from '@/hermes'
import { profileScopeKey } from '@/hermes'
import { useI18n } from '@/i18n'
import { compactNumber } from '@/lib/format'
import type { ToolsetInfo } from '@/types/hermes'

import {
  IcPageBody,
  IcPageButton,
  IcPageDetail,
  IcPagePill,
  IcPageRail,
  IcPageState,
  IcSwitch
} from '../profiles/ic-page'
import { SETTINGS_ROUTE } from '../routes'
import { ComputerUsePanel } from '../settings/computer-use-panel'
import { asText, toolNames, toolsetDisplayLabel } from '../settings/helpers'
import { TerminalBackendPanel } from '../settings/terminal-backend-panel'
import { ToolsetConfigPanel } from '../settings/toolset-config-panel'

import { SkillsRailNote, SkillsRailStrip } from './rail-parts'
import { DetailHeader } from './skill-detail'
import { toolsetCalls } from './skill-logic'

interface ToolsetsTabProps {
  allEnabled: boolean
  busy: boolean
  onBulkToggle: (enabled: boolean) => void
  onConfiguredChange: () => void
  onFlipSort: () => void
  onQueryChange: (query: string) => void
  onSelect: (name: string) => void
  onToggle: (toolset: ToolsetInfo, enabled: boolean) => void
  profile?: ProfileScope
  query: string
  selected: null | ToolsetInfo
  sortDesc: boolean
  toolCalls: null | Record<string, number>
  toolsets: ToolsetInfo[]
}

export function ToolsetsTab({
  allEnabled,
  busy,
  onBulkToggle,
  onConfiguredChange,
  onFlipSort,
  onQueryChange,
  onSelect,
  onToggle,
  profile,
  query,
  selected,
  sortDesc,
  toolCalls,
  toolsets
}: ToolsetsTabProps) {
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
          />
        }
        label={t.skills.tabToolsets}
        search={{
          label: t.skills.searchToolsets,
          onChange: onQueryChange,
          placeholder: t.skills.searchToolsets,
          value: query
        }}
      >
        {toolsets.length === 0 ? (
          <SkillsRailNote label={t.skills.tabToolsets} query={query} />
        ) : (
          toolsets.map(toolset => {
            const label = toolsetDisplayLabel(toolset)
            const calls = toolCalls ? toolsetCalls(toolset, toolCalls) : null

            return (
              <li className="icsk__row-wrap" key={toolset.name}>
                <button
                  aria-current={selected?.name === toolset.name}
                  className="icpg__row"
                  data-ic-row={toolset.name}
                  onClick={() => onSelect(toolset.name)}
                  type="button"
                >
                  <span className="icpg__row-text">
                    <span className="icpg__row-title">{label}</span>
                    <span className="icpg__row-meta">{asText(toolset.description)}</span>
                  </span>
                  <span className="icpg__row-trailing">
                    {calls === null
                      ? `${toolNames(toolset).length} ${t.skills.tabToolsets.toLowerCase()}`
                      : calls > 0
                        ? `×${compactNumber(calls)}`
                        : `${toolNames(toolset).length} ${t.skills.tabToolsets.toLowerCase()}`}
                  </span>
                </button>
                <span className="icsk__row-switch">
                  <IcSwitch
                    checked={toolset.enabled}
                    disabled={busy}
                    label={t.skills.toggleToolset(label, !toolset.enabled)}
                    onChange={enabled => onToggle(toolset, enabled)}
                  />
                </span>
              </li>
            )
          })
        )}
      </IcPageRail>
      <IcPageDetail label={selected ? toolsetDisplayLabel(selected) : undefined}>
        {selected ? (
          <>
            <ToolsetDetail
              onConfiguredChange={onConfiguredChange}
              profile={profile}
              toolCalls={toolCalls ?? {}}
              toolset={selected}
            />
            <p className="icpg__dim">{t.skills.changesApplyNewSessions}</p>
          </>
        ) : (
          <IcPageState
            description={asText(query) ? t.skills.emptyNothingMatches(query.trim()) : undefined}
            kind="empty"
            title={t.skills.emptyNoneFound(t.skills.tabToolsets)}
          />
        )}
      </IcPageDetail>
    </IcPageBody>
  )
}

function ToolsetDetail({
  onConfiguredChange,
  profile,
  toolCalls,
  toolset
}: {
  onConfiguredChange: () => void
  profile?: ProfileScope
  toolCalls: Record<string, number>
  toolset: ToolsetInfo
}) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const tools = toolNames(toolset)
  const label = toolsetDisplayLabel(toolset)

  return (
    <>
      {/* "Configured" as a resting state is noise — only the warn state earns a pill. */}
      <DetailHeader
        description={asText(toolset.description) || t.skills.noDescription}
        pills={!toolset.configured ? <IcPagePill tone="warn">{t.skills.needsKeys}</IcPagePill> : null}
        title={label}
      />
      {tools.length > 0 ? (
        <div className="icsk__chips">
          {tools.map(name => (
            <span className="icsk__chip" key={name}>
              {name}
              {(toolCalls[name] ?? 0) > 0 ? (
                <span className="icsk__chip-count">×{compactNumber(toolCalls[name])}</span>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      {toolset.name === 'vision' ? (
        // Vision has no provider matrix — model resolution runs through the
        // auxiliary model config. Point at the actual home (Settings → Models,
        // aux "vision" row) via an internal deep link instead of leaving the
        // detail pane empty.
        <div className="icpg__stack">
          <p className="icpg__listrow-hint">{t.skills.visionModelHint}</p>
          <div>
            <IcPageButton onClick={() => navigate(`${SETTINGS_ROUTE}?tab=config:model&aux=vision`)} tone="quiet">
              {t.skills.visionModelLink}
            </IcPageButton>
          </div>
        </div>
      ) : null}
      {toolset.name === 'computer_use' ? <ComputerUsePanel onConfiguredChange={onConfiguredChange} /> : null}
      {toolset.name === 'terminal' ? <TerminalBackendPanel onConfiguredChange={onConfiguredChange} /> : null}
      <ToolsetConfigPanel
        key={`${toolset.name}:${profileScopeKey(profile)}`}
        onConfiguredChange={onConfiguredChange}
        profile={profile}
        toolset={toolset.name}
      />
    </>
  )
}
