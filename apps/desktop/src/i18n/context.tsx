import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { getHermesConfigRecord, type HermesConfigRecord, saveHermesConfig } from '@/hermes'
import { isRecord } from '@/iclone-shared/guards'

import { en } from './en'
import { DEFAULT_LOCALE, isOfferedLocale, localeConfigValue, normalizeLocale } from './languages'
import { loadedTranslations, loadTranslations } from './locale-loader'
import { setRuntimeI18nLocale } from './runtime'
import type { Locale, Translations } from './types'

export { LOCALE_META } from './languages'

export interface I18nConfigClient {
  getConfig: () => Promise<HermesConfigRecord>
  saveConfig: (config: HermesConfigRecord) => Promise<{ ok: boolean }>
}

const defaultConfigClient: I18nConfigClient = {
  getConfig: () => {
    if (typeof window === 'undefined' || !window.hermesDesktop?.api) {
      return Promise.resolve({})
    }

    return getHermesConfigRecord()
  },
  saveConfig: config => {
    if (typeof window === 'undefined' || !window.hermesDesktop?.api) {
      return Promise.resolve({ ok: true })
    }

    return saveHermesConfig(config)
  }
}

function getConfigDisplayLanguage(config: HermesConfigRecord): unknown {
  return isRecord(config.display) ? config.display.language : undefined
}

/** Ruling 61: English is the default everywhere. With no saved `display.language` the app opens in English, whatever
 *  the operating system's language; the system language never selects pt-PT (or anything else) on its own. */
const startingLocale = (): Locale => DEFAULT_LOCALE

function withConfigDisplayLanguage(config: HermesConfigRecord, locale: Locale): HermesConfigRecord {
  const display = isRecord(config.display) ? config.display : {}

  return {
    ...config,
    display: {
      ...display,
      language: localeConfigValue(locale)
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

// Ruling 59: Arabic is not offered, so no right-to-left locale is selectable. Add a locale here only with its catalogue. G-25: when a right-to-left locale returns, restore the positive RTL test (dir=rtl, then ltr on switch back) removed by V3-LANG.
const RTL_LOCALES = new Set<Locale>()

/** K99: the longest the first paint waits for the starting locale's chunk before it paints in English. */
const FIRST_PAINT_WAIT_MS = 1_500

function applyDocumentLocale(locale: Locale) {
  if (typeof document === 'undefined') {
    return
  }

  document.documentElement.lang = locale
  document.documentElement.dir = RTL_LOCALES.has(locale) ? 'rtl' : 'ltr'
}

export interface I18nContextValue {
  configLoadError: Error | null
  isLoadingConfig: boolean
  isSavingLocale: boolean
  locale: Locale
  saveError: Error | null
  setLocale: (next: Locale) => Promise<void>
  t: Translations
}

const I18nContext = createContext<I18nContextValue>({
  configLoadError: null,
  isLoadingConfig: false,
  isSavingLocale: false,
  locale: DEFAULT_LOCALE,
  saveError: null,
  setLocale: async () => {},
  t: en
})

interface I18nProviderProps {
  children: ReactNode
  configClient?: I18nConfigClient | null
  initialLocale?: unknown
}

export function I18nProvider({ children, configClient = defaultConfigClient, initialLocale }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(() =>
    initialLocale === undefined ? startingLocale() : normalizeLocale(initialLocale)
  )

  const [isLoadingConfig, setIsLoadingConfig] = useState(false)
  const [isSavingLocale, setIsSavingLocale] = useState(false)
  const [configLoadError, setConfigLoadError] = useState<Error | null>(null)
  const [saveError, setSaveError] = useState<Error | null>(null)
  const localeRef = useRef(locale)
  // K99: the words on screen. A locale whose chunk is still on its way keeps the previous words (English at first);
  // `arrived` re-renders once it lands.
  const lastShown = useRef<Translations>(en)
  const shown = loadedTranslations(locale) ?? lastShown.current
  const [, setArrived] = useState(0)
  // The first paint waits for the starting locale's chunk (a few ms from disk), so a non-English reader never sees
  // a flash of English; a fetch that does not answer within FIRST_PAINT_WAIT_MS paints in English.
  const [painted, setPainted] = useState(() => loadedTranslations(locale) !== null)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    lastShown.current = shown
  }, [shown])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    localeRef.current = locale
    setRuntimeI18nLocale(locale)
    applyDocumentLocale(locale)
  }, [locale])

  // FX-1: the fallback is armed ONCE, at boot, and only a paint disarms it. A locale change (the config answering
  // with another language, or failing and falling back to English) never resets or clears it.
  useEffect(() => {
    if (painted) {
      return
    }

    const fallback = setTimeout(() => setPainted(true), FIRST_PAINT_WAIT_MS)

    return () => clearTimeout(fallback)
  }, [painted])

  useEffect(() => {
    if (loadedTranslations(locale)) {
      // English (always in the bundle) or a chunk already in: nothing left to wait for.
      setPainted(true)

      return
    }

    let current = true

    // A failed chunk answers English (locale-loader); either way the app paints.
    void loadTranslations(locale)
      .catch(() => undefined)
      .then(() => {
        if (current) {
          setArrived(count => count + 1)
          setPainted(true)
        }
      })

    return () => {
      current = false
    }
  }, [locale])

  useEffect(() => {
    if (!configClient) {
      return
    }

    let cancelled = false

    setIsLoadingConfig(true)
    setConfigLoadError(null)

    configClient
      .getConfig()
      .then(config => {
        if (!cancelled) {
          const stored = getConfigDisplayLanguage(config)

          const resolved =
            stored === undefined || stored === null || stored === '' ? startingLocale() : normalizeLocale(stored)

          // Ruling 69: an older build may have saved e.g. 'pt-PT' here; it opens English and the window writes nothing
          // back. Review r2 (R2-M5): the window used to rewrite it once at mount, which reached only the profile open
          // at that moment — and, through a remote gateway, a VPS's config. Main sets display.language to English in
          // every LOCAL profile's config, at launch and before every spawn (electron/iclone-display-language.ts).
          setLocaleState(resolved)
        }
      })
      .catch(error => {
        if (!cancelled) {
          setConfigLoadError(toError(error))
          setLocaleState(DEFAULT_LOCALE)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingConfig(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [configClient, initialLocale])

  const setLocale = useCallback(
    async (next: Locale) => {
      const previousLocale = localeRef.current

      // Ruling 59: only an offered locale is ever applied or written to the config.
      const offered: Locale = isOfferedLocale(next) ? next : DEFAULT_LOCALE

      setSaveError(null)
      setLocaleState(offered)

      if (!configClient) {
        return
      }

      setIsSavingLocale(true)

      try {
        const latestConfig = await configClient.getConfig()
        const result = await configClient.saveConfig(withConfigDisplayLanguage(latestConfig, offered))

        if (!result.ok) {
          throw new Error('Failed to save language')
        }
      } catch (error) {
        const nextError = toError(error)

        setLocaleState(previousLocale)
        setSaveError(nextError)

        throw nextError
      } finally {
        setIsSavingLocale(false)
      }
    },
    [configClient]
  )

  const value = useMemo<I18nContextValue>(
    () => ({
      configLoadError,
      isLoadingConfig,
      isSavingLocale,
      locale,
      saveError,
      setLocale,
      t: shown
    }),
    [configLoadError, isLoadingConfig, isSavingLocale, locale, saveError, setLocale, shown]
  )

  return <I18nContext.Provider value={value}>{painted ? children : null}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}
