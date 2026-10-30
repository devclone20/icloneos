import { describe, expect, it, vi } from 'vitest'

import { Settings2, Wrench } from '@/lib/icons'
import type { ConfigFieldSchema, HermesConfigRecord } from '@/types/hermes'

import {
  buildConfigSearchEntries,
  buildCredentialSearchEntries,
  buildKeybindSearchEntries,
  buildPaneSearchEntries,
  credentialSettingsView,
  filterSettingsSearchEntries
} from './settings-search'
import { envVar } from './test-utils'

const searchCopy = {
  fieldDescriptions: {
    'display.personality': 'Choose how Hermes sounds in conversation.',
    'tts.edge.voice': 'Voice used by Edge TTS.'
  },
  fieldLabels: {
    'display.personality': 'Personality',
    'tts.edge.voice': 'Edge voice',
    'tts.openai.voice': 'OpenAI voice'
  },
  sections: {
    chat: 'Chat',
    voice: 'Voice'
  }
}

// K105: the Japanese pane search loads the whole Settings pane registry: sized from its isolated p95 × 3 (measured
// 2026-10-21 at load ≈ 11: 8.6–9.5 s), so a loaded full suite does not turn it red on time alone.
vi.setConfig({ testTimeout: 30_000 })

describe('settings search index', () => {
  it('builds config results from renderable schema fields with exact deep links', () => {
    const schema: Record<string, ConfigFieldSchema> = {
      'display.personality': { type: 'select' },
      'tts.edge.voice': { type: 'string' },
      'tts.openai.voice': { type: 'string' }
    }

    const config = {
      display: { personality: 'default' },
      tts: { provider: 'edge', edge: { voice: '' }, openai: { voice: '' } }
    } as unknown as HermesConfigRecord

    const entries = buildConfigSearchEntries(schema, config, searchCopy)

    expect(entries.map(entry => entry.id)).toEqual([
      'config-field:display.personality',
      'config-field:tts.provider',
      'config-field:tts.edge.voice'
    ])
    expect(entries[0]).toMatchObject({
      context: 'Chat',
      description: 'Choose how Hermes sounds in conversation.',
      label: 'Personality',
      target: { field: 'display.personality', view: 'config:chat' }
    })
    expect(entries.some(entry => entry.id === 'config-field:tts.openai.voice')).toBe(false)
  })

  it('discovers future tool and setting entries entirely from backend metadata', () => {
    const vars = {
      FUTURE_CRAWLER_API_KEY: envVar('tool', {
        description: 'Fetch structured pages from a new crawler.',
        tools: ['future_crawl'],
        url: 'https://future.example/keys'
      }),
      FUTURE_GATEWAY_URL: envVar('setting', { description: 'Route gateway traffic.' }),
      TELEGRAM_BOT_TOKEN: envVar('messaging', { channel_managed: true }),
      MODEL_PROVIDER_API_KEY: envVar('provider')
    }

    const entries = buildCredentialSearchEntries(
      vars,
      { settings: 'Settings', tools: 'Tools' },
      { settings: Settings2, tools: Wrench }
    )

    expect(entries.map(entry => entry.id)).toEqual([
      'credential:FUTURE_CRAWLER_API_KEY',
      'credential:FUTURE_GATEWAY_URL'
    ])
    expect(entries[0]).toMatchObject({
      context: 'Tools',
      label: 'FUTURE CRAWLER',
      target: { key: 'FUTURE_CRAWLER_API_KEY', keysView: 'tools', view: 'keys' }
    })
    expect(filterSettingsSearchEntries(entries, 'structured crawler')).toHaveLength(1)
    expect(filterSettingsSearchEntries(entries, 'future_crawl')[0]?.id).toBe('credential:FUTURE_CRAWLER_API_KEY')
    expect(filterSettingsSearchEntries(entries, 'gateway traffic')[0]?.id).toBe('credential:FUTURE_GATEWAY_URL')
  })

  it('shares the Tools and Settings category boundary with the rendered page', () => {
    expect(credentialSettingsView(envVar('tool'))).toBe('tools')
    expect(credentialSettingsView(envVar('setting'))).toBe('settings')
    expect(credentialSettingsView(envVar('messaging'))).toBe('settings')
    expect(credentialSettingsView(envVar('messaging', { channel_managed: true }))).toBeNull()
    expect(credentialSettingsView(envVar('provider'))).toBeNull()
  })

  it('uses AND matching across labels, context, descriptions, and raw keys', () => {
    const entries = buildCredentialSearchEntries(
      {
        BRAVE_SEARCH_API_KEY: envVar('tool', { description: 'Search public web pages.' }),
        FIRECRAWL_API_KEY: envVar('tool', { description: 'Extract public web pages.' })
      },
      { settings: 'Settings', tools: 'Tools' },
      { settings: Settings2, tools: Wrench }
    )

    expect(filterSettingsSearchEntries(entries, 'brave tools')[0]?.id).toBe('credential:BRAVE_SEARCH_API_KEY')
    expect(filterSettingsSearchEntries(entries, 'firecrawl extract')[0]?.id).toBe('credential:FIRECRAWL_API_KEY')
    expect(filterSettingsSearchEntries(entries, 'brave extract')).toEqual([])
  })
})

describe('pane and keyboard-shortcut entries (U2-p2b-03 / U4-p2b-05)', () => {
  async function catalogue(locale: 'en' | 'ja') {
    const t = locale === 'ja' ? (await import('@/i18n/ja')).ja : (await import('@/i18n/en')).en
    const { settingsPaneSearchRows } = await import('./panes')
    const { KEYBIND_ACTIONS } = await import('@/lib/keybinds/actions')
    const panes = buildPaneSearchEntries(settingsPaneSearchRows(t), id => id.startsWith('config:'))

    const keybinds = buildKeybindSearchEntries(
      KEYBIND_ACTIONS,
      () => ['mod+k'],
      {
        actions: t.keybinds.actions,
        context: t.settings.nav.keybinds,
        keywords: [t.keybinds.title, ...t.settings.search.keybindWords]
      },
      Wrench
    )

    return { actions: KEYBIND_ACTIONS, entries: [...panes, ...keybinds], panes }
  }

  it('finds the Keyboard Shortcuts pane first and every shortcut row for キーボード in Japanese', async () => {
    const { actions, entries } = await catalogue('ja')
    const hits = filterSettingsSearchEntries(entries, 'キーボード')

    expect(hits[0]).toMatchObject({
      id: 'pane:keybinds',
      label: 'キーボードショートカット',
      target: { view: 'keybinds' }
    })
    expect(hits.filter(hit => hit.id.startsWith('keybind:'))).toHaveLength(actions.length)
    const first = hits.find(hit => hit.id === `keybind:${actions[0].id}`)

    expect(first?.target).toEqual({ setting: actions[0].id, view: 'keybinds' })
    // formatCombo renders the platform's modifier (⌘K on macOS, Ctrl+K elsewhere).
    expect(first?.description).toMatch(/^(⌘|Ctrl\+)K$/)
  })

  it('reaches the pane and every shortcut row by a catalogue alias in Japanese and English (UF3A-r1-T3)', async () => {
    for (const [locale, alias] of [
      ['ja', 'ホットキー'],
      ['en', 'hotkey']
    ] as const) {
      const { actions, entries } = await catalogue(locale)
      const hits = filterSettingsSearchEntries(entries, alias)

      // An alias is a keyword, not the pane's name: the pane is among the hits, not necessarily first.
      expect(hits.map(hit => hit.id)).toContain('pane:keybinds')
      expect(hits.filter(hit => hit.id.startsWith('keybind:'))).toHaveLength(actions.length)
    }
  })

  it('ranks the pane first for a prefix of its English name and skips the panes another list serves', async () => {
    const { actions, entries, panes } = await catalogue('en')
    const hits = filterSettingsSearchEntries(entries, 'keyb')

    expect(hits[0].id).toBe('pane:keybinds')
    expect(hits.filter(hit => hit.id.startsWith('keybind:'))).toHaveLength(actions.length)
    expect(panes.some(pane => pane.id.startsWith('pane:config:'))).toBe(false)
    expect(panes.map(pane => pane.label)).toContain('Keyboard shortcuts')
    expect(panes.find(pane => pane.id === 'pane:sessions-bots')).toMatchObject({
      context: 'Agent',
      label: 'Sessions & Bots'
    })
  })
})
