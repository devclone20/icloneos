import './context-panel.css'

import { useStore } from '@nanostores/react'
import { useMemo } from 'react'

import type { SessionView } from '@/app/chat/session-view'

import { CompactSlot } from './compact-slot'
import { CONTEXT_PANEL_COPY as copy } from './context-panel.copy'
import {
  buildContextCard,
  type ContextHeadline,
  formatShare,
  formatTokens,
  sessionSpendRows,
  type SpendRow,
  todaySpend
} from './context-rows'
import { estimateAutoCompact } from './threshold'
import { type ContextPanelData, useContextPanelData, useContextUsage } from './use-context-panel'

const RING_RADIUS = 5.5
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** 14 px progress ring; decorative — the owner control carries the label. */
export function ContextRing({ percent }: { percent: number }) {
  const bounded = Math.max(0, Math.min(100, percent))

  return (
    <svg aria-hidden className="ic-ctx-ring" height="14" viewBox="0 0 14 14" width="14">
      <circle className="ic-ctx-ring-track" cx="7" cy="7" fill="none" r={RING_RADIUS} strokeWidth="2" />
      <circle
        className="ic-ctx-ring-fill"
        cx="7"
        cy="7"
        fill="none"
        r={RING_RADIUS}
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - bounded / 100)}
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  )
}

function SpendBlock({ rows, title }: { rows: SpendRow[]; title: string }) {
  if (rows.length === 0) {
    return null
  }

  return (
    <section aria-label={title} className="ic-ctx-spend">
      <h3>{title}</h3>
      <dl>
        {rows.map(row => (
          <div data-spend={row.key} key={row.key}>
            <dt>{row.label}</dt>
            <dd>{formatTokens(row.value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function Threshold({ headline, model, data }: { data: ContextPanelData; headline: ContextHeadline; model: string }) {
  if (!data.compression) {
    return null
  }

  const estimate = estimateAutoCompact(headline.max, model, data.compression)

  if (!estimate) {
    return (
      <div className="ic-ctx-threshold" data-testid="context-autocompact">
        {copy.autoCompactOff}
      </div>
    )
  }

  const remaining = Math.max(0, estimate.tokens - headline.used)

  return (
    <div className="ic-ctx-threshold" data-testid="context-autocompact" data-threshold={estimate.tokens}>
      <span>
        {copy.autoCompactAt} <strong>{formatTokens(estimate.tokens, true)}</strong>
      </span>
      <span className="ic-ctx-note" title={copy.estimatedHint}>
        {copy.estimated}
      </span>
      <span>
        <strong>{formatTokens(remaining, true)}</strong> {copy.untilAutoCompact}
      </span>
    </div>
  )
}

/** The context card: runtime numbers only, tokens only. */
export function ContextCard({ open = true, view }: { open?: boolean; view: SessionView }) {
  const runtimeId = useStore(view.$runtimeId)
  const model = useStore(view.$model)
  const usage = useContextUsage(view)
  const data = useContextPanelData(runtimeId, open)
  const card = useMemo(() => buildContextCard(usage, data.breakdown), [usage, data.breakdown])
  const today = useMemo(() => todaySpend(data.spend, Date.now()), [data.spend])
  const { headline } = card
  const displayModel = data.breakdown?.model || model

  return (
    <div className="ic-ctx" data-testid="context-card">
      <header className="ic-ctx-head">
        <div className="ic-ctx-eyebrow">
          {copy.title}
          {displayModel ? ` · ${displayModel}` : ''}
        </div>
        <div className="ic-ctx-percent" data-testid="context-percent">
          {headline ? `${Math.round(headline.percent)}%` : '—'}
        </div>
        <div
          className="ic-ctx-used"
          data-testid="context-used"
          title={headline ? (headline.estimated ? copy.estimatedSourceHint : copy.measuredHint) : undefined}
        >
          {headline
            ? `${formatTokens(headline.used, headline.estimated)} / ${formatTokens(headline.max)} ${copy.tokens}`
            : ''}
        </div>
      </header>

      {headline ? (
        <div
          aria-label={copy.progressLabel}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={Math.round(headline.percent)}
          aria-valuetext={copy.progressValueText(
            Math.round(headline.percent),
            formatTokens(headline.used, headline.estimated),
            formatTokens(headline.max)
          )}
          className="ic-ctx-bar"
          role="progressbar"
        >
          {card.segments.length > 0 ? (
            card.segments.map(segment => (
              <span
                className="ic-ctx-seg"
                data-swatch={segment.slot}
                key={segment.id}
                style={{ width: `${segment.width}%` }}
                title={segment.label}
              />
            ))
          ) : (
            <span
              className="ic-ctx-seg ic-ctx-seg-plain"
              style={{ width: `${Math.max(0, Math.min(100, headline.percent))}%` }}
            />
          )}
        </div>
      ) : null}

      {card.rows.length > 0 ? (
        <ul className="ic-ctx-rows" data-testid="context-rows">
          {card.rows.map(row => (
            <li
              className="ic-ctx-row"
              data-category={row.id}
              data-swatch={row.slot}
              data-tokens={row.tokens}
              key={row.id}
            >
              <span aria-hidden className="ic-ctx-dot" />
              <span className="ic-ctx-label">{row.label}</span>
              <span className="ic-ctx-value">{formatTokens(row.tokens, true)}</span>
              <span className="ic-ctx-share">{formatShare(row.share)}</span>
            </li>
          ))}
          {headline && card.free ? (
            <li className="ic-ctx-row" data-free={card.free.tokens} data-testid="context-free">
              <span aria-hidden className="ic-ctx-dot ic-ctx-dot-free" />
              <span className="ic-ctx-label">{copy.freeSpace}</span>
              <span className="ic-ctx-value">{formatTokens(card.free.tokens, headline.estimated)}</span>
              <span className="ic-ctx-share">{formatShare(card.free.share)}</span>
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="ic-ctx-muted" role="status">
          {data.breakdownError ? copy.breakdownUnavailable : copy.breakdownPending}
        </p>
      )}

      {card.files.length > 0 ? (
        <details className="ic-ctx-files">
          <summary>
            <span>{copy.contextFiles}</span>
            <span>{card.files.length}</span>
          </summary>
          <ul className="ic-ctx-rows">
            {card.files.map(file => (
              <li className="ic-ctx-row" key={file.path || file.label} title={file.path}>
                <span aria-hidden />
                <span className="ic-ctx-label">{file.label}</span>
                <span className="ic-ctx-value">{formatTokens(file.est_tokens ?? 0, true)}</span>
                <span className="ic-ctx-share ic-ctx-file-status">
                  {file.loaded === false ? copy.notLoaded : (file.status ?? '')}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {headline ? <Threshold data={data} headline={headline} model={displayModel} /> : null}

      <div className="ic-ctx-footer">{runtimeId ? <CompactSlot sessionId={runtimeId} /> : null}</div>

      <SpendBlock rows={sessionSpendRows(usage)} title={copy.spendSession} />
      {today ? <SpendBlock rows={today.rows} title={copy.spendToday} /> : null}
      {today && today.tasks.length > 0 ? <SpendBlock rows={today.tasks} title={copy.spendTasks} /> : null}
    </div>
  )
}
