import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { snapPetScale } from './pet-ids'
import { PetSprite } from './pet-sprite'
import { testPet } from './pet-test-pets'

/** A recording 2D context: jsdom has no canvas, and the pixels are proven on the pure layer (pet-draw.test). */
function fakeContext(canvas: HTMLCanvasElement) {
  return {
    canvas,
    clearRect: vi.fn(),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), height: h, width: w }),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    putImageData: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setTransform: vi.fn()
  }
}

const contexts: ReturnType<typeof fakeContext>[] = []

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const ctx = fakeContext(this)
    contexts.push(ctx)

    return ctx as never
  })
})

afterEach(() => {
  cleanup()
  contexts.length = 0
  vi.restoreAllMocks()
})

describe('PetSprite', () => {
  it("is a bare canvas: the pet's size × whole scale, pixelated, no box, no background", () => {
    const pet = testPet('n2')
    const { container } = render(<PetSprite pet={pet} scale={2} state="idle" still={0} />)
    const canvas = container.querySelector('canvas')!

    expect(canvas.style.width).toBe('86px')
    expect(canvas.style.height).toBe('138px')
    expect(canvas.style.imageRendering).toBe('pixelated')
    expect(canvas.style.background).toBe('')
    expect(canvas.style.border).toBe('')
    expect(canvas.getAttribute('data-pet-id')).toBe('n2')
    expect(canvas.getAttribute('data-pet-scale')).toBe('2')
    expect(canvas.getAttribute('aria-label')).toBe('#2')
    // DPR 1 in jsdom: the backing store is the CSS size, one device px a CSS px.
    expect([canvas.width, canvas.height]).toEqual([86, 138])
    // Painted: cleared, the shadow, then the tiles.
    const main = contexts.find(c => c.canvas === canvas)!
    expect(main.clearRect).toHaveBeenCalled()
    expect(main.drawImage).toHaveBeenCalledTimes(2)
  })

  it('snaps any scale to 1, 2 or 3', () => {
    expect([0, 1, 1.4, 1.6, 2, 2.5, 3, 7, Number.NaN, '2'].map(snapPetScale)).toEqual([1, 1, 1, 2, 2, 3, 3, 3, 1, 1])
  })
})
