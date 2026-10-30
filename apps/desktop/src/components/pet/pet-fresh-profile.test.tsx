import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PetSettings } from '@/app/settings/pet-settings'
import { onPersistenceEvent } from '@/lib/storage'
import { flashPetActivity, removePet, resetPetActivity, setPetRoam, setPetScale } from '@/store/pet'
import { popInPet, restorePetOverlay } from '@/store/pet-overlay'

import { FloatingPet } from './floating-pet'

const petKeys = () => Object.keys(window.localStorage).filter(key => /pet/i.test(key))

beforeEach(() => {
  window.localStorage.clear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return {
      canvas: this,
      clearRect: () => {},
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      drawImage: () => {},
      fillRect: () => {},
      putImageData: () => {},
      restore: () => {},
      save: () => {},
      setTransform: () => {}
    } as never
  })
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('a fresh profile writes no pet key at all (gate P13 extended, gate P16)', () => {
  it('loading every pet module: no write, no remove', async () => {
    vi.resetModules()
    const storage = await import('@/lib/storage')
    const touched: string[] = []
    const off = storage.onPersistenceEvent(e => void (e.op !== 'read' && /pet/i.test(e.key) && touched.push(e.key)))

    await import('@/store/pet')
    await import('@/store/pet-overlay')
    await import('./floating-pet')
    await import('./pet-overlay-root')
    await import('@/app/settings/pet-settings')
    off()

    expect(touched).toEqual([])
    expect(petKeys()).toEqual([])
  })

  it('mounting the scene and the library, a whole turn, and every "set it to what it is" path: still nothing', async () => {
    const touched: string[] = []
    const off = onPersistenceEvent(e => e.op !== 'read' && /pet/i.test(e.key) && touched.push(`${e.op} ${e.key}`))

    render(
      <>
        <PetSettings />
        <FloatingPet onOpenSession={() => {}} />
      </>
    )

    act(() => {
      flashPetActivity({ celebrate: true, reasoning: false, toolRunning: false })
      resetPetActivity()
      removePet()
      popInPet()
      restorePetOverlay()
      setPetScale(1)
      setPetRoam(false)
    })
    await act(async () => new Promise(r => setTimeout(r, 30)))
    off()

    expect(touched).toEqual([])
    expect(petKeys()).toEqual([])
  })
})
