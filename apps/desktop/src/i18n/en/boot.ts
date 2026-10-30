import type { Translations } from '../types'

export const boot: Translations['boot'] = {
  ready: 'iclone os is ready',
  desktopBootFailedWithMessage: message => `Desktop boot failed: ${message}`,
  steps: {
    connectingGateway: 'Connecting live desktop gateway',
    preparingAgentDependencies: "Preparing the agent's dependencies…",
    loadingSettings: 'Loading settings',
    loadingSessions: 'Loading recent sessions',
    retryingRemoteBackend: 'Reconnecting to the remote agent backend…',
    startingDesktopConnection: 'Starting desktop connection',
    startingHermesDesktop: 'Starting iclone os…'
  },
  errors: {
    backgroundExited: 'The agent background process exited.',
    backgroundExitedDuringStartup: 'The agent background process exited during startup.',
    backendStopped: 'Backend stopped',
    desktopBootFailed: 'Desktop boot failed',
    gatewayConnectionLost: 'Lost connection to the gateway',
    gatewayConnectionLostDetail:
      'Still retrying in the background. You can keep reading and drafting — open Gateway settings if this persists.',
    gatewaySignInRequired: 'Gateway sign-in required',
    ipcBridgeUnavailable: 'Desktop IPC bridge is unavailable.'
  },
  failure: {
    title: "The agent couldn't start",
    description:
      "The background gateway didn't come up. Try one of the recovery steps below. Nothing here deletes your chats or settings.",
    remoteTitle: 'Remote gateway sign-in required',
    remoteDescription:
      'Your remote gateway session has expired. Sign in again to reconnect. Nothing here deletes your chats or settings.',
    retry: 'Retry',
    repairInstall: 'Repair install',
    useLocalGateway: 'Use local gateway',
    gatewaySettings: 'Gateway settings',
    back: 'Back',
    openLogs: 'Open logs',
    repairHint: 'Repair re-runs the installer and can take a few minutes on a fresh machine.',
    remoteSignInHint: signInLabel =>
      `Signs out of the saved remote browser session, then opens ${signInLabel}. Use local gateway to switch to the bundled backend instead.`,
    signOutAndSignIn: 'Sign out & sign in',
    remoteFailureHint: 'Check the gateway URL and sign-in under Gateway settings, or switch to the local gateway.',
    cloudDownTitle: 'Your cloud agent is down',
    cloudDownDescription:
      'The managed cloud agent this gateway connects to is returning a server error. It cannot be restarted from here — check its status, switch to the local gateway, or get support.',
    cloudDownHint: 'The buttons below open the Nous Portal (instance status and controls) and our Discord for support.',
    gateTitle: 'The permission gate is not in place',
    gateDescription:
      'icloneOS did not start the agent: its permission gate could not be installed or loaded in this agent runtime, so no command would be checked. Nothing here deletes your chats or settings.',
    gateHint:
      'Retry checks the gate again. Repair install reinstalls the agent runtime, then the gate. If the box above says the gate is disabled via config, first remove iclone-permissions and iclone-confinement from plugins.disabled in your Hermes config.yaml, then Retry.',
    gateHintUnmanaged:
      "This agent runtime was not installed by icloneOS (for example, your own git checkout of Hermes), so icloneOS only checks it and never changes it. Repair install sets up icloneOS's own verified copy in the app's folder; your folder stays as it is.",
    cloudDownCheckPortal: 'Check Portal status',
    cloudDownDiscord: 'Get help on Discord',
    hideRecentLogs: 'Hide recent logs',
    showRecentLogs: 'Show recent logs',
    signedInTitle: 'Signed in',
    signedInMessage: 'Reconnecting to the remote gateway…',
    signInIncompleteTitle: 'Sign-in incomplete',
    signInIncompleteMessage: 'The login window closed before authentication finished.',
    signInFailed: 'Sign-in failed',
    signInToRemoteGateway: 'Sign in to remote gateway',
    signInWithProvider: provider => `Sign in with ${provider}`,
    identityProvider: 'your identity provider'
  }
}
