import type { Translations } from '../types'

export const notifications: Translations['notifications'] = {
  region: 'Notifications',
  hide: 'Hide',
  show: 'Show',
  more: count => `${count} more ${count === 1 ? 'notification' : 'notifications'}`,
  clearAll: 'Clear all',
  dismiss: 'Dismiss notification',
  details: 'Details',
  copyDetail: 'Copy detail',
  copyDetailFailed: 'Could not copy notification detail',
  backendOutOfDateTitle: 'Backend out of date',
  backendOutOfDateMessage:
    'Your agent backend is older than this desktop build and may not work correctly. Update to align them.',
  installMethodUnsupportedTitle: 'Unsupported install method',
  updateHermes: 'Update the agent',
  updateReadyTitle: 'Update ready',
  updateReadyMessage: count => `${count} new change${count === 1 ? '' : 's'} available.`,
  updateReadyMessageUnknown: 'A new update is available.',
  seeWhatsNew: "See what's new",
  mcp: {
    needsAuthTitle: 'MCP server needs re-authentication',
    needsAuthMessage: name => `${name} MCP needs re-authentication.`,
    errorTitle: 'MCP server unreachable',
    errorMessage: name => `${name} MCP failed its health check.`,
    signIn: 'Sign in',
    view: 'View'
  },
  errors: {
    elevenLabsNeedsKey: 'ElevenLabs STT needs ELEVENLABS_API_KEY.',
    elevenLabsRejectedKey: 'ElevenLabs rejected the API key (401).',
    diskFull: 'Disk full — free some space, then try again.',
    gatewayAuthFailed: 'Gateway authentication failed — check your API_SERVER_KEY.',
    methodNotAllowed: 'The desktop backend rejected that request (405 Method Not Allowed). Try restarting iclone os.',
    microphonePermission: 'Microphone permission was denied.',
    openaiRejectedApiKey: 'OpenAI rejected the API key.',
    openaiRejectedApiKeyWithStatus: status => `OpenAI rejected the API key (${status} invalid_api_key).`,
    openaiTtsNeedsKey: 'OpenAI TTS needs VOICE_TOOLS_OPENAI_KEY or OPENAI_API_KEY.'
  },
  voice: {
    configureSpeechToText: 'Configure speech-to-text to use voice mode.',
    couldNotStartSession: 'Could not start voice session',
    microphoneAccessDenied: 'Microphone access denied.',
    microphoneConstraintsUnsupported: 'Microphone constraints are not supported by this device.',
    microphoneFailed: 'Microphone failed',
    microphoneInUse: 'Microphone is already in use by another app.',
    microphonePermissionDenied: 'Microphone permission was denied.',
    microphoneStartFailed: 'Could not start microphone recording.',
    microphoneUnsupported: 'This runtime does not support microphone recording.',
    noMicrophone: 'No microphone was found.',
    noSpeechDetected: 'No speech detected',
    playbackFailed: 'Voice playback failed',
    recordingFailed: 'Voice recording failed',
    sayStopToEnd: phrase => `Say "${phrase}" to end the voice chat.`,
    transcriptionFailed: 'Voice transcription failed',
    transcriptionUnavailable: 'Voice transcription is not available yet.',
    tryRecordingAgain: 'Try recording again.',
    unavailable: 'Voice unavailable'
  },
  native: {
    approvalTitle: 'Approval needed',
    inputTitle: 'Input needed',
    inputBody: 'The agent is waiting for your response.',
    turnDoneTitle: 'The agent finished',
    turnDoneBody: '',
    turnErrorTitle: 'Turn failed',
    backgroundDoneTitle: 'Background task finished',
    backgroundFailedTitle: 'Background task failed',
    creditsTitle: 'Credits'
  }
}
