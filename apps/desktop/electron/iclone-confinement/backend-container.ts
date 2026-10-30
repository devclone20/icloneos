/**
 * V3-G — the Apple `container` backend, behind the same seam as Seatbelt. It is not used in this version (no spike C1
 * baseline; Seatbelt is this version's sandbox): it detects and reports only, and every spawn is refused — never a
 * silent fall back to running unconfined. The refusal says so, with what the last probe saw (K131): an installed
 * `container` is never told to be installed.
 */
import type {
  BackendStatus,
  BackendStatusView,
  ConfinedProcessView,
  KillResultView
} from '../../src/iclone-shared/confinement'

import type { ConfinementBackend, SpawnResult } from './backend'
import { probeContainer, probeFailedView } from './probe'

interface ContainerDeps {
  probe?: () => Promise<BackendStatusView>
}

/** What the probe saw, in the refusal's words (main-side English, like every spawn error). */
const SEEN: Record<BackendStatus, (view: BackendStatusView) => string> = {
  installed: view => `installed${view.version ? ` (${view.version})` : ''} but not used`,
  'not-installed': () => 'not installed on this Mac',
  broken: () => 'installed, but its check failed',
  unknown: () => 'installed, but its check did not finish in time',
  unsupported: () => 'this Mac cannot run it',
  ready: () => 'present, but not used'
}

/** The spawn refusal: the backend is not available in this version, and what the probe saw (or that none ran yet). */
export function containerRefusal(view: BackendStatusView | null): string {
  const seen = view ? `: ${SEEN[view.status](view)}` : ''

  return `Apple container is not available in this version of icloneOS${seen}. The command is refused rather than run unconfined.`
}

export function createContainerBackend(deps: ContainerDeps = {}): ConfinementBackend {
  // The last probe answer, for the refusal text only: no count or pane number is ever read from it. It is exactly the
  // view the layer stores for the pane (G3-3): every probe replaces it, and a probe that throws becomes the same
  // `probe-failed` view here as in index.ts, so the refusal can never say "installed" while the pane shows red.
  let seen: BackendStatusView | null = null
  // G3 r2 m-3: probes may overlap; only the newest one started may set `seen`, so an older answer landing last (a
  // timeout) never replaces a newer one.
  let started = 0
  let landed = 0

  return {
    id: 'container',
    async probe() {
      const ticket = ++started
      let view: BackendStatusView

      try {
        view = await (deps.probe ?? probeContainer)()
      } catch (error) {
        view = probeFailedView('container', error)
      }

      if (ticket > landed) {
        landed = ticket
        seen = view
      }

      return view
    },
    spawn(): SpawnResult {
      return { ok: false, error: containerRefusal(seen) }
    },
    list(): ConfinedProcessView[] {
      return []
    },
    async kill(pid: number): Promise<KillResultView> {
      return {
        ok: false,
        pid,
        reason: 'not-confined',
        survivors: [],
        error: 'the container backend runs nothing in this version'
      }
    },
    explain(pid: number): string[] {
      return [`pid ${pid}: the container backend runs nothing in this version. ${containerRefusal(seen)}`]
    }
  }
}
