import { beforeEach, expect, test, vi } from 'vitest'

const getHermesConfigRecord = vi.fn()
const saveHermesConfig = vi.fn()
const restartBackend = vi.fn()
const register = vi.fn((_contribution: unknown) => () => {})

vi.mock('@/api/config', () => ({
  getHermesConfigRecord: (...args: unknown[]) => getHermesConfigRecord(...args),
  saveHermesConfig: (...args: unknown[]) => saveHermesConfig(...args)
}))

vi.mock('@/contrib/registry', () => ({
  registry: { register: (contribution: unknown) => register(contribution) }
}))

const { $browserHeaded, $browserRecording, refreshBrowserHeaded, refreshBrowserRecording, registerIcloneBrowserTool } =
  await import('./browser-tool')

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
  expect(published('iclone-browser-recording')?.data.label).toMatch(/recordings folder/)
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
