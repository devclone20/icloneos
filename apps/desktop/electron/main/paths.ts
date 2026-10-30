// Desktop state files under userData and the bootstrap marker. Imports env, so userData is read after its override.

import path from 'node:path'

import { app } from 'electron'

import { ACTIVE_HERMES_ROOT } from './env'

// BOOTSTRAP_COMPLETE_MARKER — written by the first-launch bootstrap runner
// (Phase 1D) after install.ps1 has completed all stages and the user has
// finished initial configuration. Presence of this marker means the install
// is in a known-good state and we can skip the bootstrap flow on subsequent
// boots, going straight to `resolveHermesBackend()`. Missing or stale marker
// means we re-run the bootstrap; install.ps1's stages are idempotent so a
// re-run on an already-good install just discovers everything in place.
//
// We deliberately put the marker INSIDE ACTIVE_HERMES_ROOT (not alongside)
// so that deleting the checkout to start fresh also deletes the marker --
// avoids the confusing "marker exists but checkout is gone" state.
export const BOOTSTRAP_COMPLETE_MARKER = path.join(ACTIVE_HERMES_ROOT, '.hermes-bootstrap-complete')

export const BOOTSTRAP_MARKER_SCHEMA_VERSION = 1

export const DESKTOP_CONNECTION_CONFIG_PATH = path.join(app.getPath('userData'), 'connection.json')

// v2 multi-connection registry (named agent sources). Lives BESIDE
// connection.json — v1 stays on disk untouched so older builds sharing the
// profile keep working; the registry imports from it once and then owns its
// own file. Same secret posture as connection.json (encrypted tokens, 0600).
export const DESKTOP_CONNECTIONS_REGISTRY_PATH = path.join(app.getPath('userData'), 'connections.json')

export const DESKTOP_INSTALLATION_PATH = path.join(app.getPath('userData'), 'desktop-installation.json')

export const DESKTOP_UPDATE_CONFIG_PATH = path.join(app.getPath('userData'), 'updates.json')

export const DESKTOP_WINDOW_STATE_PATH = path.join(app.getPath('userData'), 'window-state.json')

export const DESKTOP_BACKEND_OWNERSHIP_PATH = path.join(app.getPath('userData'), 'backend-ownership.json')

export const DESKTOP_MANAGED_SSH_RECOVERY_PATH = path.join(app.getPath('userData'), 'managed-ssh-update-recovery.json')

// active-profile.json records which Hermes profile the desktop launches its
// local backend as. When set, startHermes() passes `hermes --profile <name>
// dashboard …`, which deterministically pins HERMES_HOME (see
// _apply_profile_override in hermes_cli/main.py) and bypasses the sticky
// ~/.hermes/active_profile file. Unset (null) preserves the legacy behavior:
// no --profile flag, so the backend honors active_profile / default.
export const DESKTOP_PROFILE_CONFIG_PATH = path.join(app.getPath('userData'), 'active-profile.json')
