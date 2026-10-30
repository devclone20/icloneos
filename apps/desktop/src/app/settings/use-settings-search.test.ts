import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { enAgentUpdate } from '@/i18n/en'
import { TEXT_SIZE_COPY } from '@/lib/text-size'

import { APPEARANCE_SETTING_IDS, filterSettingsSearchEntries, type SettingsSearchEntry } from './settings-search'
import { agentUpdateSearchEntries, textSizeSearchEntry } from './use-settings-search'

describe('settings search — Updates and Text size entries', () => {
  it('lands every agent-update word on the Updates pane', () => {
    const [entry] = agentUpdateSearchEntries(enAgentUpdate, 'Updates')

    expect(entry.target).toEqual({ view: 'updates' })
    expect(entry.label).toBe(enAgentUpdate.searchLabel)

    for (const word of ['hermes', 'agent', 'runtime', 'update', 'version', 'nous']) {
      expect(entry.keywords).toContain(word)
    }
  })

  it('lands the Text size words on the appearance row', () => {
    const entry = textSizeSearchEntry('Appearance')

    expect(entry.target).toEqual({ setting: APPEARANCE_SETTING_IDS.textSize, view: 'config:appearance' })
    expect(entry.label).toBe(TEXT_SIZE_COPY.title)
    expect(entry.keywords).toEqual(['font', 'text', 'size', 'bigger', 'smaller'])
  })
})

// Ruling 69 (owner, 2026-10-25, supersedes 59's two-language reading): the app ships in ENGLISH ONLY, so Appearance
// draws no Language row — and the palette must offer no entry that scrolls to a row that is not there. These rows
// used to pin the entry's keywords ("locale" only, never "japanese"); they now pin its absence, in the source that
// builds the entries and through the filter that would have matched it. The entry returns with the language (G-31).
describe('ruling 69 — settings search offers no language entry', () => {
  const source = readFileSync(join(__dirname, 'use-settings-search.ts'), 'utf8')

  it('the appearance entries are built without a language entry, and without its words', () => {
    expect(source).not.toContain('APPEARANCE_SETTING_IDS.language')
    expect(source).not.toContain('t.language')
    expect(source).not.toContain("keywords: ['locale']")
    expect(APPEARANCE_SETTING_IDS).not.toHaveProperty('language')
  })

  it('searching "language", "locale" or a language name finds nothing in the appearance entries', () => {
    // The entries the pane really builds, minus the hook's React-only wiring: every appearance id still in the map.
    const entries: SettingsSearchEntry[] = Object.values(APPEARANCE_SETTING_IDS).map(setting => ({
      context: 'Appearance',
      description: `${setting} description`,
      icon: textSizeSearchEntry('Appearance').icon,
      id: `setting:${setting}`,
      keywords: [],
      label: setting,
      target: { setting, view: 'config:appearance' }
    }))

    for (const query of ['language', 'locale', 'idioma', 'japanese', 'chinese', 'arabic', '日本語', 'português']) {
      expect(filterSettingsSearchEntries(entries, query), query).toHaveLength(0)
    }

    // The filter itself still works: the surviving rows are findable by their own words.
    expect(filterSettingsSearchEntries(entries, 'theme')).toHaveLength(1)
  })
})
