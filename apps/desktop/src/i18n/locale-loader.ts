/**
 * K99 — the app catalogue, one locale at a time. English is the fallback and stays in the boot bundle; every other
 * locale is its own chunk, fetched when it becomes the active one (a reader reads one language: shipping all six at
 * boot cost about 1.1 MB on every start). `catalog.ts` keeps the eager six-locale table for the parity tests only.
 */
import { en } from './en'
import type { Locale, Translations } from './types'

type Loader = () => Promise<Translations>

// Chunk loaders, not words: the parity gate's bank registry (which looks for per-locale records) has nothing to check here.
const LOADERS: { readonly [locale in Exclude<Locale, 'en'>]: Loader } = {
  ar: () => import('./ar').then(module => module.ar),
  ja: () => import('./ja').then(module => module.ja),
  'pt-PT': () => import('./pt-PT').then(module => module.ptPt),
  zh: () => import('./zh').then(module => module.zh),
  'zh-hant': () => import('./zh-hant').then(module => module.zhHant)
}

const loaded = new Map<Locale, Translations>([['en', en]])
const inflight = new Map<Locale, Promise<Translations>>()

/** The locale's words when its chunk is in, else null (the caller keeps what it shows, or English). */
export function loadedTranslations(locale: Locale): Translations | null {
  return loaded.get(locale) ?? null
}

/** The locale's words, or English until they arrive: what a module-level translator reads. */
export function translationsOrEnglish(locale: Locale): Translations {
  return loaded.get(locale) ?? en
}

/** Fetches the locale's chunk once. A failed fetch resolves to English and is not remembered, so the next ask retries. */
export function loadTranslations(locale: Locale): Promise<Translations> {
  const ready = loaded.get(locale)

  if (ready) {
    return Promise.resolve(ready)
  }

  const running = inflight.get(locale)

  if (running) {
    return running
  }

  const loader = LOADERS[locale as Exclude<Locale, 'en'>]

  if (!loader) {
    return Promise.resolve(en)
  }

  const next = loader()
    .then(words => {
      loaded.set(locale, words)

      return words
    })
    .catch(() => en)
    .finally(() => inflight.delete(locale))

  inflight.set(locale, next)

  return next
}

/**
 * Every locale at once: the test environment (vitest.setup.ts) reads all six synchronously, as the app did before K99.
 *
 * @public — vitest.setup.ts reaches it through vi.mock's importOriginal, which knip cannot follow.
 */
export function preloadAllLocales(): Promise<Translations[]> {
  return Promise.all((Object.keys(LOADERS) as Exclude<Locale, 'en'>[]).map(locale => loadTranslations(locale)))
}
