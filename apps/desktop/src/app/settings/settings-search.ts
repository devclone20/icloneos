import type { IconComponent } from '@/lib/icons'
import type { KeybindActionMeta } from '@/lib/keybinds/actions'
import { formatCombo } from '@/lib/keybinds/combo'
import { normalize } from '@/lib/text'
import type { ConfigFieldSchema, EnvVarInfo, HermesConfigRecord } from '@/types/hermes'

import { FIELD_LABELS, SECTIONS } from './constants'
import { credentialRowLabel } from './credential-key-ui'
import { fieldCopyForSchemaKey } from './field-copy'
import { prettyName, sectionFieldEntries, voiceFieldVisible } from './helpers'
import type { DesktopConfigSection, SettingsView } from './types'

type CredentialSettingsView = 'settings' | 'tools'

export const APPEARANCE_SETTING_IDS = {
  backdrop: 'appearance.backdrop',
  dockWindowSize: 'appearance.dock-window-size',
  embeds: 'appearance.embeds',
  introSplash: 'appearance.intro-splash',
  textSize: 'appearance.text-size',
  theme: 'appearance.theme',
  toolView: 'appearance.tool-view',
  translucency: 'appearance.translucency'
} as const

interface SettingsSearchTarget {
  field?: string
  key?: string
  keysView?: CredentialSettingsView
  plugin?: string
  providerView?: 'accounts' | 'custom-endpoints' | 'keys'
  setting?: string
  view: SettingsView
}

export interface SettingsSearchEntry {
  context: string
  description?: string
  icon: IconComponent
  id: string
  keywords: string[]
  label: string
  target: SettingsSearchTarget
}

interface ConfigSearchCopy {
  fieldDescriptions: Record<string, string>
  fieldLabels: Record<string, string>
  sections: Record<string, string>
}

interface CredentialSearchCopy {
  settings: string
  tools: string
}

export function credentialSettingsView(info: EnvVarInfo): CredentialSettingsView | null {
  if (info.channel_managed) {
    return null
  }

  if (info.category === 'tool') {
    return 'tools'
  }

  if (info.category === 'setting' || info.category === 'messaging') {
    return 'settings'
  }

  return null
}

function configFieldLabel(key: string, copy: ConfigSearchCopy): string {
  return (
    fieldCopyForSchemaKey(copy.fieldLabels, key) ??
    fieldCopyForSchemaKey(FIELD_LABELS, key) ??
    prettyName(key.split('.').pop() ?? key)
  )
}

function configFieldDescription(key: string, field: ConfigFieldSchema, copy: ConfigSearchCopy): string {
  return fieldCopyForSchemaKey(copy.fieldDescriptions, key) ?? field.description ?? ''
}

export function buildConfigSearchEntries(
  schema: Record<string, ConfigFieldSchema> | null | undefined,
  config: HermesConfigRecord | null | undefined,
  copy: ConfigSearchCopy,
  sections: DesktopConfigSection[] = SECTIONS
): SettingsSearchEntry[] {
  if (!schema || !config) {
    return []
  }

  const sectionFields = sectionFieldEntries(schema, config)

  return sections.flatMap(section => {
    const context = copy.sections[section.id] ?? section.label
    const fields = sectionFields.get(section.id) ?? []
    const visibleFields = section.id === 'voice' ? fields.filter(([key]) => voiceFieldVisible(key, config)) : fields

    return visibleFields.map(([key, field]) => ({
      context,
      description: configFieldDescription(key, field, copy),
      icon: section.icon,
      id: `config-field:${key}`,
      keywords: ['settings', section.id, section.label, key],
      label: configFieldLabel(key, copy),
      target: {
        field: key,
        view: `config:${section.id}` as SettingsView
      }
    }))
  })
}

export function buildCredentialSearchEntries(
  vars: Record<string, EnvVarInfo> | null | undefined,
  copy: CredentialSearchCopy,
  icons: Record<CredentialSettingsView, IconComponent>
): SettingsSearchEntry[] {
  if (!vars) {
    return []
  }

  return Object.entries(vars)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, info]) => {
      const view = credentialSettingsView(info)

      if (!view) {
        return []
      }

      return [
        {
          context: view === 'tools' ? copy.tools : copy.settings,
          description: info.description || undefined,
          icon: icons[view],
          id: `credential:${key}`,
          keywords: [key, info.url ?? '', ...(Array.isArray(info.tools) ? info.tools : [])],
          label: credentialRowLabel(key, info),
          target: {
            key,
            keysView: view,
            view: 'keys' as const
          }
        }
      ]
    })
}

/** A pane of the Settings rail as the search sees it: its name, its group's name and its door. */
interface PaneSearchRow {
  group: string
  icon: IconComponent
  /** The pane's `?tab=` id (every rail pane resolves there, the three page panes included). */
  id: string
  /** Extra words that reach the pane (a catalogue's aliases), besides its name and id. */
  keywords?: readonly string[]
  label: string
}

/** One entry per rail pane (tester U2-p2b-03 / U4-p2b-05), so a pane's own name
 *  is a hit in every locale. `skip` holds the panes another list already serves
 *  (the palette's own settings rows), so a name is never offered twice. */
export function buildPaneSearchEntries(
  rows: readonly PaneSearchRow[],
  skip: (paneId: string) => boolean
): SettingsSearchEntry[] {
  return rows
    .filter(row => !skip(row.id))
    .map(row => ({
      context: row.group,
      icon: row.icon,
      id: `pane:${row.id}`,
      keywords: [row.id, ...(row.keywords ?? [])],
      label: row.label,
      target: { view: row.id as SettingsView }
    }))
}

interface KeybindSearchCopy {
  /** The localized action names, by action id (`t.keybinds.actions`). */
  actions: Record<string, string>
  /** The pane's name — the entry's context (`t.settings.nav.keybinds`). */
  context: string
  /** Words a person types for a shortcut (keyboard, shortcut, hotkey…), in their language. */
  keywords: readonly string[]
}

/** One entry per keyboard shortcut: its localized name, its current combos and
 *  the pane door with `setting=<action id>` so the row scrolls into view. */
export function buildKeybindSearchEntries(
  actions: readonly KeybindActionMeta[],
  combosOf: (actionId: string) => readonly string[],
  copy: KeybindSearchCopy,
  icon: IconComponent
): SettingsSearchEntry[] {
  return actions.map(action => {
    const combos = combosOf(action.id)

    return {
      context: copy.context,
      description: combos.map(combo => formatCombo(combo)).join(' · ') || undefined,
      icon,
      id: `keybind:${action.id}`,
      keywords: [...copy.keywords, action.id, action.category, ...combos],
      label: copy.actions[action.id] ?? action.label ?? action.id,
      target: { setting: action.id, view: 'keybinds' }
    }
  })
}

function searchScore(entry: SettingsSearchEntry, query: string): number {
  const needle = normalize(query)

  if (!needle) {
    return 0
  }

  const label = normalize(entry.label)
  const context = normalize(entry.context)
  const haystack = normalize([entry.label, entry.context, entry.description ?? '', ...entry.keywords].join(' '))
  const terms = needle.split(/\s+/).filter(Boolean)

  if (!terms.every(term => haystack.includes(term))) {
    return 0
  }

  if (label === needle) {
    return 100
  }

  if (label.startsWith(needle)) {
    return 90
  }

  if (label.includes(needle)) {
    return 80
  }

  // A pane name typed from its start ranks its rows right under the pane itself.
  if (context.startsWith(needle)) {
    return 75
  }

  if (context.includes(needle)) {
    return 70
  }

  if (terms.every(term => label.includes(term) || context.includes(term))) {
    return 60
  }

  return 50
}

export function filterSettingsSearchEntries(entries: SettingsSearchEntry[], query: string): SettingsSearchEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, score: searchScore(entry, query) }))
    .filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(result => result.entry)
}

/** Serialize a search target to the Settings route's query string. */
export function settingsSearchTargetQuery(target: SettingsSearchTarget): string {
  const params = new URLSearchParams()
  params.set('tab', target.view)

  if (target.providerView) {
    params.set('pview', target.providerView)
  }

  if (target.keysView) {
    params.set('kview', target.keysView)
  }

  if (target.field) {
    params.set('field', target.field)
  }

  if (target.setting) {
    params.set('setting', target.setting)
  }

  if (target.key) {
    params.set('key', target.key)
  }

  if (target.plugin) {
    params.set('plugin', target.plugin)
  }

  return params.toString()
}
