import type { TranslationOverrides } from '../../define-locale'
import type { SettingsEconomyTranslations } from '../../types/settings/economy'

export const settingsEconomy: Pick<NonNullable<TranslationOverrides['settings']>, keyof SettingsEconomyTranslations> = {
  economyOS: {
    navLabel: 'EconomyOS',
    title: 'انقل وكيل iNFT الخاص بك من الصفر إلى الكسب، خطوة بخطوة',
    description:
      'يُتحقق من كل خطوة قبل أن تُفتح التالية، ويمكنك التوقف والعودة لاحقًا. يحصل كل iNFT على محفظته وبريده وبطاقته المصرفية وحسابَي Hyperliquid وACP الخاصة به عبر Virtuals.'
  }
}
