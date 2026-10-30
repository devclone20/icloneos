import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $petMotion, $petScale, choosePet, removePet, setPetScale } from '@/store/pet'
import { $petOverlayActive, handleOverlayControl, popInPet } from '@/store/pet-overlay'

import { FloatingPet } from './floating-pet'
import { loadPet } from './pet-catalog'
import { homeSpot } from './roam-geometry'

const COMPOSER = { bottom: 780, height: 90, left: 300, right: 1100, top: 690, width: 800, x: 300, y: 690 }

function fakeBridge() {
  return {
    close: vi.fn(async () => ({ ok: true })),
    control: vi.fn(),
    onControl: vi.fn(() => () => {}),
    onState: vi.fn(() => () => {}),
    open: vi.fn(async () => ({ ok: true })),
    pushState: vi.fn(),
    setBounds: vi.fn(),
    setIgnoreMouse: vi.fn()
  }
}

let bridge: ReturnType<typeof fakeBridge>
let composer: HTMLDivElement
/** The canvas alpha under a device pixel (the hit-test reads it back): opaque everywhere unless a test says so. */
let alphaAt: (x: number, y: number) => number = () => 255
const getContextCalls: unknown[][] = []

beforeEach(() => {
  removePet()
  setPetScale(1)
  bridge = fakeBridge()
  ;(window as unknown as { hermesDesktop: object }).hermesDesktop = { petOverlay: bridge }
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
  composer = window.document.createElement('div')
  composer.setAttribute('data-slot', 'composer-surface')
  composer.getBoundingClientRect = () => ({ ...COMPOSER, toJSON: () => ({}) }) as DOMRect
  window.document.body.appendChild(composer)
  alphaAt = () => 255
  getContextCalls.length = 0
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
    ...args: unknown[]
  ) {
    getContextCalls.push(args)

    return {
      canvas: this,
      clearRect: vi.fn(),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      getImageData: (x: number, y: number) => ({ data: [0, 0, 0, alphaAt(x, y)] }),
      putImageData: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      setTransform: vi.fn()
    } as never
  })
})

afterEach(() => {
  cleanup()
  popInPet()
  removePet()
  composer.remove()
  window.localStorage.clear()
  vi.restoreAllMocks()
  delete (window as unknown as { hermesDesktop?: object }).hermesDesktop
})

const pets = () => window.document.querySelectorAll('[data-pet-host], canvas[data-pet-id]')

/** A point on the in-window pet's canvas (dx, dy CSS px from its top-left corner). */
function onPet(container: HTMLElement, dx = 20, dy = 30) {
  const host = container.querySelector<HTMLElement>('[data-pet-host]')!

  return { clientX: parseFloat(host.style.left) + dx, clientY: parseFloat(host.style.top) + dy }
}

describe('the pet is off until one is chosen (gate P13)', () => {
  it('a fresh profile: 0 pet nodes, 0 animation frames, 0 timers, 0 overlay IPC', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const timeout = vi.spyOn(window, 'setTimeout')
    const interval = vi.spyOn(window, 'setInterval')
    const listen = vi.spyOn(window, 'addEventListener')
    const { container } = render(<FloatingPet onOpenSession={vi.fn()} />)
    const timersAtMount = timeout.mock.calls.length
    await act(async () => new Promise(r => setTimeout(r, 30)))

    expect(container.innerHTML).toBe('')
    expect(pets()).toHaveLength(0)
    expect(raf).not.toHaveBeenCalled()
    expect(timersAtMount).toBe(0)
    expect(timeout).toHaveBeenCalledTimes(1) // the test's own wait
    expect(interval).not.toHaveBeenCalled()
    expect(listen).not.toHaveBeenCalled()
    expect(Object.values(bridge).every(fn => fn.mock.calls.length === 0)).toBe(true)
  })

  it('choose from the library: the pet is at the composer corner on the same frame; remove: back to nothing', async () => {
    await loadPet('n87') // the library has drawn it already: the choice hits the decoded cache
    const { container } = render(<FloatingPet onOpenSession={vi.fn()} />)

    act(() => {
      choosePet('n87')
    })

    const canvas = container.querySelector('canvas[data-pet-id]')!
    expect(canvas.getAttribute('data-pet-id')).toBe('n87')
    const host = container.querySelector<HTMLElement>('[data-pet-host]')!
    const home = homeSpot({ id: 'composer', left: 300, right: 1100 - 43, y: 690 }, 69, 1)
    expect([host.style.left, host.style.top, host.style.visibility]).toEqual([`${home.x}px`, `${home.y}px`, 'visible'])
    // Standing on the composer's top edge, never over it.
    expect(home.y + 69).toBeLessThanOrEqual(COMPOSER.top)

    const raf = vi.spyOn(window, 'requestAnimationFrame')

    act(() => removePet())

    expect(pets()).toHaveLength(0)
    expect($petMotion.get()).toBeNull()
    await act(async () => new Promise(r => setTimeout(r, 60)))
    expect(raf).not.toHaveBeenCalled()
  })

  it('choosing another pet swaps the composer pet (gate P6, DOM proof)', async () => {
    const { container } = render(<FloatingPet onOpenSession={vi.fn()} />)

    for (const id of ['n2', 'n30', 'n136']) {
      act(() => {
        choosePet(id)
      })
      await vi.waitFor(() => expect(container.querySelector('canvas')?.getAttribute('data-pet-id')).toBe(id))
    }
  })
})

describe('what the in-window pet does', () => {
  it('click: it waves; Alt+wheel: a whole scale; shift-click: it pops out', async () => {
    await loadPet('n2')
    const { container } = render(<FloatingPet onOpenSession={vi.fn()} />)

    act(() => {
      choosePet('n2')
    })

    const canvas = () => container.querySelector('canvas')!
    expect(canvas().getAttribute('data-pet-state')).toBe('idle')
    fireEvent.click(canvas(), onPet(container))
    expect(canvas().getAttribute('data-pet-state')).toBe('wave')

    fireEvent.wheel(container.querySelector('[data-pet-host]')!, { altKey: true, deltaY: -120 })
    expect($petScale.get()).toBe(2)
    expect(canvas().getAttribute('data-pet-scale')).toBe('2')
    fireEvent.wheel(container.querySelector('[data-pet-host]')!, { deltaY: -120 })
    expect($petScale.get()).toBe(2)

    fireEvent.click(canvas(), { ...onPet(container), shiftKey: true })
    expect(bridge.open).toHaveBeenCalledTimes(1)
    expect($petOverlayActive.get()).toBe(true)
    expect(container.querySelector('canvas')).toBeNull()
  })
})

describe("click-through: only the pet's own pixels take the mouse (gate P15)", () => {
  it('in the window: the box passes clicks to the app behind; an opaque pixel takes them', async () => {
    await loadPet('n2')
    const { container } = render(<FloatingPet onOpenSession={vi.fn()} />)

    act(() => {
      choosePet('n2')
    })

    const host = container.querySelector<HTMLElement>('[data-pet-host]')!
    const canvas = () => container.querySelector('canvas')!
    // The canvas is read back for the hit-test: a CPU-readable backing store.
    expect(
      getContextCalls.some(args => (args[1] as { willReadFrequently?: boolean } | undefined)?.willReadFrequently)
    ).toBe(true)
    // Nothing of the box takes the mouse by itself.
    expect(host.style.pointerEvents).toBe('none')
    expect(canvas().style.pointerEvents).toBe('none')

    // Opaque only in the left half of the canvas (device px < 20): the right half is transparent.
    alphaAt = x => (x < 20 ? 255 : 0)

    fireEvent.mouseMove(window, onPet(container, 30, 30))
    expect(canvas().style.pointerEvents).toBe('none')
    fireEvent.mouseMove(window, onPet(container, 5, 30))
    expect(canvas().style.pointerEvents).toBe('auto')
    fireEvent.mouseMove(window, onPet(container, 30, 30))
    expect(canvas().style.pointerEvents).toBe('none')
    // Outside the pet's box altogether.
    fireEvent.mouseMove(window, { clientX: 10, clientY: 10 })
    expect(canvas().style.pointerEvents).toBe('none')

    // A click that still reaches the canvas over a transparent pixel (the pet walked under a still pointer) is not
    // the pet's: no wave. On an opaque pixel: the wave.
    fireEvent.click(canvas(), onPet(container, 30, 30))
    expect(canvas().dataset.petState).toBe('idle')
    fireEvent.click(canvas(), onPet(container, 5, 30))
    expect(canvas().dataset.petState).toBe('wave')
  })

  it('the pet moves under a still pointer: the hit-test runs again at that pointer on every placement step (n3)', async () => {
    await loadPet('n2')
    const { container } = render(<FloatingPet onOpenSession={vi.fn()} />)

    act(() => {
      choosePet('n2')
    })

    const host = container.querySelector<HTMLElement>('[data-pet-host]')!
    const canvas = () => container.querySelector('canvas')!
    alphaAt = x => (x < 20 ? 255 : 0) // opaque only in the left half
    const left0 = parseFloat(host.style.left)
    const pointer = onPet(container, 30, 30) // over a transparent pixel
    fireEvent.mouseMove(window, pointer)
    expect(canvas().style.pointerEvents).toBe('none')

    // The composer moves 12 px right (the layout changed) and the pet steps with it — no mouse move at all.
    const moveComposer = (dx: number) => {
      composer.getBoundingClientRect = () =>
        ({
          ...COMPOSER,
          left: COMPOSER.left + dx,
          right: COMPOSER.right + dx,
          x: COMPOSER.x + dx,
          toJSON: () => ({})
        }) as DOMRect
      fireEvent(window, new Event('resize'))
    }

    moveComposer(12)
    expect(parseFloat(host.style.left)).toBe(left0 + 12)
    // The still pointer is now over the pet's opaque half: the canvas takes the click there.
    expect(canvas().style.pointerEvents).toBe('auto')
    fireEvent.click(canvas(), pointer)
    expect(canvas().dataset.petState).toBe('wave')

    // And back: under the still pointer only a transparent pixel again, so the click goes to the app below.
    moveComposer(0)
    expect(parseFloat(host.style.left)).toBe(left0)
    expect(canvas().style.pointerEvents).toBe('none')
  })

  it('the shadow is not the pet: below alpha 128 the click goes through', async () => {
    await loadPet('n2')
    const { container } = render(<FloatingPet onOpenSession={vi.fn()} />)

    act(() => {
      choosePet('n2')
    })

    const canvas = () => container.querySelector('canvas')!
    alphaAt = () => 82 // .32 × 255, the shadow at its densest
    fireEvent.mouseMove(window, onPet(container))
    expect(canvas().style.pointerEvents).toBe('none')
    alphaAt = () => 178 // the rim, .7 × 255
    fireEvent.mouseMove(window, onPet(container))
    expect(canvas().style.pointerEvents).toBe('auto')
  })
})

describe("the pop-out's prompt box sends through the pet's sender (gate P7)", () => {
  const target = () => ({ busy: false, runtimeId: 'rt-1', storedId: 'st-1' })

  it("a submit goes to the app's composer send (attachments [], the session on screen) and is answered; none without a pet", async () => {
    await loadPet('n2')
    const submitText = vi.fn(async () => true)

    const answers = vi.fn()

    ;(bridge as unknown as { sendPromptResult: typeof answers }).sendPromptResult = answers
    const { rerender } = render(<FloatingPet onOpenSession={vi.fn()} onSubmitText={submitText} promptTarget={target} />)

    handleOverlayControl({ id: 1, text: 'nothing yet', type: 'submit' })
    expect(submitText).not.toHaveBeenCalled()
    expect(answers).toHaveBeenLastCalledWith({ id: 1, outcome: 'refused', reason: 'not-sent' })

    act(() => {
      choosePet('n2')
    })
    handleOverlayControl({ id: 2, text: ' tidy the imports ', type: 'submit' })
    await vi.waitFor(() => expect(answers).toHaveBeenLastCalledWith({ id: 2, outcome: 'sent' }))
    expect(submitText).toHaveBeenCalledWith('tidy the imports', { attachments: [] })

    // A slash command never reaches the composer send.
    handleOverlayControl({ id: 3, text: '/new', type: 'submit' })
    await vi.waitFor(() => expect(answers).toHaveBeenLastCalledWith({ id: 3, outcome: 'refused', reason: 'command' }))
    expect(submitText).toHaveBeenCalledTimes(1)

    // A new callback identity (the app re-rendered) is used at once, with no gap.
    const next = vi.fn(async () => true)
    rerender(<FloatingPet onOpenSession={vi.fn()} onSubmitText={next} promptTarget={target} />)
    handleOverlayControl({ id: 4, text: 'again', type: 'submit' })
    await vi.waitFor(() => expect(answers).toHaveBeenLastCalledWith({ id: 4, outcome: 'sent' }))
    expect(next).toHaveBeenCalledWith('again', { attachments: [] })
    expect(submitText).toHaveBeenCalledTimes(1)
  })
})
