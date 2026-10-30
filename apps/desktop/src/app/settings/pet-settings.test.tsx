import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { FloatingPet } from '@/components/pet/floating-pet'
import { loadPet } from '@/components/pet/pet-catalog'
import { PET_CATALOG } from '@/components/pet/pet-ids'
import { $petId, PET_STORAGE_KEYS, removePet } from '@/store/pet'

import { matchesPetQuery, PetSettings } from './pet-settings'

beforeAll(async () => {
  await Promise.all(PET_CATALOG.map(entry => loadPet(entry.id)))
})

const clearRect = vi.fn()
/** Paints so far: every paint clears its canvas first. */
const paints = () => clearRect.mock.calls.length

beforeEach(() => {
  removePet()
  clearRect.mockClear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return {
      canvas: this,
      clearRect,
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      putImageData: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      setTransform: vi.fn()
    } as never
  })
})

afterEach(() => {
  cleanup()
  removePet()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

function mount() {
  const view = render(
    <>
      <PetSettings />
      <div data-testid="scene">
        <FloatingPet onOpenSession={vi.fn()} />
      </div>
    </>
  )

  return { ...view, scene: () => screen.getByTestId('scene') }
}

describe('the pet library (Settings › Machine › Appearance › Pet)', () => {
  it('shows the 20 by legion, each drawn live at scale 1 with #n and a Choose action; no pet in the scene', () => {
    const { container, scene } = mount()

    for (const [legion, n] of [
      ['play', 7],
      ['death', 7],
      ['god', 6]
    ] as const) {
      const row = container.querySelector(`[data-pet-legion="${legion}"]`)!
      expect(row.querySelectorAll('[data-pet-choice]')).toHaveLength(n)
    }

    for (const entry of PET_CATALOG) {
      const tile = container.querySelector(`[data-pet-choice="${entry.id}"]`)!
      expect(tile.getAttribute('aria-label')).toBe(`Choose ${entry.name}`)
      expect(within(tile as HTMLElement).getByText(entry.name)).toBeTruthy()
      expect(within(tile as HTMLElement).getByText('Choose')).toBeTruthy()
      expect(tile.querySelector('canvas')!.getAttribute('data-pet-scale')).toBe('1')
    }

    expect(scene().innerHTML).toBe('')
  })

  it('until a pet is chosen, scale, roam and pop-out are disabled with the reason', () => {
    const { container } = mount()
    const disabled = container.querySelectorAll('[data-setting-row][aria-disabled="true"]')
    expect(disabled).toHaveLength(3)
    expect(screen.getAllByText('Choose a pet first.')).toHaveLength(3)
    expect(screen.queryByText('Remove pet')).toBeNull()
  })

  it('choosing each of the 20: the key persists and the composer pet becomes it (gate P6)', () => {
    const { container, scene } = mount()

    for (const entry of PET_CATALOG) {
      fireEvent.click(container.querySelector(`[data-pet-choice="${entry.id}"]`)!)
      expect(window.localStorage.getItem(PET_STORAGE_KEYS.selected)).toBe(entry.id)
      expect(scene().querySelector('canvas')!.getAttribute('data-pet-id')).toBe(entry.id)
      expect(container.querySelector(`[data-pet-choice="${entry.id}"]`)!.getAttribute('aria-pressed')).toBe('true')
    }

    expect(container.querySelectorAll('[data-setting-row][aria-disabled="true"]')).toHaveLength(0)
  })

  it('Remove pet: back to the no-pet state, the scene empty again', () => {
    const { container, scene } = mount()
    fireEvent.click(container.querySelector('[data-pet-choice="n30"]')!)
    expect(scene().querySelector('canvas')).not.toBeNull()

    act(() => {
      fireEvent.click(screen.getByText('Remove pet'))
    })

    expect($petId.get()).toBeNull()
    expect(window.localStorage.getItem(PET_STORAGE_KEYS.selected)).toBeNull()
    expect(scene().innerHTML).toBe('')
  })

  it('search by number, #number, id or legion', () => {
    const n87 = PET_CATALOG.find(p => p.id === 'n87')!
    expect(['87', '#87', 'n87', 'play', ''].map(q => matchesPetQuery(n87, q))).toEqual([true, true, true, true, true])
    expect(matchesPetQuery(n87, 'god')).toBe(false)

    const { container } = mount()
    fireEvent.change(screen.getByLabelText('Find a pet by number'), { target: { value: '#14' } })
    expect([...container.querySelectorAll('[data-pet-choice]')].map(el => el.getAttribute('data-pet-choice'))).toEqual([
      'n1405'
    ])
    fireEvent.change(screen.getByLabelText('Find a pet by number'), { target: { value: 'zzz' } })
    expect(screen.getByText('No pets match "zzz".')).toBeTruthy()
  })
})

describe('the library animates on ONE clock (m11, R4-F3)', () => {
  it('its 20 live previews share one timer: a frame only when one of them changes, never two in flight', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const queue: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => queue.push(cb))
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
    const { container } = mount()

    expect(container.querySelectorAll('[data-pet-choice] canvas')).toHaveLength(20)
    // All twenty drew their first frame at once; nothing runs until the first of them changes.
    expect(raf).not.toHaveBeenCalled()
    expect(paints()).toBe(20)

    let wasted = 0

    for (let i = 0; i < 375; i++) {
      act(() => {
        vi.advanceTimersByTime(16)
      })
      expect(queue.length).toBeLessThanOrEqual(1)
      const due = queue.splice(0)
      const before = paints()
      act(() => due.forEach(cb => cb(performance.now())))
      wasted += due.length && paints() === before ? 1 : 0
    }

    // 6 s of twenty idle pets: far fewer frames than the display's 375, and every one of them paints.
    expect(raf.mock.calls.length).toBeGreaterThan(0)
    expect(raf.mock.calls.length).toBeLessThan(375)
    expect(wasted).toBe(0)
    vi.useRealTimers()
  })
})
