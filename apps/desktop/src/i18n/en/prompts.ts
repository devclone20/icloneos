import type { Translations } from '../types'

export const prompts: Translations['prompts'] = {
  gatewayDisconnected: "The agent's gateway is not connected",
  sudoSendFailed: 'Could not send sudo password',
  secretSendFailed: 'Could not send secret',
  sudoTitle: 'Administrator password',
  sudoDesc: 'The agent needs your sudo password to run a privileged command. It is sent only to your local agent.',
  sudoPlaceholder: 'sudo password',
  secretTitle: 'Secret required',
  secretDesc: 'The agent needs a credential to continue.',
  secretPlaceholder: 'secret value'
}
