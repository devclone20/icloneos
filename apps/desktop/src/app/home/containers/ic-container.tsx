/**
 * The Containers dock mark, in the dock's stroke language (iclone-icons.tsx: 1.6 stroke, round caps, currentColor):
 * a closed box seen from above with a lock-bar across its lid — a command kept inside. Its own file so the shared
 * icon sheet is not edited (V3-G contract §2).
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }

export function IcContainer({ size = 22, strokeWidth = 1.6, ...rest }: IconProps) {
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
      <path d="M12 3.2 20 7.4v9.2L12 20.8 4 16.6V7.4z" />
      <path d="M4 7.4 12 11.6l8-4.2" />
      <path d="M12 11.6v9.2" />
      <path d="M8 5.3l8 4.2" />
      <circle cx="16" cy="15.2" fill="currentColor" r="1.1" stroke="none" />
    </svg>
  )
}
