interface BootstrapMarkerLike {
  pinnedCommit?: unknown
  schemaVersion?: unknown
}

interface ActiveRuntimeState {
  hasValidMarker: boolean
  shouldUseActiveRuntime: boolean
  usabilityReason: 'usable' | 'unusable'
}

export function hasValidBootstrapMarker(
  marker: BootstrapMarkerLike | null | undefined,
  schemaVersion: number
): boolean {
  if (!marker || typeof marker !== 'object') {
    return false
  }

  if (marker.schemaVersion !== schemaVersion) {
    return false
  }

  if (typeof marker.pinnedCommit !== 'string' || marker.pinnedCommit.length < 7) {
    return false
  }

  return true
}

// The active install at ~/.hermes/hermes-agent can be real and runnable even if
// Desktop never wrote its first-run bootstrap marker (for example when Hermes
// was installed by the CLI first, or when a past desktop build forgot the
// marker). Runtime usability is authoritative for "can we launch local Hermes
// right now?"; the marker is only provenance about how that install was
// created. A missing/stale marker must never force a healthy local install into
// the first-run bootstrap UI.
export function classifyActiveRuntime(
  marker: BootstrapMarkerLike | null | undefined,
  schemaVersion: number,
  runtimeUsable: boolean
): ActiveRuntimeState {
  const hasValidMarker = hasValidBootstrapMarker(marker, schemaVersion)

  if (!runtimeUsable) {
    return {
      hasValidMarker,
      shouldUseActiveRuntime: false,
      usabilityReason: 'unusable'
    }
  }

  return {
    hasValidMarker,
    shouldUseActiveRuntime: true,
    usabilityReason: 'usable'
  }
}

/** What the canonical interpreter path of the app's runtime holds: nothing, a link to a file that is gone, a file. */
export type VenvPythonState = 'dangling' | 'missing' | 'present'

/**
 * v0.0.9 r2 (m-r2-2): a broken install is not a first run. The app installed its runtime here (its bootstrap marker,
 * or the record a packaged install writes) and the source tree is still there, but the environment cannot run: its
 * interpreter is gone (a dangling `venv/bin/python`, a PM environment whose interpreter vanished) or, in a dev build,
 * does not import the agent. Before this, that fell through to the first-run "Set up iclone os" chooser — no cause,
 * and the repair kit unreachable under it. The reason returned here becomes a `runtime-env-broken` boot failure, whose
 * Repair is the kit's `runtime-venv` class (owner click) and a reinstall. Null: not a broken install (a real first
 * run, a half-finished install, or a repair already asked for the installer).
 */
export function brokenAppInstallReason(input: {
  activeRuntimeUsable: boolean
  hasSourceTree: boolean
  installedByApp: boolean
  repairRequested: boolean
  venvPython: string
  venvPythonState: VenvPythonState
}): null | string {
  if (input.activeRuntimeUsable || input.repairRequested || !input.hasSourceTree || !input.installedByApp) {
    return null
  }

  switch (input.venvPythonState) {
    case 'dangling':
      return `the agent's Python interpreter ${input.venvPython} points at a file that is gone`

    case 'missing':
      return `the agent's environment has no Python interpreter (${input.venvPython} is missing)`

    case 'present':
      return `the agent's environment at ${input.venvPython} cannot start the agent`
  }
}
