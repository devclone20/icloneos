import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { en } from '@/i18n/en'
import { $notifications, clearNotifications } from '@/store/notifications'
import { $screenRecord, $screenRecordBusy, formatElapsed, IDLE_SCREEN_RECORD, type ScreenRecordBridge } from '@/store/screen-record'

const register = vi.fn((_contribution: unknown) => () => {})

// Tip's own imports read the real registry; only what this tool publishes is caught.
vi.mock('@/contrib/registry', async importOriginal => {
  const actual = await importOriginal<{ registry: object }>()

  return {
    ...actual,
    registry: Object.assign(Object.create(actual.registry), { register: (contribution: unknown) => register(contribution) })
  }
})

const { registerScreenRecordTool, ScreenRecordBadge, toggleScreenRecord } = await import('./screen-record-tool')

const copy = en.desktop.home.tools
const start = vi.fn<ScreenRecordBridge['start']>()
const stop = vi.fn<ScreenRecordBridge['stop']>()

const running = { ...IDLE_SCREEN_RECORD, framesKept: 1, recording: true, startedAt: Date.now() }

interface Published {
  data: { active: boolean; id: string; keepOverModals?: boolean; label: string; onSelect: () => void; title: string }
}

const tool = () => (register.mock.calls.at(-1)![0] as Published).data
const lastNote = () => $notifications.get()[0]

window.hermesDesktop = {
  ...window.hermesDesktop,
  screenRecord: {
    discard: vi.fn(),
    onState: () => () => undefined,
    start,
    status: async () => $screenRecord.get(),
    stop,
    take: async () => null
  }
} as typeof window.hermesDesktop

registerScreenRecordTool()

beforeEach(() => {
  start.mockReset()
  stop.mockReset()
  register.mockClear()
  clearNotifications()
  window.localStorage.clear()
  window.location.hash = ''
  $screenRecordBusy.set(false)
  $screenRecord.set({ ...IDLE_SCREEN_RECORD, framesKept: -1 })
  $screenRecord.set(IDLE_SCREEN_RECORD)
})

test('AI record is its own tool and its words say screen', () => {
  expect(tool().id).toBe('iclone-ai-record')
  expect(tool().label).toMatch(/^AI record/)
  expect(tool().label).toMatch(/record the screen/i)
  expect(tool().active).toBe(false)
})

test('one click starts, one click stops, and the state is unmistakable while it runs', async () => {
  start.mockResolvedValue({ ok: true, status: running })
  stop.mockResolvedValue(IDLE_SCREEN_RECORD)

  tool().onSelect()
  await vi.waitFor(() => expect(tool().active).toBe(true))
  expect(start).toHaveBeenCalledTimes(1)
  expect(tool().label).toMatch(/click to stop/i)
  expect(tool().keepOverModals).toBe(true)

  await toggleScreenRecord()
  expect(stop).toHaveBeenCalledTimes(1)
  expect(tool().active).toBe(false)
})

test('a click while one is on its way does nothing', async () => {
  start.mockReturnValue(new Promise(() => undefined))
  void toggleScreenRecord()
  await toggleScreenRecord()
  expect(start).toHaveBeenCalledTimes(1)
  $screenRecordBusy.set(false)
})

test('consent off: the button says so and offers Settings › Privacy', async () => {
  start.mockResolvedValue({ ok: false, reason: 'consent' })
  await toggleScreenRecord()

  expect(lastNote().message).toBe(copy.screenRecordConsentOff)
  lastNote().action!.onClick()
  expect(window.location.hash).toBe('#/settings?tab=privacy')

  $screenRecord.set({ ...IDLE_SCREEN_RECORD, consentOn: false })
  expect(tool().label).toBe(copy.screenRecordConsentOff)
})

test('grant missing: a plain line that takes the user to the Setup row', async () => {
  start.mockResolvedValue({ ok: false, reason: 'needs-grant' })
  await toggleScreenRecord()

  expect(lastNote().message).toMatch(/macOS has not allowed/)
  lastNote().action!.onClick()
  expect(window.location.hash).toBe('#/settings?tab=setup')
})

test('a grant that needs a restart says so, in the words of the macOS note', async () => {
  start.mockResolvedValue({ ok: false, reason: 'needs-restart' })
  await toggleScreenRecord()

  expect(lastNote().message).toMatch(/only when the app starts again/)
})

test('blank frames are said, and are not a recording', async () => {
  start.mockResolvedValue({ ok: false, reason: 'blank' })
  await toggleScreenRecord()

  expect(lastNote().message).toMatch(/came back blank/)
  expect(tool().active).toBe(false)
})

test('first use: one note that names the whole screen, secrets and sending, once', async () => {
  start.mockResolvedValue({ ok: true, status: running })
  stop.mockResolvedValue(IDLE_SCREEN_RECORD)

  await toggleScreenRecord()
  expect(lastNote().message).toMatch(/whole screen, including any secrets/)
  expect(lastNote().message).toMatch(/only when you send/)

  await toggleScreenRecord()
  clearNotifications()
  await toggleScreenRecord()
  expect($notifications.get()).toHaveLength(0)
})

test('elapsed time reads as a clock', () => {
  expect(formatElapsed(0)).toBe('0:00')
  expect(formatElapsed(7_400)).toBe('0:07')
  expect(formatElapsed(299_000)).toBe('4:59')
})

test('the badge says what it does in the app tooltip, the same words, and no native title', async () => {
  $screenRecord.set(running)
  render(<ScreenRecordBadge />)

  const button = screen.getByRole('button', { name: copy.screenRecordActive })

  expect(button.getAttribute('title')).toBeNull()
  fireEvent.pointerMove(button)
  expect((await screen.findByRole('tooltip')).textContent).toContain(copy.screenRecordActive)
})

test('the web build has no recorder: the button is not offered', async () => {
  const desktop = window.hermesDesktop

  window.hermesDesktop = { ...desktop, screenRecord: undefined } as typeof window.hermesDesktop
  register.mockClear()
  vi.resetModules()

  const fresh = await import('./screen-record-tool')

  fresh.registerScreenRecordTool()
  expect(register).not.toHaveBeenCalled()
  window.hermesDesktop = desktop
})

test('G20: a start that works takes the earlier refusal down', async () => {
  start.mockResolvedValueOnce({ ok: false, reason: 'blank' })
  await toggleScreenRecord()
  expect(lastNote()?.id).toBe('screen-record-refused')

  start.mockResolvedValueOnce({ ok: true, status: running })
  await toggleScreenRecord()

  expect($notifications.get().some(note => note.id === 'screen-record-refused')).toBe(false)
  $screenRecord.set(IDLE_SCREEN_RECORD)
})
