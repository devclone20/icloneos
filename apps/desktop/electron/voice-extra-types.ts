// v0.0.9 W1b — the shapes the voice-extra install shares between main, the preload and the renderer (pure: no node,
// no electron). See electron/voice-extra.ts.

/** The runtime extra that carries local speech recognition (pyproject `stt-whisper`: faster-whisper). */
export const VOICE_EXTRA = 'stt-whisper'

/** The marker on the ONE control that may install it: the owner's own click (preload lock `voiceExtra`). */
export const VOICE_EXTRA_CONFIRM_ATTR = 'data-voice-extra-confirm'

/**
 * - `installed`: the agent's dependency environment already carries it.
 * - `absent`: it can be installed on the owner's click.
 * - `installing`: an install this app started is running.
 * - `unsupported`: the runtime's own platform gate excludes this machine (macOS on Intel, Windows on ARM).
 * - `unmanaged`: no app-managed runtime with private dependencies (a dev checkout, or no runtime yet).
 */
export type VoiceExtraState = 'absent' | 'installed' | 'installing' | 'unmanaged' | 'unsupported'

export interface VoiceExtraStatus {
  state: VoiceExtraState
  /** True after this app installed it: the running agent picks it up on its next start. */
  restartNeeded?: boolean
}

export type VoiceExtraRefusal = 'busy' | 'gesture' | 'unmanaged' | 'unsupported'

export type VoiceExtraInstallAnswer =
  | { ok: true; status: VoiceExtraStatus }
  | { ok: false; refused: VoiceExtraRefusal }
  | { ok: false; error: string }

/** The preload bridge (`window.hermesDesktop.icloneVoiceExtra`). */
export interface VoiceExtraBridge {
  status(): Promise<VoiceExtraStatus | null>
  install(): Promise<VoiceExtraInstallAnswer | null>
}
