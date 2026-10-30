import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'

import { leaseTerminalWebgl, type WebglLease } from '@/app/home/gpu-lease'
import { writeClipboardText } from '@/components/ui/copy-button'
import { markRightPanePerf } from '@/debug/right-pane-events'
import { triggerHaptic } from '@/lib/haptics'
import { useTheme } from '@/themes/context'

import { observeActiveTerminalResize, scheduleRendererCanvasSync, stopRendererCanvasSync } from './active-resize'
import { registerAgentTerminalWriter } from './agent-terminal-stream'
import { bindAtlasAddon, registerAtlasTerminal, requestAtlasRebuild } from './atlas'
import { makeTerminalReader, registerTerminalReader } from './buffer'
import { mirrorSelection, terminalClipboardIntent } from './clipboard'
import { terminalLinkHandler, terminalWebLinksAddon } from './links'
import { isMacPlatform, resolveSurfaceColor, terminalTheme } from './selection'
import { registerTerminalContextMenu } from './terminal-context-menu'
import { prepareTerminalFontFamily } from './terminal-font'
import { useTerminalFontController } from './use-terminal-font'

// Read-only terminal for an agent background process: a write-only xterm (no PTY,
// no input) fed live by the backend output stream, keyed by process id. Shares
// the user terminal's look so the two read as one surface.
interface AgentTerminalOptions {
  active: boolean
  /** Owns the keyboard. Defaults to `active` (one visible agent tab at a time). */
  focused?: boolean
  id: string
  procId: string
}

export function useAgentTerminal({ active, focused: focusedOption, id, procId }: AgentTerminalOptions) {
  const focused = focusedOption ?? active
  const { renderedMode, theme, themeName } = useTheme()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  const leaseRef = useRef<WebglLease | null>(null)
  const activeRef = useRef(active)
  const focusedRef = useRef(focused)
  const fitRef = useRef<((visible: boolean) => void) | null>(null)
  const initialActiveFitRef = useRef(false)
  const { latestFontFamilyRef, mountedRef } = useTerminalFontController({ fitRef, termRef })

  const surfaceTheme = () => {
    const ansi = renderedMode === 'dark' ? (theme.darkTerminal ?? theme.terminal) : theme.terminal
    const base = terminalTheme(renderedMode, ansi)
    // Fall back to the palette's own background, not white — a hardcoded
    // '#ffffff' flashes a white slab in dark mode whenever the probe can't read
    // the token (pre-paint mount). Same contract as the user terminal.
    const surface = resolveSurfaceColor(base.background ?? '#ffffff')

    return { ...base, background: surface, cursorAccent: surface }
  }

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    const host = hostRef.current

    if (!host) {
      return
    }

    let disposed = false

    let unregister = () => {}

    let unregisterReader = () => {}

    let unregisterAtlas = () => {}

    let releaseLease = () => {}

    const term = new Terminal({
      allowProposedApi: true,
      allowTransparency: false,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: latestFontFamilyRef.current,
      fontSize: 11,
      fontWeight: 'normal',
      fontWeightBold: 'bold',
      letterSpacing: 0,
      lineHeight: 1.12,
      linkHandler: terminalLinkHandler,
      minimumContrastRatio: 4.5,
      scrollback: 1000,
      theme: surfaceTheme()
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new Unicode11Addon())
    term.loadAddon(terminalWebLinksAddon())
    term.unicode.activeVersion = '11'

    // Read-only mirror, but the output is exactly what people want to copy.
    // No paste path: this terminal has no PTY to paste into.
    const selectionDisposable = term.onSelectionChange(() => mirrorSelection(host, term.getSelection()))

    // Right-clicks resolve through the app context menu; the handle carries
    // the xterm selection the DOM resolver cannot see. paste stays null —
    // there is nothing to paste into.
    const contextMenuDisposable = registerTerminalContextMenu(host, {
      getSelection: () => term.getSelection(),
      paste: null,
      selectAll: () => term.selectAll()
    })

    term.attachCustomKeyEventHandler(event => {
      const intent = terminalClipboardIntent(event, {
        hasSelection: Boolean(term.getSelection()),
        isMac: isMacPlatform()
      })

      if (intent !== 'copy') {
        return true
      }

      event.preventDefault()
      void writeClipboardText(term.getSelection()).catch(() => {
        // Clipboard unavailable — leave the selection so the user can retry.
      })
      term.clearSelection()
      triggerHaptic('selection')

      return false
    })

    fitRef.current = visible => {
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        try {
          fit.fit()
          markRightPanePerf(visible ? 'terminal-fit-active' : 'terminal-fit-hidden', id)
        } catch {
          // Mid-transition layout — the next observer tick refits.
          return
        }

        if (visible) {
          scheduleRendererCanvasSync(term)
        }
      }
    }

    const mount = () => {
      if (disposed || !host.isConnected) {
        return
      }

      term.open(host)
      termRef.current = term
      mountedRef.current = true

      const atlasEntry = {
        clearTextureAtlas: () => webglRef.current?.clearTextureAtlas(),
        refresh: () => term.refresh(0, term.rows - 1)
      }

      unregisterAtlas = registerAtlasTerminal(atlasEntry)

      // The GPU lease owns the WebGL addon; every renderer switch changes the
      // cell metrics, so refit, then repaint every row.
      const lease = leaseTerminalWebgl(term, webglRef, () => {
        bindAtlasAddon(atlasEntry, webglRef.current)
        fitRef.current?.(activeRef.current)
        term.refresh(0, term.rows - 1)
      })

      leaseRef.current = lease

      releaseLease = () => {
        leaseRef.current = null
        lease.dispose()
      }

      lease.setVisible(activeRef.current)

      if (focusedRef.current) {
        lease.touch()
      }

      fitRef.current?.(activeRef.current)
      initialActiveFitRef.current = activeRef.current

      // Stream live output straight into the terminal (replays backlog on attach).
      unregister = registerAgentTerminalWriter(procId, chunk => term.write(chunk))
      unregisterReader = registerTerminalReader(id, makeTerminalReader(term))
    }

    void prepareTerminalFontFamily(
      () => latestFontFamilyRef.current,
      () => !disposed && host.isConnected
    ).then(fontFamily => {
      if (!fontFamily) {
        return
      }

      term.options.fontFamily = fontFamily
      mount()
    })

    return () => {
      disposed = true
      mountedRef.current = false
      unregister()
      unregisterReader()
      releaseLease()
      unregisterAtlas()
      selectionDisposable.dispose()
      contextMenuDisposable()
      fitRef.current = null
      // Stop the canvas watch HERE, while the terminal is still in hand: the
      // active effect's cleanup runs after this one and only sees a null ref,
      // so it used to leave a live ResizeObserver per closed pane.
      stopRendererCanvasSync(term)
      term.dispose()
      termRef.current = null
      webglRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const term = termRef.current

    if (!term) {
      return
    }

    const raf = requestAnimationFrame(() => {
      term.options.theme = surfaceTheme()
      requestAtlasRebuild()
    })

    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderedMode, themeName])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    activeRef.current = active
    leaseRef.current?.setVisible(active)
  }, [active])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    focusedRef.current = focused

    if (focused) {
      leaseRef.current?.touch()
    }
  }, [focused])

  // Keep inactive agent terminals mounted for their backlog, but do not observe
  // or fit them until they become the visible tab.
  // eslint-disable-next-line no-restricted-syntax -- lifecycle flag prevents a duplicate first-mount fit
  useEffect(() => {
    if (!active) {
      initialActiveFitRef.current = false

      return
    }

    const host = hostRef.current

    if (!host) {
      return
    }

    const fitOnActivate = !initialActiveFitRef.current
    initialActiveFitRef.current = false

    const stopResize = observeActiveTerminalResize(host, {
      fitOnActivate,
      onFit: () => fitRef.current?.(true),
      onActivate: () => {
        const term = termRef.current

        // Redraw only: the texture atlas is shared, so clearing it here would
        // garble every other visible pane (see atlas.ts).
        term?.refresh(0, term.rows - 1)

        // Take focus on activation (parity with the user terminal) so the active
        // agent tab holds focus and ⌘W's isFocusWithin('[data-terminal]') routes
        // the close to this tab rather than to a preview.
        if (focusedRef.current) {
          term?.focus()
        }

        if (term) {
          scheduleRendererCanvasSync(term)
        }
      }
    })

    return () => {
      stopResize()
      stopRendererCanvasSync(termRef.current)
    }
  }, [active])

  return { hostRef }
}
