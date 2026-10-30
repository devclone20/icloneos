/**
 * THE canonical iCLONE head — one copy for the whole app.
 *
 * Owner rule, after six hand-drawn attempts were rejected: this
 * mark is never redrawn by hand. The path below is copied VERBATIM from
 * cloneframe.io's dock (`index.html`, the first `.dock-item` SVG); its
 * `fill-rule="evenodd"` is what carves the scope tube and the lens out of the
 * single path. The only permitted addition is the tiny "i 01" engraved at the
 * TIP of the small ear, past the cap arc, lying on the ear's own oblique.
 *
 * It lives in its own module because it is worn in more than one place (the
 * empty collection card, the titlebar's home door, the dock). The mask id is
 * per-instance (`useId`) so two marks on screen never collide on one DOM id.
 */
import { type JSX, useId } from 'react'

/** The head's outline. Never edit — re-copy from the site if it ever changes. */
const ICLONE_HEAD_PATH =
  'M12.4 2.55C13.35 2.53 14.79 2.56 15.84 2.78C16.88 2.99 17.94 3.45 18.67 3.85C19.4 4.24 19.79 4.46 20.23 5.14C20.68 5.83 20.96 7.02 21.33 7.96L23.38 8.49L23.69 11.93L22.2 12.75C22.23 14.13 22.33 15.64 22.28 16.88C22.24 18.13 22.05 19.11 21.93 20.22L20.07 20.47L19.97 21.44L4.61 21.44C4.61 21.14 4.48 20.83 4.59 20.54C4.69 20.25 5.03 19.97 5.25 19.69C4.74 18.86 4.07 17.93 3.71 17.19C3.36 16.45 3.22 15.8 3.12 15.26C3.02 14.71 3.04 14.56 3.12 13.93C3.2 13.31 3.45 12.31 3.61 11.5C2.97 11.24 2.25 11.14 1.7 10.72C1.15 10.3 0.78 9.56 0.31 8.98C1.09 8.87 1.63 8.94 2.64 8.64C3.65 8.34 5.55 7.89 6.36 7.2C7.17 6.51 7.22 5.07 7.51 4.5C7.81 3.92 7.68 4.03 8.12 3.75C8.56 3.48 9.43 3.07 10.15 2.87C10.86 2.67 11.45 2.57 12.4 2.55ZM13.58 16.56L22.51 13.27A2.74 2.74 0 0 1 20.62 8.13L11.69 11.41A2.74 2.74 0 0 1 13.58 16.56ZM13.32 15.84L22.25 12.55A1.97 1.97 0 0 1 20.89 8.85L11.96 12.13A1.97 1.97 0 0 1 13.32 15.84ZM10.56 14.29a1.81 1.81 0 1 0 3.63 0a1.81 1.81 0 1 0 -3.63 0Z'

export function IcloneHeadMark({
  className,
  engraved = true,
  size
}: {
  className?: string
  /** The "i 01" engraving. Off below ~20px, where it would just be grit. */
  engraved?: boolean
  size?: number
}): JSX.Element {
  const maskId = `iclone-head-${useId()}`

  return (
    <svg
      aria-hidden="true"
      className={className}
      // Inherit the surrounding ink by default; the collection card's own
      // rule (`.inft-card__headmark { fill: … }`) still wins where it applies.
      fill="currentColor"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      {engraved && (
        <defs>
          <mask id={maskId}>
            <rect fill="#fff" height="24" width="24" />
            {/* Engraved on the very TIP of the ear — PAST the cap arc (owner
                rule: "atrás do arco"), on the ear's own oblique: the
                lens-to-muzzle axis runs at -20.2 degrees, and the clean box
                measured off the render sits at t 0.94-0.98 along it. */}
            <text
              fill="#000"
              fontFamily="-apple-system, sans-serif"
              fontSize="0.88"
              fontWeight="700"
              textAnchor="middle"
              transform="rotate(-20.2 21.15 10.86)"
              x="21.15"
              y="11.17"
            >
              i 01
            </text>
          </mask>
        </defs>
      )}
      <path d={ICLONE_HEAD_PATH} fillRule="evenodd" mask={engraved ? `url(#${maskId})` : undefined} />
    </svg>
  )
}
