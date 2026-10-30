import { describe, expect, it } from 'vitest'

import type { IcloneUpdatePolicyInfo } from '@/types/iclone-updates'

import { developerHowItUpdates, updatesIntro } from './intro'

const info = (sha: string, date = '2026-10-15'): IcloneUpdatePolicyInfo => ({
  align: null,
  override: null,
  packaged: true,
  pin: { date, sha, verified: 'contract lock' },
  policy: 'curated',
  runtimeCheckOff: true
})

describe('R1.r2.intro_copy_curated', () => {
  it('names the bundled pin and never the raw hermes update door', () => {
    const text = updatesIntro(info('1ac3f97deadbeef00112233445566778899aabb'))

    expect(text).toContain('pinned at 1ac3f97 (2026-10-15)')
    expect(text).toContain('never contacts Nous Research on its own')
    expect(text).not.toMatch(/hermes update|updates raw/i)
  })

  it('reads an unknown policy (fail closed) without inventing a pin', () => {
    const text = updatesIntro(null)

    expect(text).toContain('pinned by this release')
    expect(text).not.toContain('unknown')
  })
})

describe('U2p1-T2 curated channel copy', () => {
  const developer = (sha: string): IcloneUpdatePolicyInfo => ({ ...info(sha), packaged: false, policy: 'developer' })

  const nousAutoUpdate =
    /checks for updates automatically|in the background and lets you know|hermes update|as-is|pulls/i

  it('the developer intro and How it updates keep the pin and never promise a raw upstream pull', () => {
    const dev = developer('1ac3f97fbe0958aa')

    for (const text of [updatesIntro(dev), developerHowItUpdates(dev)]) {
      expect(text).toContain('pinned at 1ac3f97 (2026-10-15)')
      expect(text).toContain('never contact Nous Research on their own')
      expect(text).not.toMatch(nousAutoUpdate)
    }

    expect(updatesIntro(info('1ac3f97fbe0958aa'))).not.toBe(updatesIntro(dev))
  })
})
