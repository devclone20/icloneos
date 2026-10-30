/**
 * Compatibility — the verdict of the app's runtime contract against the
 * installed runtime (and the update target when one is pending). One card per
 * broken root, each tied to its fix-forward ticket and the upstream commits
 * that caused it. The gate itself lives in Electron main; this only reads it.
 */

import { memo } from 'react'

import { CompatChip, compatLevel } from '@/app/updates-overlay.compat-chip'
import { asFiniteNumber } from '@/iclone-shared/guards'
import { Layers3 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { IcloneCompatCard, IcloneCompatProbe, IcloneCompatVerdict } from '@/types/iclone-compat'

import { useUpdatesCopy } from '../machine/updates-copy'
import { SettingsSection } from '../primitives'

import { Aside, Code, count, shortSha, StatusCard, timeAgo } from './parts'

const RANK: Record<string, number> = { RED: 0, AMBER: 1, UNKNOWN: 2, GREEN: 3 }
const NAMES_SHOWN = 6

const HEADLINE = {
  GREEN: 'Every call the app makes still exists in the runtime',
  AMBER: 'The runtime changed in ways the app tolerates — review before updating',
  RED: 'The runtime no longer answers calls the app depends on',
  UNKNOWN: 'No verdict yet — the contract has not been checked against this runtime'
} as const

// FETCH-FAILED in a preview is the update target (installed + target specs); any other kind reads the installed runtime alone.
// `tip` is main's install target: null means it was never resolved, so there was nothing to read.
function fetchFailed(verdict: IcloneCompatVerdict, tip: InstallTip): string {
  if (verdict.kind !== 'preview') {
    return 'the installed runtime could not be read'
  }

  return tip === null ? 'the update target could not be resolved' : 'the update target could not be read'
}

// Why a computed verdict stayed UNKNOWN, most fundamental first (rules from electron/iclone-compat/verify.ts and guard.ts).
const UNVERIFIED: readonly (readonly [rule: string, reason: string | typeof fetchFailed])[] = [
  ['LOCK-MISSING', 'the app’s contract lock is missing'],
  ['FETCH-FAILED', fetchFailed],
  ['STALE-BACKEND', 'the running backend is older than the runtime on disk'],
  ['NO-OPENRPC', 'the runtime publishes no typed contract, so parameters and results are unchecked'],
  ['ENGINE-DEP-GONE', 'an engine dependency the app relies on is gone']
]

const TONE = { GREEN: 'available', AMBER: 'warn', RED: 'error', UNKNOWN: 'unknown' } as const

const DOT: Record<string, string> = {
  RED: 'bg-red-500',
  AMBER: 'bg-amber-500',
  GREEN: 'bg-emerald-500',
  UNKNOWN: 'bg-muted-foreground/40'
}

function versionPair(live: null | number, target: null | number): string {
  return target != null && target !== live ? `${live} → ${target}` : String(live)
}

function stateLine(state: IcloneCompatVerdict['state'] | undefined): null | string {
  const liveDb = asFiniteNumber(state?.liveDb) ?? null

  if (liveDb == null) {
    return null
  }

  const liveConfig = asFiniteNumber(state?.liveConfig) ?? null

  const config =
    liveConfig == null ? '' : ` · config v${versionPair(liveConfig, asFiniteNumber(state?.targetConfig) ?? null)}`

  return `State DB v${versionPair(liveDb, asFiniteNumber(state?.targetDb) ?? null)}${config}${state?.oneWay === true ? ' · one-way migration' : ''}`
}

function probeLine(probe: IcloneCompatProbe | null): null | string {
  if (!probe) {
    return null
  }

  const parts = [`${count(probe.ok)} answered`, `${count(probe.gone)} gone`]

  if (probe.renamed) {
    parts.push(`${count(probe.renamed)} renamed`)
  }

  return `Live probe: ${parts.join(' · ')}${probe.unsafe ? ' · stopped as unsafe' : ''}`
}

/** Main's install target as `status()` sends it: a sha, null when unresolved, undefined when the status carries none. */
type InstallTip = null | string | undefined

// The status type does not declare `installTarget`, so read it without trusting the shape.
export function installTip(status: unknown): InstallTip {
  if (!status || typeof status !== 'object' || !('installTarget' in status)) {
    return undefined
  }

  const tip = (status as { installTarget: unknown }).installTarget

  return typeof tip === 'string' && tip ? tip : null
}

export function compatHeadline(
  level: keyof typeof HEADLINE,
  verdict: IcloneCompatVerdict | null,
  tip?: InstallTip
): string {
  if (level !== 'UNKNOWN' || !verdict) {
    return HEADLINE[level]
  }

  const rules = new Set(verdict.cards.flatMap(card => card.rules))
  const why = UNVERIFIED.find(([rule]) => rules.has(rule))?.[1]
  const reason = typeof why === 'function' ? why(verdict, tip) : why

  return reason ? `Could not verify — ${reason}` : 'Could not verify this runtime — the check gave no reason'
}

function CompatCard({ card }: { card: IcloneCompatCard }) {
  const names = card.names
  const extra = Math.max(0, card.items - Math.min(names.length, NAMES_SHOWN))

  return (
    <li
      className="grid gap-1.5 border-t border-(--ui-stroke-tertiary) py-3 first:border-t-0"
      data-iclone-compat-card={card.root}
    >
      <div className="flex items-baseline gap-2">
        <span aria-hidden className={cn('size-1.5 shrink-0 translate-y-[-0.1rem] rounded-full', DOT[card.level])} />
        <span className="font-medium text-foreground">{card.root}</span>
        <span className="text-(--ui-text-tertiary)">
          {count(card.items)} {card.items === 1 ? 'item' : 'items'}
          {card.sites ? ` · ${count(card.sites)} call ${card.sites === 1 ? 'site' : 'sites'}` : ''}
        </span>
        {card.ticket && <span className="ml-auto font-mono text-[0.7rem] text-muted-foreground">{card.ticket}</span>}
      </div>
      {names.length > 0 && (
        <div className="pl-3.5 font-mono text-[0.72rem] leading-relaxed text-muted-foreground">
          {names.slice(0, NAMES_SHOWN).join(' · ')}
          {extra > 0 ? ` · +${count(extra)}` : ''}
        </div>
      )}
      {card.upstream.length > 0 && (
        <div className="pl-3.5 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
          Caused upstream by{' '}
          {card.upstream.slice(0, 4).map((sha, i) => (
            <span key={sha}>
              {i > 0 && ', '}
              <Code>{shortSha(sha)}</Code>
            </span>
          ))}
          {card.upstream.length > 4 ? ` +${card.upstream.length - 4}` : ''}
        </div>
      )}
    </li>
  )
}

export const CompatSection = memo(function CompatSection({
  now,
  probe,
  tip,
  verdict
}: {
  now: number
  probe: IcloneCompatProbe | null
  tip?: InstallTip
  verdict: IcloneCompatVerdict | null
}) {
  const u = useUpdatesCopy()
  const level = compatLevel(verdict?.level)

  const cards = (verdict?.cards ?? [])
    .filter(card => compatLevel(card.level) !== 'GREEN')
    .sort((a, b) => (RANK[a.level] ?? 9) - (RANK[b.level] ?? 9) || a.root.localeCompare(b.root))

  const broken = cards.filter(c => c.level === 'RED').length
  const details = [stateLine(verdict?.state), probeLine(probe)].filter(Boolean)
  const target = verdict?.runtime?.to

  return (
    <div data-iclone-compat-section="compat">
      <SettingsSection
        aside={verdict?.computedAt ? <Aside>checked {timeAgo(verdict.computedAt, now)}</Aside> : undefined}
        icon={Layers3}
        title={u.compatTitle}
      >
        <StatusCard
          detail={
            <>
              {target ? (
                <>
                  Runtime <Code>{shortSha(target)}</Code>
                  {verdict?.runtime?.from && shortSha(verdict.runtime.from) !== shortSha(target) && (
                    <>
                      {' '}
                      from <Code>{shortSha(verdict.runtime.from)}</Code>
                    </>
                  )}
                  {broken > 0 && ` · ${broken} broken ${broken === 1 ? 'root' : 'roots'}`}
                </>
              ) : verdict ? (
                'No runtime revision was read; the next runtime check tries again.'
              ) : (
                'The verdict appears after the next runtime check.'
              )}
              {details.map(line => (
                <span className="block" key={line}>
                  {line}
                </span>
              ))}
            </>
          }
          title={
            <span className="flex flex-wrap items-center gap-2">
              <CompatChip level={level} />
              <span>{compatHeadline(level, verdict, tip)}</span>
            </span>
          }
          tone={TONE[level]}
        />
        {cards.length > 0 && (
          <ul className="mt-2 text-sm">
            {cards.map(card => (
              <CompatCard card={card} key={card.root} />
            ))}
          </ul>
        )}
      </SettingsSection>
    </div>
  )
})
