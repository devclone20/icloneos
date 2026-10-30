import type { Translations } from '../types'

export const onboarding: Translations['onboarding'] = {
  headerTitle: "Let's get you set up with iclone os",
  headerDesc: 'Connect a model provider to start chatting. Most options take one click.',
  preparingInstall: 'The agent is finishing install. This usually takes under a minute on first run.',
  starting: 'Starting the agent…',
  lookingUpProviders: 'Looking up providers...',
  collapse: 'Collapse',
  otherProviders: 'Other providers',
  haveApiKey: 'I have an API key',
  chooseLater: "I'll choose a provider later",
  recommended: 'Recommended',
  connected: 'Connected',
  featuredPitch: 'One subscription, 300+ frontier models — the recommended way to run the agent',
  fireworksPitch: 'Direct model API — Fireworks-hosted frontier models',
  openRouterPitch: 'One key, hundreds of models — a solid default',
  apiKeyOptions: {
    fireworks: {
      short: 'direct model API',
      description: 'Direct access to models hosted by Fireworks AI.'
    },
    openrouter: {
      short: 'one key, many models',
      description: 'Hosts hundreds of models behind a single key. Good default for new installs.'
    },
    openai: { short: 'GPT-class models', description: 'Direct access to OpenAI models.' },
    gemini: { short: 'Gemini models', description: 'Direct access to Google Gemini models.' },
    xai: { short: 'Grok models', description: 'Direct access to xAI Grok models.' },
    local: {
      short: 'self-hosted',
      description:
        'Point the agent at a local or self-hosted OpenAI-compatible endpoint (vLLM, llama.cpp, Ollama, etc).'
    }
  },
  backToSignIn: 'Back to sign in',
  getKey: 'Get a key',
  replaceCurrent: 'Replace current value',
  pasteApiKey: 'Paste API key',
  localApiKeyPlaceholder: 'API key (optional — only if your endpoint requires one)',
  couldNotSave: 'Could not save credential.',
  connecting: 'Connecting',
  update: 'Update',
  flowSubtitles: {
    pkce: 'Opens your browser to sign in, then continues here',
    device_code: 'Opens a verification page in your browser — the agent connects automatically',
    external: 'Sign in once in your terminal, then come back to chat'
  },
  startingSignIn: provider => `Starting sign-in for ${provider}...`,
  verifyingCode: provider => `Verifying your code with ${provider}...`,
  connectedProvider: provider => `${provider} connected`,
  connectedPicking: provider => `${provider} connected. Picking a default model...`,
  signInFailed: 'Sign-in failed. Try again.',
  pickDifferentProvider: 'Pick a different provider',
  signInWith: provider => `Sign in with ${provider}`,
  openedBrowser: provider => `We opened ${provider} in your browser.`,
  authorizeThere: 'Authorize the agent there.',
  copyAuthCode: 'Copy the authorization code and paste it below.',
  pasteAuthCode: 'Paste authorization code',
  reopenAuthPage: 'Re-open authorization page',
  autoBrowser: provider =>
    `We opened ${provider} in your browser. Authorize the agent there and you'll be connected automatically — nothing to copy or paste.`,
  reopenSignInPage: 'Re-open sign-in page',
  waitingAuthorize: 'Waiting for you to authorize...',
  externalPending: provider =>
    `${provider} signs in through its own CLI. Run this command in a terminal, then come back and pick "I've signed in":`,
  signedIn: "I've signed in",
  deviceCodeOpened: provider => `We opened ${provider} in your browser. Enter this code there:`,
  reopenVerification: 'Re-open verification page',
  copy: 'Copy',
  defaultModel: 'Default model',
  freeTier: 'Free tier',
  pro: 'Pro',
  free: 'Free',
  price: (input, output) => `${input} in / ${output} out per Mtok`,
  change: 'Change',
  startChatting: 'Begin',
  docs: provider => `${provider} docs`
}
