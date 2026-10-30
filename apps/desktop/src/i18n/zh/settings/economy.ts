import type { Translations } from '../../types'
import type { SettingsEconomyTranslations } from '../../types/settings/economy'

export const settingsEconomy: Pick<Translations['settings'], keyof SettingsEconomyTranslations> = {
  economyOS: {
    navLabel: 'EconomyOS',
    title: '一步一步，让你的 iNFT 智能体从零开始赚钱',
    description:
      '每一步都会在下一步开放前完成检查，你可以随时暂停并稍后继续。每个 iNFT 都会通过 Virtuals 获得自己的钱包、邮箱、银行卡、Hyperliquid 和 ACP 账户。'
  }
}
