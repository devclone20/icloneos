import { APP_INTL_LOCALE } from '../src/iclone-shared/app-intl-locale'

/** The slice of Electron's `app.commandLine` this needs, so the rule can be exercised without Electron. */
export interface LocaleCommandLine {
  appendSwitch(name: string, value?: string): void
}

/**
 * Ruling 69: Chromium's UI locale is the default locale of every renderer `Intl` formatter and of `toLocale*String`,
 * and it comes from the operating system unless `--lang` names one. The app ships in English only, so main pins it
 * to `APP_INTL_LOCALE`. Must run before the app's `ready` event: Chromium reads the switch once, at start-up.
 */
export function pinChromiumUiLocale(commandLine: LocaleCommandLine): void {
  commandLine.appendSwitch('lang', APP_INTL_LOCALE)
}
