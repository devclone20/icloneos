import { Fragment, type KeyboardEvent, memo, type ReactNode } from 'react'

import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { TabDropdown } from '@/components/ui/tab-dropdown'
import type { IconComponent } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { PAGE_MAX_W } from '../layout-constants'

import { OVERLAY_TOP_CLEARANCE } from './overlay-view'

// The wide rail and the narrow dropdown swap at exactly the width where
// OverlaySplitLayout drops to a single column, so the rail never stacks.
const RAIL_HIDDEN = 'max-[47.5rem]:hidden'
const BAR_HIDDEN = 'hidden max-[47.5rem]:flex'

interface OverlaySplitLayoutProps {
  children: ReactNode
  className?: string
}

interface OverlaySidebarProps {
  children: ReactNode
  className?: string
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void
}

interface OverlayMainProps {
  children: ReactNode
  className?: string
}

interface OverlayNavItemProps {
  active: boolean
  icon: IconComponent
  /** Stable identity for the row, used as its `data-tour` handle. */
  id?: string
  label: string
  // Renders as an indented child of another nav item: smaller icon and a
  // lighter active state so it never competes with the boxed parent item.
  nested?: boolean
  onClick: () => void
  trailing?: ReactNode
}

export function OverlaySplitLayout({ children, className }: OverlaySplitLayoutProps) {
  return (
    <div
      className={cn(
        // Narrow: one column, and pin rows to [nav-bar auto | main 1fr] — without
        // an explicit template the grid's default align-content:stretch splits the
        // height evenly across the two rows, shoving the content to mid-screen.
        // The rail grows with the text size (the 13rem it always had at default
        // and below, × the scale above it), so large text never truncates a label.
        'grid h-full min-h-0 flex-1 grid-cols-[calc(13rem*max(1,var(--ic-text-scale,1)))_minmax(0,1fr)] overflow-hidden bg-transparent max-[47.5rem]:grid-cols-1 max-[47.5rem]:grid-rows-[auto_minmax(0,1fr)]',
        className
      )}
    >
      {children}
    </div>
  )
}

function OverlaySidebar({ children, className, onKeyDown }: OverlaySidebarProps) {
  return (
    <aside
      className={cn(
        // The left links sit beside (not under) the floating close button, so
        // they ride up via the shorter shared OVERLAY_TOP_CLEARANCE (same line
        // as a Panel header) instead of main's taller X-clearance. The bg still
        // fills from the card's top edge, so there's no gap above the sidebar.
        // Rows never shrink: in a scrolling flex column the default flex-shrink
        // squeezed every row once a sub-tab made the rail taller than the
        // card, and `truncate` headings were clipped to half their height.
        // The rail scrolls instead.
        'flex min-h-0 flex-col gap-0.5 overflow-y-auto bg-(--ui-sidebar-surface-background) px-2.5 pb-3 *:shrink-0',
        OVERLAY_TOP_CLEARANCE,
        className
      )}
      // Every overlay's left nav (settings, cron, profiles, agents) answers to
      // one name, so a tour can point at "the nav" without knowing which
      // overlay is open. See lib/tour.
      data-tour="overlay-nav"
      onKeyDown={onKeyDown}
    >
      {children}
    </aside>
  )
}

export function OverlayMain({ children, className }: OverlayMainProps) {
  return (
    <main
      className={cn(
        // Main sits UNDER the floating close button (top-right), so it keeps the
        // taller top pad to clear the X — unlike the sidebar / Panel header,
        // which sit to its left and ride up via OVERLAY_TOP_CLEARANCE. All four
        // paddings are 1/3 tighter than the raw values (×2/3): the wide/narrow
        // top clearance, the bottom gutter, and the horizontal clamp gutter
        // (inlined from PAGE_INSET_X so only overlay panes tighten, not the
        // shared page gutter). Narrow top drops toward the OverlayNav bar.
        'mx-auto flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-transparent pb-2 pt-[calc((var(--titlebar-height)/2+1rem)*2/3)] max-[47.5rem]:pt-[calc(0.5rem*2/3)] px-[clamp(0.8333rem,2.6667vw,2.6667rem)]',
        PAGE_MAX_W,
        className
      )}
    >
      {children}
    </main>
  )
}

const OverlayNavItem = memo(function OverlayNavItem({
  active,
  icon: Icon,
  id,
  label,
  nested,
  onClick,
  trailing
}: OverlayNavItemProps) {
  return (
    <button
      aria-current={active ? (nested ? 'true' : 'page') : undefined}
      className={cn(
        // Keyboard parity with the mouse: these rows had hover states but no
        // focus ring at all — Tab landed on them invisibly (the app's global
        // reset kills the UA outline). The house outline, so every overlay
        // nav (settings, cron, profiles, agents) lights up the moment focus
        // arrives, at a contrast the stage can show.
        'flex min-h-7 w-full items-center justify-start gap-2 rounded-md border px-2 py-1 text-start text-[length:var(--conversation-text-font-size)] font-normal transition-colors outline-none',
        OVERLAY_FOCUS_OUTLINE,
        nested
          ? active
            ? 'border-transparent bg-(--chrome-action-hover) font-medium text-foreground'
            : 'border-transparent bg-transparent text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
          : active
            ? 'border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary) text-foreground'
            : 'border-transparent bg-transparent text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      )}
      // Names the row by its own id, so a tour can address one link
      // (`[data-tour="nav-models"]`) instead of guessing at nth-child.
      data-tour={id ? `nav-${id}` : undefined}
      onClick={onClick}
      type="button"
    >
      <Icon
        aria-hidden
        className={cn(
          'shrink-0',
          nested ? 'size-3.5' : 'size-4',
          active ? 'text-foreground/80' : 'text-muted-foreground/80'
        )}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  )
})

export interface OverlayNavLink {
  active: boolean
  icon: IconComponent
  id: string
  label: string
  onSelect: () => void
}

export interface OverlayNavGroup extends OverlayNavLink {
  /** Sub-links: expanded under the active group on the rail, always listed
   *  (flattened + indented) in the narrow dropdown. */
  children?: OverlayNavLink[]
  /** Visual break before this group — a spacer on the rail, a separator in
   *  the dropdown. */
  gapBefore?: boolean
}

// A non-interactive section label above a run of groups — e.g. Settings'
// "Agent & Models" / "Appearance & Desktop" rail headings. Optional and
// additive: a `groups` array of plain OverlayNavGroup entries (every consumer
// before this one) renders exactly as before, since nothing emits `kind`.
/**
 * The keyboard focus indicator of overlay nav rows and headings (and the
 * Settings landing doors): the house solid outline, as on the Close button and
 * the Dock tiles — not the 25 %-alpha ring, which never reaches 3:1 on the dark
 * stage (tester U3-01-p2 / p2b).
 */
export const OVERLAY_FOCUS_OUTLINE =
  'focus-visible:outline-[1.67px] focus-visible:outline-solid focus-visible:outline-(--ic-gold-500) focus-visible:outline-offset-1'

export interface OverlayNavHeading {
  readonly kind: 'heading'
  /** Opt-in: the heading becomes a disclosure button over the rows that follow
   *  it (up to the next heading). The consumer owns the state, so it decides
   *  which group a deep link or the active row must reveal. Collapsed rows stay
   *  mounted (inert): hidden by disclosure is not removed. */
  disclosure?: {
    expanded: boolean
    onToggle: () => void
  }
  id: string
  label: string
}

type OverlayNavRow = OverlayNavGroup | OverlayNavHeading

function isNavHeading(row: OverlayNavRow): row is OverlayNavHeading {
  return 'kind' in row && row.kind === 'heading'
}

interface RailSegment {
  heading?: OverlayNavHeading
  rows: OverlayNavGroup[]
}

// Splits the flat model into one segment per heading (plus a leading run of
// rows with no heading), so a disclosure can wrap exactly the rows it owns.
function railSegments(groups: OverlayNavRow[]): RailSegment[] {
  const segments: RailSegment[] = []

  for (const row of groups) {
    if (isNavHeading(row)) {
      segments.push({ heading: row, rows: [] })
    } else if (segments.length === 0) {
      segments.push({ rows: [row] })
    } else {
      segments[segments.length - 1].rows.push(row)
    }
  }

  return segments
}

const RAIL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home'])

// Arrow keys walk the rail's buttons in order (headings and rows alike).
// Rows under a collapsed heading sit inside an `inert` region, which the
// selector skips, so focus never lands on a row the person cannot see.
function moveRailFocus(event: KeyboardEvent<HTMLElement>) {
  if (!RAIL_KEYS.has(event.key)) {
    return
  }

  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button')).filter(
    button => !button.closest('[inert]')
  )

  const at = buttons.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement)

  if (at < 0) {
    return
  }

  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : Math.min(buttons.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))

  event.preventDefault()
  buttons[next]?.focus()
}

// The chevron turns on the app's own motion tokens; reduced motion snaps it.
const DISCLOSURE_MOTION = 'duration-(--ic-dur-base) ease-(--ic-ease-spring) motion-reduce:transition-none'

function NavDisclosureHeading({ heading, panelId }: { heading: OverlayNavHeading; panelId: string }) {
  const open = heading.disclosure?.expanded ?? true

  return (
    <button
      aria-controls={panelId}
      aria-expanded={open}
      className={cn(
        'group/heading mt-2 flex min-h-7 w-full items-center gap-1.5 rounded-(--ic-radius-sm) px-2 py-1 text-start text-[length:var(--conversation-text-font-size)] font-medium text-(--ic-text-2) outline-none transition-colors first:mt-0 hover:bg-(--ic-fill-hover) hover:text-(--ic-text-1)',
        OVERLAY_FOCUS_OUTLINE
      )}
      data-nav-heading={heading.id}
      onClick={heading.disclosure?.onToggle}
      type="button"
    >
      <DisclosureCaret
        aria-hidden
        className={cn('text-(--ic-text-3) group-hover/heading:text-(--ic-text-2)', DISCLOSURE_MOTION)}
        open={open}
        size="0.875em"
      />
      <span className="min-w-0 flex-1 truncate">{heading.label}</span>
    </button>
  )
}

function isDisclosure(row: OverlayNavRow): boolean {
  return isNavHeading(row) && row.disclosure !== undefined
}

function renderRailRow(row: OverlayNavGroup) {
  return (
    <Fragment key={row.id}>
      {row.gapBefore && <div aria-hidden className="h-2" />}
      <OverlayNavItem active={row.active} icon={row.icon} id={row.id} label={row.label} onClick={row.onSelect} />
      {row.children && row.active && (
        <div className="ml-3.5 flex flex-col gap-0.5 pl-1.5">
          {row.children.map(child => (
            <OverlayNavItem
              active={child.active}
              icon={child.icon}
              id={child.id}
              key={child.id}
              label={child.label}
              nested
              onClick={child.onSelect}
            />
          ))}
        </div>
      )}
    </Fragment>
  )
}

// Data-driven pane nav: one model renders a persistent left rail on wide
// viewports and a single dropdown bar on narrow ones (matching the tab
// dropdown the deleted PageSearchShell used to carry), so every OverlaySplitLayout pane degrades the
// same way instead of stacking its whole sidebar. Drop it in as the first
// child of an OverlaySplitLayout, before OverlayMain.
export function OverlayNav({ footer, groups }: { footer?: ReactNode; groups: OverlayNavRow[] }) {
  // Narrow dropdown has no room for a repeated text heading — a heading still
  // draws a divider (like `gapBefore`) ahead of the next real item so the
  // grouping isn't lost entirely, just silent.
  let forceSeparator = false

  const dropdownItems = groups.flatMap(row => {
    if (isNavHeading(row)) {
      forceSeparator = true

      return []
    }

    const separatorBefore = forceSeparator || row.gapBefore
    forceSeparator = false

    return [
      {
        active: row.active && !row.children?.some(child => child.active),
        icon: row.icon,
        id: row.id,
        label: row.label,
        onSelect: row.onSelect,
        separatorBefore
      },
      ...(row.children ?? []).map(child => ({
        active: child.active,
        icon: child.icon,
        id: child.id,
        indent: true,
        label: child.label,
        onSelect: child.onSelect
      }))
    ]
  })

  return (
    <>
      <OverlaySidebar className={RAIL_HIDDEN} onKeyDown={groups.some(isDisclosure) ? moveRailFocus : undefined}>
        {railSegments(groups).map((segment, index) => {
          const rows = segment.rows.map(renderRailRow)
          const heading = segment.heading

          if (!heading) {
            return <Fragment key={`rows-${index}`}>{rows}</Fragment>
          }

          if (!heading.disclosure) {
            return (
              <Fragment key={heading.id}>
                <div className="mt-3 truncate px-2 pb-1 text-[0.6875rem] font-semibold tracking-wide text-(--ui-text-tertiary) uppercase first:mt-0">
                  {heading.label}
                </div>
                {rows}
              </Fragment>
            )
          }

          const panelId = `${heading.id}-rows`
          const open = heading.disclosure.expanded

          return (
            <Fragment key={heading.id}>
              <NavDisclosureHeading heading={heading} panelId={panelId} />
              {/* Rows animate open by their grid track (0fr -> 1fr) and stay in
                  the DOM while closed; `inert` removes them from focus and
                  from the accessibility tree until the heading opens. */}
              <div
                className={cn(
                  'grid transition-[grid-template-rows]',
                  DISCLOSURE_MOTION,
                  open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                )}
                data-nav-rows={heading.id}
                id={panelId}
                inert={!open}
                role="group"
              >
                <div className="flex min-h-0 flex-col gap-0.5 overflow-hidden">{rows}</div>
              </div>
            </Fragment>
          )
        })}
        {footer && <div className="mt-auto flex items-center gap-1 pt-2">{footer}</div>}
      </OverlaySidebar>

      {/* Narrow: ride the OverlayView titlebar strip so the dropdown shares the
          close button's row instead of taking its own. The bar is
          pointer-events-none (children opt back in) so the floating X underneath
          stays clickable; pr clears it, no-drag beats the strip's drag region,
          and the height matches the strip so the trigger lines up with the X. */}
      <div
        className={cn(
          'pointer-events-none relative z-20 h-[calc(var(--titlebar-height)+0.1875rem)] items-center justify-between gap-2 pl-3 pr-12',
          BAR_HIDDEN
        )}
      >
        <div className="pointer-events-auto min-w-0 [-webkit-app-region:no-drag]">
          <TabDropdown align="start" items={dropdownItems} />
        </div>
        {footer && (
          <div className="pointer-events-auto flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
            {footer}
          </div>
        )}
      </div>
    </>
  )
}
