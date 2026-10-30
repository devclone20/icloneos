import type { Translations } from '../types'

export const billingBlock: Translations['billingBlock'] = {
  titleNous: 'Nous Portal 额度已用尽',
  titleProvider: provider => `额度已用尽 — ${provider}`,
  fallbackMessage: '您的账户额度已用尽。请充值以继续使用。',
  openBilling: '打开账单',
  addCredits: '添加额度',
  dismiss: '忽略'
}
