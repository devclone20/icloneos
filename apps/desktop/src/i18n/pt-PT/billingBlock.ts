import type { TranslationOverrides } from '../define-locale'

export const billingBlock: TranslationOverrides['billingBlock'] = {
  titleNous: 'Sem créditos do Nous Portal',
  titleProvider: provider => `Sem créditos — ${provider}`,
  fallbackMessage: 'A sua conta ficou sem créditos. Adicione créditos para continuar.',
  openBilling: 'Abrir faturação',
  addCredits: 'Adicionar créditos',
  dismiss: 'Dispensar'
}
