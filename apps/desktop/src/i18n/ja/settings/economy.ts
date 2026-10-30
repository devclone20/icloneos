import type { TranslationOverrides } from '../../define-locale'
import type { SettingsEconomyTranslations } from '../../types/settings/economy'

export const settingsEconomy: Pick<NonNullable<TranslationOverrides['settings']>, keyof SettingsEconomyTranslations> = {
  economyOS: {
    navLabel: 'EconomyOS',
    title: 'iNFT エージェントをゼロから収益化まで、一歩ずつ進めます',
    description:
      '各ステップは次が開く前に確認され、途中でやめて後から再開できます。iNFT ごとに Virtuals でウォレット、メール、バンクカード、Hyperliquid、ACP のアカウントが用意されます。'
  }
}
