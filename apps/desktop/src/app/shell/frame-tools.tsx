import { useEffect, useRef, useState } from 'react'

import { registerIcloneBrowserTool } from '@/app/home/browser-tool'
import { useIcloneHudTool } from '@/app/home/hud-tool'
import { registerIcloneThemeTool } from '@/app/home/theme-tool'
import { $homeCopy, $toolsCopy } from '@/app/home/tools-copy'
import { registerIcloneWalletTool } from '@/app/home/wallet-tool'
import { Tip } from '@/components/ui/tooltip'
import { useContributions } from '@/contrib/react/use-contributions'
import type { Contribution } from '@/contrib/types'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import type { TitlebarTool } from './titlebar-controls'

/** OUR frame's tools, left to right at the top right: wallet, theme cycle, the
 *  browser pair, then HUD mode (the old titlebar's system cluster sat last). */
export const FRAME_TOOL_IDS = [
  'iclone-wallet',
  'iclone-theme-cycle',
  'iclone-browser-headed',
  'iclone-browser-recording',
  'iclone-hud'
] as const

// The home modules still publish their live tool state (label, glyph, active,
// handler) as core contributions to this area. Only the ids above are read
// from it: plugin contributions to titleBar.* have no slot (owner #20).
const TOOLS_AREA = 'titleBar.tools.right'

export function frameTools(contributions: readonly Contribution[]): TitlebarTool[] {
  const byId = new Map<string, TitlebarTool>()

  for (const c of contributions) {
    if ((c.source ?? 'core') === 'core' && c.data) {
      byId.set(c.id, c.data as TitlebarTool)
    }
  }

  return FRAME_TOOL_IDS.map(id => byId.get(id)).filter((tool): tool is TitlebarTool => Boolean(tool && !tool.hidden))
}

// OUR modals: a piece with a scrim is modal (ic-layers.css). The band sits
// outside the `.ihome` stacking context, so no scrim rung can cover the tools;
// they leave sight, the pointer and the Tab order while a scrim is mounted.
const OUR_MODAL_SCRIMS = '.inft-scrim, .iwbal-scrim'

const touchesScrim = (nodes: NodeList) =>
  Array.from(nodes).some(
    node => node instanceof Element && (node.matches(OUR_MODAL_SCRIMS) || node.querySelector(OUR_MODAL_SCRIMS) !== null)
  )

/** Whether one of OUR modal scrims is in the document. Only the subtrees a
 *  mutation adds or removes are inspected, so chat streaming stays cheap. */
function useOurModalOpen(): boolean {
  const [open, setOpen] = useState(() => document.querySelector(OUR_MODAL_SCRIMS) !== null)

  useEffect(() => {
    const sync = () => setOpen(document.querySelector(OUR_MODAL_SCRIMS) !== null)

    const observer = new MutationObserver(records => {
      if (records.some(r => touchesScrim(r.addedNodes) || touchesScrim(r.removedNodes))) {
        sync()
      }
    })

    observer.observe(document.body, { childList: true, subtree: true })
    sync()

    return () => observer.disconnect()
  }, [])

  return open
}

/** Icon-only controls on the main window's drag band. The cluster opts out of
 *  the drag region so a click reaches the button instead of moving the window.
 *  The `ichrome` classes follow OUR `i*__*` naming, which is how the boot
 *  filmstrip tells our frame from leaked upstream chrome. */
export function FrameTools() {
  const { t } = useI18n()

  // Words first, so the first publish below is already in the display language.
  useEffect(() => {
    $toolsCopy.set(t.desktop.home.tools)
    $homeCopy.set(t.desktop.home)
  }, [t])

  useEffect(() => {
    registerIcloneWalletTool()
    registerIcloneThemeTool()
    registerIcloneBrowserTool()
  }, [])

  useIcloneHudTool()

  const tools = frameTools(useContributions(TOOLS_AREA))
  const modalOpen = useOurModalOpen()
  const stripRef = useRef<HTMLDivElement>(null)

  // The strip's measurement is published on <html>: --titlebar-tools-width is
  // its width (the chat header reserves it beside --titlebar-tools-right) and
  // --titlebar-tools-span the distance from the viewport's right edge to the
  // strip's left edge, which the expanded window heads (ic-window.css,
  // msg-sidebar.css) keep their right-aligned controls clear of.
  useEffect(() => {
    const root = document.documentElement
    const strip = stripRef.current

    if (!strip) {
      root.style.setProperty('--titlebar-tools-width', '0px')
      root.style.setProperty('--titlebar-tools-span', '0px')

      return
    }

    const publish = () => {
      const rect = strip.getBoundingClientRect()

      root.style.setProperty('--titlebar-tools-width', `${Math.ceil(rect.width)}px`)
      root.style.setProperty('--titlebar-tools-span', `${Math.ceil(Math.max(0, window.innerWidth - rect.left))}px`)
    }

    publish()

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(publish)

    observer.observe(strip)

    return () => {
      observer.disconnect()
      root.style.removeProperty('--titlebar-tools-width')
      root.style.removeProperty('--titlebar-tools-span')
    }
  }, [tools.length])

  if (tools.length === 0) {
    return null
  }

  return (
    <div
      aria-hidden={modalOpen || undefined}
      aria-label={t.desktop.home.windowTools}
      className={cn(
        'ichrome absolute inset-y-0 right-3.5 flex items-center gap-0.5 transition-opacity duration-(--ic-dur-fast) ease-(--ic-ease-std) [-webkit-app-region:no-drag]',
        modalOpen ? 'pointer-events-none opacity-0' : 'pointer-events-auto'
      )}
      data-ic-frame-tools=""
      dir="ltr"
      inert={modalOpen}
      ref={stripRef}
      role="toolbar"
    >
      {tools.map(tool => (
        <Tip key={tool.id} label={tool.title ?? tool.label}>
          <button
            aria-busy={tool.busy || undefined}
            aria-label={tool.label}
            aria-pressed={tool.active === undefined ? undefined : tool.active}
            className="ichrome__tool grid size-6 place-items-center rounded-(--ic-radius-sm) text-(--ic-ctl-ink) opacity-80 transition-[background-color,color,opacity] duration-(--ic-dur-fast) ease-(--ic-ease-std) hover:bg-(--ic-ctl-hover-fill) hover:text-(--ic-ctl-hover-ink) hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--ic-accent) disabled:pointer-events-none disabled:opacity-40 aria-pressed:text-(--ic-accent) aria-pressed:opacity-100"
            data-ic-frame-tool={tool.id}
            data-working={tool.busy ? '' : undefined}
            disabled={tool.disabled}
            onClick={event => {
              // A busy toggle is never `disabled`: Chromium blurs a focused
              // element the instant it is, and Enter/Space lost their focus.
              if (!tool.busy) {
                tool.onSelect?.(event)
              }
            }}
            type="button"
          >
            {tool.icon}
          </button>
        </Tip>
      ))}
    </div>
  )
}
