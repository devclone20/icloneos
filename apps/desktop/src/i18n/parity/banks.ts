/**
 * Every word bank the app keeps per locale, for the locale parity gate (front V3-T). A bank is read as the locale's
 * OWN words — never through an English fallback — so a key that only resolves to English counts as missing.
 *
 * A new `Record<Locale, …>` bank (or plugin locale bundle) must be listed here: the gate's registry check scans the
 * sources and names any file that keeps per-locale words without an entry below.
 */
import { CONFINEMENT_COPY } from '@/app/home/containers/containers-copy'
import { ACP_WORK_COPY } from '@/app/home/econ/market/work/work-copy'
import { IT_PANES_COPY } from '@/app/home/it/bus/copy'
import { agentUpdateCopy } from '@/app/settings/app-atualisation/agent-model'
import { BILLING_COPY } from '@/app/settings/billing/copy'
import { customEndpointsCopyNow } from '@/app/settings/custom-endpoints-copy'
import { INFT_PANE_COPY } from '@/app/settings/inft-setup-copy'
import { INFT_WIZARD_COPY } from '@/app/settings/inft-setup-wizard-copy'
import { keysCopy } from '@/app/settings/keys-copy'
import { appUpdateWords } from '@/app/settings/machine/app-update-copy'
import { diagnosticsCheckCopy } from '@/app/settings/machine/diagnostics-checks-copy'
import { diagnosticsCopy } from '@/app/settings/machine/diagnostics-copy'
import { MACHINE_WORDS } from '@/app/settings/machine/machine-words'
import { UNINSTALL_COPY } from '@/app/settings/machine/uninstall-copy'
import { updatesCopy } from '@/app/settings/machine/updates-copy'
import { privacyCopy } from '@/app/settings/privacy-copy'
import { consentBankFor } from '@/components/consent/copy'
import { setupBankFor } from '@/components/setup/copy'
import { functionCopyFor } from '@/iclone-shared/permission-function-copy'
import { ignoreConfirmCopy } from '@/iclone-shared/permission-ignore-copy'
import { COMPLETION_SOUND_NAMES, COMPLETION_SOUND_VARIANTS } from '@/lib/completion-sound'
import { TEXT_SIZE_WORDS } from '@/lib/text-size'
import { KANBAN_LOCALES } from '@/plugins/kanban/i18n'

import { paymentsSheetCopy } from '../../iclone-shared/payments-sheet-copy'
import { TRANSLATIONS } from '../catalog'
import { ownWords } from '../define-locale'
import { getRuntimeI18nLocale, setRuntimeI18nLocale } from '../runtime'
import type { Locale } from '../types'

/** @public */
export interface LocaleBank {
  /** The bank's name in the gate's report. */
  id: string
  /** The source files that keep the per-locale records (paths under apps/desktop/src). */
  files: readonly string[]
  /** The locale's own words, or undefined when the bank has none for it. */
  words: (locale: Locale) => unknown
}

function underRuntimeLocale<T>(locale: Locale, read: () => T): T {
  const previous = getRuntimeI18nLocale()

  setRuntimeI18nLocale(locale)

  try {
    return read()
  } finally {
    setRuntimeI18nLocale(previous)
  }
}

const soundNames = (locale: Locale): Record<string, string> | undefined =>
  locale === 'en'
    ? Object.fromEntries(COMPLETION_SOUND_VARIANTS.map(variant => [String(variant.id), variant.name]))
    : (COMPLETION_SOUND_NAMES[locale] as Record<string, string> | undefined)

export const LOCALE_BANKS: readonly LocaleBank[] = [
  { id: 'catalog', files: ['i18n/catalog.ts'], words: locale => ownWords(TRANSLATIONS[locale]) },
  {
    id: 'agentUpdate',
    files: ['app/settings/app-atualisation/agent-model.ts', 'app/settings/machine/agent-update-words.ts'],
    words: agentUpdateCopy
  },
  { id: 'billing', files: ['app/settings/billing/copy.ts'], words: locale => BILLING_COPY[locale] },
  {
    id: 'customEndpoints',
    files: ['app/settings/custom-endpoints-copy.tsx'],
    words: locale => underRuntimeLocale(locale, customEndpointsCopyNow)
  },
  { id: 'inftPane', files: ['app/settings/inft-setup-copy.ts'], words: locale => INFT_PANE_COPY[locale] },
  { id: 'inftWizard', files: ['app/settings/inft-setup-wizard-copy.ts'], words: locale => INFT_WIZARD_COPY[locale] },
  { id: 'keys', files: ['app/settings/keys-copy.tsx'], words: keysCopy },
  { id: 'appUpdate', files: ['app/settings/machine/app-update-copy.ts'], words: locale => appUpdateWords(locale).copy },
  { id: 'diagnosticsChecks', files: ['app/settings/machine/diagnostics-checks-copy.ts'], words: diagnosticsCheckCopy },
  { id: 'diagnostics', files: ['app/settings/machine/diagnostics-copy.ts'], words: diagnosticsCopy },
  { id: 'machineWords', files: ['app/settings/machine/machine-words.ts'], words: locale => MACHINE_WORDS[locale] },
  { id: 'uninstall', files: ['app/settings/machine/uninstall-copy.ts'], words: locale => UNINSTALL_COPY[locale] },
  { id: 'updates', files: ['app/settings/machine/updates-copy.ts'], words: updatesCopy },
  { id: 'privacy', files: ['app/settings/privacy-copy.tsx'], words: privacyCopy },
  { id: 'consent', files: ['components/consent/copy.ts'], words: consentBankFor },
  { id: 'setup', files: ['components/setup/copy.ts'], words: setupBankFor },
  { id: 'completionSounds', files: ['lib/completion-sound.ts'], words: soundNames },
  { id: 'textSize', files: ['lib/text-size.ts'], words: locale => TEXT_SIZE_WORDS[locale] },
  { id: 'kanban', files: ['plugins/kanban/i18n.ts'], words: locale => KANBAN_LOCALES[locale] },
  { id: 'confinement', files: ['app/home/containers/containers-copy.ts'], words: locale => CONFINEMENT_COPY[locale] },
  { id: 'acpWork', files: ['app/home/econ/market/work/work-copy.ts'], words: locale => ACP_WORK_COPY[locale] },
  { id: 'itPanes', files: ['app/home/it/bus/copy.ts'], words: locale => IT_PANES_COPY[locale] },
  // J4-4: the labels of main's two owner sheets (mandate, settings / stop); the values are never words. Main reads it,
  // so it is keyed by its own six ids, not `Locale` (no file listed, like the Ignore confirm).
  { id: 'paymentsSheet', files: [], words: locale => paymentsSheetCopy(locale) },
  // Main's native Ignore-permissions confirm. Keyed by the Electron locale's language subtag, not by `Locale`, so the
  // registry scan cannot see it (no file listed); a locale it lacks reads English and the gate names every line.
  { id: 'permissionIgnore', files: [], words: locale => ignoreConfirmCopy(locale) },
  // V3-F2: the Functions matrix and main's native raise confirm (permission-function-copy.ts). Keyed by the Electron
  // locale's language subtag like the Ignore confirm, so it is listed with no file; a locale it lacks reads English.
  { id: 'permissionFunctions', files: [], words: locale => functionCopyFor(locale) }
]

/** Files that name a `Record<Locale, …>` or `PluginLocaleBundles` without keeping words in it: the locale metadata,
 *  the plugin bundle type, and this registry. */
export const NOT_WORD_BANKS: readonly string[] = ['i18n/languages.ts', 'i18n/plugin-i18n.ts', 'i18n/parity/banks.ts']
