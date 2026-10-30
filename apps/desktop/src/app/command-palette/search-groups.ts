/**
 * The palette groups that only exist because the user typed: the root's
 * granular lists (settings fields, API keys, MCP servers, sessions, themes,
 * direct id/path jumps) and the Settings-scoped page's own catalog.
 *
 * They are hooks, not components, because that is the seam they were cut on:
 * each was a `useMemo` in the palette body and keeps its dependency list
 * verbatim, so the memo still rebuilds on exactly what it used to.
 */

import { useMemo } from 'react'

import { codiconIcon } from '@/components/ui/codicon'
import type { Translations } from '@/i18n'
import { Archive, Layers3, MessageCircle, Palette, SlidersHorizontal, Wrench } from '@/lib/icons'
import { openFolderAsProject } from '@/store/projects'
import type { ThemeMode, useTheme } from '@/themes/context'

import { SETTINGS_ROUTE, SKILLS_ROUTE } from '../routes'
import { SECTIONS } from '../settings/constants'
import type { SettingsSearchEntry } from '../settings/settings-search'
import type { useSettingsSearchCatalog } from '../settings/use-settings-search'

import type { SessionEntry } from './sessions'
import { NON_CONFIG_SETTINGS } from './settings-rows'
import { THEME_MODES, themeSupportsMode } from './theme-modes'
import type { PaletteGroup, PaletteItem } from './types'

type ThemeApi = ReturnType<typeof useTheme>
type SettingsCatalog = ReturnType<typeof useSettingsSearchCatalog>
type Go = (path: string) => () => void
type SettingsEntryItem = (entry: SettingsSearchEntry) => PaletteItem

interface SettingsPageGroupsInput {
  go: Go
  search: string
  settingsCatalog: SettingsCatalog
  settingsEntryItem: SettingsEntryItem
  settingsSectionLabel: (section: (typeof SECTIONS)[number]) => string
  t: Translations
}

interface SearchGroupsInput {
  archivedSessions: SessionEntry[]
  availableThemes: ThemeApi['availableThemes']
  go: Go
  goSession: (sessionId: string) => (event?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => void
  mcpServers: string[]
  mode: ThemeApi['mode']
  previewTheme: ThemeApi['previewTheme']
  resolveThemeMode: (target: ThemeMode) => 'dark' | 'light'
  resolvedMode: ThemeApi['resolvedMode']
  search: string
  sessions: SessionEntry[]
  setMode: ThemeApi['setMode']
  setTheme: ThemeApi['setTheme']
  settingsCatalog: SettingsCatalog
  settingsEntryItem: SettingsEntryItem
  t: Translations
  themeName: ThemeApi['themeName']
}

// Hermes session ids: <YYYYMMDD>_<HHMMSS>_<6 hex>. Used to offer a direct
// "Go to session ‹id›" jump for ids that aren't in the recent-200 list.
const SESSION_ID_RE = /^\d{8}_\d{6}_[a-f0-9]{6}$/

// A typed/pasted folder path: absolute (`/…`) or a Windows drive (`C:\…`).
// Deliberately NOT `~/…`: the upsert's membership check (projectIdForCwd)
// compares literal strings against the tree's absolute paths, so an unexpanded
// home path would always miss and double-create.
const FOLDER_PATH_RE = /^(\/|[A-Za-z]:[/\\]).+/

/**
 * Plugins and stored credentials are groups of their own wherever the settings
 * catalog is listed, skipped when empty — same two blocks on the root and on
 * the Settings page, so they live here once.
 */
function catalogSideGroups(
  settingsCatalog: SettingsCatalog,
  settingsEntryItem: SettingsEntryItem,
  t: Translations
): PaletteGroup[] {
  return [
    { entries: settingsCatalog.pluginEntries, heading: t.settings.nav.plugins },
    { entries: settingsCatalog.credentialEntries, heading: t.settings.nav.apiKeys }
  ]
    .filter(group => group.entries.length > 0)
    .map(group => ({ heading: group.heading, items: group.entries.map(settingsEntryItem) }))
}

export function useSearchGroups({
  archivedSessions,
  availableThemes,
  go,
  goSession,
  mcpServers,
  mode,
  previewTheme,
  resolveThemeMode,
  resolvedMode,
  search,
  sessions,
  setMode,
  setTheme,
  settingsCatalog,
  settingsEntryItem,
  t,
  themeName
}: SearchGroupsInput): PaletteGroup[] {
  return useMemo<PaletteGroup[]>(() => {
    if (!search.trim()) {
      return []
    }

    const result: PaletteGroup[] = []

    // Paste a raw session id → jump straight to it, even if it predates the
    // recent-200 window the lists below are built from.
    const directId = search.trim()

    if (SESSION_ID_RE.test(directId)) {
      result.push({
        items: [
          {
            icon: MessageCircle,
            id: `goto-${directId}`,
            keywords: ['session', 'id', 'go to', directId],
            label: `${t.commandCenter.goToSession} ${directId}`,
            runWithEvent: goSession(directId)
          }
        ]
      })
    }

    // Paste/type an absolute folder path → open it as a project directly (the
    // ⌘O upsert without the native picker). Same reflex as the raw-session-id
    // row above.
    if (FOLDER_PATH_RE.test(directId)) {
      result.push({
        items: [
          {
            icon: codiconIcon('folder-opened'),
            id: `open-folder-${directId}`,
            keywords: ['open', 'folder', 'project', directId],
            label: t.commandCenter.openFolderAt(directId),
            run: () => void openFolderAsProject(directId)
          }
        ]
      })
    }

    // Deep-link straight to a Capabilities sub-tab. The root "Go to" entry only
    // lands on the top-level Skills view; typing "mcp"/"tools"/"skills" should
    // jump to the exact tab (matches the "not just the top lvl" ask).
    const capLabel = t.commandCenter.nav.skills.title

    result.push({
      heading: capLabel,
      items: [
        {
          icon: Wrench,
          id: 'cap-skills',
          keywords: ['skills', 'capabilities'],
          label: `${capLabel}: ${t.skills.tabSkills}`,
          run: go(`${SKILLS_ROUTE}?tab=skills`)
        },
        {
          icon: SlidersHorizontal,
          id: 'cap-toolsets',
          keywords: ['tools', 'toolsets', 'capabilities'],
          label: `${capLabel}: ${t.skills.tabToolsets}`,
          run: go(`${SKILLS_ROUTE}?tab=toolsets`)
        },
        {
          icon: Layers3,
          id: 'cap-mcp',
          keywords: ['mcp', 'servers', 'tools', 'capabilities', 'model context protocol'],
          label: `${capLabel}: ${t.skills.tabMcp}`,
          run: go(`${SKILLS_ROUTE}?tab=mcp`)
        }
      ]
    })

    // Apply a theme directly from the root search (e.g. "nous" → Nous). Live
    // preview via keepOpen, mirroring the nested theme picker. If the theme
    // can't render the current light/dark mode, flip to the one it supports.
    result.push({
      heading: t.settings.appearance.themeTitle,
      items: availableThemes.map(theme => {
        // Same mode fixup as run(): if a theme cannot render the current
        // light/dark, preview (and commit) in the one mode it supports.
        const previewMode = themeSupportsMode(theme.name, resolvedMode)
          ? resolvedMode
          : resolvedMode === 'dark'
            ? 'light'
            : 'dark'

        return {
          active: themeName === theme.name,
          icon: Palette,
          id: `search-theme-${theme.name}`,
          keepOpen: true,
          keywords: ['theme', 'appearance', 'color', 'skin', theme.name, theme.description],
          label: theme.label,
          onHighlight: () => previewTheme(theme.name, previewMode),
          run: () => {
            setTheme(theme.name)

            if (!themeSupportsMode(theme.name, resolvedMode)) {
              setMode(previewMode)
            }
          }
        }
      })
    })

    // Switch light/dark/system directly (typing "dark" shouldn't require the
    // nested color-mode page).
    result.push({
      heading: t.settings.appearance.colorMode,
      items: THEME_MODES.map(entry => ({
        active: mode === entry.mode,
        icon: entry.icon,
        id: `search-mode-${entry.mode}`,
        keepOpen: true,
        keywords: ['appearance', 'color mode', 'brightness', entry.mode, t.settings.modeOptions[entry.mode].label],
        label: t.settings.modeOptions[entry.mode].label,
        onHighlight: () => previewTheme(themeName, resolveThemeMode(entry.mode)),
        run: () => setMode(entry.mode)
      }))
    })

    if (sessions.length > 0) {
      result.push({
        heading: t.commandCenter.sections.sessions,
        items: sessions.map(session => ({
          icon: MessageCircle,
          id: `session-${session.id}`,
          keywords: [
            'chat',
            'session',
            ...(session.preview ? [session.preview] : []),
            ...(session.git_branch ? [session.git_branch] : [])
          ],
          label: session.title,
          runWithEvent: goSession(session.id)
        }))
      })
    }

    const fieldItems = [...settingsCatalog.appearanceEntries, ...settingsCatalog.configEntries].map(settingsEntryItem)

    if (fieldItems.length > 0) {
      result.push({ heading: t.commandCenter.settingsFields, items: fieldItems })
    }

    result.push(...catalogSideGroups(settingsCatalog, settingsEntryItem, t))

    if (mcpServers.length > 0) {
      result.push({
        heading: t.commandCenter.mcpServers,
        items: mcpServers.map(name => ({
          icon: Wrench,
          id: `mcp-${name}`,
          keywords: ['mcp', 'server', 'tool'],
          label: name,
          run: go(`${SKILLS_ROUTE}?tab=mcp&server=${encodeURIComponent(name)}`)
        }))
      })
    }

    if (archivedSessions.length > 0) {
      result.push({
        heading: t.commandCenter.archivedChats,
        items: archivedSessions.map(session => ({
          icon: Archive,
          id: `archived-${session.id}`,
          keywords: [
            'archived',
            'chat',
            'session',
            ...(session.preview ? [session.preview] : []),
            ...(session.git_branch ? [session.git_branch] : [])
          ],
          label: session.title,
          run: go(`${SETTINGS_ROUTE}?tab=sessions&session=${encodeURIComponent(session.id)}`)
        }))
      })
    }

    return result
  }, [
    archivedSessions,
    availableThemes,
    go,
    goSession,
    mcpServers,
    mode,
    previewTheme,
    resolvedMode,
    resolveThemeMode,
    search,
    sessions,
    setMode,
    setTheme,
    settingsCatalog,
    settingsEntryItem,
    t,
    themeName
  ])
}

// Settings-scoped page (⌘K on the Settings overlay, or its search pill):
// the same catalog as root, minus everything that isn't settings. Pages
// always list; the granular entries surface on type, same contract as the
// root.
export function useSettingsPageGroups({
  go,
  search,
  settingsCatalog,
  settingsEntryItem,
  settingsSectionLabel,
  t
}: SettingsPageGroupsInput): PaletteGroup[] {
  return useMemo<PaletteGroup[]>(() => {
    const settingsTab = (tab: string) => `${SETTINGS_ROUTE}?tab=${tab}`
    const cc = t.commandCenter

    const result: PaletteGroup[] = [
      {
        heading: cc.settings,
        items: [
          ...SECTIONS.map(section => ({
            icon: section.icon,
            id: `sp-config-${section.id}`,
            keywords: ['settings', section.label, settingsSectionLabel(section)],
            label: settingsSectionLabel(section),
            run: go(settingsTab(`config:${section.id}`))
          })),
          ...NON_CONFIG_SETTINGS.map(entry => ({
            icon: entry.icon,
            id: `sp-${entry.tab}`,
            keywords: ['settings', ...(entry.keywords ?? [])],
            label: t.settings.nav[entry.labelKey],
            run: go(settingsTab(entry.tab))
          }))
        ]
      }
    ]

    if (search.trim()) {
      result.push({
        heading: cc.settingsFields,
        items: [...settingsCatalog.appearanceEntries, ...settingsCatalog.configEntries].map(settingsEntryItem)
      })

      result.push(...catalogSideGroups(settingsCatalog, settingsEntryItem, t))
    }

    return result
  }, [go, search, settingsCatalog, settingsEntryItem, settingsSectionLabel, t])
}
