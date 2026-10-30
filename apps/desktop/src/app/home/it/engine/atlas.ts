// xterm's WebGL renderer shares one glyph texture atlas between every terminal
// with the same font/color config. Clearing it from one pane invalidates the
// texture coordinates the other panes already drew with, so a pane-local clear
// (the old per-activation clear) garbles every other visible pane. Clears are
// therefore global events — theme, font, DPR, power resume, explicit recovery —
// and always run as ONE pass over every mounted terminal: all clears first,
// then all redraws, coalesced into a single animation frame.
//
// Sharing has a second cost: each WebGL context keeps its OWN texture copy of
// the shared pages and uploads it only when that pane renders. When one pane
// changes the shared atlas (new page, page merge, atlas swap), every other
// WebGL pane is redrawn in full on the next frame so it re-uploads the pages
// and rebuilds its texture coordinates instead of sampling a stale copy.

import type { IDisposable, IEvent } from '@xterm/xterm'

export interface AtlasTerminal {
  clearTextureAtlas: () => void
  refresh: () => void
}

/** The slice of a WebglAddon whose events reveal a shared-atlas change. */
export interface AtlasAddon {
  onAddTextureAtlasCanvas: IEvent<HTMLCanvasElement>
  onChangeTextureAtlas: IEvent<HTMLCanvasElement>
  onRemoveTextureAtlasCanvas: IEvent<HTMLCanvasElement>
}

const mounted = new Set<AtlasTerminal>()
const bound = new Map<AtlasTerminal, IDisposable[]>()
const changedBy = new Set<AtlasTerminal>()
let pendingFrame: null | number = null
let resyncFrame: null | number = null
let rebuilding = false
let detachTriggers: (() => void) | null = null

function rebuildMountedAtlases() {
  pendingFrame = null
  const terminals = [...mounted]

  // The pass redraws every terminal itself; the atlas events it provokes add nothing.
  rebuilding = true

  try {
    terminals.forEach(terminal => terminal.clearTextureAtlas())
  } finally {
    rebuilding = false
  }

  terminals.forEach(terminal => terminal.refresh())
}

function resyncWebglTerminals() {
  resyncFrame = null
  const sources = [...changedBy]

  changedBy.clear()

  for (const terminal of bound.keys()) {
    if (sources.some(source => source !== terminal)) {
      terminal.refresh()
    }
  }
}

function noteAtlasChange(source: AtlasTerminal) {
  if (rebuilding || !mounted.has(source)) {
    return
  }

  changedBy.add(source)
  resyncFrame ??= requestAnimationFrame(resyncWebglTerminals)
}

function unbind(terminal: AtlasTerminal) {
  bound.get(terminal)?.forEach(subscription => subscription.dispose())
  bound.delete(terminal)
  changedBy.delete(terminal)
}

/**
 * Follow the terminal's current WebGL addon (null = DOM renderer). Call it on
 * every renderer change: only WebGL terminals hold a texture copy to resync.
 */
export function bindAtlasAddon(terminal: AtlasTerminal, addon: AtlasAddon | null) {
  unbind(terminal)

  if (!addon || !mounted.has(terminal)) {
    return
  }

  const note = () => noteAtlasChange(terminal)

  bound.set(terminal, [
    addon.onChangeTextureAtlas(note),
    addon.onAddTextureAtlasCanvas(note),
    addon.onRemoveTextureAtlasCanvas(note)
  ])
}

/** Schedule the coordinated rebuild; every request made before the next frame shares one pass. */
export function requestAtlasRebuild() {
  if (pendingFrame !== null || mounted.size === 0) {
    return
  }

  pendingFrame = requestAnimationFrame(rebuildMountedAtlases)
}

// A resolution media query matches one exact ratio, so it has to be re-armed
// after every change to keep following zoom and display moves.
function watchDevicePixelRatio(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') {
    return () => {}
  }

  let query: MediaQueryList | null = null

  const handleChange = () => {
    query?.removeEventListener('change', handleChange)
    arm()
    onChange()
  }

  const arm = () => {
    query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    query.addEventListener('change', handleChange)
  }

  arm()

  return () => query?.removeEventListener('change', handleChange)
}

function attachRebuildTriggers() {
  const fonts = typeof document === 'undefined' ? undefined : document.fonts

  // A late webfont swaps the faces the atlas rasterized with.
  fonts?.addEventListener?.('loadingdone', requestAtlasRebuild)

  // Sleep/wake and screen unlock can hand back a GPU whose textures were evicted.
  const unsubscribePowerResume = window.hermesDesktop?.onPowerResume?.(requestAtlasRebuild)
  const unwatchDevicePixelRatio = watchDevicePixelRatio(requestAtlasRebuild)

  return () => {
    fonts?.removeEventListener?.('loadingdone', requestAtlasRebuild)
    unsubscribePowerResume?.()
    unwatchDevicePixelRatio()
  }
}

/**
 * Join the coordinated atlas rebuild for as long as the terminal is mounted.
 * `clearTextureAtlas` should read the current WebGL addon lazily: the renderer
 * can switch between WebGL and DOM during the terminal's life.
 */
export function registerAtlasTerminal(terminal: AtlasTerminal) {
  mounted.add(terminal)
  detachTriggers ??= attachRebuildTriggers()

  return () => {
    unbind(terminal)

    if (!mounted.delete(terminal) || mounted.size > 0) {
      return
    }

    detachTriggers?.()
    detachTriggers = null

    if (pendingFrame !== null) {
      cancelAnimationFrame(pendingFrame)
      pendingFrame = null
    }

    if (resyncFrame !== null) {
      cancelAnimationFrame(resyncFrame)
      resyncFrame = null
    }
  }
}
