// V3-BK r2: opening the Book and the upgrade seed share one read of the set-up state.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $acpConfigMap } from '@/app/home/acp-setup'

import { refreshSetupState } from './book-seed'

afterEach(() => {
  Reflect.deleteProperty(window, 'hermesDesktop')
  $acpConfigMap.set({})
})

describe('refreshSetupState', () => {
  it('concurrent callers share one read; a later call reads again', async () => {
    const configMap = vi.fn(() => Promise.resolve({ s1: { slug: 's1', configured: true } }))

    Object.assign(window, { hermesDesktop: { icloneAcp: { configMap } } })

    await Promise.all([refreshSetupState(), refreshSetupState()])

    expect(configMap).toHaveBeenCalledOnce()
    expect($acpConfigMap.get().s1?.configured).toBe(true)

    await refreshSetupState()

    expect(configMap).toHaveBeenCalledTimes(2)
  })
})
