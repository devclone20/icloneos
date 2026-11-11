import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { en } from '@/i18n/en'
import { $notifications, clearNotifications } from '@/store/notifications'
import { $screenRecord, IDLE_SCREEN_RECORD, type ScreenRecordResult, timelineAfterRemoval } from '@/store/screen-record'

const getGlobalModelInfo = vi.fn()

vi.mock('@/api/models', () => ({ getGlobalModelInfo: () => getGlobalModelInfo() }))

const { useScreenFrameDelivery } = await import('./use-screen-frame-delivery')

const copy = en.desktop.home.tools
const take = vi.fn<() => Promise<null | ScreenRecordResult>>()

const result: ScreenRecordResult = {
  blankDropped: 0,
  durationMs: 3000,
  folder: '/f',
  frames: [
    { path: '/f/screen-t000s.png', tMs: 0 },
    { path: '/f/screen-t003s.png', tMs: 3000 }
  ],
  hitTimeLimit: false,
  thinnedFrom: 2,
  timeline: 'Screen recording, 3 s. Frame times: 1 t+0 s, 2 t+3 s.'
}

window.hermesDesktop = {
  ...window.hermesDesktop,
  screenRecord: {
    discard: vi.fn(),
    onState: () => () => undefined,
    start: vi.fn(),
    status: async () => $screenRecord.get(),
    stop: vi.fn(),
    take
  }
} as typeof window.hermesDesktop

const attachImagePath = vi.fn(async () => true)
const addText = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  clearNotifications()
  take.mockResolvedValue(result)
  getGlobalModelInfo.mockResolvedValue({ capabilities: { supports_vision: true }, model: 'seeing-model' })
  $screenRecord.set(IDLE_SCREEN_RECORD)
})

const hook = (chatOpen: boolean, enabled = true) =>
  renderHook(props => useScreenFrameDelivery({ addText, attachImagePath, ...props }), {
    initialProps: { chatOpen, enabled }
  })

test('on stop the frames go into the message in order, through the image path, with the timeline', async () => {
  hook(true)
  $screenRecord.set({ ...IDLE_SCREEN_RECORD, pending: true })

  await waitFor(() => expect(addText).toHaveBeenCalledWith(result.timeline))
  expect(attachImagePath.mock.calls.map(c => (c as unknown[])[0])).toEqual(result.frames.map(f => f.path))
  expect(take).toHaveBeenCalledTimes(1)
  expect($notifications.get()).toHaveLength(0)
})

test('B5: a delivered recording is known, so taking a frame off rewrites its text', async () => {
  hook(true)
  $screenRecord.set({ ...IDLE_SCREEN_RECORD, pending: true })

  await waitFor(() => expect(addText).toHaveBeenCalledWith(result.timeline))
  expect(timelineAfterRemoval('/f/screen-t000s.png')?.from).toBe(result.timeline)
})

test('minor 5: a chip taken off while later frames still attach rewrites the text, which is already there', async () => {
  const seen: unknown[] = []

  attachImagePath.mockImplementationOnce(async () => true).mockImplementationOnce(async () => {
    seen.push(addText.mock.calls.length, timelineAfterRemoval('/f/screen-t000s.png')?.from)

    return true
  })

  hook(true)
  $screenRecord.set({ ...IDLE_SCREEN_RECORD, pending: true })

  await waitFor(() => expect(attachImagePath).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(seen).toEqual([1, result.timeline]))
  expect(addText).toHaveBeenCalledTimes(1)
  expect(addText).toHaveBeenCalledWith(result.timeline)
})

test('no chat open: the frames stay in main, one plain line, and they attach when a chat opens', async () => {
  const view = hook(false)

  $screenRecord.set({ ...IDLE_SCREEN_RECORD, pending: true })

  await waitFor(() => expect($notifications.get()[0]?.message).toBe(copy.screenRecordWaiting))
  expect(take).not.toHaveBeenCalled()
  expect(attachImagePath).not.toHaveBeenCalled()

  view.rerender({ chatOpen: true, enabled: true })
  await waitFor(() => expect(addText).toHaveBeenCalled())
  expect(attachImagePath).toHaveBeenCalledTimes(2)
})

test('a window that does not own the composer leaves the frames for the one that does', async () => {
  hook(true, false)
  $screenRecord.set({ ...IDLE_SCREEN_RECORD, pending: true })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(take).not.toHaveBeenCalled()
})

test('a model that takes no images: said plainly, and the frames stay attached', async () => {
  getGlobalModelInfo.mockResolvedValue({ capabilities: { supports_vision: false }, model: 'blind-model' })
  hook(true)
  $screenRecord.set({ ...IDLE_SCREEN_RECORD, pending: true })

  await waitFor(() => expect($notifications.get()[0]?.message).toMatch(/blind-model takes no images/))
  expect(attachImagePath).toHaveBeenCalledTimes(2)
  expect($notifications.get()[0]?.message).toMatch(/stay attached/)
})

test('no model set up: said plainly, frames kept', async () => {
  getGlobalModelInfo.mockResolvedValue({ capabilities: {}, model: '' })
  hook(true)
  $screenRecord.set({ ...IDLE_SCREEN_RECORD, pending: true })

  await waitFor(() => expect($notifications.get()[0]?.message).toMatch(/No model is set up/))
  expect(attachImagePath).toHaveBeenCalledTimes(2)
})

test('a recording that ended with nothing says why', async () => {
  hook(true)
  $screenRecord.set({ ...IDLE_SCREEN_RECORD, ended: 'blank' })

  await waitFor(() => expect($notifications.get()[0]?.message).toMatch(/came back blank/))
})
