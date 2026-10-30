import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $petMotion, $petRoamDir, choosePet, removePet, setPetRoam } from '@/store/pet'
import { popInPet } from '@/store/pet-overlay'

import { FloatingPet } from './floating-pet'
import { loadPet } from './pet-catalog'
import type * as PetDraw from './pet-draw'
import { PetSprite } from './pet-sprite'
import type { PetFrame } from './pet-states'
import { frameKey, petFrame } from './pet-states'
import { testPet } from './pet-test-pets'

// The renderer's frames, as painted: the canvas half is mocked (jsdom has no canvas), the pure half is the real one.
const painted: { canvas: HTMLCanvasElement; frame: PetFrame }[] = []

vi.mock('./pet-draw', async importOriginal => {
  const real = await importOriginal<typeof PetDraw>()

  return {
    ...real,
    paintPet: (ctx: CanvasRenderingContext2D, _pet: unknown, frame: PetFrame) =>
      painted.push({ canvas: ctx.canvas, frame })
  }
})

let now = 1000
let frames: FrameRequestCallback[] = []
let reduced = false

/** `ms` later: the shared clock's timer fires if a deadline came, then its one animation frame runs. */
function tick(ms = 16) {
  now += ms
  act(() => {
    vi.advanceTimersByTime(ms)
  })
  const due = frames
  frames = []
  act(() => due.forEach(cb => cb(now)))
}

/** A point on the in-window pet's canvas (where the host stands), for a click that lands on it. */
function onPet(container: HTMLElement) {
  const host = container.querySelector<HTMLElement>('[data-pet-host]')!

  return { clientX: parseFloat(host.style.left) + 20, clientY: parseFloat(host.style.top) + 30 }
}

const lastFrame = (canvas?: HTMLCanvasElement | null) =>
  [...painted].reverse().find(p => !canvas || p.canvas === canvas)!.frame

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  now = 1000
  frames = []
  painted.length = 0
  reduced = false
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
    frames.push(cb)

    return frames.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
    frames = []
  })
  vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return { canvas: this, getImageData: () => ({ data: [0, 0, 0, 255] }) } as never
  })
  window.matchMedia = ((query: string) => ({
    addEventListener: () => {},
    matches: query.includes('reduce') && reduced,
    media: query,
    removeEventListener: () => {}
  })) as never
  ;(window as unknown as { hermesDesktop: object }).hermesDesktop = {}
})

afterEach(() => {
  cleanup()
  popInPet()
  removePet()
  setPetRoam(false)
  window.localStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (window as unknown as { matchMedia?: unknown }).matchMedia
  delete (window as unknown as { hermesDesktop?: object }).hermesDesktop
})

describe('prefers-reduced-motion in the renderer (m3, gate P5)', () => {
  it('the sprite draws the breath alone when the OS asks for less motion — and the full state when not', () => {
    const pet = testPet('n30')

    render(<PetSprite pet={pet} scale={1} state="jump" still={0.3} />)
    expect(lastFrame().lift).toBe(3)
    cleanup()

    reduced = true
    render(<PetSprite facing={1} pet={pet} scale={1} state="jump" still={0.3} />)
    expect(lastFrame()).toEqual(petFrame('idle', 0.3, pet.seed, true))
    expect(lastFrame().yaw).toBe(0)
  })

  it('a roaming pet stops gliding under reduced motion: it never walks (m11)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.spyOn(Math, 'random').mockReturnValue(0.9) // the roam always chooses a stroll
    await loadPet('n2')
    setPetRoam(true)

    const walk = async () => {
      const { container } = render(<FloatingPet onOpenSession={vi.fn()} />)
      act(() => {
        choosePet('n2')
      })
      const host = container.querySelector<HTMLElement>('[data-pet-host]')!
      const start = host.style.left
      let walked = false

      for (let i = 0; i < 300; i++) {
        now += 100
        await act(async () => {
          vi.advanceTimersByTime(100)
        })
        walked ||= $petMotion.get() === 'run' || host.style.left !== start
      }

      cleanup()
      removePet()

      return walked
    }

    expect(await walk()).toBe(true)
    reduced = true
    expect(await walk()).toBe(false)
  })
})

describe('one shared clock (m11, R4-F3)', () => {
  it('twenty live sprites share ONE timer and ONE frame a beat; nothing left once they unmount', () => {
    const pets = ['n2', 'n30', 'n87', 'n16'].map(testPet)

    const { unmount } = render(
      <>
        {Array.from({ length: 20 }, (_, i) => (
          <PetSprite key={i} pet={pets[i % pets.length]!} scale={1} state="run" />
        ))}
      </>
    )

    // Each drew its first frame at once; the clock sleeps until the next foot change.
    expect(painted).toHaveLength(20)
    expect(frames).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(1)
    painted.length = 0
    tick(110) // a run beat later: every sprite has a new frame to paint
    expect(painted).toHaveLength(20)
    expect(frames).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
    tick()
    expect(frames).toHaveLength(0)
  })

  it('an idle pet wakes only when its frame changes (gate P4): 60 s at 60 Hz, every frame asked for is painted', () => {
    const pet = testPet('n87')
    render(<PetSprite pet={pet} scale={1} state="idle" />)
    const raf = vi.mocked(window.requestAnimationFrame)
    const keys = [frameKey(lastFrame())]

    for (let i = 0; i < 3750; i++) {
      tick(16)
      const key = frameKey(lastFrame())

      if (key !== keys.at(-1)) {
        keys.push(key)
      }
    }

    // The display-rate loop asked for 3750 frames; the clock asks only at the frame's own edges — and each one paints.
    expect(raf.mock.calls.length).toBe(painted.length - 1)
    expect(painted.length).toBe(keys.length)
    expect(painted.length).toBeLessThan(120)

    // The same frames, in the same order, as sampling the state at every one of those 3750 ticks.
    const sampled = [frameKey(petFrame('idle', 0, pet.seed))]

    for (let i = 1; i <= 3750; i++) {
      const key = frameKey(petFrame('idle', (i * 16) / 1000, pet.seed))

      if (key !== sampled.at(-1)) {
        sampled.push(key)
      }
    }

    expect(keys).toEqual(sampled)
  })

  it('hidden: no timer and no frame; shown again: the frame of now at once', () => {
    let visibility: DocumentVisibilityState = 'visible'
    vi.spyOn(window.document, 'visibilityState', 'get').mockImplementation(() => visibility)
    const pet = testPet('n2')
    render(<PetSprite pet={pet} scale={1} state="run" />)
    expect(vi.getTimerCount()).toBe(1)

    visibility = 'hidden'
    act(() => {
      window.document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(vi.getTimerCount()).toBe(0)
    const before = painted.length
    tick(5100) // 5.1 s: the other foot is up by now
    expect(painted.length).toBe(before)
    expect(frames).toHaveLength(0)

    visibility = 'visible'
    act(() => {
      window.document.dispatchEvent(new Event('visibilitychange'))
    })
    tick(1)
    expect(painted.length).toBe(before + 1)
    expect(lastFrame()).toEqual(petFrame('run', (now - 1000) / 1000, pet.seed))
  })
})

describe('the in-window pet in motion', () => {
  it('walking, it faces its way with its own side views; standing, the front again (m8)', async () => {
    await loadPet('n2')
    const { container } = render(<FloatingPet onOpenSession={vi.fn()} />)
    act(() => {
      choosePet('n2')
    })
    const canvas = () => container.querySelector('canvas')!

    act(() => {
      $petMotion.set('run')
      $petRoamDir.set(1)
    })
    tick()
    expect(canvas().dataset.petState).toBe('run')
    expect(canvas().dataset.petFacing).toBe('1')
    expect(lastFrame(canvas()).yaw).toBe(6)

    act(() => $petRoamDir.set(-1))
    tick()
    expect(lastFrame(canvas()).yaw).toBe(18)

    act(() => {
      $petMotion.set(null)
      $petRoamDir.set(0)
    })
    tick()
    expect(canvas().dataset.petFacing).toBeUndefined()
    expect(lastFrame(canvas()).yaw).toBe(0)
  })

  it('every click waves again from the start, even mid-wave (m9)', async () => {
    await loadPet('n2')
    const { container } = render(<FloatingPet onOpenSession={vi.fn()} />)
    act(() => {
      choosePet('n2')
    })
    const canvas = () => container.querySelector('canvas')!

    fireEvent.click(canvas(), onPet(container))
    expect(canvas().dataset.petState).toBe('wave')
    tick(900) // 0.9 s into the wave: the top rows are on their left slip
    expect(lastFrame(canvas()).waveDx).toBe(-1)

    fireEvent.click(canvas(), onPet(container))
    // The clock restarted: t = 0 of a new wave (+1), not t = 0.9 of the old one.
    expect(lastFrame(canvas()).waveDx).toBe(1)
    tick(500) // 1.4 s after the first click — the old wave would be over; the new one is half way
    expect(canvas().dataset.petState).toBe('wave')
    expect(lastFrame(canvas()).waveDx).toBe(1)
  })
})

describe('the sprite clock', () => {
  it('a new clockKey restarts the state at t = 0', () => {
    const pet = testPet('n2')
    const { rerender } = render(<PetSprite clockKey={1} pet={pet} scale={1} state="wave" />)
    tick(900)
    expect(lastFrame().waveDx).toBe(-1)
    rerender(<PetSprite clockKey={2} pet={pet} scale={1} state="wave" />)
    expect(lastFrame().waveDx).toBe(1)
  })
})
