import type { Translations } from '../types'

import { settingsAgent } from './settings/agent'
import { settingsEconomy } from './settings/economy'
import { settingsMachine } from './settings/machine'
import { settingsProfile } from './settings/profile'
import { settingsShell } from './settings/shell'

export const settings: Translations['settings'] = {
  ...settingsShell,
  ...settingsProfile,
  ...settingsAgent,
  ...settingsEconomy,
  ...settingsMachine
}
