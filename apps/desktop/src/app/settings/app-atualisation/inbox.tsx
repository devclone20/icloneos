/**
 * Inbox — the upstream commits worth a decision this week, ranked by the
 * adoption scan's scored formula. Every row lists the terms that fired, so the
 * rank is never a black box. Deciding writes a ledger line through Electron
 * main; nothing here touches the repo or the runtime.
 */

import { memo } from 'react'

import { Button } from '@/components/ui/button'
import { Mail } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { IcloneCompatDecision, IcloneCompatInboxRow } from '@/types/iclone-compat'

import { useUpdatesCopy } from '../machine/updates-copy'
import { SettingsSection } from '../primitives'

import { Aside, Code, count, formatDate, shortSha } from './parts'

export type InboxDecision = 'adopt' | 'defer' | 'ignore' | 'watch'

/** Rows shown at once — the contract's top-12 inbox. */
export const INBOX_ROWS = 12

const DECISIONS: [InboxDecision, string][] = [
  ['adopt', 'Adopt'],
  ['watch', 'Watch'],
  ['ignore', 'Ignore'],
  ['defer', 'Later']
]

const DISPOSITION_CLASS: Record<IcloneCompatInboxRow['disposition'], string> = {
  adopt: 'text-primary',
  watch: 'text-amber-600 dark:text-amber-400',
  ignore: 'text-muted-foreground'
}

/** The newest week's rows, best score first, capped at INBOX_ROWS. */
export function inboxRows(rows: readonly IcloneCompatInboxRow[] | null | undefined): IcloneCompatInboxRow[] {
  if (!rows?.length) {
    return []
  }

  const week = rows.reduce((max, r) => (r.week > max ? r.week : max), rows[0].week)

  return rows
    .filter(r => r.week === week)
    .sort((a, b) => b.score - a.score || (a.sha < b.sha ? -1 : 1))
    .slice(0, INBOX_ROWS)
}

const DEFER_DAYS = 7

/**
 * The ledger line for one decision. Main accepts only `CS-<hex>` ids, so a
 * cluster (`CL-<hex>`) keeps its hex and a lone commit is its own set.
 */
export function inboxDecision(
  row: IcloneCompatInboxRow,
  decision: InboxDecision,
  now = Date.now()
): IcloneCompatDecision {
  const until = new Date(now + DEFER_DAYS * 86_400_000).toISOString().slice(0, 10)

  return {
    cs: `CS-${row.cluster?.replace(/^CL-/, '') || row.sha.slice(0, 10)}`,
    upstream: [row.sha],
    decision: decision === 'defer' ? `defer:${until}` : decision
  }
}

function InboxRow({
  busy,
  onDecide,
  row
}: {
  busy: boolean
  onDecide?: (sha: string, decision: InboxDecision) => void
  row: IcloneCompatInboxRow
}) {
  return (
    <li
      className="grid gap-1.5 border-t border-(--ui-stroke-tertiary) py-3 first:border-t-0"
      data-iclone-inbox-row={row.sha}
    >
      <div className="flex items-baseline gap-3">
        <span className="w-7 shrink-0 text-right font-mono text-[0.7rem] text-muted-foreground tabular-nums">
          {row.score}
        </span>
        <span className="min-w-0 flex-1 text-foreground">{row.subject}</span>
        <span className={cn('shrink-0 text-[0.7rem] font-medium', DISPOSITION_CLASS[row.disposition])}>
          {row.disposition}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-10 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
        <Code>{shortSha(row.sha)}</Code>
        <span>{formatDate(row.at)}</span>
        {row.terms.length > 0 && <span className="font-mono text-[0.68rem]">{row.terms.join(' · ')}</span>}
        {onDecide && (
          <span className="ml-auto flex gap-1">
            {DECISIONS.map(([decision, label]) => (
              <Button
                disabled={busy}
                key={decision}
                onClick={() => onDecide(row.sha, decision)}
                size="xs"
                variant={decision === 'adopt' ? 'secondary' : 'ghost'}
              >
                {label}
              </Button>
            ))}
          </span>
        )}
      </div>
    </li>
  )
}

export const InboxSection = memo(function InboxSection({
  busySha,
  onDecide,
  rows
}: {
  busySha?: null | string
  onDecide?: (sha: string, decision: InboxDecision) => void
  rows: readonly IcloneCompatInboxRow[] | null | undefined
}) {
  const u = useUpdatesCopy()
  const shown = inboxRows(rows)

  return (
    <div data-iclone-compat-section="inbox">
      <SettingsSection
        aside={shown.length > 0 ? <Aside>{shown[0].week}</Aside> : undefined}
        icon={Mail}
        title={u.inboxTitle}
      >
        {shown.length === 0 ? (
          <p className="py-3 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
            Nothing upstream waits for a decision. The scan reads new commits after every fetch.
          </p>
        ) : (
          <>
            <ul className="text-sm">
              {shown.map(row => (
                <InboxRow busy={busySha === row.sha} key={row.sha} onDecide={onDecide} row={row} />
              ))}
            </ul>
            <p className="mt-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
              Top {count(shown.length)} of the week by score. Adopt opens a ticket to re-implement it in iclone os;
              upstream code is studied, never merged.
            </p>
          </>
        )}
      </SettingsSection>
    </div>
  )
})
