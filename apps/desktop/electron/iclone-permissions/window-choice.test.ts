/** S11: the selector in an empty chat. Main holds the choice from the click, for that window, for the session it starts. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { confirmIgnoreNatively } from './ignore-dialog'
import { CLICK, FakeWindow, launchMain } from './ipc.test-helpers'

const SET = 'iclone:permissions:set-mode'
const CLAIM = 'iclone:permissions:claim-window-choice'
const STATE = 'iclone:permissions:state'

/** What the gate reports for a session that has already run a tool. */
const RAN = {
  agent: { inft: null, profile: null, session_id: 'ran', subagent_id: null, task_id: null },
  lineage: ['ran'],
  project: null,
  sessionProject: null,
  pid: 1,
  seq: 1,
  tool: 'terminal',
  target: 'ls',
  cls: 'A3',
  keyId: 'k',
  mode: 'manual',
  outcome: 'allow',
  grantId: null,
  fn: null
} as never

describe('S11: a choice held for the session this window starts', () => {
  let dir: string
  let inputAt: number
  let alerts: number
  const A = () => new FakeWindow(1)

  const launch = () =>
    launchMain(
      dir,
      [],
      () => [],
      () => inputAt,
      path.join(dir, 'home'),
      async () => {
        alerts += 1

        return true
      }
    )

  const hold = (main: ReturnType<typeof launch>, from: FakeWindow, mode = 'ignore') => {
    inputAt = Date.now()

    return main.invokeFrom(from, SET, { mode, scope: 'new-session', gesture: CLICK })
  }

  const typed = () => {
    inputAt = Date.now() + 5
  }

  const modes = (main: ReturnType<typeof launch>) => main.authority.state().mode

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'win-choice-'))
    inputAt = Date.now()
    alerts = 0
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('never writes the Setting, a project or a session at the click', async () => {
    const main = launch()

    expect(await hold(main, A())).toMatchObject({ ok: true, mode: 'ignore', scope: 'new-session' })
    expect(modes(main)).toMatchObject({ standing: 'manual', projects: {}, sessions: {} })
    expect(alerts).toBe(1)
  })

  it('applies to the session that window starts, once, and later new sessions take the Setting', async () => {
    const main = launch()
    const window = A()

    await hold(main, window)
    typed()
    expect(await main.invokeFrom(window, CLAIM, { sessionId: 's1' })).toEqual({ ok: true, mode: 'ignore' })
    expect(modes(main).sessions).toEqual({ s1: 'ignore' })
    expect(modes(main).standing).toBe('manual')
    expect((await main.invokeFrom(window, CLAIM, { sessionId: 's2' })).ok).toBe(false)
    expect(modes(main).sessions).toEqual({ s1: 'ignore' })
    expect(modes(main).sessions).not.toHaveProperty('s2')
    // The first action of that session finds it in force: the gate reports the call, main answers with the session's mode.
    main.authority.recordDecision({ ...(RAN as object), agent: { session_id: 's1' }, lineage: ['s1'] } as never)
    expect(main.authority.modeOfCaller('s1')).toBe('ignore')
  })

  it('takes the mode from main: a claim naming another mode changes nothing about it', async () => {
    const main = launch()
    const window = A()

    await hold(main, window, 'plan')
    typed()
    expect(await main.invokeFrom(window, CLAIM, { sessionId: 's1', mode: 'ignore' })).toEqual({ ok: true, mode: 'plan' })
    expect(modes(main).sessions).toEqual({ s1: 'plan' })
  })

  it('another window cannot claim it, and sees none of it', async () => {
    const main = launch()
    const other = new FakeWindow(2)

    await hold(main, A())
    typed()
    expect((await main.invokeFrom(other, CLAIM, { sessionId: 's1' })).ok).toBe(false)
    expect(modes(main).sessions).toEqual({})
    expect((await main.invokeFrom(other, STATE, {})).pendingMode ?? null).toBeNull()
    expect((await main.invokeFrom(A(), STATE, {})).pendingMode).toBe('ignore')
  })

  it('a renderer call without main’s gesture check holds nothing, so nothing can be claimed', async () => {
    const main = launch()
    const window = A()

    inputAt = 0
    expect(await main.invokeFrom(window, SET, { mode: 'ignore', scope: 'new-session', gesture: CLICK })).toMatchObject({
      ok: false,
      error: 'gesture'
    })
    inputAt = Date.now()
    expect(await main.invokeFrom(window, SET, { mode: 'ignore', scope: 'new-session' })).toMatchObject({
      ok: false,
      error: 'gesture'
    })
    typed()
    expect((await main.invokeFrom(window, CLAIM, { sessionId: 's1' })).ok).toBe(false)
    expect(modes(main).sessions).toEqual({})
    expect(alerts).toBe(0)
  })

  it('a claim with no real input to that window since the choice is refused and keeps the choice', async () => {
    const main = launch()
    const window = A()

    await hold(main, window)
    inputAt = 0
    expect((await main.invokeFrom(window, CLAIM, { sessionId: 's1' })).ok).toBe(false)
    expect(modes(main).sessions).toEqual({})
    typed()
    expect((await main.invokeFrom(window, CLAIM, { sessionId: 's1' })).ok).toBe(true)
  })

  it('dies with the window, even one that closes while the alert is up', async () => {
    const main = launch()
    const window = A()

    await hold(main, window)
    window.close()
    typed()
    expect((await main.invokeFrom(window, CLAIM, { sessionId: 's1' })).ok).toBe(false)
    expect(modes(main).sessions).toEqual({})

    const closing = launchMain(
      path.join(dir, 'second'),
      [],
      () => [],
      () => inputAt,
      path.join(dir, 'second', 'home'),
      async () => {
        closingWindow.close()

        return true
      }
    )

    const closingWindow = new FakeWindow(3)

    inputAt = Date.now()
    await closing.invokeFrom(closingWindow, SET, { mode: 'ignore', scope: 'new-session', gesture: CLICK })
    typed()
    expect((await closing.invokeFrom(closingWindow, CLAIM, { sessionId: 's1' })).ok).toBe(false)
  })

  it('cannot land on a session that already has a mode or has already run', async () => {
    const main = launch()
    const window = A()

    await main.invokeFrom(window, SET, { mode: 'manual', scope: 'session', key: 'old', gesture: CLICK })
    await hold(main, window)
    typed()
    expect((await main.invokeFrom(window, CLAIM, { sessionId: 'old' })).ok).toBe(false)
    expect(modes(main).sessions).toEqual({ old: 'manual' })

    main.authority.recordDecision(RAN)
    expect((await main.invokeFrom(window, CLAIM, { sessionId: 'ran' })).ok).toBe(false)
    expect(modes(main).sessions).toEqual({ old: 'manual' })
  })

  it('A8: an explicit change of the Setting or the project in that window clears the held choice', async () => {
    const moded = path.join(dir, 'moded')

    mkdirSync(moded, { recursive: true })

    for (const change of [
      { mode: 'manual', scope: 'standing' },
      { mode: 'manual', scope: 'project', key: moded }
    ]) {
      const main = launch()
      const window = A()

      await hold(main, window)
      expect(main.authority.windowChoice(window.id)).toBe('ignore')
      expect(await main.authority.setMode(change, true, window.id)).toMatchObject({ ok: true })
      expect(main.authority.windowChoice(window.id)).toBeNull()
      typed()
      expect(await main.invokeFrom(window, CLAIM, { sessionId: 's1' })).toEqual({ ok: false })
    }
  })

  it('A8: a change to one open chat, or by another window, leaves the held choice for its empty chat', async () => {
    const main = launch()
    const window = A()
    const other = new FakeWindow(2)

    await hold(main, window)
    inputAt = Date.now()
    await main.invokeFrom(window, SET, { mode: 'manual', scope: 'session', key: 'open-chat', gesture: CLICK })
    inputAt = Date.now()
    await main.invokeFrom(other, SET, { mode: 'manual', scope: 'standing', gesture: CLICK })
    expect(main.authority.windowChoice(window.id)).toBe('ignore')
  })

  it('a later choice in that window replaces the held one', async () => {
    const main = launch()
    const window = A()

    await hold(main, window)
    await hold(main, window, 'automatic')
    typed()
    expect(await main.invokeFrom(window, CLAIM, { sessionId: 's1' })).toEqual({ ok: true, mode: 'automatic' })
  })

  it('a call with no window behind it holds nothing', async () => {
    const main = launch()

    expect(await main.invoke(SET, { mode: 'ignore', scope: 'new-session', gesture: CLICK })).toMatchObject({
      ok: false,
      error: 'invalid'
    })
    expect(alerts).toBe(0)
  })

  it('the alert names the true scope', async () => {
    const shown: { message?: string; detail?: string }[] = []

    const dialog = {
      showMessageBox: (first: object, second?: object) => {
        shown.push(second ?? first)

        return Promise.resolve({ response: 1, checkboxChecked: false })
      }
    } satisfies Parameters<typeof confirmIgnoreNatively>[0]

    expect(await confirmIgnoreNatively(dialog, null, 'en', { scope: 'new-session', key: null })).toBe(true)
    expect(shown[0]!.message).toBe('Ignore permissions for the chat this window starts next?')
    expect(shown[0]!.detail).toContain('Only that chat. Other new chats keep the mode set in Settings.')
    expect(shown[0]!.detail).not.toContain('Every project')
  })
})
