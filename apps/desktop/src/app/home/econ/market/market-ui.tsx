/**
 * EconomyOS — Market: the small parts its views share.
 */
import { ArrowLeft, CloudOff } from 'lucide-react'
import { createContext, Fragment, memo, useContext, useMemo } from 'react'

import { Tip } from '@/components/ui/tooltip'

import { type AcpFailure, setupNotice } from '../cli'
import { timeAgo } from '../format'
import { Action, Empty, Note, Pill } from '../ui'

import { chainName, type ChainNames, failureText, jobStatusTone, needsSetup, statusLabel } from './market-data'
import { highlight } from './market-search'

/** Text with the searched words marked — React elements, never raw HTML. */
export const Highlight = memo(function Highlight({ text, tokens }: { text: string; tokens: readonly string[] }) {
  const segments = useMemo(() => highlight(text, tokens), [text, tokens])

  return (
    <>
      {segments.map((segment, index) =>
        segment.hit ? (
          <mark className="mk-hit" key={index}>
            {segment.text}
          </mark>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        )
      )}
    </>
  )
})

export function OnlineDot({ label, online }: { label?: string; online: boolean }) {
  const dot = (
    <span
      aria-label={label ?? (online ? 'online' : 'offline')}
      className={online ? 'mk-dot mk-dot--on' : 'mk-dot'}
      role="img"
    />
  )

  return label ? <Tip label={label}>{dot}</Tip> : dot
}

/** The chain list as a name map, provided once by the app: when it lands
 *  only the pills re-render — the cards and rows around them keep their props. */
export const ChainNamesContext = createContext<ChainNames>(new Map())

export const ChainPills = memo(function ChainPills({ chainIds, max = 3 }: { chainIds: number[]; max?: number }) {
  const names = useContext(ChainNamesContext)

  if (chainIds.length === 0) {
    return null
  }

  const shown = chainIds.slice(0, max)
  const rest = chainIds.length - shown.length

  return (
    <span className="mk-chains">
      {shown.map(id => (
        <Pill key={id} tone="muted">
          {chainName(id, names)}
        </Pill>
      ))}
      {rest > 0 ? <Pill tone="muted">+{rest}</Pill> : null}
    </span>
  )
})

/** One chain's name, as text — for rows and headers. */
export const ChainName = memo(function ChainName({ chainId }: { chainId: number }) {
  return <>{chainName(chainId, useContext(ChainNamesContext))}</>
})

export function StatusPill({ status }: { status: string }) {
  return <Pill tone={jobStatusTone(status)}>{statusLabel(status)}</Pill>
}

/** A read that failed with nothing to show: say why and what to do next. */
export function FailureState({
  failure,
  onRetry,
  onSetup,
  title
}: {
  failure: AcpFailure
  onRetry: () => void
  onSetup: () => void
  title: string
}) {
  const setup = needsSetup(failure)
  const notice = setupNotice(failure)
  const signIn = notice === 'Sign in again'

  return (
    <Empty
      action={
        setup ? (
          <Action kind="primary" onClick={onSetup}>
            {signIn ? notice : 'Open Setup'}
          </Action>
        ) : (
          <Action onClick={onRetry}>Try again</Action>
        )
      }
      hint={failureText(failure)}
      icon={<CloudOff size={22} strokeWidth={1.6} />}
      title={setup ? 'Sign-in needed' : title}
    />
  )
}

/** A refresh that failed while older data is still on screen. */
export function StaleNote({ at, failure, onRetry }: { at: number; failure: AcpFailure; onRetry: () => void }) {
  return (
    <Note kind="warn">
      Couldn’t refresh — {failureText(failure)} Showing what was read {at ? timeAgo(at) : 'earlier'}.{' '}
      <button className="e-link" onClick={onRetry} type="button">
        Try again
      </button>
    </Note>
  )
}

/** The way back from a detail shown in the main column (narrow windows). */
export function BackBar({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div className="mk-back">
      <button className="mk-back__btn" onClick={onBack} type="button">
        <ArrowLeft size={14} strokeWidth={1.8} />
        {label}
      </button>
    </div>
  )
}
