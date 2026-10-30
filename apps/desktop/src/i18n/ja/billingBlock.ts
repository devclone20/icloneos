import type { TranslationOverrides } from '../define-locale'

export const billingBlock: TranslationOverrides['billingBlock'] = {
  titleNous: 'Nous Portal クレジットが不足しています',
  titleProvider: provider => `クレジット不足 — ${provider}`,
  fallbackMessage: 'アカウントのクレジットが不足しています。続行するにはクレジットを追加してください。',
  openBilling: '請求を開く',
  addCredits: 'クレジットを追加',
  dismiss: '閉じる'
}
