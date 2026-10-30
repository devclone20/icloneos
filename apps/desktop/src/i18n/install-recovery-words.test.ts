// r2c (critic r2b minor B): in EVERY locale, the header and the diagnosis name the button that is actually on screen.
import { describe, expect, it } from 'vitest'

import { install as ar } from './ar/install'
import { install as en } from './en/install'
import { install as ja } from './ja/install'
import { install as ptPT } from './pt-PT/install'
import { install as zhHant } from './zh-hant/install'
import { install as zh } from './zh/install'

const LOCALES = { ar, en, ja, 'pt-PT': ptPT, zh, 'zh-hant': zhHant }

describe.each(Object.entries(LOCALES))('%s: recovery copy names its button', (_locale, copy) => {
  const r = copy!.recovery!

  it('Try again: the button, the after-fix button, the resume header and the slow diagnosis use the same words', () => {
    expect(r.fixRetry).toBeTruthy()
    expect(r.retryNow).toBe(r.fixRetry)
    expect(r.failedDesc).toContain(r.fixRetry)
    expect(r.diagnosis!.slow).toContain(r.fixRetry)
  })

  it('Repair: the repair-class header names the Repair button and never promises Try again', () => {
    expect(r.failedDescRepair).toContain(r.fixRepair)
    expect(r.failedDescRepair).not.toContain(r.fixRetry)
  })
})
