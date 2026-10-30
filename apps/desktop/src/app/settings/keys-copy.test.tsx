import { describe, expect, it } from 'vitest'

import type { EnvVarInfo } from '@/types/hermes'

import { credentialKind, credentialWords, keysCopy, ownVariableTitle } from './keys-copy'

const OTHERS = ['ja', 'zh', 'zh-hant', 'ar', 'pt-PT'] as const
// What a title a person reads may never carry (ruling S27).
const DEV_SPEAK = /hermes|gateway|\bttl\b|\benv\b|[A-Z]{2,}_[A-Z0-9_]+|:\s*$/i

const info = (over: Partial<EnvVarInfo> = {}): EnvVarInfo =>
  ({ category: 'provider', description: '', is_password: true, is_set: false, ...over }) as EnvVarInfo

describe('keys copy', () => {
  const en = keysCopy('en')

  it('has every credential, provider and kind in all six locales, and the other five differ from English', () => {
    for (const locale of OTHERS) {
      const copy = keysCopy(locale)

      expect(Object.keys(copy.vars).sort()).toEqual(Object.keys(en.vars).sort())
      expect(Object.keys(copy.providers).sort()).toEqual(Object.keys(en.providers).sort())
      expect(Object.keys(copy.kinds).sort()).toEqual(Object.keys(en.kinds).sort())

      for (const [key, [title]] of Object.entries(copy.vars)) {
        expect(title, `${locale} ${key}`).not.toBe(en.vars[key][0])
      }

      for (const [name, pitch] of Object.entries(copy.providers)) {
        expect(pitch, `${locale} ${name}`).not.toBe(en.providers[name])
      }

      expect(copy.lessFields).not.toBe(en.lessFields)
    }
  })

  it('titles are sentences with no runtime name, no variable name, no "gateway", no ttl and no trailing colon', () => {
    for (const locale of ['en', ...OTHERS] as const) {
      const copy = keysCopy(locale)
      const titles = [...Object.values(copy.vars), ...Object.values(copy.kinds)].map(([title]) => title)

      expect(
        titles.filter(title => DEV_SPEAK.test(title)),
        locale
      ).toEqual([])
      expect(
        Object.values(copy.providers).filter(pitch => /hermes/i.test(pitch)),
        locale
      ).toEqual([])
    }
  })

  it("reads a provider's extra setting by its kind", () => {
    expect(credentialKind('ANTHROPIC_BASE_URL', info({ is_password: false }))).toBe('serverAddress')
    expect(credentialKind('OPENVIKING_ENDPOINT', info({ is_password: false }))).toBe('serverAddress')
    expect(credentialKind('AWS_REGION', info({ is_password: false }))).toBe('region')
    expect(credentialKind('AWS_PROFILE', info({ is_password: false }))).toBe('cloudProfile')
    expect(credentialKind('VERTEX_CREDENTIALS_PATH', info({ is_password: false }))).toBe('credentialsFile')
    expect(credentialKind('ANTHROPIC_TOKEN', info())).toBe('anotherKey')
    expect(credentialKind('AZURE_DEPLOYMENT', info({ is_password: false }))).toBe('other')
  })

  it('falls back to the kind for a provider setting and to the name for a variable the person added', () => {
    expect(credentialWords(en, 'FIRECRAWL_BROWSER_TTL', info(), 'name').title).toBe(
      'Choose how long a Firecrawl browser session stays open'
    )
    expect(credentialWords(en, 'ZZZ_BASE_URL', info({ is_password: false }), 'kind')).toEqual({
      hint: en.kinds.serverAddress[1],
      title: en.kinds.serverAddress[0]
    })
    expect(credentialWords(en, 'MY_SERVICE_ID', info(), 'name')).toEqual({ hint: '', title: 'My service ID' })
    expect(ownVariableTitle('HERMES_CUSTOM_FLAG')).toBe('Custom flag')
  })
})
