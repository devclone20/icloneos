import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'

import { NON_CONFIG_SETTINGS, SETTINGS_PANE_DESTINATIONS } from '@/app/command-palette/settings-rows'
import { useGatewayRequest } from '@/app/gateway/hooks/use-gateway-request'
import { $pluginRecords } from '@/contrib/plugins-store'
import { getEnvVars, getHermesConfigSchema } from '@/hermes'
import { useI18n } from '@/i18n'
import type { AgentUpdateCopy } from '@/i18n/en'
import { Keyboard, Package, Palette, RefreshCw, Settings2, Wrench } from '@/lib/icons'
import { allKeybindActions } from '@/lib/keybinds/actions'
import { TEXT_SIZE_COPY } from '@/lib/text-size'
import { $agentPlugins, isDesktopRelevantPlugin, loadAgentPlugins } from '@/store/agent-plugins'
import { $bindings, bindingsFor } from '@/store/keybinds'
import { $gatewayState } from '@/store/session'
import { TRANSLUCENCY_SUPPORTED } from '@/store/translucency'

import { useHermesConfigRecord } from '../hooks/use-config-record'
import { useOnProfileSwitch } from '../hooks/use-on-profile-switch'

import { agentUpdateCopy } from './app-atualisation/agent-model'
import type { settingsPaneSearchRows } from './panes'
import {
  APPEARANCE_SETTING_IDS,
  buildConfigSearchEntries,
  buildCredentialSearchEntries,
  buildKeybindSearchEntries,
  buildPaneSearchEntries,
  type SettingsSearchEntry
} from './settings-search'

// Panes the palette's own settings page already lists (settings-rows.ts: the
// config sections and NON_CONFIG_SETTINGS / SETTINGS_PANE_DESTINATIONS); the
// catalog adds the other rail panes so every pane name is a hit exactly once.
const PALETTE_LISTED_PANES: ReadonlySet<string> = new Set([
  ...NON_CONFIG_SETTINGS.map(entry => entry.tab.split('&')[0]),
  ...SETTINGS_PANE_DESTINATIONS.map(entry => entry.tab)
])

function isPaletteListedPane(paneId: string): boolean {
  return paneId.startsWith('config:') || PALETTE_LISTED_PANES.has(paneId)
}

/** Settings › Updates › Agent: "hermes", "nous", "agent update"… all land on the Updates pane. `context` is the
 *  nav row's own label (settings.nav.updates), so the palette's detail line follows the locale too. */
export function agentUpdateSearchEntries(copy: AgentUpdateCopy, context: string): SettingsSearchEntry[] {
  return [
    {
      context,
      description: copy.searchDescription,
      icon: RefreshCw,
      id: 'setting:updates.agent',
      keywords: ['hermes', 'agent', 'runtime', 'update', 'upgrade', 'version', 'nous', 'nous research'],
      label: copy.searchLabel,
      target: { view: 'updates' }
    }
  ]
}

/** H2's Text size row; its copy lives with the setting until the `settings.appearance.textSize*` keys land. */
export function textSizeSearchEntry(context: string): SettingsSearchEntry {
  return {
    context,
    description: TEXT_SIZE_COPY.description,
    icon: Palette,
    id: `setting:${APPEARANCE_SETTING_IDS.textSize}`,
    keywords: ['font', 'text', 'size', 'bigger', 'smaller'],
    label: TEXT_SIZE_COPY.title,
    target: { setting: APPEARANCE_SETTING_IDS.textSize, view: 'config:appearance' }
  }
}

/**
 * The granular settings-search catalog (appearance controls, config fields,
 * credentials) for the command palette's Settings page. Page destinations stay
 * on the palette side — it already owns section/page rows — this hook only
 * contributes the deep, schema-driven targets.
 */
type PaneSearchRows = typeof settingsPaneSearchRows

let paneSearchRows: null | PaneSearchRows = null
let paneSearchRowsLoad: null | Promise<PaneSearchRows> = null

/**
 * The one load of the pane registry chunk, shared by every palette open. A failed chunk import (a packaging slip, an
 * evicted file) is not cached: the promise is dropped, so the next open retries, and the failure resolves to `null`
 * (no pane rows this open) instead of an unhandled rejection. `importPanes` is the test seam.
 */
export function loadPaneSearchRows(
  importPanes: () => Promise<{ settingsPaneSearchRows: PaneSearchRows }> = () => import('./panes')
): Promise<null | PaneSearchRows> {
  paneSearchRowsLoad ??= importPanes().then(
    module => (paneSearchRows = module.settingsPaneSearchRows),
    (error: unknown) => {
      paneSearchRowsLoad = null

      throw error
    }
  )

  return paneSearchRowsLoad.catch((error: unknown) => {
    console.warn('settings search: the pane registry did not load', error)

    return null
  })
}

/** Test-only: forget the loaded registry, so a test can load it again through its own seam. */
export function resetPaneSearchRowsForTests(): void {
  paneSearchRows = null
  paneSearchRowsLoad = null
}

/**
 * K100: the rail panes' names for the palette, from the pane registry, which imports every Settings pane. A static
 * import here put the whole Settings window chunk (about 1 MB) on the boot path through the command palette; the
 * registry now loads the first time the palette opens (its body mounts per open) and stays loaded.
 */
function usePaneSearchRows(enabled: boolean): null | PaneSearchRows {
  const [rows, setRows] = useState<null | PaneSearchRows>(() => paneSearchRows)

  useEffect(() => {
    if (!enabled || rows) {
      return
    }

    let current = true

    void loadPaneSearchRows().then(loaded => current && loaded && setRows(() => loaded))

    return () => {
      current = false
    }
  }, [enabled, rows])

  return rows
}

export function useSettingsSearchCatalog(enabled: boolean) {
  const { locale, t } = useI18n()
  const paneRows = usePaneSearchRows(enabled)
  const configQuery = useHermesConfigRecord()
  const bindings = useStore($bindings)

  const schemaQuery = useQuery({
    queryKey: ['hermes-config-schema'],
    queryFn: () => getHermesConfigSchema(),
    enabled,
    staleTime: 5 * 60 * 1000
  })

  const {
    data: envVars,
    isError: envVarsError,
    isFetching: envVarsFetching,
    refetch: refetchEnvVars
  } = useQuery({
    queryKey: ['desktop-settings-search-env-vars'],
    queryFn: () => getEnvVars(),
    enabled,
    staleTime: 5 * 60 * 1000
  })

  const refreshCatalog = useCallback(() => {
    void refetchEnvVars()
  }, [refetchEnvVars])

  useOnProfileSwitch(refreshCatalog)

  // Plugin rows: desktop plugins are already in their store (discovered at
  // boot); agent plugins ride the gateway, so load them the first time the
  // catalog is wanted — same RPC the Plugins page fires on mount, deduped by
  // the store's own inflight guard.
  const { requestGateway } = useGatewayRequest()
  const gatewayState = useStore($gatewayState)
  const desktopPluginRecords = useStore($pluginRecords)
  const agentPlugins = useStore($agentPlugins)

  useEffect(() => {
    if (enabled && gatewayState === 'open') {
      void loadAgentPlugins(requestGateway)
    }
  }, [enabled, gatewayState, requestGateway])

  const pluginContext = t.settings.nav.plugins

  const pluginEntries: SettingsSearchEntry[] = [
    ...Object.values(desktopPluginRecords).map(record => ({
      context: pluginContext,
      description: record.description,
      icon: Package,
      id: `plugin:desktop:${record.id}`,
      keywords: ['plugin', 'extension', record.id],
      label: record.name,
      target: { plugin: record.id, view: 'plugins' as const }
    })),
    ...agentPlugins.filter(isDesktopRelevantPlugin).map(row => ({
      context: pluginContext,
      description: row.description || undefined,
      icon: Package,
      id: `plugin:agent:${row.key ?? row.name}`,
      keywords: ['plugin', 'extension', ...(row.key ? [row.key] : [])],
      label: row.name,
      target: { plugin: row.key ?? row.name, view: 'plugins' as const }
    }))
  ]

  // Never expose stale profile-scoped targets while a catalog is refreshing.
  // Field/key results wait for the current profile's data rather than briefly
  // pointing into the previous one.
  const configEntries =
    configQuery.isFetching || schemaQuery.isFetching || configQuery.isError || schemaQuery.isError
      ? []
      : buildConfigSearchEntries(schemaQuery.data?.fields, configQuery.data, {
          fieldDescriptions: t.settings.fieldDescriptions,
          fieldLabels: t.settings.fieldLabels,
          sections: t.settings.sections
        })

  const appearanceContext = t.settings.sections.appearance
  const appearance = t.settings.appearance

  // Ruling 69 (owner): the app ships in ENGLISH ONLY, so Appearance has no Language row — and the
  // palette offers no entry that would scroll to a row that is not there. It returns with the language (G-31).
  const appearanceEntries: SettingsSearchEntry[] = [
    {
      context: appearanceContext,
      description: appearance.themeDesc,
      icon: Palette,
      id: `setting:${APPEARANCE_SETTING_IDS.theme}`,
      keywords: ['color mode', 'skin'],
      label: appearance.themeTitle,
      target: { setting: APPEARANCE_SETTING_IDS.theme, view: 'config:appearance' }
    },
    textSizeSearchEntry(appearanceContext),
    // Linux has no translucency row to land on, and a palette hit that scrolls
    // to nothing is worse than no hit.
    ...(TRANSLUCENCY_SUPPORTED
      ? [
          {
            context: appearanceContext,
            description: appearance.translucencyDesc,
            icon: Palette,
            id: `setting:${APPEARANCE_SETTING_IDS.translucency}`,
            keywords: ['opacity', 'transparent'],
            label: appearance.translucencyTitle,
            target: { setting: APPEARANCE_SETTING_IDS.translucency, view: 'config:appearance' as const }
          }
        ]
      : []),
    {
      context: appearanceContext,
      description: appearance.dockWindowSizeDesc,
      icon: Palette,
      id: `setting:${APPEARANCE_SETTING_IDS.dockWindowSize}`,
      keywords: ['window', 'maximize', 'maximized', 'full screen', 'dock'],
      label: appearance.dockWindowSizeTitle,
      target: { setting: APPEARANCE_SETTING_IDS.dockWindowSize, view: 'config:appearance' }
    },
    {
      context: appearanceContext,
      description: appearance.backdropDesc,
      icon: Palette,
      id: `setting:${APPEARANCE_SETTING_IDS.backdrop}`,
      keywords: ['background', 'blur'],
      label: appearance.backdropTitle,
      target: { setting: APPEARANCE_SETTING_IDS.backdrop, view: 'config:appearance' }
    },
    {
      context: appearanceContext,
      description: appearance.introSplashDesc,
      icon: Palette,
      id: `setting:${APPEARANCE_SETTING_IDS.introSplash}`,
      keywords: ['splash', 'wordmark', 'empty chat', 'new chat'],
      label: appearance.introSplashTitle,
      target: { setting: APPEARANCE_SETTING_IDS.introSplash, view: 'config:appearance' }
    },
    {
      context: appearanceContext,
      description: appearance.toolViewDesc,
      icon: Palette,
      id: `setting:${APPEARANCE_SETTING_IDS.toolView}`,
      keywords: ['tool display', 'technical'],
      label: appearance.toolViewTitle,
      target: { setting: APPEARANCE_SETTING_IDS.toolView, view: 'config:appearance' }
    },
    {
      context: appearanceContext,
      description: appearance.embedsDesc,
      icon: Palette,
      id: `setting:${APPEARANCE_SETTING_IDS.embeds}`,
      keywords: ['external content', 'privacy'],
      label: appearance.embedsTitle,
      target: { setting: APPEARANCE_SETTING_IDS.embeds, view: 'config:appearance' }
    }
  ]

  const credentialEntries = buildCredentialSearchEntries(
    envVarsFetching || envVarsError ? null : envVars,
    {
      settings: t.settings.nav.keysSettings,
      tools: t.settings.nav.keysTools
    },
    { settings: Settings2, tools: Wrench }
  )

  const paneEntries = paneRows ? buildPaneSearchEntries(paneRows(t), isPaletteListedPane) : []

  const keybindEntries = buildKeybindSearchEntries(
    allKeybindActions(),
    id => bindingsFor(id, bindings),
    {
      actions: t.keybinds.actions,
      context: t.settings.nav.keybinds,
      keywords: [t.keybinds.title, ...t.settings.search.keybindWords]
    },
    Keyboard
  )

  return {
    appearanceEntries,
    // The palette lists config entries as field rows; the pane, shortcut and
    // agent-update rows ride with them.
    configEntries: [
      ...configEntries,
      ...paneEntries,
      ...keybindEntries,
      ...agentUpdateSearchEntries(agentUpdateCopy(locale), t.settings.nav.updates)
    ],
    credentialEntries,
    pluginEntries
  }
}
