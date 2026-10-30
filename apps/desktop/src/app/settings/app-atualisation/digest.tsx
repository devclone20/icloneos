/**
 * Digest — the whole upstream firehose since the last read, folded into
 * counts: how much arrived, how the policy sorted it, how much was noise.
 */

import { memo } from 'react'

import { asFiniteNumber, asNonEmptyString } from '@/iclone-shared/guards'
import { NotebookTabs } from '@/lib/icons'
import type { IcloneCompatBacklog } from '@/types/iclone-compat'

import { useUpdatesCopy } from '../machine/updates-copy'
import { SettingsSection } from '../primitives'

import { Code, count, shortSha } from './parts'

/** The adoption scan's backlog fields this section renders. */
interface DigestView {
  range: { from: null | string; to: null | string }
  commits: number
  counts: Record<'adopt' | 'ignore' | 'watch', number>
  noise: Record<string, number>
  clusters: number
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** Narrows the scan's `backlog.json` (main reads it from disk; nothing about its shape is assumed). */
export function digestView(backlog: IcloneCompatBacklog | null | undefined): DigestView | null {
  if (!backlog) {
    return null
  }

  const range = record(backlog.range)
  const counts = record(backlog.counts)

  return {
    range: { from: asNonEmptyString(range.from) ?? null, to: asNonEmptyString(range.to) ?? null },
    commits: asFiniteNumber(backlog.commits) ?? 0,
    counts: {
      adopt: asFiniteNumber(counts.adopt) ?? 0,
      ignore: asFiniteNumber(counts.ignore) ?? 0,
      watch: asFiniteNumber(counts.watch) ?? 0
    },
    noise: Object.fromEntries(Object.entries(record(backlog.noise)).map(([k, n]) => [k, asFiniteNumber(n) ?? 0])),
    clusters: asFiniteNumber(backlog.clusters) ?? 0
  }
}

const NOISE_SHOWN = 4

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0">
      <div className="text-xl font-medium tracking-tight text-foreground tabular-nums">{count(value)}</div>
      <div className="mt-0.5 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
        {label}
      </div>
    </div>
  )
}

export const DigestSection = memo(function DigestSection({ backlog }: { backlog: DigestView | null }) {
  const u = useUpdatesCopy()

  const noise = Object.entries(backlog?.noise ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  const noiseTotal = noise.reduce((sum, [, n]) => sum + n, 0)

  return (
    <div data-iclone-compat-section="digest">
      <SettingsSection icon={NotebookTabs} title={u.digestTitle}>
        {!backlog ? (
          <p className="py-3 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
            No scan yet. The digest folds every upstream commit since the last read into one view.
          </p>
        ) : (
          <div className="@container grid gap-4 py-3">
            <div className="grid grid-cols-2 gap-4 @md:grid-cols-4">
              <Figure label="commits read" value={backlog.commits} />
              <Figure label="to adopt" value={backlog.counts.adopt} />
              <Figure label="to watch" value={backlog.counts.watch} />
              <Figure label="ignored" value={backlog.counts.ignore} />
            </div>
            <p className="text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
              {backlog.range.from && backlog.range.to ? (
                <>
                  Upstream <Code>{shortSha(backlog.range.from)}</Code> → <Code>{shortSha(backlog.range.to)}</Code>.{' '}
                </>
              ) : null}
              {noiseTotal > 0 &&
                `${count(noiseTotal)} noise (${noise
                  .slice(0, NOISE_SHOWN)
                  .map(([k, n]) => `${k} ${count(n)}`)
                  .join(', ')}${noise.length > NOISE_SHOWN ? ', …' : ''}). `}
              {backlog.clusters ? `${count(backlog.clusters)} clusters of related commits are decided together.` : ''}
            </p>
          </div>
        )}
      </SettingsSection>
    </div>
  )
})
