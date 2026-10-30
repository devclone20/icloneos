/**
 * Ruling 69 (owner): the app ships in English only, so dates, numbers and money are written the English
 * way whatever the operating system's region is. Every formatter passes this tag instead of `undefined` (which means
 * "the OS locale" and printed 'outubro', '1,2 mil' and '4,50 US$' on a Portuguese Mac); main hands the same tag to
 * Chromium as its UI locale, so a formatter that still omits the locale resolves to it too.
 * Self-contained: main imports it as well as the renderer.
 */
export const APP_INTL_LOCALE = 'en-US'
