import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import * as legacyStore from '@/app/right-sidebar/store'
import * as legacyStream from '@/app/right-sidebar/terminal/agent-terminal-stream'
import * as legacyAtlas from '@/app/right-sidebar/terminal/atlas'
import * as legacyBuffer from '@/app/right-sidebar/terminal/buffer'
import * as legacyMenu from '@/app/right-sidebar/terminal/terminal-context-menu'
import * as legacyFont from '@/app/right-sidebar/terminal/terminal-font'
import * as legacyTerminals from '@/app/right-sidebar/terminal/terminals'

import * as stream from './agent-terminal-stream'
import * as atlas from './atlas'
import * as buffer from './buffer'
import { $terminalInjection, $terminalTakeover, runInTerminal } from './store'
import * as store from './store'
import * as menu from './terminal-context-menu'
import * as font from './terminal-font'
import * as terminals from './terminals'

/** The iT terminal engine moved out of the upstream right sidebar (E3c).
 *  These cases pin the three things the move must not change: ONE engine
 *  instance behind the legacy module paths other fronts still import, the
 *  engine files gone from the sidebar folder, and the takeover store's
 *  persisted key (PLANO L §2.2 freezes storage keys). */

const SIDEBAR_ROOT = resolve(process.cwd(), 'src/app/right-sidebar')
const SIDEBAR_TERMINAL = resolve(SIDEBAR_ROOT, 'terminal')

type Pair = [string, Record<string, unknown>, Record<string, unknown>]

const SHIMS: Pair[] = [
  ['agent-terminal-stream.ts', legacyStream, stream],
  ['atlas.ts', legacyAtlas, atlas],
  ['buffer.ts', legacyBuffer, buffer],
  ['terminal-context-menu.ts', legacyMenu, menu],
  ['terminal-font.ts', legacyFont, font],
  ['terminals.ts', legacyTerminals, terminals]
]

/** Engine modules that must no longer exist under the sidebar. */
const MOVED = [
  'active-resize.ts',
  'active-resize.test.ts',
  'agent-terminal-stream.test.ts',
  'atlas.test.ts',
  'clipboard.ts',
  'clipboard.test.ts',
  'instance.tsx',
  'links.ts',
  'links.test.ts',
  'revive-buffer.test.ts',
  'selection.ts',
  'terminal-font.test.ts',
  'terminals.test.ts',
  'use-agent-terminal.ts',
  'use-agent-terminal.test.tsx',
  'use-terminal-font.ts',
  'use-terminal-font.test.tsx',
  'use-terminal-session.ts'
]

/** Deleted with the move: the upstream deck-terminal UI (chrome, rail,
 *  persistent, workspace — E3c r3) and the whole files / review sidebar
 *  cluster (E3c r4). iclone os has ONE terminal — iT (home/it-terminal.tsx) —
 *  so nothing rendered `WiredPane part="terminal"` any more, and OUR home
 *  stage replaces the sidebars, so neither had a renderer left. Both deletions
 *  are pinned by the EXACT folder listings below, not by name lists: a file
 *  coming back is a new legacy path and fails here. */
const SIDEBAR_LEFT = ['store.ts', 'terminal']

describe('the iT engine lives under app/home/it/engine', () => {
  it('the legacy sidebar paths re-export the one engine, binding for binding', () => {
    const pairs: Pair[] = [...SHIMS, ['../store.ts', legacyStore, store]]

    for (const [name, legacy, engine] of pairs) {
      expect(Object.keys(legacy).sort(), name).toEqual(Object.keys(engine).sort())

      for (const key of Object.keys(engine)) {
        expect(legacy[key], `${name} ${key}`).toBe(engine[key])
      }
    }
  })

  it('the moved files are gone from the sidebar, and what is left there is a one-line re-export', () => {
    const left = readdirSync(SIDEBAR_TERMINAL)

    expect(left.filter(name => MOVED.includes(name))).toEqual([])

    for (const [shim] of SHIMS) {
      const source = readFileSync(resolve(SIDEBAR_TERMINAL, shim), 'utf8')

      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)

      expect(code, shim).toEqual([`export * from '@/app/home/it/engine/${shim.replace(/\.ts$/, '')}'`])
    }
  })

  it('deleted the upstream deck-terminal UI, leaving only the re-export shims', () => {
    // Exact set, not a subset: a new file in the folder is a new legacy path.
    expect(readdirSync(SIDEBAR_TERMINAL).sort()).toEqual(SHIMS.map(([name]) => name).sort())
  })

  it('deleted the upstream files and review sidebars, code and tests', () => {
    for (const gone of ['file-actions.tsx', 'files', 'index.test.tsx', 'index.tsx', 'review']) {
      expect(existsSync(resolve(SIDEBAR_ROOT, gone)), gone).toBe(false)
    }

    // All that is left of the upstream right sidebar is the legacy re-export
    // surface the engine moved out from under.
    expect(readdirSync(SIDEBAR_ROOT).sort()).toEqual(SIDEBAR_LEFT)
  })

  it('keeps the persisted takeover key the installed app already wrote', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/home/it/engine/store.ts'), 'utf8')

    expect(source).toContain("'hermes.desktop.terminalTakeover'")
  })
})

describe('runInTerminal', () => {
  beforeEach(() => {
    $terminalTakeover.set(false)
    $terminalInjection.set(null)
  })

  it('opens the terminal and queues the trimmed command', () => {
    runInTerminal('  hermes auth logout  ')

    expect($terminalTakeover.get()).toBe(true)
    expect($terminalInjection.get()).toBe('hermes auth logout')
  })

  it('ignores a blank command, so nothing opens on an empty click', () => {
    runInTerminal('   ')

    expect($terminalTakeover.get()).toBe(false)
    expect($terminalInjection.get()).toBeNull()
  })
})
