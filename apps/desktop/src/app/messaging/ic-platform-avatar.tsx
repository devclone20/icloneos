import '@/components/ic/ic-page.css'

import type { ComponentPropsWithoutRef } from 'react'
import { forwardRef, memo } from 'react'

import { PLATFORM_ICONS, type PlatformIconSpec } from './platform-icon'

interface IcPlatformAvatarProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  platformId: string
  platformName: string
}

/** A brand mark this dark would be a hole in the card — paint it as ink. */
const INK = new Set(['#000000', '#000'])

const brandInk = (color: string) => (INK.has(color.toLowerCase()) ? 'var(--ic-text-1)' : color)

/** The letter shown when a brand publishes no usable mark. */
const monogramOf = (spec: PlatformIconSpec | undefined, platformName: string) =>
  spec?.monogram ?? (platformName.trim()[0] ?? '?').toUpperCase()

// OUR chip (E3 decision #8): the brand glyph on a tint of its own colour, on
// our own element and our own tokens — never the upstream `AvatarChip`.
//
// It lives in its own module ON PURPOSE. `platform-icon.tsx`'s `PlatformAvatar`
// is ALSO rendered by `app/chat/sidebar/{index,session-row}.tsx`, which is not
// this front's surface: rewriting it in place changed a page we do not own and
// broke its test (critic r2, E3d2-T1). So this chip is used only by
// `src/app/messaging/**`; rebasing the chat sidebar onto it is the sidebar
// owner's change, not ours. `forwardRef` + `...rest` stay so a wrapping <Tip>
// (Radix `asChild`) can attach its trigger — dropping them fails silently.
export const IcPlatformAvatar = memo(
  forwardRef<HTMLSpanElement, IcPlatformAvatarProps>(function IcPlatformAvatar(
    { className, platformId, platformName, ...rest },
    ref
  ) {
    const spec = PLATFORM_ICONS[platformId]
    const Icon = spec?.Icon

    return (
      <span
        aria-hidden="true"
        className={className ? `icpg__avatar ${className}` : 'icpg__avatar'}
        ref={ref}
        style={{ '--icpg-brand': brandInk(spec?.color ?? '#71717A') } as React.CSSProperties}
        {...rest}
      >
        {Icon ? (
          <Icon height={14} width={14} />
        ) : (
          <span className="icpg__avatar-mono">{monogramOf(spec, platformName)}</span>
        )}
      </span>
    )
  })
)
