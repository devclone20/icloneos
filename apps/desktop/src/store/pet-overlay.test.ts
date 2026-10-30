import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PET_PROMPT_MAX_CHARS } from '@/iclone-shared/pet-prompt'

import { $petActivity, $petId, $petScale, $petUnread, choosePet, markPetUnread, removePet } from './pet'
import {
  $petOverlayActive,
  currentOverlayPayload,
  handleOverlayControl,
  initPetOverlayBridge,
  overlayWindowSize,
  PET_OVERLAY_STORAGE_KEYS,
  type PetOverlayOpenRequest,
  popInPet,
  popOutPet,
  restorePetOverlay,
  setPetOverlayOpenAppHandler,
  setPetOverlaySubmitHandler
} from './pet-overlay'

function fakeBridge() {
  let control: ((payload: unknown) => void) | null = null

  return {
    api: {
      close: vi.fn(async () => ({ ok: true })),
      control: vi.fn(),
      onControl: vi.fn((cb: (payload: unknown) => void) => {
        control = cb

        return () => {
          control = null
        }
      }),
      onState: vi.fn(() => () => {}),
      open: vi.fn(async (request: { bounds: object }) => ({ bounds: { ...request.bounds, x: 500 }, ok: true })),
      pushState: vi.fn(),
      promptHandoff: vi.fn(async () => true),
      sendPromptResult: vi.fn(),
      setBounds: vi.fn(),
      setIgnoreMouse: vi.fn()
    },
    send: (payload: unknown) => control?.(payload)
  }
}

let bridge: ReturnType<typeof fakeBridge>

beforeEach(() => {
  bridge = fakeBridge()
  ;(window as unknown as { hermesDesktop: object }).hermesDesktop = { petOverlay: bridge.api }
  choosePet('n2')
})

afterEach(() => {
  popInPet()
  window.localStorage.clear()
  $petActivity.set({})
  $petUnread.set(false)
  delete (window as unknown as { hermesDesktop?: object }).hermesDesktop
})

describe('the pop-out pet', () => {
  it('opens a padded window centred over the pet and mirrors its state', async () => {
    popOutPet({ height: 69, width: 43, x: 100, y: 400 })
    expect($petOverlayActive.get()).toBe(true)

    const request = bridge.api.open.mock.calls[0]![0] as PetOverlayOpenRequest

    expect(request.screen).toBe(false)
    // R4-F1: hung from the pet's feet (bottom-centre), which main converts with this window's zoom; the overlay
    // stands the pet 12 px above its bottom edge, so the window reaches that far below the feet.
    expect(request.anchor).toEqual({ x: 100 + 43 / 2, y: 400 + 69 })
    expect(request.bounds).toEqual({
      ...overlayWindowSize(43, 69),
      x: 100 + 43 / 2 - 208 / 2,
      y: 400 + 69 + 12 - 141
    })
    await Promise.resolve()
    await Promise.resolve()
    // The screen bounds main used are remembered for next time.
    expect(JSON.parse(window.localStorage.getItem(PET_OVERLAY_STORAGE_KEYS.bounds)!).x).toBe(500)

    bridge.api.pushState.mockClear()
    $petActivity.set({ busy: true, toolRunning: true })
    expect(bridge.api.pushState).toHaveBeenLastCalledWith(
      expect.objectContaining({ petId: 'n2', scale: $petScale.get() })
    )
    expect(bridge.api.pushState.mock.lastCall![0].activity).toMatchObject({ busy: true, toolRunning: true })
  })

  it('a second shift-click while out is a no-op; pop-in closes and stops mirroring', () => {
    popOutPet({ height: 69, width: 43, x: 0, y: 0 })
    popOutPet({ height: 69, width: 43, x: 0, y: 0 })
    expect(bridge.api.open).toHaveBeenCalledTimes(1)
    popInPet()
    expect($petOverlayActive.get()).toBe(false)
    expect(bridge.api.close).toHaveBeenCalled()
    bridge.api.pushState.mockClear()
    $petId.set('n30')
    expect(bridge.api.pushState).not.toHaveBeenCalled()
  })

  it('removing the pet pops it back in', () => {
    popOutPet({ height: 69, width: 43, x: 0, y: 0 })
    removePet()
    expect($petOverlayActive.get()).toBe(false)
  })

  it('restores at the remembered spot, and never spawns an orphan without one', () => {
    $petOverlayActive.set(true)
    restorePetOverlay()
    expect(bridge.api.open).not.toHaveBeenCalled()
    expect($petOverlayActive.get()).toBe(false)

    window.localStorage.setItem(
      PET_OVERLAY_STORAGE_KEYS.bounds,
      JSON.stringify({ height: 141, width: 160, x: 9, y: 9 })
    )
    $petOverlayActive.set(true)
    restorePetOverlay()
    expect(bridge.api.open).toHaveBeenCalledWith({ bounds: { height: 141, width: 160, x: 9, y: 9 }, screen: true })
  })

  it('routes the overlay control messages and ignores malformed ones', () => {
    const openApp = vi.fn()
    setPetOverlayOpenAppHandler(openApp)
    const dispose = initPetOverlayBridge()
    popOutPet({ height: 69, width: 43, x: 0, y: 0 })

    markPetUnread()
    bridge.send({ type: 'open-app' })
    expect(openApp).toHaveBeenCalledTimes(1)
    expect($petUnread.get()).toBe(false)

    bridge.send({ scale: 2.7, type: 'scale' })
    expect($petScale.get()).toBe(3)
    bridge.send({ scale: 'big', type: 'scale' })
    expect($petScale.get()).toBe(3)

    bridge.send({ bounds: { height: 1, width: 1, x: Number.NaN, y: 0 }, type: 'bounds' })
    bridge.send({ type: 'rm -rf' })
    handleOverlayControl(null)

    bridge.send({ type: 'pop-in' })
    expect($petOverlayActive.get()).toBe(false)
    dispose()
    setPetOverlayOpenAppHandler(null)
  })

  it('the payload carries only the pet: id, scale, activity, unread, locale', () => {
    expect(Object.keys(currentOverlayPayload()).sort()).toEqual(['activity', 'locale', 'petId', 'scale', 'unread'])
  })
})

describe('the pop-out falls back into the window (m10)', () => {
  it('open answers ok:false (off every display): the pet is back in the window, the reset spot remembered', async () => {
    const reset = { height: 141, width: 160, x: 1280, y: 300 }
    bridge.api.open.mockResolvedValueOnce({ bounds: reset, ok: false, reason: 'off-screen' } as never)
    window.localStorage.setItem(PET_OVERLAY_STORAGE_KEYS.bounds, JSON.stringify({ ...reset, x: 2600 }))

    popOutPet({ height: 69, width: 43, x: 100, y: 400 })
    expect($petOverlayActive.get()).toBe(true)
    await vi.waitFor(() => expect($petOverlayActive.get()).toBe(false))
    expect(JSON.parse(window.localStorage.getItem(PET_OVERLAY_STORAGE_KEYS.bounds)!)).toEqual(reset)
    // Nothing mirrors to a window that does not exist.
    bridge.api.pushState.mockClear()
    $petScale.set(3)
    expect(bridge.api.pushState).not.toHaveBeenCalled()

    // The next pop-out opens at the reset spot.
    popOutPet({ height: 69, width: 43, x: 100, y: 400 })
    expect(bridge.api.open).toHaveBeenLastCalledWith({ bounds: reset, screen: true })
  })

  it('open fails outright (rejects, or ok:false with no spot): back in the window, the remembered spot forgotten', async () => {
    window.localStorage.setItem(
      PET_OVERLAY_STORAGE_KEYS.bounds,
      JSON.stringify({ height: 141, width: 160, x: 1, y: 2 })
    )
    bridge.api.open.mockRejectedValueOnce(new Error('ipc gone'))
    popOutPet({ height: 69, width: 43, x: 100, y: 400 })
    await vi.waitFor(() => expect($petOverlayActive.get()).toBe(false))
    expect(window.localStorage.getItem(PET_OVERLAY_STORAGE_KEYS.bounds)).toBeNull()

    bridge.api.open.mockResolvedValueOnce({ ok: false, reason: 'failed' } as never)
    popOutPet({ height: 69, width: 43, x: 100, y: 400 })
    await vi.waitFor(() => expect($petOverlayActive.get()).toBe(false))
    // A fresh pop-out after that is a normal one (centred over the in-window pet), not a stuck hidden pet.
    popOutPet({ height: 69, width: 43, x: 100, y: 400 })
    expect($petOverlayActive.get()).toBe(true)
  })

  it('a boot restore at a spot that is gone: the in-window pet shows', async () => {
    const reset = { height: 141, width: 160, x: 0, y: 25 }
    window.localStorage.setItem(PET_OVERLAY_STORAGE_KEYS.bounds, JSON.stringify({ ...reset, x: -9000 }))
    $petOverlayActive.set(true)
    bridge.api.open.mockResolvedValueOnce({ bounds: reset, ok: false, reason: 'off-screen' } as never)
    restorePetOverlay()
    await vi.waitFor(() => expect($petOverlayActive.get()).toBe(false))
    expect(JSON.parse(window.localStorage.getItem(PET_OVERLAY_STORAGE_KEYS.bounds)!)).toEqual(reset)
  })
})

describe("the pop-out's prompt box reaches the pet's sender, and every submit is answered (gate P7)", () => {
  it('a submit is sent once, trimmed, and its answer goes back with its id; blank, over-cap, odd or with no pet: refused', async () => {
    const sent = vi.fn(async () => ({ outcome: 'queued' as const }))
    setPetOverlaySubmitHandler(sent)
    const dispose = initPetOverlayBridge()
    const answers = bridge.api.sendPromptResult

    bridge.send({ id: 1, text: '  refactor the parser  ', type: 'submit' })
    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent).toHaveBeenLastCalledWith('refactor the parser', expect.any(Function))
    await vi.waitFor(() => expect(answers).toHaveBeenLastCalledWith({ id: 1, outcome: 'queued' }))

    for (const text of ['', ' \n ', 'x'.repeat(PET_PROMPT_MAX_CHARS + 1), 7, null]) {
      bridge.send({ id: 2, text, type: 'submit' })
    }

    expect(sent).toHaveBeenCalledTimes(1)
    expect(answers).toHaveBeenLastCalledWith({ id: 2, outcome: 'refused', reason: 'not-sent' })

    // No id: nothing to answer, nothing sent.
    bridge.send({ text: 'hello', type: 'submit' })
    expect(sent).toHaveBeenCalledTimes(1)

    removePet()
    bridge.send({ id: 3, text: 'hello', type: 'submit' })
    expect(sent).toHaveBeenCalledTimes(1)
    expect(answers).toHaveBeenLastCalledWith({ id: 3, outcome: 'refused', reason: 'not-sent' })

    dispose()
    setPetOverlaySubmitHandler(null)
  })

  it("R4-F2: the sender's hand-off tells main which submit is about to leave (its own id)", async () => {
    let handOff: () => Promise<unknown> = async () => undefined
    setPetOverlaySubmitHandler(async (_text, h) => {
      handOff = h

      return { outcome: 'sent' }
    })
    const dispose = initPetOverlayBridge()

    bridge.send({ id: 42, text: 'hello', type: 'submit' })
    expect(bridge.api.promptHandoff).not.toHaveBeenCalled()
    await expect(handOff()).resolves.toBe(true)
    expect(bridge.api.promptHandoff).toHaveBeenCalledWith(42)

    dispose()
    setPetOverlaySubmitHandler(null)
  })

  it('a sender that throws or rejects, or none at all, answers refused — never silence', async () => {
    const dispose = initPetOverlayBridge()
    const answers = bridge.api.sendPromptResult

    setPetOverlaySubmitHandler(null)
    bridge.send({ id: 10, text: 'hi', type: 'submit' })
    expect(answers).toHaveBeenLastCalledWith({ id: 10, outcome: 'refused', reason: 'not-sent' })

    setPetOverlaySubmitHandler(() => {
      throw new Error('boom')
    })
    bridge.send({ id: 11, text: 'hi', type: 'submit' })
    await vi.waitFor(() => expect(answers).toHaveBeenLastCalledWith({ id: 11, outcome: 'refused', reason: 'not-sent' }))

    setPetOverlaySubmitHandler(async () => Promise.reject(new Error('later')))
    bridge.send({ id: 12, text: 'hi', type: 'submit' })
    await vi.waitFor(() => expect(answers).toHaveBeenLastCalledWith({ id: 12, outcome: 'refused', reason: 'not-sent' }))

    setPetOverlaySubmitHandler(async () => ({ outcome: 'refused', reason: 'command' }))
    bridge.send({ id: 13, text: '/yolo', type: 'submit' })
    await vi.waitFor(() => expect(answers).toHaveBeenLastCalledWith({ id: 13, outcome: 'refused', reason: 'command' }))

    dispose()
    setPetOverlaySubmitHandler(null)
  })
})
