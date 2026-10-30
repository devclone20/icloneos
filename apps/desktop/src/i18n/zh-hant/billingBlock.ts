import type { TranslationOverrides } from '../define-locale'

export const billingBlock: TranslationOverrides['billingBlock'] = {
  titleNous: 'Nous Portal 額度已用盡',
  titleProvider: provider => `額度已用盡 — ${provider}`,
  fallbackMessage: '您的帳戶額度已用盡。請儲值以繼續使用。',
  openBilling: '開啟帳單',
  addCredits: '新增額度',
  dismiss: '忽略'
}
