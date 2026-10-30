import type { Translations } from '../../types'
import type { SettingsProfileTranslations } from '../../types/settings/profile'

export const settingsProfile: Pick<Translations['settings'], keyof SettingsProfileTranslations> = {
  credentials: {
    pasteKey: 'Paste key',
    pasteLabelKey: label => `Paste ${label} key`,
    optional: 'Optional',
    enterValueFirst: 'Enter a value first.',
    couldNotSave: 'Could not save credential.',
    remove: 'Remove',
    getKey: 'Get a key',
    saving: 'Saving'
  },
  envActions: {
    actions: 'Actions',
    manageInKeys: 'Manage in API Keys',
    docs: 'Docs',
    hideValue: 'Hide value',
    revealValue: 'Reveal value',
    replace: 'Replace',
    set: 'Set'
  },
  keys: {
    failedLoad: 'API keys failed to load',
    empty: 'Nothing configured in this category yet.'
  },
  providers: {
    connectAccount: 'Connect an account',
    haveApiKey: 'Have an API key instead?',
    intro:
      'Sign in with an account you already have; there is no key to copy. The sign-in opens in your browser and finishes here.',
    connected: 'Connected',
    collapse: 'Collapse',
    connectAnother: 'Connect another provider',
    otherProviders: 'Other providers',
    claudeSubscription: 'Claude subscription (needs extra usage credits)',
    disconnect: 'Disconnect',
    disconnectInTerminal: 'Disconnect (runs the removal command in the terminal)',
    removeExternalGeneric: provider => `${provider} is managed by its own CLI — remove it there.`,
    removeKeyManaged: provider => `${provider} is configured from an API key. Remove it from API Keys.`,
    removeTerminalRunning: provider => `Running ${provider} disconnect in the terminal…`,
    removedTitle: 'Account removed',
    removedMessage: provider => `${provider} was removed.`,
    noProviderKeys: 'No provider API keys available.',
    searchKeys: 'Search providers…',
    noKeysMatch: 'No providers match your search.',
    manage: provider => `Manage ${provider}`,
    endpoints: {
      heading: 'Model servers of your own',
      addHeading: 'Add a server',
      editHeading: 'Edit this server',
      name: 'What to call this server',
      nameHint: 'The name you will see when you pick a model.',
      providerId: 'A short id for this server',
      providerIdHint: 'Lowercase letters, numbers and dashes; the app uses it to tell servers apart.',
      url: 'Where the server answers',
      urlHint: 'Its web address; OpenAI-compatible servers usually end in /v1.',
      model: 'Which model it answers with by default',
      context: 'How much of a conversation the model can keep in mind',
      contextHint: 'Leave it on Auto and the app asks the server.',
      apiKey: 'The key the server expects',
      apiKeyHint: 'Only if the server asks for one.',
      useForNewChats: 'Start new chats on this server',
      discoverModels: 'Find the models it offers when you test it',
      discoverModelsHint: 'The list fills the model field above.'
    },
    featuredPitch: 'One subscription for more than 300 leading models.',
    moreFields: count => `More settings (${count})`,
    localEndpoint: {
      title: 'Use a model server of your own',
      description: 'Any OpenAI-compatible server works, such as vLLM, llama.cpp or Ollama.',
      action: 'Set up'
    }
  }
}
