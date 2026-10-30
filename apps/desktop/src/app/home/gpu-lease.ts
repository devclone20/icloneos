/**
 * The GPU lease — which terminal may hold a WebGL context, and for how long.
 *
 * Chromium keeps at most 16 live WebGL contexts per renderer process and,
 * past that, silently kills the OLDEST one ("Too many active WebGL
 * contexts") — usually the 3D stage or the pane the owner is reading. Every
 * xterm used to build its WebglAddon at mount and keep it forever, hidden
 * workspaces and agent mirrors included, so a busy iT session walked straight
 * into that cap.
 *
 * Policy (contract P2, decision 3):
 * - only VISIBLE terminals hold a WebglAddon; a hidden one keeps it for a
 *   3 s grace (workspace flips and zoom toggles must not thrash), then drops
 *   to the DOM renderer, which is idle anyway while its host is hidden;
 * - at most TERMINAL_WEBGL_BUDGET terminal contexts, and never more than
 *   GPU_CONTEXT_TOTAL_CAP together with `reserveGpuContext` holders;
 *   the focused terminal first, then the most recently focused/shown;
 * - releases are deterministic: a disposed WebglAddon leaves its context
 *   alive until GC, so the lease loses it explicitly right after dispose;
 * - a context loss falls back to DOM, cools down 10 s, then re-acquires
 *   (at most 3 losses a minute per terminal, after that DOM for the session);
 * - only a failure to CREATE a context latches the session onto DOM —
 *   evictions and losses never do.
 */
import { WebglAddon } from '@xterm/addon-webgl'
import type { ITerminalAddon, Terminal } from '@xterm/xterm'

import { requestAtlasRebuild } from '@/app/right-sidebar/terminal/atlas'

export const CHROMIUM_WEBGL_CAP = 16
export const TERMINAL_WEBGL_BUDGET = 8
export const GPU_CONTEXT_TOTAL_CAP = 12
export const HIDDEN_GRACE_MS = 3_000
export const LOSS_COOLDOWN_MS = 10_000
const LOSS_WINDOW_MS = 60_000
const MAX_LOSSES_PER_WINDOW = 3
const GPU_ACCELERATION_KEY = 'iclone.gpu.acceleration'

export type GpuAcceleration = 'auto' | 'off' | 'on'
type RendererChoice = 'auto' | 'dom' | 'webgl'

export interface WebglLease {
  /** Mirrors the terminal's `active` (its host is on screen). */
  setVisible(visible: boolean): void
  /** The terminal took focus: it ranks first for a context. */
  touch(): void
  forceRenderer(renderer: RendererChoice): void
  dispose(): void
}

/** The slice of a WebglAddon the lease drives — a fake in tests. */
export interface LeaseAddon extends ITerminalAddon {
  onContextLoss: (listener: () => void) => { dispose(): void }
}

/** The slice of an xterm Terminal the lease drives. */
export interface LeaseTerminal<A extends LeaseAddon> {
  readonly cols: number
  readonly element: HTMLElement | undefined
  loadAddon(addon: A): void
  refresh(start: number, end: number): void
  readonly rows: number
}

interface LeaseInfo {
  focusedAt: number
  id: string
  losses: number
  renderer: 'dom' | 'webgl'
  visible: boolean
}

interface GpuDevSeam {
  force(id: string, renderer: RendererChoice): boolean
  leases(): LeaseInfo[]
  liveContexts(): number
  rebuild(id: string): boolean
}

interface GpuLeasePoolOptions<A extends LeaseAddon> {
  budget?: number
  createAddon: () => A
  readPreference?: () => GpuAcceleration
  /** The shared-atlas coordinator (AD2); the dev-seam rebuild falls back to it. */
  requestAtlasRebuild?: () => void
  totalCap?: number
  writePreference?: (value: GpuAcceleration) => void
}

interface GpuLeasePool<A extends LeaseAddon> {
  devSeam(): GpuDevSeam
  lease(term: LeaseTerminal<A>, ref: { current: A | null }, onRendererChange: () => void): WebglLease
  reserve(owner: string): () => void
  setPreference(value: GpuAcceleration): void
}

interface LeaseState<A extends LeaseAddon> {
  addon: A | null
  blocked: boolean
  canvases: HTMLCanvasElement[]
  cooldownTimer: ReturnType<typeof setTimeout> | null
  cooldownUntil: number
  disposed: boolean
  failed: boolean
  focusSeq: number
  focusedAt: number
  forced: RendererChoice
  graceOver: boolean
  graceTimer: ReturnType<typeof setTimeout> | null
  hiddenSeq: number
  key: string
  lossSub: { dispose(): void } | null
  losses: number
  onRendererChange: () => void
  recentLosses: number[]
  ref: { current: A | null }
  shownSeq: number
  term: LeaseTerminal<A>
  visible: boolean
}

function webglOf(canvas: HTMLCanvasElement): null | WebGL2RenderingContext {
  try {
    return canvas.getContext('webgl2')
  } catch {
    return null
  }
}

interface RenderServiceInternals {
  _core?: { _renderService?: { handleResize?: (cols: number, rows: number) => void } }
}

/**
 * A full model rebuild of one terminal, whatever renderer it is on. Without
 * xterm's render service the only deeper reset is an atlas clear, and the
 * atlas is shared by every pane: that goes through the coordinated pass.
 */
function rebuildModel<A extends LeaseAddon>(term: LeaseTerminal<A>, requestAtlasPass: () => void): void {
  const service = (term as unknown as RenderServiceInternals)._core?._renderService

  if (typeof service?.handleResize === 'function') {
    service.handleResize(term.cols, term.rows)
  } else {
    requestAtlasPass()
  }

  term.refresh(0, term.rows - 1)
}

export function createGpuLeasePool<A extends LeaseAddon>(options: GpuLeasePoolOptions<A>): GpuLeasePool<A> {
  const budget = options.budget ?? TERMINAL_WEBGL_BUDGET
  const totalCap = options.totalCap ?? GPU_CONTEXT_TOTAL_CAP
  const requestAtlasPass = options.requestAtlasRebuild ?? requestAtlasRebuild
  const leases = new Set<LeaseState<A>>()
  const reserves = new Set<{ owner: string }>()
  let preference: GpuAcceleration = options.readPreference?.() ?? 'auto'
  let latched = false
  let seq = 0
  let reconciling = false
  let dirty = false

  const allowed = (state: LeaseState<A>, now: number) =>
    !state.disposed &&
    !state.failed &&
    !state.blocked &&
    state.forced !== 'dom' &&
    (state.forced === 'webgl' || (preference !== 'off' && !(latched && preference === 'auto'))) &&
    now >= state.cooldownUntil &&
    Boolean(state.term.element)

  const wants = (state: LeaseState<A>, now: number) =>
    allowed(state, now) && (state.visible || state.forced === 'webgl')

  const inGrace = (state: LeaseState<A>, now: number) => !state.visible && !state.graceOver && allowed(state, now)

  const rank = (a: LeaseState<A>, b: LeaseState<A>) => b.focusSeq - a.focusSeq || b.shownSeq - a.shownSeq

  const notify = (state: LeaseState<A>) => {
    if (state.disposed) {
      return
    }

    try {
      state.onRendererChange()
    } catch (error) {
      console.warn('[gpu-lease] renderer change handler failed', error)
    }
  }

  const detach = (state: LeaseState<A>, lose: boolean) => {
    const addon = state.addon

    if (!addon) {
      return
    }

    // Grab the contexts BEFORE dispose: dispose detaches the canvases, and
    // the addon's own loss listeners must be gone before we lose them.
    const contexts = lose ? state.canvases.map(webglOf).filter((gl): gl is WebGL2RenderingContext => gl !== null) : []

    state.lossSub?.dispose()
    state.lossSub = null
    state.addon = null
    state.canvases = []

    if (state.ref.current === addon) {
      state.ref.current = null
    }

    try {
      addon.dispose()
    } catch (error) {
      console.warn('[gpu-lease] WebglAddon dispose failed', error)
    }

    for (const gl of contexts) {
      if (!gl.isContextLost()) {
        gl.getExtension('WEBGL_lose_context')?.loseContext()
      }
    }

    notify(state)
  }

  const onLoss = (state: LeaseState<A>) => {
    const now = Date.now()

    state.losses++
    state.recentLosses = [...state.recentLosses.filter(at => now - at < LOSS_WINDOW_MS), now]
    state.blocked = state.recentLosses.length >= MAX_LOSSES_PER_WINDOW
    state.cooldownUntil = now + LOSS_COOLDOWN_MS
    // The context is already gone: nothing left to lose explicitly.
    detach(state, false)

    if (state.cooldownTimer !== null) {
      clearTimeout(state.cooldownTimer)
    }

    // The timer, not the clock, ends the cooldown: a timer that fires a
    // millisecond early must not leave the terminal on DOM for good.
    state.cooldownTimer = setTimeout(() => {
      state.cooldownTimer = null
      state.cooldownUntil = 0
      reconcile()
    }, LOSS_COOLDOWN_MS)
    reconcile()
  }

  const attach = (state: LeaseState<A>) => {
    const host = state.term.element

    if (!host) {
      return
    }

    const before = new Set(host.querySelectorAll('canvas'))
    let addon: A | null = null

    try {
      addon = options.createAddon()
      state.term.loadAddon(addon)
    } catch (error) {
      try {
        addon?.dispose()
      } catch {
        // A half-activated addon may not dispose cleanly; it is dropped either way.
      }

      console.warn('[gpu-lease] WebGL unavailable; using the DOM renderer', error)

      if (preference === 'on') {
        state.failed = true
      } else {
        latched = true
      }

      dirty = true

      return
    }

    const created = addon

    state.canvases = [...host.querySelectorAll('canvas')].filter(canvas => !before.has(canvas))
    state.addon = created
    state.lossSub = created.onContextLoss(() => {
      if (state.addon === created) {
        onLoss(state)
      }
    })
    state.ref.current = created
    notify(state)
  }

  const pass = () => {
    const now = Date.now()
    const slots = Math.max(0, Math.min(budget, totalCap - reserves.size))
    const all = [...leases]

    const keep = new Set(
      all
        .filter(state => wants(state, now))
        .sort(rank)
        .slice(0, slots)
    )

    // Hidden holders inside their grace keep a context only while it is not
    // needed by a visible terminal; the most recently hidden go last.
    const grace = all
      .filter(state => state.addon && !keep.has(state) && inGrace(state, now))
      .sort((a, b) => b.hiddenSeq - a.hiddenSeq)
      .slice(0, Math.max(0, slots - keep.size))

    const kept = new Set([...keep, ...grace])

    // Release before acquiring, so the live count never overshoots.
    for (const state of all) {
      if (state.addon && !kept.has(state)) {
        detach(state, true)
      }
    }

    for (const state of keep) {
      if (!state.addon && wants(state, Date.now())) {
        attach(state)
      }
    }
  }

  function reconcile() {
    if (reconciling) {
      dirty = true

      return
    }

    reconciling = true

    try {
      let rounds = 0

      do {
        dirty = false
        pass()
        rounds++
      } while (dirty && rounds < 4)
    } finally {
      reconciling = false
    }
  }

  const keyOf = (state: LeaseState<A>) =>
    state.term.element?.closest('[data-it-host]')?.getAttribute('data-it-host') ?? state.key

  const find = (id: string) => [...leases].find(state => keyOf(state) === id)

  return {
    devSeam: () => ({
      force: (id, renderer) => {
        const state = find(id)

        if (!state) {
          return false
        }

        state.forced = renderer
        reconcile()

        return true
      },
      leases: () =>
        [...leases].map(state => ({
          focusedAt: state.focusedAt,
          id: keyOf(state),
          losses: state.losses,
          renderer: state.addon ? 'webgl' : 'dom',
          visible: state.visible
        })),
      liveContexts: () => {
        let live = 0

        for (const state of leases) {
          for (const canvas of state.addon ? state.canvases : []) {
            const gl = webglOf(canvas)

            if (gl && !gl.isContextLost()) {
              live++
            }
          }
        }

        return live
      },
      rebuild: id => {
        const state = find(id)

        if (!state) {
          return false
        }

        rebuildModel(state.term, requestAtlasPass)

        return true
      }
    }),

    lease(term, ref, onRendererChange) {
      const state: LeaseState<A> = {
        addon: null,
        blocked: false,
        canvases: [],
        cooldownTimer: null,
        cooldownUntil: 0,
        disposed: false,
        failed: false,
        focusSeq: 0,
        focusedAt: 0,
        forced: 'auto',
        graceOver: false,
        graceTimer: null,
        hiddenSeq: 0,
        key: `lease-${++seq}`,
        lossSub: null,
        losses: 0,
        onRendererChange,
        recentLosses: [],
        ref,
        shownSeq: 0,
        term,
        visible: false
      }

      const clearGrace = () => {
        if (state.graceTimer !== null) {
          clearTimeout(state.graceTimer)
          state.graceTimer = null
        }
      }

      leases.add(state)

      return {
        dispose() {
          if (state.disposed) {
            return
          }

          state.disposed = true
          clearGrace()

          if (state.cooldownTimer !== null) {
            clearTimeout(state.cooldownTimer)
            state.cooldownTimer = null
          }

          detach(state, true)
          leases.delete(state)
          reconcile()
        },
        forceRenderer(renderer) {
          state.forced = renderer
          reconcile()
        },
        setVisible(visible) {
          if (state.disposed || state.visible === visible) {
            return
          }

          state.visible = visible
          clearGrace()

          if (visible) {
            state.shownSeq = ++seq
          } else {
            state.hiddenSeq = ++seq
            state.graceOver = false

            if (state.addon) {
              state.graceTimer = setTimeout(() => {
                state.graceTimer = null
                state.graceOver = true
                reconcile()
              }, HIDDEN_GRACE_MS)
            }
          }

          reconcile()
        },
        touch() {
          if (state.disposed) {
            return
          }

          state.focusSeq = ++seq
          state.focusedAt = Date.now()
          reconcile()
        }
      }
    },

    reserve(owner) {
      const token = { owner }

      reserves.add(token)
      reconcile()

      return () => {
        if (reserves.delete(token)) {
          reconcile()
        }
      }
    },

    setPreference(value) {
      preference = value
      options.writePreference?.(value)
      reconcile()
    }
  }
}

function readStoredPreference(): GpuAcceleration {
  try {
    const value = window.localStorage.getItem(GPU_ACCELERATION_KEY)

    return value === 'off' || value === 'on' ? value : 'auto'
  } catch {
    return 'auto'
  }
}

function writeStoredPreference(value: GpuAcceleration): void {
  try {
    window.localStorage.setItem(GPU_ACCELERATION_KEY, value)
  } catch {
    // Storage can be unavailable; the choice still applies to this session.
  }
}

const pool = createGpuLeasePool<WebglAddon>({
  createAddon: () => new WebglAddon(),
  readPreference: readStoredPreference,
  writePreference: writeStoredPreference
})

export function leaseTerminalWebgl(
  term: Terminal,
  ref: { current: WebglAddon | null },
  onRendererChange: () => void
): WebglLease {
  return pool.lease(term, ref, onRendererChange)
}

/** Non-terminal WebGL users (the 3D stage) count against the total cap. */
export function reserveGpuContext(owner: string): () => void {
  return pool.reserve(owner)
}

function setGpuAcceleration(value: GpuAcceleration): void {
  pool.setPreference(value)
}

/** An idle stage draws at most 30 frames a second; a busy one (input, a transition) at display rate. */
export const IDLE_FRAME_MS = 1000 / 30
// vsync timestamps jitter by a fraction of a millisecond; without slack a 60 Hz display would skip to 20 fps.
const FRAME_SLACK_MS = 2

interface LoopBudget {
  /** True while the stage needs display rate. */
  busy: () => boolean
  idleFrameMs?: number
}

/**
 * The frame loop of a `reserveGpuContext` holder (the 3D stage), safe across
 * context churn: a loss stops the loop and claims the restore (without
 * preventDefault Chromium never hands the context back); a restore lets the
 * owner rebuild, then restarts the loop — always exactly one loop. Returns
 * the stop function. With a budget, an idle loop draws at the budget's rate.
 */
export function runContextSafeLoop(
  canvas: EventTarget,
  frame: () => void,
  onRestored: () => void,
  budget?: LoopBudget
): () => void {
  let handle = 0
  let stopped = false
  let last = Number.NEGATIVE_INFINITY

  const tick = (now: number) => {
    if (stopped) {
      return
    }

    // A ProMotion display calls back at 120 Hz; an idle stage draws on every vsync that closes its budget.
    if (!budget || budget.busy() || now - last >= (budget.idleFrameMs ?? IDLE_FRAME_MS) - FRAME_SLACK_MS) {
      last = now
      frame()
    }

    handle = requestAnimationFrame(tick)
  }

  const start = () => {
    cancelAnimationFrame(handle)
    handle = requestAnimationFrame(tick)
  }

  const onLost = (event: Event) => {
    event.preventDefault()
    cancelAnimationFrame(handle)
    handle = 0
  }

  const onRestore = () => {
    if (stopped) {
      return
    }

    onRestored()
    start()
  }

  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestore)
  start()

  return () => {
    stopped = true
    cancelAnimationFrame(handle)
    handle = 0
    canvas.removeEventListener('webglcontextlost', onLost)
    canvas.removeEventListener('webglcontextrestored', onRestore)
  }
}

declare global {
  interface Window {
    __icloneGpu?: GpuDevSeam
  }
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__icloneGpu = pool.devSeam()
}
