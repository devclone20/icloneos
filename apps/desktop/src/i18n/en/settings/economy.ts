import type { Translations } from '../../types'
import type { SettingsEconomyTranslations } from '../../types/settings/economy'

export const settingsEconomy: Pick<Translations['settings'], keyof SettingsEconomyTranslations> = {
  economyOS: {
    navLabel: 'EconomyOS',
    title: 'Take your iNFT agent from nothing to earning, one step at a time',
    description:
      'Each step is checked before the next one opens, and you can stop and come back. Every iNFT gets its own wallet, email, bank card, Hyperliquid and ACP account through Virtuals.'
  }
}
