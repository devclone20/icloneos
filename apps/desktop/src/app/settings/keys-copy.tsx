import { useI18n } from '@/i18n'
import type { Locale } from '@/i18n/types'
import type { EnvVarInfo } from '@/types/hermes'

import { isKeyVar } from './credential-key-ui'
import { keysCopyAr } from './keys-copy-ar'
import { keysCopyEn } from './keys-copy-en'
import { keysCopyJa } from './keys-copy-ja'
import { keysCopyPtPt } from './keys-copy-pt-PT'
import { keysCopyZh } from './keys-copy-zh'
import { keysCopyZhHant } from './keys-copy-zh-hant'

// The words of Settings › Keys and Providers › API keys in all five locales (I-A r3, ruling S27): every
// credential the app knows has a hand-written one-sentence title and a hint, never the backend's
// description or the variable's name. A hint may be empty; an empty hint beats an English one.

/** A credential's one-sentence title and the hint under it. */
type CredentialWords = readonly [title: string, hint: string]

/** What a provider's extra setting does, read from its variable name, for the settings without words of
 *  their own (a provider's server address, a second key, a region…). */
type CredentialKind = 'anotherKey' | 'cloudProfile' | 'credentialsFile' | 'other' | 'region' | 'serverAddress'

export interface KeysCopy {
  /** Providers you connect with a pasted key instead of a browser sign-in, keyed by provider id. */
  apiKeyProviders: Record<string, CredentialWords>
  kinds: Record<CredentialKind, CredentialWords>
  /** The provider's extra settings are open: the label that folds them back. */
  lessFields: string
  /** The empty key field's placeholder (never built from the row's sentence title). */
  pasteKey: string
  /** One sentence per provider, keyed by the name the app shows. */
  providers: Record<string, string>
  vars: Record<string, CredentialWords>
}

const COPY: Record<Locale, KeysCopy> = {
  ar: keysCopyAr,
  en: keysCopyEn,
  ja: keysCopyJa,
  'pt-PT': keysCopyPtPt,
  zh: keysCopyZh,
  'zh-hant': keysCopyZhHant
}

export const keysCopy = (locale: Locale): KeysCopy => COPY[locale] ?? keysCopyEn

export function useKeysCopy(): KeysCopy {
  const { locale } = useI18n()

  return keysCopy(locale)
}

export function credentialKind(varKey: string, info: EnvVarInfo): CredentialKind {
  if (/_PROFILE$/.test(varKey)) {
    return 'cloudProfile'
  }

  if (/_REGION$/.test(varKey)) {
    return 'region'
  }

  if (/_(?:CREDENTIALS_)?PATH$/.test(varKey)) {
    return 'credentialsFile'
  }

  if (/_(?:URL|ENDPOINT)$/.test(varKey)) {
    return 'serverAddress'
  }

  return isKeyVar(varKey, info) ? 'anotherKey' : 'other'
}

// Words a variable name spells in capitals that stay capitals in a sentence.
const ACRONYMS = new Set(['AI', 'API', 'ID', 'IDS', 'URL'])

/** A variable the person added themselves has no words in the catalogue: its own name, in sentence case,
 *  is the only honest title ("MY_SERVICE_ID" → "My service ID"); the app's own HERMES_ prefix is dropped. */
export function ownVariableTitle(varKey: string): string {
  const words = varKey
    .replace(/^HERMES_/, '')
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word, index) => {
      const upper = word.toUpperCase()

      if (ACRONYMS.has(upper)) {
        return upper === 'IDS' ? 'IDs' : upper
      }

      const lower = word.toLowerCase()

      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
    })

  return words.join(' ') || varKey
}

/** The words a credential row shows: its own, else — for a provider's extra setting — those of its kind,
 *  else (a variable the person added) its own name and no hint. */
export function credentialWords(
  copy: KeysCopy,
  varKey: string,
  info: EnvVarInfo,
  fallback: 'kind' | 'name'
): { hint: string; title: string } {
  const own = copy.vars[varKey]

  const [title, hint] =
    own ?? (fallback === 'kind' ? copy.kinds[credentialKind(varKey, info)] : [ownVariableTitle(varKey), ''])

  return { hint, title }
}
