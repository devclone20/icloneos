/**
 * The Settings entries the schema-driven catalog cannot produce: pages that
 * are UI, not config (accounts, keys, gateway, plugins, about). Rows, not
 * code — the palette and the Settings page both read this one list, so a tab
 * added here appears in both.
 */

import type { Translations } from '@/i18n'
import {
  Archive,
  Command,
  Globe,
  type IconComponent,
  Info,
  KeyRound,
  MessageSquareText,
  Package,
  Settings2,
  Zap
} from '@/lib/icons'

import { COMMAND_CENTER_PANE_TAB } from '../routes'

type NonConfigSettingsLabel =
  | 'about'
  | 'archivedChats'
  | 'gateway'
  | 'keysSettings'
  | 'keysTools'
  | 'mcp'
  | 'plugins'
  | 'providerAccounts'
  | 'providerApiKeys'

export const NON_CONFIG_SETTINGS: ReadonlyArray<{
  icon: IconComponent
  keywords?: string[]
  labelKey: NonConfigSettingsLabel
  tab: string
}> = [
  {
    icon: Zap,
    keywords: ['accounts', 'sign in', 'oauth', 'login', 'subscription', 'models', 'anthropic', 'openai'],
    labelKey: 'providerAccounts',
    tab: 'providers&pview=accounts'
  },
  {
    icon: KeyRound,
    keywords: ['providers', 'api key', 'keys', 'secrets', 'tokens', 'egress', 'iron proxy', 'sandbox proxy'],
    labelKey: 'providerApiKeys',
    tab: 'providers&pview=keys'
  },
  {
    icon: Globe,
    // The Connections registry merged into the unified Gateways page.
    keywords: [
      'connection',
      'connections',
      'messaging',
      'remote',
      'multi',
      'instances',
      'ssh',
      'cloud',
      'add gateway',
      'registry'
    ],
    labelKey: 'gateway',
    tab: 'gateway'
  },
  {
    icon: KeyRound,
    keywords: ['api', 'secrets', 'tokens', 'credentials', 'browser', 'search'],
    labelKey: 'keysTools',
    tab: 'keys&kview=tools'
  },
  {
    icon: Settings2,
    keywords: ['gateway', 'proxy', 'server', 'webhook', 'env', 'egress proxy', 'iron proxy'],
    labelKey: 'keysSettings',
    tab: 'keys&kview=settings'
  },
  {
    icon: Package,
    keywords: ['plugins', 'extensions', 'desktop plugins', 'addon', 'add-on'],
    labelKey: 'plugins',
    tab: 'plugins'
  },
  { icon: Archive, keywords: ['history', 'archived'], labelKey: 'archivedChats', tab: 'sessions' },
  { icon: Info, keywords: ['version', 'about'], labelKey: 'about', tab: 'about' }
]

/**
 * Settings panes that are a PAGE, so the palette offers them where it offers
 * routes — not where it offers config rows.
 *
 * Messaging and the Command Center stopped being routes on 2026-10-20 (front
 * K5) and their `routes-commands.ts` entries died with their `AppRouteId`,
 * which took them out of the palette altogether: a page you cannot find is
 * lost even though its pane still renders. They cannot go in
 * `NON_CONFIG_SETTINGS` above, whose labels are keys of `t.settings.nav`;
 * these two are named in `t.commandCenter`, by the same keys the Settings rail
 * reads (panes.tsx), so the palette and the rail cannot drift apart.
 */
export const SETTINGS_PANE_DESTINATIONS: ReadonlyArray<{
  icon: IconComponent
  id: string
  keywords: string[]
  label: (t: Translations) => string
  tab: string
}> = [
  {
    icon: MessageSquareText,
    id: 'messaging',
    keywords: ['messaging', 'telegram', 'slack', 'discord', 'whatsapp', 'bot', 'channels'],
    label: t => t.commandCenter.nav.messaging.title,
    tab: 'messaging'
  },
  {
    icon: Command,
    id: 'command-center',
    keywords: ['command center', 'sessions', 'system', 'usage', 'tokens', 'dashboard'],
    label: t => t.commandCenter.commandCenter,
    tab: COMMAND_CENTER_PANE_TAB
  }
]
