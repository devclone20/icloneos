/**
 * iclone os — the dock marks.
 *
 * Real-world apps, drawn in the theme: one stroke language (1.6–1.7, round
 * caps), painted by `currentColor` so they follow every skin.
 *   wallet      the iNFT's crypto wallet (fold + coin slot)
 *   card        agentcard.ai virtual card (chip + sparkle)
 *   email       the agent inbox (a sealed envelope: the flap is filled)
 *   message     the Hermes chat window
 *   hyperliquid the Hyperliquid mark: a bold H whose bars are liquid waves
 *   market      the ACP marketplace (a stall)
 *   settings    the cloneframe.io sliders
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }

function Stroke({ size = 22, strokeWidth = 1.6, children, ...rest }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      viewBox="0 0 24 24"
      width={size}
      {...rest}
    >
      {children}
    </svg>
  )
}

export function IcWallet(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h11.5a2 2 0 0 1 2 2v1.5" />
      <rect height="11" rx="2.5" width="17" x="3.5" y="8.5" />
      <path d="M15.5 14h5" />
      <circle cx="15.5" cy="14" fill="currentColor" r="1.2" stroke="none" />
    </Stroke>
  )
}

export function IcCard(props: IconProps) {
  return (
    <Stroke {...props}>
      <rect height="13" rx="2.5" width="19" x="2.5" y="5.5" />
      <path d="M2.5 9.5h19" />
      <rect height="3" rx=".8" width="4" x="5.5" y="12.5" />
      <path d="M17.5 12.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" fill="currentColor" stroke="none" />
    </Stroke>
  )
}

export function IcEmail(props: IconProps) {
  return (
    <Stroke {...props}>
      {/* The closing flap, filled (owner): the top of the envelope
          down to the fold, so the mark reads as a sealed letter. */}
      <path d="M5.5 5.5h13A2.5 2.5 0 0 1 21 8v.2L12 13.5 3 8.2V8a2.5 2.5 0 0 1 2.5-2.5z" fill="currentColor" />
      <rect height="13" rx="2.5" width="18" x="3" y="5.5" />
      <path d="M3.5 8.5 12 13.5l8.5-5" />
    </Stroke>
  )
}

export function IcMessage(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17H6.5A2.5 2.5 0 0 1 4 14.5z" />
      <path d="M8.5 9h7M8.5 12.2h4.5" />
    </Stroke>
  )
}

export function IcHyperliquid({ size = 22, ...rest }: IconProps) {
  return (
    <svg aria-hidden="true" fill="currentColor" height={size} viewBox="0 0 24 24" width={size} {...rest}>
      {/* Solid (owner): the two inner counters are filled, one heavy mark. */}
      <path d="M2.4 12c0-3.6 1.5-6.2 3.6-6.2 2.6 0 3 4.4 4.6 4.4 1.5 0 1.9-3 4.1-3 2.6 0 4.9 2.3 4.9 4.8s-2.3 4.8-4.9 4.8c-2.2 0-2.6-3-4.1-3-1.6 0-2 4.4-4.6 4.4-2.1 0-3.6-2.6-3.6-6.2z" />
    </svg>
  )
}

export function IcMarket(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M3.5 9.5 5 4.5h14l1.5 5" />
      <path d="M3.5 9.5h17v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 2.5 2.5 0 0 1-5 0z" />
      <path d="M5 12.5V20h14v-7.5M10 20v-4h4v4" />
    </Stroke>
  )
}

export function IcSettings(props: IconProps) {
  return (
    <Stroke {...props} strokeWidth={props.strokeWidth ?? 1.7}>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2.1" />
      <circle cx="9" cy="17" r="2.1" />
    </Stroke>
  )
}
