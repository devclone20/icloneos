// Credential removal copy (Settings → Keys, Providers, Model, Custom endpoints,
// Memory, Messaging, Gateway). Kept as its own block so the shared removal flow
// can type against it; other locales fall back to English.
export const enCredentialRemoval = {
  actionsFor: (key: string) => `Actions for ${key}`,
  activeProviderNote: 'This is your current model provider. The Model page will ask you to choose another one.',
  alreadyRemovedMessage: (label: string) => `${label} was already removed.`,
  alsoSignedIn: (provider: string, list: string, count: number) =>
    `${provider} is also signed in through ${list}. ${count === 1 ? 'It stays' : 'They stay'}, so ${provider} keeps working.`,
  auditEmpty: 'No credential changes yet.',
  auditHeading: 'Recent credential changes',
  auditHint: 'Names only — values are never recorded.',
  auditKinds: {
    api_key: 'API key',
    bot_token: 'Bot token',
    custom_endpoint: 'Custom endpoint',
    external: 'External account',
    gateway_session: 'Gateway sign-in',
    memory_secret: 'Memory secret',
    oauth: 'Account'
  },
  auditResults: {
    already_removed: 'Already removed',
    failed: 'Failed',
    removed: 'Removed',
    signed_out: 'Signed out',
    terminal_started: 'Command started'
  },
  chooseProvider: (provider: string) => `${provider} credentials were removed. Choose a provider to continue.`,
  confirmLabel: 'Remove',
  description: {
    api_key: (key: string, provider: string) =>
      `Deletes ${key} from this Mac (~/.hermes/.env and its mirrors). ${provider} keeps the key valid until you revoke it on their site.`,
    bot_token: (key: string) => `Clears ${key}. The bot stops responding until a new token is set.`,
    custom_endpoint: 'Deletes the endpoint, its key and any model pinned to it.',
    external: (provider: string, hint: string) => `${provider} is managed by its own CLI. ${hint}`,
    externalCommand: (command: string) => `Runs "${command}" in the terminal to delete the credential on this Mac.`,
    memory_secret: (key: string) =>
      `Deletes ${key} from this Mac (~/.hermes/.env). The memory provider stops using it.`,
    oauth: (provider: string) =>
      `Signs this Mac out of ${provider} (deletes the stored token from ~/.hermes/auth.json). The session may stay valid at ${provider} until it expires — revoke it there to be sure.`
  },
  externalDefaultHint: 'Remove it with that CLI.',
  failed: (label: string) => `Could not remove ${label}`,
  howToRemove: 'How to remove…',
  manageInProviders: 'Manage in Providers',
  memorySecretElsewhere: (label: string) =>
    `${label} is stored in the provider's own config file, not in Keys — clear it there.`,
  memorySecretUnchecked: (label: string) => `Could not check where ${label} is stored. Reopen this page to try again.`,
  openDocs: 'Open provider site',
  remove: 'Remove',
  removeCredentialsFor: (provider: string) => `Remove credentials for ${provider}`,
  removeLabel: (label: string) => `Remove ${label}`,
  removedMessage: (label: string) => `${label} was removed from this Mac.`,
  removedTitle: 'Credential removed',
  revokeAtProvider: 'Revoke at provider',
  runInTerminal: 'Run in terminal',
  signedOut: 'Signed out',
  stillSignedIn: (provider: string, list: string) => `${provider} is still signed in through ${list}.`,
  title: (label: string) => `Remove ${label}?`,
  understood: 'Got it'
}
