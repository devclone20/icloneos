import type { HermesConnection } from '@/global'

export const TITLEBAR_HEIGHT = 34
/** Titlebar tool hit target (both axes). */
export const TITLEBAR_CONTROL_SIZE = 24
/** Codicon glyph box in titlebar clusters — optical match to traffic-light row. */
export const TITLEBAR_ICON_SIZE = 13.9
export const TITLEBAR_CONTROL_OFFSET_X = 74
const TITLEBAR_CONTROLS_TOP = (TITLEBAR_HEIGHT - TITLEBAR_CONTROL_SIZE) / 2

/** Inline font-size for titlebar Codicons — beats unlayered codicon.css `font: 16px`. */
export function titlebarIconSizeCss(scale = 1): string {
  return `${TITLEBAR_ICON_SIZE * scale}px`
}

export const TITLEBAR_FALLBACK_WINDOW_BUTTON_X = 24
// Edge inset used when no left-side native controls take up that space —
// Windows/Linux (native overlay is on the right) and macOS fullscreen
// (traffic lights are hidden). Matches the right-cluster's 0.75rem padding.
export const TITLEBAR_EDGE_INSET = 14

interface TitlebarChromeContext {
  darwinMajor?: number
  isFullscreen?: boolean
  windowButtonPosition?: HermesConnection['windowButtonPosition']
}

/** Right-cluster inset — WCO width when present; macOS fullscreen matches left edge inset. */
export function titlebarToolsRightCss(
  nativeOverlayWidth: number,
  { darwinMajor = 0, isFullscreen = false }: Pick<TitlebarChromeContext, 'darwinMajor' | 'isFullscreen'> = {}
): string {
  if (nativeOverlayWidth > 0) {
    return `${nativeOverlayWidth}px`
  }

  if (isFullscreen && darwinMajor > 0) {
    return `${TITLEBAR_EDGE_INSET}px`
  }

  return '0.75rem'
}

export const titlebarHeaderBaseClass =
  'pointer-events-none relative z-3 flex h-(--titlebar-height) w-full min-w-0 shrink-0 items-center justify-start gap-3 overflow-hidden border-b border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) px-[max(0.75rem,var(--titlebar-content-inset,0rem))] pr-[calc(var(--titlebar-tools-right,0.75rem)+var(--titlebar-tools-width,0px)+0.75rem)]'

// Title row inside the header — must stay in the flex truncate chain.
export const titlebarHeaderTitleClass = 'min-w-0 flex-1 overflow-hidden'

export const titlebarHeaderShadowClass =
  "after:pointer-events-none after:absolute after:left-0 after:right-0 after:top-full after:h-4 after:bg-linear-to-b after:from-(--ui-chat-surface-background) after:to-transparent after:content-['']"

export function titlebarControlsPosition(
  windowButtonPosition: HermesConnection['windowButtonPosition'] | undefined,
  isFullscreen = false
) {
  const top = Math.max(0, TITLEBAR_CONTROLS_TOP)

  // No left-side native controls to dodge:
  //   - Windows/Linux: native min/max/close render on the right via titleBarOverlay.
  //   - macOS fullscreen: traffic lights are hidden.
  // In both cases, pin the cluster to the edge with a small inset.
  if (windowButtonPosition === null || isFullscreen) {
    return { left: TITLEBAR_EDGE_INSET, top }
  }

  return {
    left: (windowButtonPosition?.x ?? TITLEBAR_FALLBACK_WINDOW_BUTTON_X) + TITLEBAR_CONTROL_OFFSET_X,
    top
  }
}
