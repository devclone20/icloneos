import type { TranslationOverrides } from '../../define-locale'
import type { SettingsEconomyTranslations } from '../../types/settings/economy'

export const settingsEconomy: Pick<NonNullable<TranslationOverrides['settings']>, keyof SettingsEconomyTranslations> = {
  economyOS: {
    navLabel: 'EconomyOS',
    title: '一步一步，讓你的 iNFT 代理從零開始賺錢',
    description:
      '每一步都會在下一步開放前完成檢查，你可以隨時暫停並稍後繼續。每個 iNFT 都會透過 Virtuals 取得自己的錢包、電子郵件、銀行卡、Hyperliquid 與 ACP 帳戶。'
  }
}
