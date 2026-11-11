import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { ar } from '@/i18n/ar'
import { en } from '@/i18n/en'
import { ja } from '@/i18n/ja'
import { ptPt } from '@/i18n/pt-PT'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-hant'

const getHermesConfigRecord = vi.fn()
const saveHermesConfig = vi.fn()
const restartBackend = vi.fn()
const register = vi.fn((_contribution: unknown) => () => {})
const gatewayRequest = vi.fn()
const notify = vi.fn()
const dismissNotification = vi.fn()

vi.mock('@/store/gateway', () => ({
  $gateway: { get: () => ({ request: (...args: unknown[]) => gatewayRequest(...args) }) }
}))

vi.mock('@/store/notifications', () => ({
  dismissNotification: (...args: unknown[]) => dismissNotification(...args),
  notify: (...args: unknown[]) => notify(...args)
}))

vi.mock('@/api/config', () => ({
  getHermesConfigRecord: (...args: unknown[]) => getHermesConfigRecord(...args),
  saveHermesConfig: (...args: unknown[]) => saveHermesConfig(...args)
}))

vi.mock('@/contrib/registry', () => ({
  registry: { register: (contribution: unknown) => register(contribution) }
}))

const {
  $browserHeaded,
  $browserRecording,
  pollBrowserRecording,
  refreshBrowserHeaded,
  refreshBrowserRecording,
  RECORD_POLL_CAPTURING_MS,
  RECORD_STOP_RPC_MS,
  recordPollDue,
  registerIcloneBrowserTool
} = await import('./browser-tool')

// The module only publishes on state change, and it only subscribes once the
// wiring registers it — exactly as it does in the app.
registerIcloneBrowserTool()

interface Published {
  area: string
  data: { active: boolean; busy?: boolean; disabled?: boolean; label: string; onSelect: () => void }
  id: string
  order: number
}

/** The most recent publish of one tool — two share the mock, so address by id. */
function published(id = 'iclone-browser-headed'): Published | undefined {
  return [...register.mock.calls]
    .reverse()
    .map(call => call[0] as Published)
    .find(contribution => contribution?.id === id)
}

function click(id?: string) {
  published(id)!.data.onSelect()
}

/** Let the toggle's awaits settle. */
async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  getHermesConfigRecord.mockReset()
  saveHermesConfig.mockReset()
  restartBackend.mockReset()
  register.mockClear()

  saveHermesConfig.mockResolvedValue({ ok: true })
  restartBackend.mockResolvedValue({ ok: true })
  gatewayRequest.mockReset()
  gatewayRequest.mockResolvedValue({ capturing: [], notices: [] })
  notify.mockReset()
  dismissNotification.mockReset()
  window.localStorage.clear()
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { restartBackend }

  // Force a publish into the cleared mock: nanostores skips notifying when the
  // value does not actually change, so go through a different state first.
  $browserHeaded.set('off')
  $browserRecording.set('off')
  register.mockClear()
  $browserHeaded.set('unknown')
  $browserRecording.set('unknown')
})

test('it publishes into the titlebar row beside the theme and wallet glyphs', () => {
  const contribution = published()

  expect(contribution?.area).toBe('titleBar.tools.right')
  expect(contribution?.id).toBe('iclone-browser-headed')
  // theme is order 0 (unset), wallet is 1 — this sits after them, not adrift.
  expect(contribution?.order).toBe(2)
})

test('reading a config with headed off shows the hidden-eye state', async () => {
  getHermesConfigRecord.mockResolvedValue({ browser: { headed: false } })

  await refreshBrowserHeaded()

  expect($browserHeaded.get()).toBe('off')
  expect(published()?.data.active).toBe(false)
})

test('a hand-edited YAML string "true" reads as on, the way the agent reads it', async () => {
  // tools/browser_tool.py accepts "true"/"1"/"yes"; the glyph must agree with
  // the agent rather than with JSON's idea of a boolean.
  getHermesConfigRecord.mockResolvedValue({ browser: { headed: 'true' } })

  await refreshBrowserHeaded()

  expect($browserHeaded.get()).toBe('on')
  expect(published()?.data.active).toBe(true)
})

test('a missing browser section is off, not unknown', async () => {
  getHermesConfigRecord.mockResolvedValue({})

  await refreshBrowserHeaded()

  expect($browserHeaded.get()).toBe('off')
})

test('an unreachable backend leaves the glyph unknown rather than claiming a state', async () => {
  getHermesConfigRecord.mockRejectedValue(new Error('ECONNREFUSED'))

  await refreshBrowserHeaded()

  expect($browserHeaded.get()).toBe('unknown')
  expect(published()?.data.label).toMatch(/could not read/i)
})

test('clicking writes the negated value AND restarts the backend', async () => {
  // The restart is the whole point: the agent latches browser.headed once per
  // process, so a write alone would leave it browsing invisibly.
  getHermesConfigRecord.mockResolvedValue({ browser: { headed: false }, model: 'keep-me' })
  $browserHeaded.set('off')

  click()
  await settle()

  expect(saveHermesConfig).toHaveBeenCalledTimes(1)
  expect(saveHermesConfig.mock.calls[0][0]).toMatchObject({ browser: { headed: true }, model: 'keep-me' })
  expect(restartBackend).toHaveBeenCalledTimes(1)
  expect($browserHeaded.get()).toBe('on')
})

test('the write carries the rest of the config back untouched', async () => {
  getHermesConfigRecord.mockResolvedValue({
    browser: { headed: false, inactivity_timeout: 120, use_real_profile: true },
    tools: { enabled: ['a', 'b'] }
  })
  $browserHeaded.set('off')

  click()
  await settle()

  expect(saveHermesConfig.mock.calls[0][0]).toEqual({
    browser: { headed: true, inactivity_timeout: 120, use_real_profile: true },
    tools: { enabled: ['a', 'b'] }
  })
})

test('it re-reads immediately before writing, so it cannot revert a newer edit', async () => {
  // The whole record goes back over the wire. If the toggle wrote from the
  // copy it read at startup, every setting changed since would be reverted.
  getHermesConfigRecord.mockResolvedValue({ browser: { headed: false }, model: 'changed-since-startup' })
  $browserHeaded.set('off')

  click()
  await settle()

  expect(getHermesConfigRecord).toHaveBeenCalled()
  expect(saveHermesConfig.mock.calls[0][0]).toMatchObject({ model: 'changed-since-startup' })
})

test('a failed save leaves the glyph unknown and re-reads, never a guessed state', async () => {
  getHermesConfigRecord.mockResolvedValue({ browser: { headed: false } })
  saveHermesConfig.mockRejectedValue(new Error('403'))
  $browserHeaded.set('off')

  click()
  await settle()

  expect(restartBackend).not.toHaveBeenCalled()
  expect(['unknown', 'off']).toContain($browserHeaded.get())
})

test('clicking while unknown retries the read instead of writing a guess', async () => {
  getHermesConfigRecord.mockResolvedValue({ browser: { headed: true } })
  $browserHeaded.set('unknown')

  click()
  await settle()

  expect(saveHermesConfig).not.toHaveBeenCalled()
  expect($browserHeaded.get()).toBe('on')
})

test('a second click while the first is in flight is ignored', async () => {
  getHermesConfigRecord.mockResolvedValue({ browser: { headed: false } })
  $browserHeaded.set('off')

  click()
  click()
  await settle()

  expect(saveHermesConfig).toHaveBeenCalledTimes(1)
  expect(restartBackend).toHaveBeenCalledTimes(1)
})

test('the working state marks the button busy — never disabled, so it keeps focus — and it cannot be double-fired (U4-p2-06)', async () => {
  getHermesConfigRecord.mockReturnValue(new Promise(() => {}))
  $browserHeaded.set('off')

  click()
  await Promise.resolve()

  expect(published()?.data.busy).toBe(true)
  expect(published()?.data.disabled).toBeUndefined()
})

// ── recording ─────────────────────────────────────────────────────────────

test('the recording tool publishes beside the headed one', () => {
  const contribution = published('iclone-browser-recording')

  expect(contribution?.area).toBe('titleBar.tools.right')
  expect(contribution?.order).toBe(3)
})

test('recording reads its own key, not the headed one', async () => {
  getHermesConfigRecord.mockResolvedValue({ browser: { headed: false, record_sessions: true } })

  await refreshBrowserRecording()

  expect($browserRecording.get()).toBe('on')
  expect(published('iclone-browser-recording')?.data.active).toBe(true)
})

test('toggling recording writes the key and does NOT restart the backend', async () => {
  // The agent re-reads browser.record_sessions at the start of every browser
  // session (tools/browser_tool.py `_maybe_start_recording`), so this lands on
  // the next one. Restarting here would kill a turn in flight for nothing —
  // which is exactly what makes this different from the headed toggle.
  getHermesConfigRecord.mockResolvedValue({ browser: { headed: true, record_sessions: false } })
  $browserRecording.set('off')

  click('iclone-browser-recording')
  await settle()

  expect(saveHermesConfig.mock.calls[0][0]).toMatchObject({ browser: { record_sessions: true } })
  expect(restartBackend).not.toHaveBeenCalled()
  expect($browserRecording.get()).toBe('on')
})

test('toggling recording leaves headed alone, and vice versa', async () => {
  getHermesConfigRecord.mockResolvedValue({ browser: { headed: true, record_sessions: false } })
  $browserRecording.set('off')

  click('iclone-browser-recording')
  await settle()

  expect(saveHermesConfig.mock.calls[0][0]).toMatchObject({ browser: { headed: true, record_sessions: true } })
  expect($browserHeaded.get()).not.toBe('working')
})

test('the off label says where recordings land, so they can be found', () => {
  // A recording nobody can locate is not a recording.
  $browserRecording.set('off')
  expect(published('iclone-browser-recording')?.data.label).toBe(
    'Recording off. Click to ask the agent to record what it does in its browser, as a video in Movies/icloneOS Recordings.'
  )
})

test('neither label promises a file the flag alone cannot produce', () => {
  // browser.record_sessions is honoured automatically only on the built-in
  // browser path. With the Browser-Use CLI installed — which wins — nothing
  // reads it, and the agent honours it from its skill. So the copy asks the
  // agent to record; it does not promise a video.
  for (const state of ['off', 'on'] as const) {
    $browserRecording.set(state)
    const label = published('iclone-browser-recording')!.data.label

    expect(label).not.toMatch(/every session is saved/i)
    expect(label.toLowerCase()).toMatch(/agent to record|records what it does/)
  }
})

test('G20: clicking off stops and saves at once, and the user reads the file name', async () => {
  getHermesConfigRecord.mockResolvedValue({ browser: { record_sessions: true } })
  gatewayRequest.mockResolvedValue({
    capturing: [],
    notices: [{ message: 'Browser video saved: a.webm, in Movies/icloneOS Recordings.', ok: true, seq: 90 }]
  })
  $browserRecording.set('capturing')

  click('iclone-browser-recording')
  await settle()
  await settle()

  expect(saveHermesConfig.mock.calls[0][0]).toMatchObject({ browser: { record_sessions: false } })
  expect(gatewayRequest).toHaveBeenCalledWith('browser.manage', { action: 'record_sync' }, expect.any(Number))
  expect($browserRecording.get()).toBe('off')
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'info', message: 'Browser video saved: a.webm, in Movies/icloneOS Recordings.' })
  )
})

test('B6: while a capture stops the button says it is saving and may take half a minute, and a click waits', async () => {
  let finish: (view: unknown) => void = () => undefined

  getHermesConfigRecord.mockResolvedValue({ browser: { record_sessions: true } })
  gatewayRequest.mockReturnValue(new Promise(resolve => (finish = resolve)))
  $browserRecording.set('capturing')

  click('iclone-browser-recording')
  await settle()

  const words = 'Saving the browser video. This can take about half a minute, and at most a minute.'

  expect(published('iclone-browser-recording')?.data.label).toBe(words)
  expect((published('iclone-browser-recording')?.data as unknown as { title: string }).title).toBe(words)
  expect(published('iclone-browser-recording')?.data.busy).toBe(true)
  expect((published('iclone-browser-recording')?.data as unknown as { keepOverModals: boolean }).keepOverModals).toBe(true)

  await refreshBrowserRecording()
  expect($browserRecording.get()).toBe('saving')

  finish({ capturing: [] })
  await settle()
  await settle()
  expect($browserRecording.get()).toBe('off')
})

test('B6: the same words when Settings turned recording off and the poll stops the capture', async () => {
  let finish: (view: unknown) => void = () => undefined

  gatewayRequest.mockImplementation((_method: string, params: { action: string }) =>
    params.action === 'record_status'
      ? Promise.resolve({ armed: false, capturing: ['s'] })
      : new Promise(resolve => (finish = resolve))
  )
  $browserRecording.set('capturing')

  const polling = pollBrowserRecording()

  await settle()
  await settle()
  expect($browserRecording.get()).toBe('saving')
  expect(published('iclone-browser-recording')?.data.label).toBe('Saving the browser video. This can take about half a minute, and at most a minute.')

  finish({ armed: false, capturing: [] })
  await polling
  expect($browserRecording.get()).toBe('off')
})

const SAVING_WORDS = 'Saving the browser video. This can take about half a minute, and at most a minute.'
const savingNotices = () => notify.mock.calls.filter(([input]) => (input as { message?: string }).message === SAVING_WORDS)

describe('M5: a save that lasts over 2 s says so in a notice, not only in the tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('the button: nothing at 1999 ms, the tooltip words at 2000 ms, gone when the save ends', async () => {
    let finish: (view: unknown) => void = () => undefined

    getHermesConfigRecord.mockResolvedValue({ browser: { record_sessions: true } })
    gatewayRequest.mockReturnValue(new Promise(resolve => (finish = resolve)))
    $browserRecording.set('capturing')

    click('iclone-browser-recording')
    await settle()
    vi.advanceTimersByTime(1999)
    expect(savingNotices()).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(savingNotices()).toHaveLength(1)
    expect(savingNotices()[0][0]).toMatchObject({ durationMs: 0, id: 'browser-record-saving', kind: 'info' })
    expect((published('iclone-browser-recording')?.data as unknown as { title: string }).title).toBe(SAVING_WORDS)

    finish({ capturing: [] })
    await settle()
    await settle()
    expect(dismissNotification).toHaveBeenCalledWith('browser-record-saving')
  })

  test('Settings off, stopped by the poll: the same notice', async () => {
    let finish: (view: unknown) => void = () => undefined

    gatewayRequest.mockImplementation((_method: string, params: { action: string }) =>
      params.action === 'record_status'
        ? Promise.resolve({ armed: false, capturing: ['s'] })
        : new Promise(resolve => (finish = resolve))
    )
    $browserRecording.set('capturing')

    const polling = pollBrowserRecording()

    await settle()
    await settle()
    expect($browserRecording.get()).toBe('saving')
    vi.advanceTimersByTime(2000)
    expect(savingNotices()).toHaveLength(1)

    finish({ armed: false, capturing: [] })
    await polling
    expect(dismissNotification).toHaveBeenCalledWith('browser-record-saving')
  })

  test('a capture stopped before the headed toggle restarts the runtime: the same notice', async () => {
    let finish: (view: unknown) => void = () => undefined

    getHermesConfigRecord.mockResolvedValue({ browser: { headed: false } })
    gatewayRequest.mockImplementation((_method: string, params: { action: string }) =>
      params.action === 'record_status'
        ? Promise.resolve({ armed: true, capturing: ['s'] })
        : new Promise(resolve => (finish = resolve))
    )
    $browserHeaded.set('off')

    click('iclone-browser-headed')
    await settle()
    await settle()
    vi.advanceTimersByTime(2000)
    expect(savingNotices()).toHaveLength(1)

    finish({ armed: true, capturing: [] })
    await settle()
    await settle()
    expect(dismissNotification).toHaveBeenCalledWith('browser-record-saving')
  })

  test('a save over within 2 s says nothing', async () => {
    let finish: (view: unknown) => void = () => undefined

    getHermesConfigRecord.mockResolvedValue({ browser: { record_sessions: true } })
    gatewayRequest.mockReturnValue(new Promise(resolve => (finish = resolve)))
    $browserRecording.set('capturing')

    click('iclone-browser-recording')
    await settle()
    vi.advanceTimersByTime(1000)
    finish({ capturing: [] })
    await settle()
    await settle()
    vi.advanceTimersByTime(5000)
    expect(savingNotices()).toHaveLength(0)
  })
})

test.each([
  ['en', en, 'at most a minute'],
  ['pt-PT', ptPt, 'no máximo, um minuto'],
  ['ar', ar, 'دقيقة واحدة'],
  ['ja', ja, '最大で1分'],
  ['zh', zh, '最多一分钟'],
  ['zh-hant', zhHant, '最多一分鐘']
])('m8: the saving words state the bound the wait really has, one minute (RECORD_STOP_RPC_MS): %s', (_locale, catalogue, bound) => {
  expect(catalogue.desktop.home.tools.recordSaving).toContain(bound)
  expect(RECORD_STOP_RPC_MS).toBe(60_000)
})

test('G20: a failed save is a warning the user reads, once', async () => {
  getHermesConfigRecord.mockResolvedValue({ browser: { record_sessions: true } })
  gatewayRequest.mockResolvedValue({
    capturing: [],
    notices: [{ message: 'The browser video was not saved: no frames.', ok: false, seq: 91 }]
  })
  $browserRecording.set('capturing')

  click('iclone-browser-recording')
  await settle()
  await settle()
  await refreshBrowserRecording()
  await settle()

  expect(notify).toHaveBeenCalledTimes(1)
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'warning', message: 'The browser video was not saved: no frames.' })
  )
})

test('G20: on says armed until a capture runs, then says it is capturing', async () => {
  getHermesConfigRecord.mockResolvedValue({ browser: { record_sessions: false } })
  $browserRecording.set('off')

  click('iclone-browser-recording')
  await settle()
  await settle()

  expect($browserRecording.get()).toBe('on')
  expect(published('iclone-browser-recording')?.data.label).toBe(
    'Recording on, not capturing yet — the agent records what it does in the browser from the next page it opens. Click to turn off.'
  )
  expect(published('iclone-browser-recording')?.data.active).toBe(true)

  getHermesConfigRecord.mockResolvedValue({ browser: { record_sessions: true } })
  gatewayRequest.mockResolvedValue({ capturing: ['a.webm'], notices: [] })
  await refreshBrowserRecording()

  expect($browserRecording.get()).toBe('capturing')
  expect(published('iclone-browser-recording')?.data.label).toBe(
    'Recording the browser now — click to stop and save the video to Movies/icloneOS Recordings.'
  )
  expect(published('iclone-browser-recording')?.data.active).toBe(true)
})

test('G20: a runtime that cannot answer leaves on as armed, never as capturing', async () => {
  getHermesConfigRecord.mockResolvedValue({ browser: { record_sessions: true } })
  gatewayRequest.mockRejectedValue(new Error('unknown action'))
  $browserRecording.set('unknown')

  await refreshBrowserRecording()

  expect($browserRecording.get()).toBe('on')
})

// G21: the button follows the capture list and the runtime's own word, not the config alone.

const recording = 'iclone-browser-recording'

function answer(view: Record<string, unknown>) {
  gatewayRequest.mockResolvedValue({ capturing: [], notices: [], ...view })
}

test('G21 P5: a capture with the setting off shows capturing, and one click stops it without arming', async () => {
  getHermesConfigRecord.mockResolvedValue({ browser: { record_sessions: false } })
  answer({ armed: false, capturing: ['a.webm'] })
  await refreshBrowserRecording()
  expect($browserRecording.get()).toBe('capturing')

  click(recording)
  await settle()
  await settle()

  expect(saveHermesConfig).not.toHaveBeenCalled()
  expect(gatewayRequest).toHaveBeenCalledWith('browser.manage', { action: 'record_sync' }, expect.any(Number))
})

test('G21 P5: a failed RPC never shows off, whatever the config says', async () => {
  getHermesConfigRecord.mockResolvedValue({ browser: { record_sessions: false } })
  gatewayRequest.mockRejectedValue(new Error('gone'))
  await refreshBrowserRecording()
  expect($browserRecording.get()).toBe('unknown')
})

test('G21 P5: the poll runs in every state and comes back from unknown', async () => {
  answer({ armed: false })
  $browserRecording.set('unknown')
  await pollBrowserRecording()
  expect($browserRecording.get()).toBe('off')
})

test('G21 P5: off in Settings during a capture stops it on the next poll, with no click on the button', async () => {
  answer({ armed: false, capturing: ['a.webm'] })
  $browserRecording.set('capturing')
  await pollBrowserRecording()
  await settle()
  expect(gatewayRequest).toHaveBeenCalledWith('browser.manage', { action: 'record_sync' }, expect.any(Number))
})

test('G21 P5: with the setting on a capture is not stopped by the poll', async () => {
  answer({ armed: true, capturing: ['a.webm'] })
  await pollBrowserRecording()
  await settle()
  expect($browserRecording.get()).toBe('capturing')
  expect(gatewayRequest).not.toHaveBeenCalledWith('browser.manage', { action: 'record_sync' }, expect.any(Number))
})

test('G21 P3: a restarted runtime counts from 1 again and its notices are still said', async () => {
  answer({ armed: true, boot: 'one', notices: [{ message: 'first', ok: true, seq: 7 }] })
  await pollBrowserRecording()
  expect(notify).toHaveBeenCalledTimes(1)

  answer({ armed: true, boot: 'two', notices: [{ message: 'after the restart', ok: false, seq: 1 }] })
  await pollBrowserRecording()
  expect(notify).toHaveBeenCalledTimes(2)
  expect(notify.mock.calls[1][0].message).toBe('after the restart')
})

test('G21 live row 5: while a capture runs every tick polls, so Settings off stops it inside 2 s; idle it stays every 2 s', () => {
  expect(RECORD_POLL_CAPTURING_MS).toBeLessThanOrEqual(500)
  expect(recordPollDue('capturing', RECORD_POLL_CAPTURING_MS)).toBe(true)
  expect(recordPollDue('off', RECORD_POLL_CAPTURING_MS)).toBe(false)
  expect(recordPollDue('on', 1_500)).toBe(false)
  expect(recordPollDue('on', 2_000)).toBe(true)
})

test('G21 M4: switching between two profiles, each with its own runtime, says nothing twice', async () => {
  answer({ armed: true, boot: 'one', notices: [{ message: 'in one', ok: true, seq: 1 }] })
  await pollBrowserRecording()
  answer({ armed: true, boot: 'two', notices: [{ message: 'in two', ok: true, seq: 1 }] })
  await pollBrowserRecording()
  answer({ armed: true, boot: 'one', notices: [{ message: 'in one', ok: true, seq: 1 }] })
  await pollBrowserRecording()
  answer({ armed: true, boot: 'two', notices: [{ message: 'in two', ok: true, seq: 1 }, { message: 'new in two', ok: true, seq: 2 }] })
  await pollBrowserRecording()
  expect(notify.mock.calls.map(call => call[0].message)).toEqual(['in one', 'in two', 'new in two'])
})

test('G21 M4: a record of the old shape still counts for its runtime', async () => {
  window.localStorage.setItem('iclone.browser-record.seen', JSON.stringify({ boot: 'one', seq: 1 }))
  answer({ armed: true, boot: 'one', notices: [{ message: 'old', ok: true, seq: 1 }, { message: 'new', ok: true, seq: 2 }] })
  await pollBrowserRecording()
  expect(notify.mock.calls.map(call => call[0].message)).toEqual(['new'])
})

test('G21 product 4: what was said is not said again in a new window, and what came meanwhile is', async () => {
  answer({ armed: true, boot: 'one', notices: [{ message: 'first', ok: true, seq: 1 }] })
  await pollBrowserRecording()
  expect(notify).toHaveBeenCalledTimes(1)
  vi.resetModules()

  const fresh = await import('./browser-tool')

  answer({
    armed: true,
    boot: 'one',
    notices: [
      { message: 'first', ok: true, seq: 1 },
      { message: 'second', ok: true, seq: 2 }
    ]
  })
  await fresh.pollBrowserRecording()
  expect(notify).toHaveBeenCalledTimes(2)
  expect(notify.mock.calls[1][0].message).toBe('second')
})

test('G21 P4: the eye button stops the capture and awaits the notice before it restarts', async () => {
  const order: string[] = []

  getHermesConfigRecord.mockResolvedValue({ browser: { headed: false } })
  gatewayRequest.mockImplementation(async (_method: string, params: { action: string }) => {
    order.push(params.action)

    return params.action === 'record_stop'
      ? { capturing: [], notices: [{ message: 'saved it', ok: true, seq: 3 }] }
      : { capturing: ['a.webm'], notices: [] }
  })
  restartBackend.mockImplementation(async () => {
    order.push('restart')
  })
  await refreshBrowserHeaded()

  click()
  await settle()
  await settle()
  await settle()

  expect(order.filter(step => step !== 'record_status')).toEqual(['record_stop', 'restart'])
  expect(notify.mock.calls.at(-1)?.[0].message).toBe('saved it')
})

test('G21 P4: when the wait runs out the eye button says so and still restarts', async () => {
  getHermesConfigRecord.mockResolvedValue({ browser: { headed: false } })
  gatewayRequest.mockImplementation(async (_method: string, params: { action: string }) => {
    if (params.action === 'record_stop') {
      throw new Error('timed out')
    }

    return { capturing: ['a.webm'], notices: [] }
  })
  await refreshBrowserHeaded()

  click()
  await settle()
  await settle()
  await settle()

  expect(restartBackend).toHaveBeenCalledTimes(1)
  expect(notify.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'warning', id: 'browser-record-ran-out' })
})

test('G21 P4: with no capture the eye button restarts without a stop', async () => {
  getHermesConfigRecord.mockResolvedValue({ browser: { headed: false } })
  answer({})
  await refreshBrowserHeaded()
  click()
  await settle()
  await settle()
  expect(gatewayRequest).not.toHaveBeenCalledWith('browser.manage', { action: 'record_stop' }, expect.any(Number))
  expect(restartBackend).toHaveBeenCalledTimes(1)
})

test('G21 product 6: a saved notice offers the file in Finder, only at the one folder', async () => {
  const revealPath = vi.fn()

  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { restartBackend, revealPath }
  answer({
    armed: true,
    boot: 'one',
    notices: [
      { file: 'browser-20261106-120000-abc123.webm', message: 'saved', ok: true, path: '/Users/x/Movies/icloneOS Recordings/browser-20261106-120000-abc123.webm', seq: 1 },
      { file: 'browser-20261106-120000-abc124.webm', message: 'elsewhere', ok: true, path: '/Users/x/.ssh/browser-20261106-120000-abc124.webm', seq: 2 }
    ]
  })
  await pollBrowserRecording()

  notify.mock.calls[0][0].action.onClick()
  expect(revealPath).toHaveBeenCalledWith('/Users/x/Movies/icloneOS Recordings/browser-20261106-120000-abc123.webm')
  expect(notify.mock.calls[1][0].action).toBeUndefined()
})

test('G21 product 7: the capture stays over a modal, the armed button does not', async () => {
  answer({ armed: true, capturing: ['browser-20261106-120000-abc123.webm'] })
  await pollBrowserRecording()
  expect((published(recording)!.data as { keepOverModals?: boolean }).keepOverModals).toBe(true)

  answer({ armed: true })
  await pollBrowserRecording()
  expect((published(recording)!.data as { keepOverModals?: boolean }).keepOverModals).toBe(false)
})
