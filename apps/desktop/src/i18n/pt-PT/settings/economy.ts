import type { TranslationOverrides } from '../../define-locale'
import type { SettingsEconomyTranslations } from '../../types/settings/economy'

export const settingsEconomy: Pick<NonNullable<TranslationOverrides['settings']>, keyof SettingsEconomyTranslations> = {
  economyOS: {
    navLabel: 'EconomyOS',
    title: 'Leve o seu agente iNFT do zero até aos primeiros ganhos, um passo de cada vez',
    description:
      'Cada passo é verificado antes de o seguinte abrir, e pode parar e voltar mais tarde. Cada iNFT recebe, através da Virtuals, a sua própria carteira, e-mail, cartão bancário, conta Hyperliquid e conta ACP.'
  }
}
