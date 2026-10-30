import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PROMPT_SUBMIT_REQUEST_TIMEOUT_MS } from '@/api/client'
import type { PetPromptResult } from '@/iclone-shared/pet-prompt'
import type { PetOverlayStatePayload } from '@/store/pet-overlay'

import { PetOverlayApp } from './pet-overlay-root'

let push: ((payload: PetOverlayStatePayload) => void) | null = null
let answer: ((result: PetPromptResult) => void) | null = null

const api = {
  close: vi.fn(),
  control: vi.fn(),
  onControl: vi.fn(() => () => {}),
  onState: vi.fn((cb: (payload: PetOverlayStatePayload) => void) => {
    push = cb

    return () => {
      push = null
    }
  }),
  onPromptResult: vi.fn((cb: (result: PetPromptResult) => void) => {
    answer = cb

    return () => {
      answer = null
    }
  }),
  open: vi.fn(),
  pushState: vi.fn(),
  setBounds: vi.fn(),
  setFocusable: vi.fn(),
  setIgnoreMouse: vi.fn()
}

let alpha = 0
const getContextCalls: unknown[][] = []

beforeEach(() => {
  alpha = 0
  getContextCalls.length = 0
  ;(window as unknown as { hermesDesktop: object }).hermesDesktop = { petOverlay: api }
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
      getImageData: () => ({ data: [0, 0, 0, alpha] }),
      putImageData: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      setTransform: vi.fn()
    } as never
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.values(api).forEach(fn => fn.mockClear())
  delete (window as unknown as { hermesDesktop?: object }).hermesDesktop
})

const payload = (over: Partial<PetOverlayStatePayload> = {}): PetOverlayStatePayload => ({
  activity: {},
  locale: 'en',
  petId: 'n30',
  scale: 1,
  unread: false,
  ...over
})

describe('the popped-out pet window (gate P7: state mirrored)', () => {
  it('says ready, then draws exactly the pushed pet, state and scale, with no gateway', async () => {
    const { container } = render(<PetOverlayApp />)
    expect(api.control).toHaveBeenCalledWith({ type: 'ready' })
    expect(container.querySelector('canvas')).toBeNull()

    act(() => push!(payload({ activity: { busy: true, toolRunning: true }, scale: 2 })))
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())
    const canvas = container.querySelector('canvas')!
    expect([canvas.dataset.petId, canvas.dataset.petState, canvas.dataset.petScale]).toEqual(['n30', 'run', '2'])
    expect(container.querySelector('[data-pet-bubble="run"]')).not.toBeNull()

    // Ruling 69 (owner, 2026-10-25): the app ships in English only, so a pushed pt-PT reads the English bubble.
    act(() => push!(payload({ activity: { error: true }, locale: 'pt-PT' })))
    expect(container.querySelector('canvas')!.dataset.petState).toBe('failed')
    expect(container.querySelector('[data-pet-bubble="failed"]')!.textContent).toMatch(
      /hit a snag|that broke|oof|snagged/
    )
  })

  it('the unread marker opens the app; shift-click goes back in; a double click toggles the app', async () => {
    const { container } = render(<PetOverlayApp />)
    act(() => push!(payload({ unread: true })))
    await vi.waitFor(() => expect(container.querySelector('[data-pet-unread]')).not.toBeNull())

    fireEvent.click(container.querySelector('[data-pet-unread]')!)
    expect(api.control).toHaveBeenCalledWith({ type: 'open-app' })

    const host = container.querySelector('canvas')!.parentElement!.parentElement!
    fireEvent.pointerDown(host, { button: 0, screenX: 10, screenY: 10 })
    fireEvent.pointerUp(host, { screenX: 10, screenY: 10, shiftKey: true })
    expect(api.control).toHaveBeenCalledWith({ type: 'pop-in' })

    fireEvent.pointerDown(host, { button: 0, screenX: 10, screenY: 10 })
    fireEvent.pointerUp(host, { screenX: 10, screenY: 10 })
    fireEvent.pointerDown(host, { button: 0, screenX: 10, screenY: 10 })
    fireEvent.pointerUp(host, { screenX: 10, screenY: 10 })
    expect(api.control).toHaveBeenCalledWith({ type: 'toggle-app' })
  })
})

describe('the popped-out pet is click-through but for its own pixels (gate P15)', () => {
  it('transparent: the desktop gets the click; opaque: the pet does — read from a willReadFrequently canvas', async () => {
    const { container } = render(<PetOverlayApp />)
    act(() => push!(payload()))
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())
    const canvas = container.querySelector('canvas')!
    canvas.getBoundingClientRect = () => ({ bottom: 69, height: 69, left: 0, right: 43, top: 0, width: 43 }) as DOMRect
    const elementFromPoint = vi.fn(() => canvas)
    window.document.elementFromPoint = elementFromPoint as never

    expect(
      getContextCalls.some(args => (args[1] as { willReadFrequently?: boolean } | undefined)?.willReadFrequently)
    ).toBe(true)

    alpha = 255
    fireEvent.mouseMove(window, { clientX: 20, clientY: 30 })
    expect(api.setIgnoreMouse).toHaveBeenLastCalledWith(false)
    alpha = 0
    fireEvent.mouseMove(window, { clientX: 21, clientY: 30 })
    expect(api.setIgnoreMouse).toHaveBeenLastCalledWith(true)
    alpha = 82 // the shadow
    fireEvent.mouseMove(window, { clientX: 22, clientY: 30 })
    expect(api.setIgnoreMouse).toHaveBeenLastCalledWith(true)
    expect(api.setIgnoreMouse).toHaveBeenCalledTimes(2)
  })
})

describe('the prompt box of the popped-out pet (gate P7)', () => {
  async function openBox(locale = 'en') {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const view = render(<PetOverlayApp />)
    act(() => push!(payload({ locale })))
    await vi.waitFor(() => expect(view.container.querySelector('canvas')).not.toBeNull())
    const host = view.container.querySelector('canvas')!.parentElement!.parentElement!
    fireEvent.pointerDown(host, { button: 0, screenX: 10, screenY: 10 })
    fireEvent.pointerUp(host, { screenX: 10, screenY: 10 })
    act(() => {
      vi.advanceTimersByTime(260)
    })

    return { ...view, box: () => view.container.querySelector<HTMLInputElement>('[data-pet-prompt]') }
  }

  afterEach(() => vi.useRealTimers())

  it('a click waves and opens the box (keyboard on); Enter sends a trimmed message; sent: the box clears and closes', async () => {
    const { box, container } = await openBox()
    expect(container.querySelector('canvas')!.dataset.petState).toBe('wave')
    expect(box()).not.toBeNull()
    expect(box()!.placeholder).toBe('Message…')
    expect(box()!.getAttribute('aria-label')).toBe('Message the current session')
    expect(box()!.maxLength).toBe(64_000)
    expect(api.setFocusable).toHaveBeenLastCalledWith(true)
    expect(api.setIgnoreMouse).toHaveBeenLastCalledWith(false)

    fireEvent.change(box()!, { target: { value: '  draft the release notes ' } })
    fireEvent.keyDown(box()!, { key: 'Enter' })
    expect(api.control).toHaveBeenLastCalledWith({ id: 1, text: 'draft the release notes', type: 'submit' })
    // Until the app answers, the text stays (read-only) and a second Enter sends nothing.
    expect(box()!.value).toBe('  draft the release notes ')
    expect(box()!.readOnly).toBe(true)
    fireEvent.keyDown(box()!, { key: 'Enter' })
    expect(api.control.mock.calls.filter(([c]) => (c as { type: string }).type === 'submit')).toHaveLength(1)

    act(() => answer!({ id: 1, outcome: 'sent' }))
    expect(box()).toBeNull()
    expect(api.setFocusable).toHaveBeenLastCalledWith(false)
  })

  it('queued (the session is busy): the box clears and closes too', async () => {
    const { box } = await openBox()
    fireEvent.change(box()!, { target: { value: 'and the changelog' } })
    fireEvent.keyDown(box()!, { key: 'Enter' })
    act(() => answer!({ id: 1, outcome: 'queued' }))
    expect(box()).toBeNull()

    // Reopened: empty.
    const host = window.document.querySelector('canvas')!.parentElement!.parentElement!
    fireEvent.pointerDown(host, { button: 0, screenX: 10, screenY: 10 })
    fireEvent.pointerUp(host, { screenX: 10, screenY: 10 })
    act(() => {
      vi.advanceTimersByTime(260)
    })
    expect(box()!.value).toBe('')
  })

  it('refused: the text stays, editable, with one line saying why (5 languages); typing clears the line', async () => {
    const { box, container } = await openBox()
    const note = () => container.querySelector('[data-pet-prompt-note]')
    fireEvent.change(box()!, { target: { value: '/yolo' } })
    fireEvent.keyDown(box()!, { key: 'Enter' })
    expect(note()).toBeNull()

    // An answer to some other message is not this one's.
    act(() => answer!({ id: 99, outcome: 'sent' }))
    expect(box()!.value).toBe('/yolo')

    act(() => answer!({ id: 1, outcome: 'refused', reason: 'command' }))
    expect(box()).not.toBeNull()
    expect(box()!.value).toBe('/yolo')
    expect(box()!.readOnly).toBe(false)
    expect(note()!.textContent).toBe('Commands go in the composer')

    fireEvent.change(box()!, { target: { value: 'what does yolo do?' } })
    expect(note()).toBeNull()
    fireEvent.keyDown(box()!, { key: 'Enter' })
    expect(api.control).toHaveBeenLastCalledWith({ id: 2, text: 'what does yolo do?', type: 'submit' })
    act(() => answer!({ id: 2, outcome: 'refused', reason: 'no-session' }))
    expect(note()!.textContent).toBe('Open a chat first')
    expect(box()!.value).toBe('what does yolo do?')
  })

  it('R4-F2: maybe sent (the app went away after handing it on): text kept, writable, "check the chat", no resend', async () => {
    const { box, container } = await openBox()
    const note = () => container.querySelector('[data-pet-prompt-note]')
    const submits = () => api.control.mock.calls.filter(([c]) => (c as { type: string }).type === 'submit')
    fireEvent.change(box()!, { target: { value: 'deploy staging' } })
    fireEvent.keyDown(box()!, { key: 'Enter' })

    act(() => answer!({ id: 1, outcome: 'unknown' }))
    expect([box()!.value, box()!.readOnly]).toEqual(['deploy staging', false])
    expect(note()!.textContent).toBe('Maybe sent — check the chat')
    // Never retried on its own: one submit, even long after.
    act(() => {
      vi.advanceTimersByTime(60 * 60_000)
    })
    expect(submits()).toHaveLength(1)
    expect(note()!.textContent).toBe('Maybe sent — check the chat')
  })

  // Ruling 69 (owner, 2026-10-25, supersedes 61 and 59's two-language reading): the app ships in ENGLISH ONLY, so the
  // locale the main window pushes never changes the pet's words — whatever it is, the popped-out window reads English.
  // The late-"unknown" half of this row is untouched: it must still land on the same text instead of clearing it.
  it('ruling 69: the maybe-sent line is English whatever locale is pushed, and a late "unknown" never clears the text', async () => {
    for (const [locale, line] of [
      ['pt-PT', 'Maybe sent — check the chat'],
      ['pt-BR', 'Maybe sent — check the chat']
    ] as const) {
      const { box, container, unmount } = await openBox(locale)
      fireEvent.change(box()!, { target: { value: 'hi' } })
      fireEvent.keyDown(box()!, { key: 'Enter' })
      // The box stopped waiting (closed); the late answer still lands on the same text, as a note — not a clear.
      fireEvent.keyDown(box()!, { key: 'Escape' })
      const host = container.querySelector('canvas')!.parentElement!.parentElement!
      fireEvent.pointerDown(host, { button: 0, screenX: 10, screenY: 10 })
      fireEvent.pointerUp(host, { screenX: 10, screenY: 10 })
      act(() => {
        vi.advanceTimersByTime(260)
      })
      act(() => answer!({ id: 1, outcome: 'unknown' }))
      expect(box()!.value, locale).toBe('hi')
      expect(container.querySelector('[data-pet-prompt-note]')!.textContent, locale).toBe(line)
      unmount()
      vi.useRealTimers()
    }
  })

  // Ruling 69: a pushed pt-PT is clamped to the one shipped language before the window picks any words.
  it('ruling 69: the refusal line is English even when the app pushes another locale', async () => {
    const { box, container } = await openBox('pt-PT')
    fireEvent.change(box()!, { target: { value: 'hi' } })
    fireEvent.keyDown(box()!, { key: 'Enter' })
    act(() => answer!({ id: 1, outcome: 'refused', reason: 'not-sent' }))
    expect(container.querySelector('[data-pet-prompt-note]')!.textContent).toBe('Not sent — try again')
  })

  it('empty or whitespace only: refused, nothing sent, the box stays; Escape closes it', async () => {
    const { box } = await openBox()
    api.control.mockClear()
    fireEvent.keyDown(box()!, { key: 'Enter' })
    fireEvent.change(box()!, { target: { value: '   \t ' } })
    fireEvent.keyDown(box()!, { key: 'Enter' })
    expect(api.control).not.toHaveBeenCalled()
    expect(box()).not.toBeNull()

    fireEvent.keyDown(box()!, { key: 'Escape' })
    expect(box()).toBeNull()
    expect(api.control).not.toHaveBeenCalled()
    expect(api.setFocusable).toHaveBeenLastCalledWith(false)
  })

  it('typing in the box is not a drag of the pet; a click beside the pet closes the box', async () => {
    const { box, container } = await openBox()
    api.setBounds.mockClear()
    api.control.mockClear()
    fireEvent.pointerDown(box()!, { button: 0, screenX: 10, screenY: 10 })
    fireEvent.pointerMove(box()!, { screenX: 40, screenY: 40 })
    fireEvent.pointerUp(box()!, { screenX: 40, screenY: 40 })
    expect(api.setBounds).not.toHaveBeenCalled()
    expect(api.control).not.toHaveBeenCalled()
    expect(box()).not.toBeNull()

    fireEvent.pointerDown(container.firstElementChild!)
    expect(box()).toBeNull()
  })

  it('an input method composing (an IME language): Enter commits the composition — nothing is sent, the box stays (n1)', async () => {
    const { box } = await openBox('pt-PT')
    fireEvent.change(box()!, { target: { value: 'にほんご' } })
    fireEvent.keyDown(box()!, { isComposing: true, key: 'Enter' })
    fireEvent.keyDown(box()!, { isComposing: true, key: 'Escape' })
    expect(api.control.mock.calls.filter(([c]) => (c as { type: string }).type === 'submit')).toHaveLength(0)
    expect(box()!.value).toBe('にほんご')

    // The composition committed: the next Enter sends the whole message.
    fireEvent.keyDown(box()!, { key: 'Enter' })
    expect(api.control).toHaveBeenLastCalledWith({ id: 1, text: 'にほんご', type: 'submit' })
  })

  it('the window loses the focus (another app): the box closes, back to a click-through, non-activating panel (n2)', async () => {
    const { box, container } = await openBox()
    fireEvent.change(box()!, { target: { value: 'half a thought' } })
    expect(api.setIgnoreMouse).toHaveBeenLastCalledWith(false)

    fireEvent.blur(window)
    expect(box()).toBeNull()
    expect(api.setFocusable).toHaveBeenLastCalledWith(false)
    // At once: no mouse move needed to stop eating the desktop's clicks.
    expect(api.setIgnoreMouse).toHaveBeenLastCalledWith(true)
    // The pet's own pixels still take the mouse when the pointer comes back over them.
    expect(container.querySelector('canvas')).not.toBeNull()

    // Reopened: the text was kept. A blur with the box closed changes nothing.
    const host = container.querySelector('canvas')!.parentElement!.parentElement!
    fireEvent.pointerDown(host, { button: 0, screenX: 10, screenY: 10 })
    fireEvent.pointerUp(host, { screenX: 10, screenY: 10 })
    act(() => {
      vi.advanceTimersByTime(260)
    })
    expect(box()!.value).toBe('half a thought')
    fireEvent.keyDown(box()!, { key: 'Escape' })
    const calls = api.setFocusable.mock.calls.length
    fireEvent.blur(window)
    expect(api.setFocusable).toHaveBeenCalledTimes(calls)
  })

  // Ruling 69: the pushed locale is normalized, and every language normalizes to the one that ships.
  it('ruling 69: the box speaks English whatever locale the app pushes', async () => {
    const { box } = await openBox('pt-PT')
    expect(box()!.placeholder).toBe('Message…')
  })
})

describe('the prompt box never waits forever on an answer (R3b n-A, gate P7)', () => {
  async function openBox() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const view = render(<PetOverlayApp />)
    act(() => push!(payload()))
    await vi.waitFor(() => expect(view.container.querySelector('canvas')).not.toBeNull())
    const host = view.container.querySelector('canvas')!.parentElement!.parentElement!

    const click = () => {
      fireEvent.pointerDown(host, { button: 0, screenX: 10, screenY: 10 })
      fireEvent.pointerUp(host, { screenX: 10, screenY: 10 })
      act(() => {
        vi.advanceTimersByTime(260)
      })
    }

    click()

    return {
      ...view,
      box: () => view.container.querySelector<HTMLInputElement>('[data-pet-prompt]'),
      click,
      note: () => view.container.querySelector('[data-pet-prompt-note]'),
      submits: () => api.control.mock.calls.filter(([c]) => (c as { type: string }).type === 'submit')
    }
  }

  afterEach(() => vi.useRealTimers())

  it('the box closes with no answer (Escape, blur, a click beside it): reopened, the text is there and writable', async () => {
    const { box, click, container, submits } = await openBox()
    fireEvent.change(box()!, { target: { value: 'hello' } })
    fireEvent.keyDown(box()!, { key: 'Enter' })
    expect(box()!.readOnly).toBe(true)

    fireEvent.keyDown(box()!, { key: 'Escape' })
    expect(box()).toBeNull()
    click()
    expect(box()!.value).toBe('hello')
    expect(box()!.readOnly).toBe(false)

    // Writable means sendable: Enter sends it again, under a new id.
    fireEvent.keyDown(box()!, { key: 'Enter' })
    expect(submits()).toHaveLength(2)
    expect(api.control).toHaveBeenLastCalledWith({ id: 2, text: 'hello', type: 'submit' })

    // The same through a blur and through a click beside the pet.
    act(() => window.dispatchEvent(new Event('blur')))
    click()
    expect(box()!.readOnly).toBe(false)
    fireEvent.keyDown(box()!, { key: 'Enter' })
    fireEvent.pointerDown(container.firstElementChild!)
    click()
    expect([box()!.value, box()!.readOnly]).toEqual(['hello', false])
  })

  it('a slow acknowledgement is not a failure; past the composer\'s own submit ceiling: writable, text kept, "not sent"', async () => {
    const { box, note } = await openBox()
    fireEvent.change(box()!, { target: { value: 'still there?' } })
    fireEvent.keyDown(box()!, { key: 'Enter' })

    // A long turn can take minutes to be acknowledged: while the composer's send may still land, no "not sent" line.
    act(() => {
      vi.advanceTimersByTime(PROMPT_SUBMIT_REQUEST_TIMEOUT_MS)
    })
    expect(box()!.readOnly).toBe(true)
    expect(note()).toBeNull()

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(box()).not.toBeNull()
    expect([box()!.value, box()!.readOnly]).toEqual(['still there?', false])
    expect(note()!.textContent).toBe('Not sent — try again')
  })

  it('an answer before the deadline cancels it: no "not sent" line afterwards', async () => {
    const { box, click, note } = await openBox()
    fireEvent.change(box()!, { target: { value: 'quick' } })
    fireEvent.keyDown(box()!, { key: 'Enter' })
    act(() => answer!({ id: 1, outcome: 'refused', reason: 'command' }))
    act(() => {
      vi.advanceTimersByTime(40 * 60_000)
    })
    expect(note()!.textContent).toBe('Commands go in the composer')

    fireEvent.change(box()!, { target: { value: 'quick two' } })
    fireEvent.keyDown(box()!, { key: 'Enter' })
    act(() => answer!({ id: 2, outcome: 'sent' }))
    act(() => {
      vi.advanceTimersByTime(40 * 60_000)
    })
    click()
    expect([box()!.value, note()]).toEqual(['', null])
  })

  it('a late answer still counts while the box holds the text that went out — never over newer typing', async () => {
    const { box, click } = await openBox()
    fireEvent.change(box()!, { target: { value: 'late one' } })
    fireEvent.keyDown(box()!, { key: 'Enter' })
    act(() => {
      vi.advanceTimersByTime(31 * 60_000)
    })
    expect(box()!.readOnly).toBe(false)

    // It did land after all: the text clears and the box closes, as on time.
    act(() => answer!({ id: 1, outcome: 'sent' }))
    expect(box()).toBeNull()
    click()
    expect(box()!.value).toBe('')

    // Closed while waiting, then typed over: the late answer leaves the new words alone.
    fireEvent.change(box()!, { target: { value: 'first' } })
    fireEvent.keyDown(box()!, { key: 'Enter' })
    fireEvent.keyDown(box()!, { key: 'Escape' })
    click()
    fireEvent.change(box()!, { target: { value: 'second thoughts' } })
    act(() => answer!({ id: 2, outcome: 'queued' }))
    expect(box()!.value).toBe('second thoughts')
  })
})
