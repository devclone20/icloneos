// Ruling 42 (+ the owner's 10:58 amendment): main's view of a starting backend child — its classified output feeds
// the readiness deadlines (backend-ready.ts, backend-health.ts) and, while it visibly installs dependencies, a
// boot-progress step and heartbeats that keep the renderer's own liveness budget fed (src/lib/backend-boot-activity.ts).

import { type BackendActivityKind, type BackendActivitySource, isDependencyInstallLine } from '../backend-health'
import { cpuProgressed, INSTALL_SAMPLE_MS, sampleTreeCpu, type TreeCpu } from '../install-liveness'

/** Boot-progress phase main publishes while the starting backend installs its dependencies (renderer: install sign). */
export const BOOT_PHASE_DEPENDENCIES = 'backend.dependencies'
/** The renderer localizes this phase (boot.steps.preparingAgentDependencies); this is the log/fallback text. */
export const BOOT_DEPENDENCIES_MESSAGE = "Preparing the agent's dependencies…"
/** At most one heartbeat per this interval while the child keeps installing (the renderer follows main's verdict and
 * only fails on its own after 120 s of silence from main). */
export const BOOT_HEARTBEAT_INTERVAL_MS = 5_000

interface OutputStream {
  on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown
  off: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown
}

export interface WatchedChild {
  pid?: number
  stdout?: OutputStream | null
  stderr?: OutputStream | null
  exitCode?: number | null
  killed?: boolean
}

export interface BackendBootWatchDeps {
  /** First install line: publish the dependencies step (a boot-progress update with BOOT_PHASE_DEPENDENCIES). */
  publishDependenciesStep: () => void
  /** Later install-time output, throttled: re-broadcast the current progress so the renderer sees a heartbeat. */
  publishHeartbeat: () => void
  now?: () => number
  /** CPU per pid of the child's tree (default: /bin/ps). Sampled every INSTALL_SAMPLE_MS once install work shows. */
  sampleCpu?: (pid: number) => Promise<null | TreeCpu>
}

export interface BackendBootWatch {
  /** Feed for waitForDashboardPortAnnouncement / waitForHermesReady. */
  source: BackendActivitySource
  /** True once the child printed install work. */
  installing: () => boolean
  /** Detach from the child's streams (ready, failed or superseded). Idempotent. */
  stop: () => void
}

/**
 * Watch a spawned backend's stdout/stderr line by line. Every complete line is a sign of life, classified as install
 * work or plain output; once install work shows, main publishes the dependencies step once and then a heartbeat at
 * most every BOOT_HEARTBEAT_INTERVAL_MS while the child keeps talking. Plain output before that publishes nothing: a
 * healthy start with nothing to install keeps the plain budgets of before.
 */
export function watchBackendBoot(child: WatchedChild, deps: BackendBootWatchDeps): BackendBootWatch {
  const now = deps.now ?? Date.now
  const listeners = new Set<(kind: BackendActivityKind) => void>()
  const buffers = new Map<OutputStream, string>()
  const handlers: [OutputStream, (chunk: Buffer | string) => void][] = []
  let installing = false
  let stopped = false
  let lastHeartbeatAt = 0

  // Ruling 42 r2: a dependency sync that prints nothing (uv behind PM's LiveTail) is still progress while its tree
  // burns CPU. Sampled only once install work showed; each CPU advance is a sign of life for the deadlines and,
  // throttled, a heartbeat for the renderer.
  const sampleCpu = deps.sampleCpu ?? sampleTreeCpu
  let cpu: TreeCpu = new Map()
  let cpuTimer: null | ReturnType<typeof setInterval> = null
  let sampling = false

  const sampleTick = async () => {
    if (sampling || stopped || typeof child.pid !== 'number') {
      return
    }

    sampling = true

    try {
      const next = await sampleCpu(child.pid)

      // null = unknown (ps failed): neither progress nor a new baseline.
      if (!next) {
        return
      }

      if (!stopped && cpuProgressed(cpu, next)) {
        if (now() - lastHeartbeatAt >= BOOT_HEARTBEAT_INTERVAL_MS) {
          lastHeartbeatAt = now()
          deps.publishHeartbeat()
        }

        for (const listener of [...listeners]) {
          listener('output')
        }
      }

      cpu = next
    } finally {
      sampling = false
    }
  }

  const startCpuSampling = () => {
    if (!cpuTimer && typeof child.pid === 'number') {
      cpuTimer = setInterval(() => void sampleTick(), INSTALL_SAMPLE_MS)
      cpuTimer.unref?.()
    }
  }

  const onLine = (line: string) => {
    if (stopped || !line.trim()) {
      return
    }

    const kind: BackendActivityKind = isDependencyInstallLine(line) ? 'install' : 'output'

    if (kind === 'install' && !installing) {
      installing = true
      lastHeartbeatAt = now()
      deps.publishDependenciesStep()
      startCpuSampling()
    } else if (installing && now() - lastHeartbeatAt >= BOOT_HEARTBEAT_INTERVAL_MS) {
      lastHeartbeatAt = now()
      deps.publishHeartbeat()
    }

    for (const listener of [...listeners]) {
      listener(kind)
    }
  }

  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) {
      continue
    }

    buffers.set(stream, '')

    const onData = (chunk: Buffer | string) => {
      // Progress bars rewrite their line with \r: each rewrite is a sign of life too.
      const text = (buffers.get(stream) ?? '') + chunk.toString()
      const parts = text.split(/\r\n|\r|\n/)
      buffers.set(stream, parts.pop() ?? '')
      parts.forEach(onLine)
    }

    stream.on('data', onData)
    handlers.push([stream, onData])
  }

  return {
    installing: () => installing,
    source: {
      isAlive: () => !stopped && (child.exitCode === null || child.exitCode === undefined) && !child.killed,
      subscribe: listener => {
        listeners.add(listener)

        return () => listeners.delete(listener)
      }
    },
    stop: () => {
      if (stopped) {
        return
      }

      stopped = true
      listeners.clear()

      if (cpuTimer) {
        clearInterval(cpuTimer)
      }

      for (const [stream, onData] of handlers) {
        stream.off('data', onData)
      }

      buffers.clear()
    }
  }
}
