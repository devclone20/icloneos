/**
 * One small iNFT Book card, in the Home card's language (`.inft-card*` from
 * home/collections.css): the art, a checkbox (checked = on Home) and a tiny
 * glass status mark — nothing written on the face (owner's part request,
 * ruling 46). Name, collection and status live in the card's native tooltip;
 * screen readers get the name from the checkbox and the status from the mark.
 *
 * Memoised on its primitive props (card, checked, configured, the labels and
 * onToggle): checking one card
 * re-renders that card and no other (gate G3). The image waits for a request
 * slot (thumb-cache.ts) unless the cache already holds its outcome; a missing
 * or broken image is the Home monogram tile.
 */
import { type JSX, memo, useEffect, useId, useState } from 'react'

import type { INftCardData } from '@/app/home/collections'
import { IcloneHeadMark } from '@/app/home/iclone-head'
import { Checkbox } from '@/components/ui/checkbox'

import { readThumb, rememberThumb, requestThumbSlot, thumbKey, type ThumbOutcome } from './thumb-cache'

type ThumbState = 'go' | 'wait' | ThumbOutcome

/** K73: an image that neither loads nor fails by then (a hung IPFS gateway) is broken, and its slot is freed. */
export const THUMB_TIMEOUT_MS = 15_000

function BookThumb({ cacheKey, imageUrl }: { cacheKey: string; imageUrl: string }): JSX.Element {
  const [state, setState] = useState<ThumbState>(() => readThumb(cacheKey) ?? 'wait')
  const settled = state === 'ok' || state === 'broken'

  // Holds a slot from grant until the image settles or the card leaves the
  // virtual window — the effect's cleanup is the release.
  useEffect(() => {
    if (settled) {
      return
    }

    return requestThumbSlot(() => setState('go'))
  }, [settled])

  // Eight hung requests would otherwise hold all eight slots and stall every other thumbnail in the grid.
  useEffect(() => {
    if (state !== 'go') {
      return
    }

    const timer = setTimeout(() => {
      rememberThumb(cacheKey, 'broken')
      setState('broken')
    }, THUMB_TIMEOUT_MS)

    return () => clearTimeout(timer)
  }, [cacheKey, state])

  if (state === 'broken' || state === 'wait') {
    return (
      <span className="inft-card__placeholder">
        <IcloneHeadMark className="inft-card__headmark" />
      </span>
    )
  }

  return (
    <img
      alt=""
      className="inft-card__img"
      decoding="async"
      loading="lazy"
      onError={() => {
        rememberThumb(cacheKey, 'broken')
        setState('broken')
      }}
      onLoad={() => {
        rememberThumb(cacheKey, 'ok')
        setState('ok')
      }}
      src={imageUrl}
    />
  )
}

/**
 * The status mark: a 16px disc of dark glass with a hairline and a soft glow —
 * brand green with a check when the iNFT is set up, a dim neutral ring when it
 * still needs setup. Static by design (no pulse), so reduced motion has nothing to stop.
 */
function StatusMark({ configured, label }: { configured: boolean; label: string }): JSX.Element {
  return (
    <span aria-label={label} className="inft-book__mark" data-state={configured ? 'set' : 'needed'} role="img">
      <svg aria-hidden="true" className="inft-book__mark-glyph" focusable="false" viewBox="0 0 16 16">
        {configured ? <path d="M5.1 8.3 7.1 10.2 10.9 6.1" /> : <circle cx="8" cy="8" r="2.4" />}
      </svg>
    </span>
  )
}

interface BookCardProps {
  card: INftCardData
  checked: boolean
  /** The Virtuals CLI state — the same source as Home's ECONOMYOS / SETUP NEEDED chip (`$acpConfigMap`). */
  configured: boolean
  onToggle: (id: string) => void
  setUp: string
  setupNeeded: string
  showOnHome: (name: string) => string
}

export const BookCard = memo(function BookCard({
  card,
  checked,
  configured,
  onToggle,
  setUp,
  setupNeeded,
  showOnHome
}: BookCardProps): JSX.Element {
  const id = useId()
  const status = configured ? setUp : setupNeeded

  return (
    <label
      className="inft-card inft-book__card"
      data-book-card={card.id}
      htmlFor={id}
      title={`${card.name} · ${card.collection}\n${status}`}
    >
      <span aria-hidden="true" className="inft-card__chrome" />
      <span aria-hidden="true" className="inft-card__art">
        {card.imageUrl ? (
          <BookThumb cacheKey={thumbKey(card)} imageUrl={card.imageUrl} key={thumbKey(card)} />
        ) : (
          <span className="inft-card__placeholder">
            <IcloneHeadMark className="inft-card__headmark" />
          </span>
        )}
      </span>
      <span aria-hidden="true" className="inft-card__edge" />
      <StatusMark configured={configured} label={status} />
      <Checkbox
        aria-label={showOnHome(card.name)}
        checked={checked}
        className="inft-book__check"
        id={id}
        onCheckedChange={() => onToggle(card.id)}
      />
    </label>
  )
})
