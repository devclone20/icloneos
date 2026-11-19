/**
 * v0.0.9 W1b — the words of Settings › Voice › Local speech recognition (the voice extra, installed app-side on the
 * owner's click). English only (the app ships English); imported directly by voice-extra-row.tsx.
 */
export const w1bVoiceExtra = {
  title: 'Local speech recognition',
  install: 'Install',
  installing: 'Installing…',
  retry: 'Try again',
  state: {
    absent: 'Not installed. Install downloads it once into the app’s own folder, only when you click.',
    installed: 'Installed. Your voice is transcribed on this Mac.',
    installedRestart: 'Installed. It is used from the agent’s next start.',
    installing: 'Installing. This can take a few minutes on a slow connection.',
    unsupported: 'Not available on this Mac (the speech engine does not support this processor).',
    unmanaged: 'Managed by your own Hermes setup in this build (run hermes tools there).'
  },
  refused: {
    gesture: 'Not installed: click Install yourself to start it.',
    busy: 'An install is already running.',
    unmanaged: 'Not available in this build.',
    unsupported: 'Not available on this Mac.'
  }
} as const
