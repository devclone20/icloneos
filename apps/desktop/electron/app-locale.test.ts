import { describe, expect, it } from 'vitest'

import { APP_INTL_LOCALE } from '../src/iclone-shared/app-intl-locale'

import { pinChromiumUiLocale } from './app-locale'

function fakeCommandLine() {
  const switches = new Map<string, string | undefined>()

  return { appendSwitch: (name: string, value?: string) => void switches.set(name, value), switches }
}

describe('Chromium UI locale (ruling 69: English only)', () => {
  it('pins --lang to the app’s English locale, whatever the operating system speaks', () => {
    const commandLine = fakeCommandLine()

    pinChromiumUiLocale(commandLine)

    expect(commandLine.switches.get('lang')).toBe('en-US')
    expect(APP_INTL_LOCALE).toBe('en-US')
  })
})
