// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ModePicker } from '@/components/permissions/mode-picker'
import { enPermissions } from '@/i18n/en/enPermissions'
import { CONFINEMENT_STATE_SCHEMA } from '@/iclone-shared/confinement'
import { ignoreConfirmCopy } from '@/iclone-shared/permission-ignore-copy'
import { PERMISSION_MODES } from '@/iclone-shared/permissions'
import { $confinement } from '@/store/confinement'
import { barMode } from '@/store/permissions'
import { $permissions } from '@/store/permissions'
import { $connection, $selectedStoredSessionId } from '@/store/session'

import { PermissionPill } from './permission-pill'
import { type ComposerScope, ComposerScopeProvider, MAIN_COMPOSER_SCOPE } from './scope'

const STATE = {
  sealed: true,
  project: null as null | string,
  enforcement: 'enforced',
  mode: { standing: 'manual', projects: {} as Record<string, string>, sessions: {}, updatedAt: '2026-11-05T00:00:00.000Z' }
}

let state = STATE
let announce: () => void = () => undefined

const bridge = {
  state: vi.fn(async () => state),
  tail: vi.fn(async () => []),
  onChanged: vi.fn((cb: () => void) => {
    announce = cb

    return () => undefined
  }),
  setMode: vi.fn(async (input: { mode: string; scope: string }) => ({ ok: true as const, ...input }))
}

async function mount() {
  await act(async () => {
    render(<PermissionPill />)
  })

  return screen.getByTestId('permission-mode-trigger')
}

async function pick(mode: string) {
  fireEvent.pointerDown(screen.getByTestId('permission-mode-trigger'), { button: 0, ctrlKey: false, pointerType: 'mouse' })
  await act(async () => undefined)

  const row = document.querySelector(`[data-perm-mode="${mode}"]`) as HTMLElement

  expect(row.hasAttribute('data-perm-mode-confirm')).toBe(true)
  await act(async () => {
    fireEvent.click(row)
  })
}

beforeEach(() => {
  state = STATE
  vi.clearAllMocks()
  $permissions.set({ status: 'loading', state: null, records: [] })
  $confinement.set({ status: 'loading', state: null, error: null })
  $connection.set(null)
  Object.assign(window, {
    hermesDesktop: { icloneConsent: { permissions: bridge }, keychainState: async () => ({ atLaunch: true, on: true }) }
  })
})

afterEach(cleanup)

describe('A1: the selector in a tile is that tile\'s', () => {
  const tileScope = (id: string): ComposerScope => ({ ...MAIN_COMPOSER_SCOPE, target: `tile:${id}` })

  const mountTile = async (id: string) => {
    await act(async () => {
      render(
        <ComposerScopeProvider value={tileScope(id)}>
          <PermissionPill />
        </ComposerScopeProvider>
      )
    })
  }

  const asState = (sessions: Record<string, string>, pendingMode: null | string = null) => {
    state = { ...STATE, mode: { ...STATE.mode, sessions }, pendingMode } as typeof STATE
  }

  afterEach(() => {
    cleanup()
    $selectedStoredSessionId.set(null)
  })

  it('a change in a tile goes to the tile, with a chat open in the main pane', async () => {
    $selectedStoredSessionId.set('primary')
    await mountTile('tile-1')
    await pick('automatic')

    expect(bridge.setMode).toHaveBeenCalledTimes(1)
    expect(bridge.setMode.mock.calls[0][0]).toMatchObject({ mode: 'automatic', scope: 'session', key: 'tile-1' })
  })

  it('a change in a tile goes to the tile, with the main pane empty: it is never held for a later chat', async () => {
    await mountTile('tile-1')
    await pick('automatic')

    expect(bridge.setMode.mock.calls[0][0]).toMatchObject({ scope: 'session', key: 'tile-1' })
  })

  it('reads the tile\'s own mode, not the primary\'s, and not what the empty chat holds', async () => {
    asState({ primary: 'manual', 'tile-1': 'automatic' }, 'ignore')
    $selectedStoredSessionId.set('primary')
    await mountTile('tile-1')
    expect(screen.getByTestId('permission-mode-trigger').textContent).toContain('Automatic')

    cleanup()
    asState({ primary: 'automatic' }, 'ignore')
    await mountTile('tile-2')
    expect(screen.getByTestId('permission-mode-trigger').textContent).toContain('Manual')
  })

  it('the main composer keeps the selected session', async () => {
    $selectedStoredSessionId.set('primary')
    await mount()
    await pick('automatic')

    expect(bridge.setMode.mock.calls[0][0]).toMatchObject({ scope: 'session', key: 'primary' })
  })
})

describe('the Message bar permission selector', () => {
  it('shows what Settings has, with its arrow, and lists the five modes', async () => {
    const trigger = await mount()

    expect(trigger.textContent).toContain('Manual')
    expect(trigger.querySelector('svg')).not.toBeNull()

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    await act(async () => undefined)

    expect([...document.querySelectorAll('[data-perm-mode]')].map(node => node.getAttribute('data-perm-mode'))).toEqual([
      'ignore',
      'manual',
      'automatic',
      'plan',
      'acceptEdits'
    ])
  })

  it('B2, L5-03: an empty chat says only this new chat; an open chat says only this chat; both name the full path', async () => {
    const line = () => document.querySelector('[data-permission-scope-line]')?.textContent

    const empty = await mount()

    fireEvent.pointerDown(empty, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    await act(async () => undefined)
    expect(line()).toBe('Only this new chat. Default in Settings › Agent › Permissions.')
    cleanup()

    $selectedStoredSessionId.set('primary')

    const open = await mount()

    fireEvent.pointerDown(open, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    await act(async () => undefined)
    expect(line()).toBe('Only this chat, from the next message. Default in Settings › Agent › Permissions.')
    expect(document.body.textContent).not.toContain('Applies everywhere')
    $selectedStoredSessionId.set(null)
  })

  // Re-pinned by DECISOES_LEAD 11-10 (L5-01): the menu's Ignore note is one line; the full account lives in the next test.
  it('b1, b2: in Ignore the menu shows one short line by the live verdict, and never says the kernel holds anything', async () => {
    expect(enPermissions.menu.ignoreNote.confined).toBe('Five checks still refuse. Details in Settings.')
    expect(enPermissions.menu.ignoreNote.unconfined).toBe('Seatbelt off: five app checks only.')

    const note = () => document.querySelector<HTMLElement>('[data-permission-ignore-note]')

    state = { ...STATE, mode: { ...STATE.mode, standing: 'ignore' } }
    fireEvent.pointerDown(await mount(), { button: 0, ctrlKey: false, pointerType: 'mouse' })
    await act(async () => undefined)
    // No confinement bridge: the verdict is not green, so the line says only the app checks hold.
    expect(note()?.textContent).toBe(enPermissions.menu.ignoreNote.unconfined)
    expect(note()?.getAttribute('role')).toBe('note')
    expect(note()?.className).toContain('--ic-warning')
    cleanup()

    Object.assign(window.hermesDesktop as object, {
      icloneConfinement: { state: async () => ({ schema: CONFINEMENT_STATE_SCHEMA, verdict: 'green', isolation: { on: true } }) }
    })
    fireEvent.pointerDown(await mount(), { button: 0, ctrlKey: false, pointerType: 'mouse' })
    await act(async () => undefined)
    expect(note()?.textContent).toBe(enPermissions.menu.ignoreNote.confined)
    expect(note()?.className).not.toContain('--ic-warning')

    for (const line of [enPermissions.menu.ignoreNote.confined, enPermissions.menu.ignoreNote.unconfined]) {
      expect(line.length).toBeLessThanOrEqual(48)
      expect(line.toLowerCase()).not.toContain('kernel')
    }

    $confinement.set({ status: 'loading', state: null, error: null })
  })

  it('L5-01: the full Ignore account is still in the system alert and in Settings › Agent › Permissions', async () => {
    const fiveChecks = [
      'the whole disk',
      'a recursive delete whose whole target is a variable or command output it cannot read',
      'a call too unreadable to check',
      'deny rules you wrote',
      'the file tools on the runtime’s own stores'
    ]

    const { still } = ignoreConfirmCopy('en', 'session')

    for (const check of fiveChecks) {
      expect(still).toContain(check)
      expect(enPermissions.modes.ignore.summary).toContain(check)
    }

    expect(still).toContain('not a wall in the kernel')
    expect(enPermissions.modes.ignore.summary).toContain('five checks stay')
    // What the menu's old Seatbelt line said is kept in Settings, so nothing is lost by the short note.
    expect(enPermissions.modes.ignore.summary).toContain(
      'Computer use, screen recording and the browser run outside the Seatbelt, and the file tools write files in your home folder outside it one file at a time.'
    )

    // Settings › Agent › Permissions renders that summary under the Ignore row.
    await act(async () => {
      render(<ModePicker chosen="manual" inForce="manual" target={{ scope: 'standing', key: null }} />)
    })
    expect(document.body.textContent).toContain(enPermissions.modes.ignore.summary)
  })

  it('S11: one click on Ignore in an empty chat asks main once, for the session this window starts, never the Setting', async () => {
    await mount()
    await pick('ignore')

    expect(bridge.setMode).toHaveBeenCalledTimes(1)
    expect(bridge.setMode).toHaveBeenCalledWith({ mode: 'ignore', scope: 'new-session', key: null })
  })

  it('S11: a project with its own mode shows it in an empty chat, and a choice there stays off that record', async () => {
    state = { ...STATE, project: '/p', mode: { ...STATE.mode, projects: { '/p': 'automatic' } } }

    const trigger = await mount()

    expect(trigger.textContent).toContain('Automatic')
    await pick('ignore')
    expect(bridge.setMode).toHaveBeenCalledWith({ mode: 'ignore', scope: 'new-session', key: null })
  })

  it('what Settings changes shows here when main announces it, in the warning tone', async () => {
    const trigger = await mount()

    state = { ...STATE, mode: { ...STATE.mode, standing: 'ignore' } }
    await act(async () => {
      announce()
    })

    expect(trigger.getAttribute('data-permission-mode')).toBe('ignore')
    expect(trigger.className).toContain('--ic-warning')
  })

  it('an unsealed launch shows the mode main reports: chosen this run is in force (fx47)', async () => {
    state = { ...STATE, sealed: false, mode: { ...STATE.mode, standing: 'ignore' } }

    const trigger = await mount()

    expect(trigger.getAttribute('data-permission-mode')).toBe('ignore')
    expect(trigger.getAttribute('aria-label')).not.toContain('is chosen, not in force')
  })

  it('an open session reads the same way, Keychain off (fx47)', async () => {
    const { barMode } = await import('@/store/permissions')
    const view = { ...STATE, sealed: false, mode: { ...STATE.mode, sessions: { s1: 'ignore' } } }

    expect(barMode(view as never, 's1').inForce).toBe('ignore')
  })

  it('a refusal from main stays readable in the menu', async () => {
    bridge.setMode.mockResolvedValueOnce({ ok: false, error: 'gesture', message: 'x' } as never)
    await mount()
    await pick('automatic')

    expect(document.querySelector('[role="alert"]')?.textContent).toBeTruthy()
  })

  it('a remote session claims nothing', async () => {
    $connection.set({ mode: 'remote' } as never)
    await act(async () => {
      render(<PermissionPill />)
    })

    expect(screen.queryByTestId('permission-mode-trigger')).toBeNull()
  })
})

describe('F40 detail: the choice is per session and the Setting is the default', () => {
  const view = (over: object) =>
    ({ sealed: true, project: null, mode: { standing: 'manual', projects: {}, sessions: {}, ...over } }) as never

  it('an open session writes its own row and shows it; another session can differ', () => {
    const state = view({ sessions: { a: 'ignore' } })

    expect(barMode(state, 'a')).toMatchObject({ inForce: 'ignore', target: { scope: 'session', key: 'a' } })
    expect(barMode(state, 'b')).toMatchObject({ inForce: 'manual', target: { scope: 'session', key: 'b' } })
  })

  it('a session with no choice follows the Setting, and with none open the choice is the Setting', () => {
    expect(barMode(view({ standing: 'automatic' }), 'b').inForce).toBe('automatic')
    expect(barMode({ ...(view({ standing: 'manual' }) as object), pendingMode: 'ignore' } as never)).toMatchObject({
      chosen: 'ignore',
      inForce: 'ignore',
      target: { scope: 'new-session', key: null }
    })
    // An open session shows its own: what the empty chat held is not its mode.
    expect(barMode({ ...(view({ standing: 'manual' }) as object), pendingMode: 'ignore' } as never, 'b').chosen).toBe('manual')
    expect(barMode(view({ standing: 'automatic' }))).toMatchObject({ chosen: 'automatic', target: { scope: 'new-session', key: null } })
  })
})

describe('G20: keys 1 to 5 in the open selector', () => {
  const open = async () => {
    await mount()
    fireEvent.pointerDown(screen.getByTestId('permission-mode-trigger'), { button: 0, ctrlKey: false, pointerType: 'mouse' })
    await act(async () => undefined)

    return screen.getByTestId('permission-mode-menu')
  }

  it('the menu is what the preload accepts a digit from, and each row shows its key', async () => {
    const menu = await open()

    expect(menu.hasAttribute('data-perm-mode-shortcuts')).toBe(true)
    expect(window.document.querySelector('[data-perm-mode="ignore"] [data-perm-mode-key]')?.textContent).toBe('1')
    expect(window.document.querySelector('[data-perm-mode="acceptEdits"] [data-perm-mode-key]')?.textContent).toBe('5')
  })

  it('a digit asks main for that row, in its own key handler', async () => {
    const menu = await open()

    await act(async () => {
      fireEvent.keyDown(menu, { key: '3' })
    })

    expect(bridge.setMode).toHaveBeenCalledTimes(1)
    expect(bridge.setMode.mock.calls[0][0].mode).toBe('automatic')
  })

  it('a chord, a held key or any other digit asks nothing', async () => {
    const menu = await open()

    await act(async () => {
      fireEvent.keyDown(menu, { key: '3', metaKey: true })
      fireEvent.keyDown(menu, { key: '3', ctrlKey: true })
      fireEvent.keyDown(menu, { key: '3', altKey: true })
      fireEvent.keyDown(menu, { key: '3', repeat: true })
      fireEvent.keyDown(menu, { key: '6' })
      fireEvent.keyDown(menu, { key: '0' })
    })

    expect(bridge.setMode).not.toHaveBeenCalled()
  })
})

describe('U-1: the menu is this chat\'s, one short line per mode', () => {
  const openMenu = async () => {
    fireEvent.pointerDown(await mount(), { button: 0, ctrlKey: false, pointerType: 'mouse' })
    await act(async () => undefined)

    return screen.getByTestId('permission-mode-menu')
  }

  it('says it changes this chat, and points to Settings for the default', async () => {
    const menu = await openMenu()

    expect(menu.textContent).toContain('This chat')
    expect(menu.querySelector('[data-permission-scope-line]')?.textContent).toContain('Settings › Agent › Permissions')
  })

  it('L5-06: the header is a menu label that names the mode list, with a divider before the choices', async () => {
    const menu = await openMenu()
    const group = menu.querySelector<HTMLElement>('[aria-labelledby]')!
    const label = document.getElementById(group.getAttribute('aria-labelledby')!)!

    expect(label.getAttribute('data-slot')).toBe('dropdown-menu-label')
    expect(label.textContent).toBe(enPermissions.menu.title)
    expect(document.getElementById(group.getAttribute('aria-describedby')!)?.hasAttribute('data-permission-scope-line')).toBe(true)
    expect(group.contains(menu.querySelector('[data-perm-mode="ignore"]'))).toBe(true)
    expect(menu.querySelector('[role="separator"]')).not.toBeNull()
    expect(screen.getByTestId('permission-mode-trigger').getAttribute('aria-label')).toBe(
      enPermissions.menu.trigger(enPermissions.modes.manual.name)
    )
  })

  it('L5-07, L5-05, L5-09: each row is described by its short, names its key, keeps the key last, rings only for the keyboard', async () => {
    const menu = await openMenu()

    PERMISSION_MODES.forEach((mode, index) => {
      const row = menu.querySelector<HTMLElement>(`[data-perm-mode="${mode}"]`)!

      expect(document.getElementById(row.getAttribute('aria-describedby')!)?.textContent).toBe(
        enPermissions.modes[mode].short
      )
      expect(row.getAttribute('aria-keyshortcuts')).toBe(String(index + 1))
      // [label … check slot · key]: the digit is the last thing drawn on every row, the check in its own slot.
      const drawn = [...row.children].filter(child => !child.hasAttribute('data-state'))
      const [check, key] = drawn.slice(-2)

      expect(key?.hasAttribute('data-perm-mode-key')).toBe(true)
      expect(check?.hasAttribute('data-perm-mode-check')).toBe(true)
      expect(Boolean(check?.firstElementChild)).toBe(mode === 'manual')
      expect(row.className).toContain('[&>span[data-state]]:hidden')
      expect(row.className).toContain('focus-visible:ring-1')
      expect(row.className).not.toMatch(/(^|\s)focus:ring/u)
    })
  })

  it('each row shows the mode name and its short, never a summary', async () => {
    const menu = await openMenu()

    for (const mode of PERMISSION_MODES) {
      const row = menu.querySelector(`[data-perm-mode="${mode}"]`) as HTMLElement

      expect(row.textContent).toContain(enPermissions.modes[mode].name)
      expect(row.querySelector('[data-perm-mode-short]')?.textContent).toBe(enPermissions.modes[mode].short)
      expect(menu.textContent).not.toContain(enPermissions.modes[mode].summary)
    }
  })
})

describe('U-1: a click shows its mode at once, and main\'s refusal rolls it back', () => {
  const deferred = () => {
    let resolve: (value: unknown) => void = () => undefined

    const promise = new Promise(done => {
      resolve = done
    })

    return { promise, resolve }
  }

  const trigger = () => screen.getByTestId('permission-mode-trigger')
  const menuOpen = () => screen.queryByTestId('permission-mode-menu') !== null

  it('the pill shows the chosen mode and the menu closes before main answers', async () => {
    const answer = deferred()

    bridge.setMode.mockReturnValueOnce(answer.promise as never)
    await mount()
    await pick('automatic')

    expect(bridge.setMode).toHaveBeenCalledTimes(1)
    expect(trigger().getAttribute('data-permission-mode')).toBe('automatic')
    expect(menuOpen()).toBe(false)

    await act(async () => {
      answer.resolve({ ok: true, mode: 'automatic', scope: 'new-session' })
    })
    expect(trigger().getAttribute('data-permission-mode')).toBe('automatic')

    // Main announces the change it made: the store is the authority again.
    state = { ...STATE, pendingMode: 'automatic' } as typeof STATE
    await act(async () => {
      announce()
    })
    expect(trigger().getAttribute('data-permission-mode')).toBe('automatic')
  })

  it('a refusal rolls the pill back and reopens the menu on the existing error copy', async () => {
    const answer = deferred()

    bridge.setMode.mockReturnValueOnce(answer.promise as never)
    await mount()
    await pick('automatic')
    expect(trigger().getAttribute('data-permission-mode')).toBe('automatic')

    await act(async () => {
      answer.resolve({ ok: false, error: 'gesture', message: 'x' })
    })

    expect(trigger().getAttribute('data-permission-mode')).toBe('manual')
    expect(menuOpen()).toBe(true)
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(enPermissions.refused.gesture)
  })

  it('a bridge failure rolls back with the unavailable copy', async () => {
    bridge.setMode.mockRejectedValueOnce(new Error('gone'))
    await mount()
    await pick('plan')

    expect(trigger().getAttribute('data-permission-mode')).toBe('manual')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(enPermissions.refused.unavailable)
  })

  it('L5-02: while the Ignore alert is open the pill never shows Ignore: the current mode stays, busy; a cancel leaves it', async () => {
    const answer = deferred()

    bridge.setMode.mockReturnValueOnce(answer.promise as never)
    await mount()
    await pick('ignore')
    expect(bridge.setMode).toHaveBeenCalledTimes(1)
    expect(trigger().getAttribute('data-permission-mode')).toBe('manual')
    expect(trigger().getAttribute('aria-busy')).toBe('true')
    expect(trigger().hasAttribute('data-permission-pending')).toBe(true)
    expect(trigger().className).not.toContain('--ic-warning')
    expect(menuOpen()).toBe(false)

    await act(async () => {
      answer.resolve({ ok: false, error: 'confirm', message: '' })
    })

    expect(trigger().getAttribute('data-permission-mode')).toBe('manual')
    expect(trigger().hasAttribute('aria-busy')).toBe(false)
    expect(trigger().hasAttribute('data-permission-pending')).toBe(false)
    expect(menuOpen()).toBe(false)
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('L5-02: Ignore shows only once main says yes, then stays with the store', async () => {
    const answer = deferred()

    bridge.setMode.mockReturnValueOnce(answer.promise as never)
    await mount()
    await pick('ignore')
    expect(trigger().getAttribute('data-permission-mode')).toBe('manual')

    await act(async () => {
      answer.resolve({ ok: true, mode: 'ignore', scope: 'new-session' })
    })
    expect(trigger().getAttribute('data-permission-mode')).toBe('ignore')
    expect(trigger().hasAttribute('aria-busy')).toBe(false)

    state = { ...STATE, pendingMode: 'ignore' } as typeof STATE
    await act(async () => {
      announce()
    })
    expect(trigger().getAttribute('data-permission-mode')).toBe('ignore')
  })

  it('L5-08: a guess stays in its chat: switching chats before main answers shows the other chat\'s own mode', async () => {
    const answer = deferred()

    state = { ...STATE, mode: { ...STATE.mode, sessions: { b: 'plan' } } } as typeof STATE
    $selectedStoredSessionId.set('a')
    bridge.setMode.mockReturnValueOnce(answer.promise as never)
    await mount()
    await pick('automatic')
    expect(trigger().getAttribute('data-permission-mode')).toBe('automatic')

    await act(async () => {
      $selectedStoredSessionId.set('b')
    })
    expect(trigger().getAttribute('data-permission-mode')).toBe('plan')

    // A refusal for chat A that lands after the switch is A's: B's menu does not open on it.
    await act(async () => {
      answer.resolve({ ok: false, error: 'invalid', message: 'late' })
    })
    expect(trigger().getAttribute('data-permission-mode')).toBe('plan')
    expect(menuOpen()).toBe(false)
    expect(document.querySelector('[role="alert"]')).toBeNull()
    $selectedStoredSessionId.set(null)
  })

  it('an older answer never undoes a newer choice', async () => {
    const first = deferred()
    const second = deferred()

    bridge.setMode.mockReturnValueOnce(first.promise as never).mockReturnValueOnce(second.promise as never)
    await mount()
    await pick('automatic')
    await pick('plan')
    expect(trigger().getAttribute('data-permission-mode')).toBe('plan')

    await act(async () => {
      first.resolve({ ok: false, error: 'invalid', message: 'late' })
    })
    expect(trigger().getAttribute('data-permission-mode')).toBe('plan')
    expect(document.querySelector('[role="alert"]')).toBeNull()

    await act(async () => {
      second.resolve({ ok: true, mode: 'plan', scope: 'new-session' })
    })
    expect(trigger().getAttribute('data-permission-mode')).toBe('plan')
  })

  it('choosing the mode already shown asks main nothing and closes the menu', async () => {
    await mount()
    await pick('manual')

    expect(bridge.setMode).not.toHaveBeenCalled()
    expect(menuOpen()).toBe(false)
  })
})
