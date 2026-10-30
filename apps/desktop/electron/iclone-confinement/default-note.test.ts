/**
 * V3-FX FX-6: main's confinement default and the Permissions pane's note read ONE value. Turning main's default off
 * without the shared value (or the other way round) turns this red, so the pane can never again say "not confined"
 * while main confines, or "confined" while it does not.
 */
import { describe, expect, it } from 'vitest'

import { CONFINEMENT_ON_BY_DEFAULT } from '../../src/iclone-shared/confinement'

import { DEFAULT_SETTINGS } from './index'

describe('FX-6: one confinement default for main and the pane', () => {
  it("main's default settings are the shared default, and that default is ON (V3-G, owner decision D2)", () => {
    expect(DEFAULT_SETTINGS.enabled).toBe(CONFINEMENT_ON_BY_DEFAULT)
    expect(DEFAULT_SETTINGS.enabled).toBe(true)
  })
})
