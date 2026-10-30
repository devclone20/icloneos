import type { SupervisorState, WorkFixCause, WorkFixView } from '../../src/iclone-shared/acp-work'
/**
 * V3-I — the lifecycle supervisor: one `acp events listen --json` per iNFT the owner put online, held by MAIN, so the
 * agent stays online with every window closed. It is the market window's own listener engine (`createAcpWatch`:
 * backoff 1 s to 60 s, silent-child recycle, SIGTERM -> SIGKILL escalation, the fatal sign-in stop), one engine per
 * iNFT, sharing the agent door's streaming registry so a slug never has two listeners.
 *
 * "Online", as measured on acp 1.0.38 (contract §0 hypothesis): `events listen` opens the SSE streams and prints
 * "Listening for events... connected." on stderr once they are open; the SDK sends no heartbeat on that transport.
 * So `online` here = our listener said connected and is alive. Whether the marketplace's own presence follows that
 * stream is reported separately (`presence`), and stays `unverified` until a lab run on a test agent settles it.
 */
import { type AcpWatch, type AcpWatchEvent, createAcpWatch, type WatchStart } from '../iclone-acp-watch'

import { fixEntry } from './fixes'

/** Fixes kept per iNFT for the tab (the ledger keeps every one). */
const FIXES_KEPT = 20

interface SupervisorDeps {
  /** Spawn `acp <argv>` for the slug exactly like the market window's listener (env, config dir, scratch cwd). */
  start(slug: string, argv: readonly string[]): Promise<WatchStart>
  /** REL-6: why the ACP tools cannot run (absent, unverified), or null. A stop it explains is not a sign-in. */
  toolsProblem?(): string | null
  /** The agent door's registry of slugs with a streaming reader (iclone-acp-ipc `streamingSlugs`). */
  streaming: Set<string>
  keychainPromptShowing(): boolean
  /** The market window's listener for this slug lets go, so the supervisor's is the only one. */
  yieldWindowWatch(slug: string): void
  /** Every listener event (job lines and stream liveness), for the windows and the watchdog. */
  emit(event: AcpWatchEvent): void
  onState(slug: string, state: SupervisorState): void
  onFix(slug: string, fix: WorkFixView): void
  log(line: string): void
  now?: () => Date
  createWatch?: typeof createAcpWatch
}

interface Run {
  watch: AcpWatch
  state: SupervisorState
  /** Set while we stop the engine ourselves, so its stream.down is not read as a crash. */
  stopping: boolean
  fixes: WorkFixView[]
  blocking: string[]
  fixSeq: number
}

export function createSupervisor(deps: SupervisorDeps) {
  const now = deps.now ?? (() => new Date())
  const runs = new Map<string, Run>()
  const make = deps.createWatch ?? createAcpWatch

  const setState = (slug: string, run: Run, state: SupervisorState) => {
    if (run.state !== state) {
      run.state = state
      deps.onState(slug, state)
    }
  }

  const fix = (slug: string, run: Run, cause: WorkFixCause) => {
    run.fixSeq += 1

    const entry = fixEntry(`${slug}:${run.fixSeq}`, now(), cause, run.state)

    run.fixes = [entry, ...run.fixes].slice(0, FIXES_KEPT)
    deps.onFix(slug, entry)
  }

  const onEvent = (slug: string, event: AcpWatchEvent) => {
    const run = runs.get(slug)

    deps.emit(event)

    if (!run || event.source !== 'stream') {
      return
    }

    if (event.type === 'stream.live' || event.type === 'stream.up') {
      // A drain keeps its listener: it needs the events until the last owed job settles.
      if (run.state !== 'draining') {
        setState(slug, run, 'online')
      }
    } else if (event.type === 'stream.stopped') {
      setState(slug, run, 'failed')
      fix(slug, run, deps.toolsProblem?.() ? 'tools-missing' : 'needs-sign-in')
    } else if (event.type === 'stream.down' && !run.stopping) {
      const draining = run.state === 'draining'

      if (!draining) {
        setState(slug, run, 'starting')
      }

      fix(slug, run, 'listener-exited')
    }
  }

  const runFor = (slug: string): Run => {
    const existing = runs.get(slug)

    if (existing) {
      return existing
    }

    const run: Run = {
      watch: make({
        start: deps.start,
        streaming: deps.streaming,
        keychainPromptShowing: deps.keychainPromptShowing,
        log: line => deps.log(line.replace('[iclone-acp-watch]', '[iclone-acp-work]')),
        emit: event => onEvent(slug, event)
      }),
      state: 'offline',
      stopping: false,
      fixes: [],
      blocking: [],
      fixSeq: 0
    }

    runs.set(slug, run)

    return run
  }

  const stopEngine = (run: Run, why: string, hard = false) => {
    run.stopping = true

    if (hard) {
      run.watch.stopAll()
    } else {
      run.watch.stop(why)
    }

    run.stopping = false
  }

  return {
    /** Put the iNFT online (idempotent). The market window's own listener yields first. */
    online(slug: string): SupervisorState {
      const run = runFor(slug)

      if (run.state === 'online' || run.state === 'starting') {
        return run.state
      }

      run.blocking = []
      setState(slug, run, 'starting')
      deps.yieldWindowWatch(slug)
      run.watch.watch(slug)

      return run.state
    },
    /** A drain began: the listener stays, the state says why the iNFT is not yet offline. */
    draining(slug: string, blocking: string[]): void {
      const run = runs.get(slug)

      if (run && run.state !== 'offline' && run.state !== 'offline-safe') {
        run.blocking = [...blocking]
        setState(slug, run, 'draining')
      }
    },
    /** The listener stops. `offline-safe` only after a drain settled every job; `offline` for a stop with none open. */
    stopListener(slug: string, final: 'offline' | 'offline-safe'): void {
      const run = runs.get(slug)

      if (!run) {
        return
      }

      stopEngine(run, final)
      run.blocking = []
      setState(slug, run, final)
    },
    /** Restart the listener with a Fix entry saying what was done. */
    reboot(slug: string): SupervisorState {
      const run = runs.get(slug)

      if (!run || run.state === 'offline' || run.state === 'offline-safe') {
        return run?.state ?? 'offline'
      }

      const draining = run.state === 'draining'

      stopEngine(run, 'reboot')

      if (!draining) {
        setState(slug, run, 'starting')
      }

      fix(slug, run, 'owner-reboot')
      deps.yieldWindowWatch(slug)
      run.watch.watch(slug)

      return run.state
    },
    /** A failure outside the listener (a read the watchdog could not make), in the same Fix list. */
    note(slug: string, cause: WorkFixCause): void {
      const run = runs.get(slug)

      if (run) {
        fix(slug, run, cause)
      }
    },
    state: (slug: string): SupervisorState => runs.get(slug)?.state ?? 'offline',
    blocking: (slug: string): string[] => [...(runs.get(slug)?.blocking ?? [])],
    fixes: (slug: string): WorkFixView[] => [...(runs.get(slug)?.fixes ?? [])],
    /** Slugs whose listener child is alive right now (for the one-listener gate and the logs). */
    live: (): string[] => [...runs.entries()].filter(([, run]) => run.watch.current() !== null).map(([slug]) => slug),
    /** App quit: every listener SIGKILLed at once; the owner's intent stays in the ledger for the next start. */
    stopAll(): void {
      for (const run of runs.values()) {
        stopEngine(run, 'quit', true)
      }
    }
  }
}

export type Supervisor = ReturnType<typeof createSupervisor>
