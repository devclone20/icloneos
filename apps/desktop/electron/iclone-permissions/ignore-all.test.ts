/**
 * F40 - Ignore all, one click. The native alert once from main, and in Ignore no layer of the app asks. Every Ignore case
 * has its Manual twin in the same test, so it can pass only when the path really ran.
 */
import type { BrowserWindow, MessageBoxOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { registerConsentDoor } from '../iclone-consent-door'

import { decideFunctions } from './functions'
import { confirmIgnoreNatively } from './ignore-dialog'
import { ACTION_CLASSES, decide, DEFAULT_STANDING_MODE, MODE_TABLE } from './modes'

describe('the table', () => {
  it('a new install stays Manual', () => {
    expect(DEFAULT_STANDING_MODE).toBe('manual')
  })

  it('Ignore allows every class, whatever the switch', () => {
    for (const cls of ACTION_CLASSES) {
      expect(MODE_TABLE.ignore[cls]).toBe('A')

      for (const ceiling of ['off', 'undecided', 'on'] as const) {
        expect(decide({ mode: 'ignore', cls, ceiling }).outcome).toBe('allow')
      }
    }

    expect(decide({ mode: 'manual', cls: 'X', ceiling: 'off' }).outcome).toBe('refuse')
    expect(decide({ mode: 'manual', cls: 'X', ceiling: 'on' }).outcome).toBe('ask')
  })

  it('a floor still refuses in Ignore', () => {
    expect(decide({ mode: 'ignore', cls: 'X', floor: 'hardline: total destruction, wipes the disk' })).toMatchObject({
      outcome: 'refuse',
      rule: 'floor'
    })
  })
})

describe('the per-function levels', () => {
  const base = { cls: 'X' as const, facts: {}, classGranted: false, fns: ['shell'] as never[], partsUnread: true }
  const levels = { shell: 'askAlways', payments: 'manual' } as never

  it('no level, unread reading or OFF switch asks or refuses in Ignore; in Manual they do', () => {
    const inIgnore = decideFunctions({ ...base, mode: 'ignore', levels, switchesOff: true, ceiling: 'off' })

    expect(inIgnore.outcome).toBe('allow')
    expect(decideFunctions({ ...base, mode: 'manual', levels, switchesOff: false }).outcome).not.toBe('allow')
  })

  it('a floor on a part read refuses in Ignore', () => {
    const part = { cls: 'X' as const, facts: {}, floor: 'hardline: total destruction, x', ceiling: undefined, classGranted: false, fns: [] }

    expect(decideFunctions({ ...base, mode: 'ignore', levels, parts: [part] })).toMatchObject({
      outcome: 'refuse',
      rule: 'floor'
    })
  })
})

describe('the native alert', () => {
  /** A dialog that answers `response` and keeps the options it was shown, whichever overload main calls. */
  const dialogAnswering = (response: number) => {
    const shown: MessageBoxOptions[] = []

    const showMessageBox = vi.fn(async (first: BrowserWindow | MessageBoxOptions, second?: MessageBoxOptions) => {
      shown.push(second ?? (first as MessageBoxOptions))

      return { response, checkboxChecked: false }
    })

    return { showMessageBox, shown } satisfies Parameters<typeof confirmIgnoreNatively>[0] & { shown: MessageBoxOptions[] }
  }

  it('with no parent it is a free-standing alert, says its scope and names the floors', async () => {
    const dialog = dialogAnswering(1)

    expect(await confirmIgnoreNatively(dialog, null, 'en', { scope: 'standing', key: null })).toBe(true)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)

    const options = dialog.shown[0]!

    expect(options.message).toBe('Ignore permissions for every session with no mode of its own?')
    expect(options.detail).toContain('move your iNFTs and send your keys')
    expect(options.detail).toContain('malicious page or file')
  })

  it('the title names the scope the choice really has', async () => {
    for (const [scope, key, title] of [
      ['session', 's1', 'Ignore permissions for this session?'],
      ['project', '/lab/proj', 'Ignore permissions for this project?'],
      ['standing', null, 'Ignore permissions for every session with no mode of its own?']
    ] as const) {
      const dialog = dialogAnswering(1)

      await confirmIgnoreNatively(dialog, null, 'en', { scope, key })
      expect(dialog.shown[0]!.message).toBe(title)
    }
  })

  it('Escape or Cancel keeps the mode', async () => {
    expect(await confirmIgnoreNatively(dialogAnswering(0), null, 'en', { scope: 'standing', key: null })).toBe(false)
  })
})

describe('the consent door', () => {
  const door = (ignoreInForce?: () => boolean) => {
    const broadcast = vi.fn()

    const built = registerConsentDoor({
      ipcMain: { handle: () => undefined },
      isTrustedSender: () => true,
      store: { read: () => ({ permissions: {} }), allowAlways: () => ({ ok: true }) },
      broadcast,
      userDataDir: '/nonexistent-f40',
      ignoreInForce
    } as never)

    return { built, broadcast }
  }

  const ask = (mode: 'ignore' | 'manual') => ({
    cls: '$' as const,
    tool: 'pay',
    target: 'x',
    mode,
    project: null,
    session: null,
    subagent: null,
    scopes: ['once']
  })

  it('a permission ask in Ignore never reaches the sheet; in Manual it does', async () => {
    const { built, broadcast } = door()

    await expect(built.askPermission('a', ask('ignore') as never, 'spendTrade' as never, 'r')).resolves.toBe('once')
    expect(broadcast).not.toHaveBeenCalled()

    const controller = new AbortController()
    const pending = built.askPermission('a', ask('manual') as never, 'spendTrade' as never, 'r', controller.signal)

    expect(broadcast).toHaveBeenCalled()
    controller.abort()
    await pending
  })

  it('the agent consent verb is answered in Ignore without the sheet and not remembered', async () => {
    let ignoring = true
    const { built, broadcast } = door(() => ignoring)

    await expect(built.request('a', 'terminal' as never, 'r')).resolves.toMatchObject({ allowed: true, scope: 'once' })
    expect(broadcast).not.toHaveBeenCalled()

    ignoring = false

    const controller = new AbortController()
    const pending = built.request('a', 'terminal' as never, 'r', controller.signal)

    expect(broadcast).toHaveBeenCalled()
    controller.abort()
    await pending
  })

  it('turning Ignore on answers what waits on the sheet, and only what it covers', async () => {
    const { built } = door()
    const covered = built.askPermission('a', ask('manual') as never, 'spendTrade' as never, 'r')
    const kept = new AbortController()

    const other = built.askPermission(
      'b',
      { ...ask('manual'), project: '/own-mode' } as never,
      'spendTrade' as never,
      'r',
      kept.signal
    )

    built.releaseAsks(permission => permission.project === '/own-mode')
    await expect(covered).resolves.toBe('once')

    let otherDone = false

    void other.then(() => (otherDone = true))
    await Promise.resolve()
    expect(otherDone).toBe(false)
    kept.abort()
    await other
  })
})

describe('L1: what left the floor in Ignore all', () => {
  const asking = ['inft: x', 'secrets: x', 'sudo: x', 'policy: x']

  it('runs with no ask in Ignore, asks in every other mode, and no grant lifts it', () => {
    for (const floor of asking) {
      expect(decide({ mode: 'ignore', cls: 'X', floor })).toMatchObject({ outcome: 'allow', rule: 'mode' })

      for (const mode of ['manual', 'automatic', 'acceptEdits'] as const) {
        expect(decide({ mode, cls: 'R', floor, granted: true })).toMatchObject({ outcome: 'ask', rule: 'floor' })
      }
    }
  })

  it('total destruction refuses in all five, with the words the plugin sends', () => {
    for (const mode of ['ignore', 'manual', 'automatic', 'plan', 'acceptEdits'] as const) {
      expect(decide({ mode, cls: 'X', floor: 'hardline: total destruction, x' })).toMatchObject({
        outcome: 'refuse',
        rule: 'floor'
      })
    }
  })
})

describe('F50, the words', () => {
  it('S8: the alert names the admin password, its own permissions and computer use on this app', async () => {
    const { ignoreConfirmCopy } = await import('../../src/iclone-shared/permission-ignore-copy')
    const lifts = ignoreConfirmCopy('en', 'session').lifts.join(' | ')

    expect(lifts).toContain('admin password')
    expect(lifts).toContain('overwrite its own permission files, though icloneOS does not take an edit it cannot verify')
    expect(lifts).toContain('own controls')
  })

  it('S8: the isolation-off alert no longer says asks judge each command, and says Ignore can spend', async () => {
    const { ISOLATION_OFF_STAYS } = await import('../iclone-confinement/isolation-switch')
    const stays = ISOLATION_OFF_STAYS.join(' ')

    expect(stays).not.toMatch(/asks, grants/)
    expect(stays).toContain('In Ignore permissions nothing asks')
    expect(stays).toContain('spend without asking')
  })
})
