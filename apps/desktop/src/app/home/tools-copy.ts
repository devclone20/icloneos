import { atom } from 'nanostores'

import type { Translations } from '@/i18n'
import { desktop as en } from '@/i18n/en/desktop'

type HomeCopy = Translations['desktop']['home']
type HomeToolsCopy = HomeCopy['tools']

/**
 * The frame tools' words in the display language. The wallet and browser
 * tools publish their labels into the contribution registry outside React, so
 * the language reaches them through this store: shell/frame-tools.tsx sets it
 * from the provider's `t` and each tool re-publishes on change. English until
 * the provider speaks, which is before any tool registers.
 */
export const $toolsCopy = atom<HomeToolsCopy>(en.home.tools)

/** The whole home catalogue for engines outside React (the iT terminal store names a fresh shell); same lifecycle. */
export const $homeCopy = atom<HomeCopy>(en.home)
