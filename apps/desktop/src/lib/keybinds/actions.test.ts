import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'

import { defaultBindings, KEYBIND_ACTIONS, KEYBIND_READONLY, keybindAction } from './actions'

// Settings -> Keybinds renders one row per DECLARED action and resolves its
// copy as `t.keybinds.actions[id] ?? action.label ?? action.id`, so a missing
// label prints a developer id and a missing handler offers a shortcut that
// reaches nothing. Handlers are wired inside a React hook, so the only place to
// check them without a renderer is that hook's source.
const HOOK_SOURCE = readFileSync(resolve(process.cwd(), 'src/app/hooks/use-keybinds.ts'), 'utf8')
const BLOCK_START = HOOK_SOURCE.indexOf('handlersRef.current = {')
const HANDLER_BLOCK = HOOK_SOURCE.slice(BLOCK_START, HOOK_SOURCE.indexOf('\n  }\n', BLOCK_START))
// The shell's view keys are built apart from the hook (shellViewHandlers) and spread into the map.
const SHELL_START = HOOK_SOURCE.indexOf('export function shellViewHandlers(')
const SHELL_BLOCK = HOOK_SOURCE.slice(SHELL_START, HOOK_SOURCE.indexOf('\n}\n', SHELL_START))

const HANDLER_KEYS = new Set(
  [...`${HANDLER_BLOCK}\n${SHELL_BLOCK}`.matchAll(/^\s+'([^']+)':/gm)].map(match => match[1])
)

// Slot families are built in a loop and spread into the map.
const HANDLER_FAMILIES: readonly [RegExp, string][] = [
  [/^profile\.switch\.\d+$/, 'profileSwitchHandlers[`profile.switch.${slot}`]'],
  [/^session\.slot\.\d+$/, 'sessionSlotHandlers[`session.slot.${slot}`]']
]

function hasHandler(id: string): boolean {
  const family = HANDLER_FAMILIES.find(([pattern]) => pattern.test(id))

  return family ? HOOK_SOURCE.includes(family[1]) : HANDLER_KEYS.has(id)
}

function englishLabel(id: string): string | undefined {
  return (en.keybinds.actions as Record<string, string | undefined>)[id]
}

describe('the shortcuts panel can render every declared action', () => {
  it('has English copy for each one, so no row prints a developer id', () => {
    const declared = [...KEYBIND_ACTIONS, ...KEYBIND_READONLY].map(action => action.id)

    expect(declared.filter(id => !englishLabel(id))).toEqual([])
  })

  it('wires a handler for each rebindable one, so no row offers a dead shortcut', () => {
    expect(HANDLER_BLOCK).toContain('...profileSwitchHandlers')
    expect(HANDLER_BLOCK).toContain('...sessionSlotHandlers')
    expect(HANDLER_BLOCK).toContain('...shellViewHandlers(')

    const builtIns = KEYBIND_ACTIONS.filter(action => !action.label).map(action => action.id)

    expect(builtIns.filter(id => !hasHandler(id))).toEqual([])
  })

  it('declares none of the view toggles whose handlers E3 deleted', () => {
    const ids = KEYBIND_ACTIONS.map(action => action.id)

    for (const dead of ['view.toggleTabStrip', 'view.toggleStatusbar', 'view.toggleReview']) {
      expect(ids).not.toContain(dead)
      expect(defaultBindings()[dead]).toBeUndefined()
    }
  })
})

describe('session.archive keybind action', () => {
  it('is registered under the session category', () => {
    const action = keybindAction('session.archive')

    expect(action).toBeDefined()
    expect(action?.category).toBe('session')
  })

  it('ships unbound so it does not claim a chord for every user', () => {
    const action = keybindAction('session.archive')

    expect(action?.defaults).toEqual([])
    // A missing entry would silently drop from the panel; an accidental
    // default binding would change behaviour for everyone. Guard both.
    expect(defaultBindings()['session.archive']).toEqual([])
  })

  it('has an English label so it renders in the shortcuts panel', () => {
    expect(en.keybinds.actions['session.archive']).toBe('Archive current session')
  })

  it('appears exactly once in KEYBIND_ACTIONS', () => {
    const matches = KEYBIND_ACTIONS.filter(action => action.id === 'session.archive')

    expect(matches).toHaveLength(1)
  })
})
