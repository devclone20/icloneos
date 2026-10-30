import type { Translations } from '../types'

export const billingBlock: Translations['billingBlock'] = {
  titleNous: 'Out of Nous Portal credits',
  titleProvider: provider => `Out of credits — ${provider}`,
  fallbackMessage: 'Your account is out of credits. Add credits to keep going.',
  openBilling: 'Open billing',
  addCredits: 'Add credits',
  dismiss: 'Dismiss'
}
