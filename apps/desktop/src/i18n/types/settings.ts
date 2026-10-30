import type { SettingsAgentTranslations } from './settings/agent'
import type { SettingsEconomyTranslations } from './settings/economy'
import type { SettingsMachineTranslations } from './settings/machine'
import type { SettingsProfileTranslations } from './settings/profile'
import type { SettingsShellTranslations } from './settings/shell'

export type SettingsTranslations = SettingsShellTranslations &
  SettingsProfileTranslations &
  SettingsAgentTranslations &
  SettingsEconomyTranslations &
  SettingsMachineTranslations
