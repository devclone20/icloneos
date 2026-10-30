import { expect, test } from 'vitest'

import { IT_PANES_COPY, paneStartFailure } from './copy'

const flatten = (value: unknown, prefix = ''): Record<string, string> => {
  if (typeof value === 'function') {
    return { [prefix]: String((value as (arg: string) => string)('X')) }
  }

  if (typeof value === 'object' && value !== null) {
    return Object.assign(
      {},
      ...Object.entries(value).map(([key, inner]) => flatten(inner, prefix ? `${prefix}.${key}` : key))
    )
  }

  return { [prefix]: String(value) }
}

test('itPanes: six locales, the same keys, every word filled and translated', () => {
  const en = flatten(IT_PANES_COPY.en)

  expect(Object.keys(IT_PANES_COPY).sort()).toEqual(['ar', 'en', 'ja', 'pt-PT', 'zh', 'zh-hant'])

  for (const [locale, copy] of Object.entries(IT_PANES_COPY)) {
    const words = flatten(copy)

    expect(Object.keys(words).sort()).toEqual(Object.keys(en).sort())

    for (const [key, word] of Object.entries(words)) {
      expect(word.trim(), `${locale}.${key}`).not.toBe('')

      if (locale !== 'en' && key !== 'noBranch') {
        expect(word, `${locale}.${key} is still English`).not.toBe(en[key])
      }
    }
  }
})

test('a remote tmux refusal from main is worded from the catalogue in the display language', () => {
  const fromMain =
    "Error invoking remote method 'hermes:terminal:start': Error: iclone:tmux-remote-off: tmux over ssh is off"

  for (const locale of ['en', 'ar', 'ja', 'zh', 'zh-hant', 'pt-PT'] as const) {
    expect(paneStartFailure(fromMain, locale)).toBe(IT_PANES_COPY[locale].tmuxRemoteOff)
  }

  expect(paneStartFailure('spawn failed', 'ja')).toBe('spawn failed')
})
