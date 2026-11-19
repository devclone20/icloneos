// v0.0.9 W1b — the voice extra's IPC with this machine's real paths and probes (logic: electron/voice-extra.ts).
// Registered once by main.ts (the `// v0.0.9 W1b` block). The install runs only on the owner's click (preload lock
// `voiceExtra`, marker `data-voice-extra-confirm`), unconfined in main, into the runtime's private dependency home.
import { ipcMain } from 'electron'

import { isolatePythonEnv } from '../iclone-spawn-env'
import { createAppSenderGuard } from '../ipc-sender-guard'
import { pmCommittedVenv } from '../pm-venv'
import { spawnCapped } from '../update-runtime-align'
import { createVoiceExtra, registerVoiceExtraIpc, type VoiceExtra } from '../voice-extra'

import { lastTrustedInputAt } from './agent-update'
import { ACTIVE_HERMES_ROOT, DEV_SERVER, IS_PACKAGED, runtimePrivateDependencies } from './env'
import { getVenvPython } from './executables'
import { checkRuntimeIntegrity } from './iclone-gate'
import { rememberLog } from './log'
import { resolveRendererIndex } from './runtime'
import { isAppManagedRuntime } from './runtime-install-state'

export function registerAppVoiceExtraIpc(): VoiceExtra {
  const voice = createVoiceExtra({
    runtimeRoot: () => ACTIVE_HERMES_ROOT,
    // Only the app's own runtime with private dependencies (`<root>/.iclone-deps`): a dev checkout's shared layout is
    // the developer's to manage (`hermes tools`), and the app never installs into the user's HERMES_HOME.
    privateDependencies: () => (isAppManagedRuntime(ACTIVE_HERMES_ROOT) ? runtimePrivateDependencies() : null),
    committedVenv: pmCommittedVenv,
    venvPython: getVenvPython,
    // A packaged app runs nothing of its runtime before the integrity check has passed, and then runs it sealed
    // (the same rule as the curated-config CLI, updates.ts `ensureRuntimeUpdateCheckOff`).
    ...(IS_PACKAGED
      ? {
          verifyRuntime: (root: string) => checkRuntimeIntegrity(root),
          sealEnv: (env: NodeJS.ProcessEnv, root: string) => isolatePythonEnv(env, root)
        }
      : {}),
    run: spawnCapped,
    log: rememberLog
  })

  registerVoiceExtraIpc({
    voice,
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    isTrustedSender: createAppSenderGuard({
      devServer: DEV_SERVER,
      log: rememberLog,
      rendererIndexPath: resolveRendererIndex
    }),
    lastInputAt: event => lastTrustedInputAt(event.sender)
  })

  return voice
}
