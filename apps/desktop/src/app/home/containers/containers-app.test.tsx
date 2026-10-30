import { readFileSync } from 'node:fs'
import path from 'node:path'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Locale } from '@/i18n/types'
import {
  CONFINEMENT_STATE_SCHEMA,
  type ConfinementReason,
  type ConfinementStateView,
  type HardlinkAckResultView,
  type HardlinkBlockView,
  type KillResultView
} from '@/iclone-shared/confinement'
import { $confinement, type IcloneConfinementBridge } from '@/store/confinement'
import { setDockWindowSize } from '@/store/dock-window-size'

import type * as Window from '../window'

import { ContainersWindow } from './containers-app'
import { CONFINEMENT_COPY } from './containers-copy'
import { backendTone, confinedGroups, counts, sayReason } from './containers-data'
import { $containersOpen, useContainersDockItem } from './containers-dock'

vi.mock('../window', async importOriginal => ({
  ...(await importOriginal<typeof Window>()),
  // The real chassis' two attributes, so a case can read how the window opened (window/expanded.ts).
  IcWindow: ({
    children,
    expanded,
    head,
    id,
    onToggleExpanded
  }: {
    children: React.ReactNode
    expanded: boolean
    head: React.ReactNode
    id: string
    onToggleExpanded: () => void
  }) => (
    <div data-expanded={expanded ? 'true' : undefined} data-ic-window={id}>
      <button onClick={onToggleExpanded} type="button">
        toggle size
      </button>
      <header>{head}</header>
      {children}
    </div>
  )
}))

const SHA = 'b'.repeat(64)

const SAMPLE_REASONS: ConfinementReason[] = [
  { code: 'backend-not-confining', backend: 'seatbelt', detail: 'not-enforcing' },
  { code: 'backend-not-confining', backend: 'seatbelt', detail: 'probe-timeout' },
  { code: 'backend-not-confining', backend: 'seatbelt', detail: 'probe-failed' },
  { code: 'backend-not-confining', backend: 'container', detail: 'not-wired' },
  { code: 'plugin-not-loaded' },
  { code: 'profile-changed', cls: 'project' },
  { code: 'widened-profile', pid: 7, sha: 'abc' },
  { code: 'unknown-profile', pid: 7, sha: 'abc' },
  { code: 'agent-command-outside', pid: 7 },
  { code: 'forged-marker', pid: 7 },
  { code: 'membership-unverified' },
  { code: 'hardlink-appeared', pid: 7, root: '/p', path: '/p/x' },
  { code: 'settings-ignored' }
]

function view(over: Partial<ConfinementStateView> = {}): ConfinementStateView {
  return {
    schema: CONFINEMENT_STATE_SCHEMA,
    at: '2026-10-21T10:00:00.000Z',
    backend: 'seatbelt',
    enabled: true,
    verdict: 'green',
    reasons: [],
    backends: [
      {
        id: 'seatbelt',
        status: 'ready',
        enforcing: true,
        version: null,
        detail: 'enforcing',
        evidence: 'exit 1',
        ownerStep: null
      },
      {
        id: 'container',
        status: 'not-installed',
        enforcing: false,
        version: null,
        detail: 'not-installed',
        evidence: '/usr/local/bin/container',
        ownerStep: 'sudo installer -pkg container-1.5.0-installer-signed.pkg -target /'
      }
    ],
    defaultClass: 'project',
    profiles: [
      { cls: 'project', sha256: SHA, network: 'grant', reads: ['project'], writes: ['scratch'], denied: ['/x'] }
    ],
    inside: [
      {
        pid: 4100,
        ppid: 1,
        root: 4100,
        cls: 'project',
        profileSha: SHA.slice(0, 12),
        profileKnown: true,
        widened: false,
        sessionId: 's-1',
        elapsedSec: 12,
        command: '/bin/bash -c npm test iclone-confined:project:bbbbbbbbbbbb:s-1'
      },
      {
        pid: 4101,
        ppid: 4100,
        root: 4100,
        cls: 'project',
        profileSha: SHA.slice(0, 12),
        profileKnown: true,
        widened: false,
        sessionId: 's-1',
        elapsedSec: 11,
        command: 'node jest'
      }
    ],
    outside: [{ pid: 900, ppid: 1, kind: 'hermes', elapsedSec: 600, command: 'python -m hermes' }],
    agents: [
      {
        sessionId: 's-1',
        inft: 'i01-7',
        lastTs: '2026-10-21T09:59:00Z',
        inside: 2,
        outside: 0,
        actions: [{ ts: '2026-10-21T09:59:00Z', kind: 'use', tool: 'terminal', target: 'npm test', outcome: null }]
      }
    ],
    refusals: [
      {
        ts: '2026-10-21T09:58:00Z',
        pid: 4102,
        process: 'cat',
        operation: 'file-read-data',
        target: '/Users/o/.ssh/id_ed25519',
        sessionId: 's-1'
      }
    ],
    hardlinks: [],
    scope: { confined: ['terminal', 'execute_code', 'file tools'], notConfined: ['MCP servers', 'browser'] },
    ...over
  }
}

const bridge = {
  state: vi.fn(async (): Promise<ConfinementStateView | null> => view()),
  kill: vi.fn(async (pid: number): Promise<KillResultView> => ({ ok: true, pid, killed: [pid, pid + 1] })),
  explain: vi.fn(async () => ['class project · profile bbbbbbbbbbbb', 'writes: scratch']),
  ackHardlink: vi.fn(
    async ({ dir }: { root: string; dir: string; digest: string }): Promise<HardlinkAckResultView> => ({
      ok: true,
      dir,
      count: 2
    })
  ),
  onChanged: vi.fn((_callback: () => void) => () => undefined)
} satisfies IcloneConfinementBridge

function Tile({ onOpen }: { onOpen: () => void }) {
  const item = useContainersDockItem('⌘⇧8', onOpen)

  return (
    <button aria-pressed={item.active} onClick={item.onSelect} type="button">
      {item.label}
    </button>
  )
}

beforeEach(() => {
  Object.assign(window, { hermesDesktop: { ...(window.hermesDesktop ?? {}), icloneConfinement: bridge } })
  $confinement.set({ status: 'loading', state: null, error: null })
  $containersOpen.set(false)
  bridge.state.mockImplementation(async () => view())
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function openPane(blocked = false) {
  const onOpen = vi.fn()

  render(
    <>
      <Tile onOpen={onOpen} />
      <ContainersWindow blocked={blocked} />
    </>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Containers' }))

  return onOpen
}

describe('the Containers Dock tile and window', () => {
  it('opens from the tile, closes the other Dock window first, and reads the live state', async () => {
    const onOpen = await openPane()

    expect(onOpen).toHaveBeenCalledTimes(1)
    await screen.findByText('Confined')
    expect(bridge.state).toHaveBeenCalled()
    expect(screen.getByText(/1 inside · 0 outside/)).toBeTruthy()
    expect(screen.getAllByText('4100').length).toBeGreaterThan(0)
    expect(screen.getByText(/Confined: the terminal, code execution, the file tools, and the browser/)).toBeTruthy()
    // V3-UP r5 (critic r4 m3): MCP servers do not start at all while confined
    expect(screen.getByText(/Off while confined: MCP servers/)).toBeTruthy()
  })

  it('Kill sends exactly that pid to main and says what stopped', async () => {
    await openPane()
    await screen.findByText('Confined')
    fireEvent.click(screen.getAllByRole('button', { name: 'Kill' })[0])
    await screen.findByText('Stopped 2 processes')
    expect(bridge.kill).toHaveBeenCalledWith(4100)
  })

  it('F1 — a Kill that leaves survivors says "could not stop N", never "stopped"', async () => {
    bridge.kill.mockImplementationOnce(async pid => ({
      ok: false,
      pid,
      reason: 'survivors',
      survivors: [4100, 4101],
      error: 'could not stop 2'
    }))
    await openPane()
    await screen.findByText('Confined')
    fireEvent.click(screen.getAllByRole('button', { name: 'Kill' })[0])
    await screen.findByText('Could not stop 2 processes')
    expect(screen.queryByText(/Stopped/)).toBeNull()
  })

  it('F5 — Hermes without its confinement plugin: not green, and the shell is said to be blocked', async () => {
    bridge.state.mockImplementation(async () => view({ verdict: 'red', reasons: [{ code: 'plugin-not-loaded' }] }))
    await openPane()
    await screen.findByText('Not confined')
    expect(screen.getByText(/Shell blocked: confinement not loaded/)).toBeTruthy()
    expect(screen.queryByText('Confined')).toBeNull()
  })

  it('F7/T2 — a project refused for its hard links says why, shows one group per folder with 3 samples, and one Allow sends that group with its digest', async () => {
    const pnpm = '/Users/me/proj/node_modules/.pnpm'

    const block: HardlinkBlockView = {
      root: '/Users/me/proj',
      kind: 'hard-links',
      paths: [`${pnpm}/pkg0/index.js`, `${pnpm}/pkg1/index.js`, `${pnpm}/pkg2/index.js`],
      count: 501,
      groups: [
        {
          dir: pnpm,
          paths: [`${pnpm}/pkg0/index.js`, `${pnpm}/pkg1/index.js`, `${pnpm}/pkg2/index.js`],
          count: 500,
          digest: 'abcdef0123456789'
        },
        { dir: '/Users/me/proj/src', paths: ['/Users/me/proj/src/planted'], count: 1, digest: '0123456789abcdef' }
      ]
    }

    bridge.state.mockImplementation(async () => view({ hardlinks: [block] }))
    await openPane()
    await screen.findByText(/Confinement will not start in \/Users\/me\/proj/)
    expect(screen.getByText(/and 498 more are hard links to a file outside the project/)).toBeTruthy()
    expect(screen.getByText(`The 500 files under ${pnpm} — hard links to outside the project`)).toBeTruthy()
    expect(screen.getByText('The 1 file under /Users/me/proj/src — hard links to outside the project')).toBeTruthy()
    expect(screen.getByText(`${pnpm}/pkg2/index.js`)).toBeTruthy()

    // One button per group (two), never one per file (501): the pnpm store is one gesture.
    const allow = screen.getAllByRole('button', { name: /^Allow/ })

    expect(allow.map(button => button.textContent)).toEqual(['Allow 500 files', 'Allow this file'])
    // The preload's lock only counts a click on a control inside data-confinement-confirm.
    expect(allow.every(button => button.closest('[data-confinement-confirm]') !== null)).toBe(true)
    fireEvent.click(allow[0])
    await screen.findByText('Allowed: these 2 files, as they are now')
    expect(bridge.ackHardlink).toHaveBeenCalledTimes(1)
    expect(bridge.ackHardlink).toHaveBeenCalledWith({ root: block.root, dir: pnpm, digest: 'abcdef0123456789' })
  })

  it('F7/T1 — a project that cannot be scanned names the folder and offers nothing to allow', async () => {
    bridge.state.mockImplementation(async () =>
      view({ hardlinks: [{ root: '/p', kind: 'cannot-scan', paths: ['/p/hidden'], count: 1, groups: [] }] })
    )
    await openPane()
    await screen.findByText(/Confinement will not start in \/p: it cannot list \/p\/hidden/)
    expect(screen.queryAllByRole('button', { name: /^Allow/ })).toEqual([])
  })

  it('F7 — an acknowledgement main refuses is said, not shown as allowed; a changed set asks to read again', async () => {
    bridge.state.mockImplementation(async () =>
      view({
        hardlinks: [
          {
            root: '/p',
            kind: 'hard-links',
            paths: ['/p/a'],
            count: 1,
            groups: [{ dir: '/p', paths: ['/p/a'], count: 1, digest: 'd' }]
          }
        ]
      })
    )
    bridge.ackHardlink.mockImplementationOnce(async () => ({ ok: false, reason: 'no-gesture' }))
    await openPane()
    fireEvent.click(await screen.findByRole('button', { name: 'Allow this file' }))
    await screen.findByText('Not allowed: click the button yourself')
    expect(screen.queryByText(/Allowed:/)).toBeNull()
    bridge.ackHardlink.mockImplementationOnce(async () => ({ ok: false, reason: 'changed' }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow this file' }))
    await screen.findByText(/changed since they were shown/)
  })

  it('T4 — the pane says the package caches are not scanned for hard links', async () => {
    await openPane()
    await screen.findByText(/Package caches .* are not scanned for hard links/)
  })

  it('Follow shows main’s explanation of the profile and the live tree', async () => {
    await openPane()
    await screen.findByText('Confined')
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }))
    await screen.findByText('Following 4100')
    await screen.findByText('writes: scratch')
    expect(bridge.explain).toHaveBeenCalledWith(4100)
  })

  it('RED: the reasons are on screen and an escaped agent command is listed outside', async () => {
    bridge.state.mockImplementation(async () =>
      view({
        verdict: 'red',
        reasons: [{ code: 'agent-command-outside', pid: 777 }],
        outside: [{ pid: 777, ppid: 900, kind: 'agent-command', elapsedSec: 1, command: 'curl evil' }]
      })
    )
    await openPane()
    await screen.findByText('Not confined')
    expect(screen.getByText(/Agent command 777 runs outside confinement/)).toBeTruthy()
    expect(screen.getByText('Agent command, not confined')).toBeTruthy()
  })

  it('the other sections render from the state: agents, profiles, refusals, backends', async () => {
    await openPane()
    await screen.findByText('Confined')
    fireEvent.click(screen.getByRole('button', { name: /Agents/ }))
    await screen.findByText('i01-7')
    fireEvent.click(screen.getByRole('button', { name: /Profiles/ }))
    await screen.findByText('Writes the project and its scratch.')
    fireEvent.click(screen.getByRole('button', { name: /Refusals/ }))
    await screen.findByText('/Users/o/.ssh/id_ed25519')
    fireEvent.click(screen.getByRole('button', { name: /Backends/ }))
    await screen.findByText(/Not installed\. Installing it is your step/)
    expect(screen.getByText(/sudo installer -pkg container-1\.5\.0/)).toBeTruthy()
    expect(screen.getByText('Enforcing: a control profile denied its canary.')).toBeTruthy()
  })

  it('K130 — a correct Apple container install is neutral "Installed" with its version, never the red "Not working"', async () => {
    const base = view()

    bridge.state.mockImplementation(async () => ({
      ...base,
      backends: [
        base.backends[0],
        {
          id: 'container',
          status: 'installed',
          enforcing: false,
          version: '1.5.0',
          detail: 'not-wired',
          evidence: '/usr/local/bin/container 1.5.0',
          ownerStep: null
        }
      ]
    }))
    await openPane()
    await screen.findByText('Confined')
    fireEvent.click(screen.getByRole('button', { name: /Backends/ }))

    const pill = await screen.findByText('Installed')
    const row = pill.closest('.e-row') as HTMLElement

    expect(pill.className).toBe('e-pill e-pill--muted')
    expect(row.textContent).toContain('1.5.0')
    expect(row.textContent).toContain('Not used in this version: icloneOS confines commands with Seatbelt only.')
    expect(screen.queryByText('Not working')).toBeNull()
    expect(row.querySelector('.e-pill--down')).toBeNull()
    expect(row.querySelector('.icont__owner-step')).toBeNull()
  })

  it('K130 — red stays for a genuinely broken install: present, but it does not answer its version', async () => {
    const base = view()

    bridge.state.mockImplementation(async () => ({
      ...base,
      backends: [
        base.backends[0],
        {
          id: 'container',
          status: 'broken',
          enforcing: false,
          version: null,
          detail: 'no-version',
          evidence: '/usr/local/bin/container --version: exit 1',
          ownerStep: null
        }
      ]
    }))
    await openPane()
    await screen.findByText('Confined')
    fireEvent.click(screen.getByRole('button', { name: /Backends/ }))

    const pill = await screen.findByText('Not working')

    expect(pill.className).toBe('e-pill e-pill--down')
    expect(screen.getByText(/Installed, but it did not answer a version check/)).toBeTruthy()
  })

  it('G3-2 — a check that timed out under load reads neutral "Could not check", never the red "Not working"', async () => {
    const base = view()

    bridge.state.mockImplementation(async () => ({
      ...base,
      backends: [
        base.backends[0],
        {
          id: 'container',
          status: 'unknown',
          enforcing: false,
          version: null,
          detail: 'probe-timeout',
          evidence: '/usr/local/bin/container --version: timed out: ',
          ownerStep: null
        }
      ]
    }))
    await openPane()
    await screen.findByText('Confined')
    fireEvent.click(screen.getByRole('button', { name: /Backends/ }))

    const pill = await screen.findByText('Could not check')
    const row = pill.closest('.e-row') as HTMLElement

    expect(pill.className).toBe('e-pill e-pill--muted')
    expect(row.textContent).toContain(
      'The check did not finish in time: this Mac may have been busy. It runs again shortly.'
    )
    expect(screen.queryByText('Not working')).toBeNull()
    expect(row.querySelector('.e-pill--down')).toBeNull()
  })

  it('M-1 — a Seatbelt check that timed out stays red (fail-closed) but never claims Seatbelt is not confining', async () => {
    const base = view()

    bridge.state.mockImplementation(async () => ({
      ...base,
      verdict: 'red',
      reasons: [{ code: 'backend-not-confining', backend: 'seatbelt', detail: 'probe-timeout' }],
      backends: [
        {
          id: 'seatbelt',
          status: 'unknown',
          enforcing: false,
          version: null,
          detail: 'probe-timeout',
          evidence: 'timed out',
          ownerStep: null
        },
        base.backends[1]
      ]
    }))
    await openPane()

    const verdict = await screen.findByText('Not confined')

    expect(verdict.className).toBe('e-pill e-pill--down')
    // M-1r2: the red hint is true for every red, a timeout included: nothing is said to run outside.
    expect(screen.getByText('Confinement is not verified. The reasons are below.')).toBeTruthy()
    expect(screen.queryByText(/outside its profile/)).toBeNull()
    expect(
      screen.getByText(/Seatbelt could not be checked in time: confinement is not verified right now/)
    ).toBeTruthy()
    expect(screen.queryByText(/is not confining/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Backends/ }))
    expect((await screen.findByText('Could not check')).className).toBe('e-pill e-pill--muted')
    expect(screen.queryByText(/is not confining/)).toBeNull()
  })

  it('M-1r2 — the plugin not loaded (every command refused, nothing runs): the red hint claims nothing runs outside', async () => {
    bridge.state.mockImplementation(async () => view({ verdict: 'red', reasons: [{ code: 'plugin-not-loaded' }] }))
    await openPane()
    await screen.findByText('Not confined')
    expect(screen.getByText('Confinement is not verified. The reasons are below.')).toBeTruthy()
    expect(screen.queryByText(/outside its profile/)).toBeNull()
  })

  it.each(Object.keys(CONFINEMENT_COPY) as (keyof typeof CONFINEMENT_COPY)[])(
    'M-1r2 — %s: the red hint is not the old "something runs outside its profile" claim',
    locale => {
      const falseClaims = [
        'Something runs outside its profile. The reasons are below.',
        'Há algo a ser executado fora do respetivo perfil. As razões estão abaixo.',
        '有内容在配置文件之外运行。原因见下方。',
        '有內容在設定檔之外執行。原因見下方。',
        'プロファイル外で動いているものがあります。理由は下にあります。',
        'هناك ما يعمل خارج ملفّه التعريفي. الأسباب أدناه.'
      ]

      expect(falseClaims).not.toContain(CONFINEMENT_COPY[locale].verdict.red.hint)
    }
  )

  it.each(Object.keys(CONFINEMENT_COPY) as (keyof typeof CONFINEMENT_COPY)[])(
    'M-1 — %s: a Seatbelt timeout is worded from its detail, never as the "not confining" sentence',
    locale => {
      const copy = CONFINEMENT_COPY[locale]
      const timedOut = sayReason(copy, { code: 'backend-not-confining', backend: 'seatbelt', detail: 'probe-timeout' })

      for (const detail of ['not-enforcing', 'cannot-run', 'binary-missing', null] as const) {
        const definite = sayReason(copy, { code: 'backend-not-confining', backend: 'seatbelt', detail })

        expect(timedOut, String(detail)).not.toBe(definite)
        expect(definite).toBe(
          sayReason(copy, { code: 'backend-not-confining', backend: 'seatbelt', detail: 'not-enforcing' })
        )
      }

      expect(timedOut).toContain('Seatbelt')
    }
  )

  it.each(Object.keys(CONFINEMENT_COPY) as (keyof typeof CONFINEMENT_COPY)[])(
    'G3 r3 m-1 — %s: a Seatbelt probe that threw is "could not be checked", never the "not confining" sentence',
    locale => {
      const copy = CONFINEMENT_COPY[locale]

      const say = (detail: 'probe-failed' | 'probe-timeout' | 'not-enforcing') =>
        sayReason(copy, { code: 'backend-not-confining', backend: 'seatbelt', detail })

      expect(say('probe-failed')).not.toBe(say('not-enforcing'))
      expect(say('probe-failed')).not.toBe(say('probe-timeout'))
      expect(say('probe-failed')).toContain('Seatbelt')
    }
  )

  it('G3 r3 nit — pt-PT status pills stay short (PT_PT_STYLE: 1–3 words, never longer than the English)', () => {
    const words = (text: string) => text.trim().split(/\s+/).length
    const { en } = CONFINEMENT_COPY

    for (const [status, label] of Object.entries(CONFINEMENT_COPY['pt-PT'].backendStatus)) {
      const english = en.backendStatus[status as keyof typeof en.backendStatus]

      expect(words(label), status).toBeLessThanOrEqual(Math.max(3, words(english)))
    }

    expect(CONFINEMENT_COPY['pt-PT'].backendStatus.unknown).toBe('Não verificado')
  })

  it('G3 r3 m-1 — en: the probe-failed sentence says it could not be checked', () => {
    expect(
      sayReason(CONFINEMENT_COPY.en, { code: 'backend-not-confining', backend: 'seatbelt', detail: 'probe-failed' })
    ).toBe('Seatbelt could not be checked: the check itself failed, so confinement is not verified right now')
  })

  it('closes when another Dock window takes the stage', async () => {
    render(<ContainersWindow blocked />)
    expect(screen.queryByText('Containers')).toBeNull()
  })

  it('outside the desktop app it says so instead of an empty pane', async () => {
    Object.assign(window, { hermesDesktop: { ...(window.hermesDesktop ?? {}), icloneConfinement: undefined } })
    await openPane()
    await screen.findByText(/Containers run in the desktop app/)
  })
})

describe('pane numbers are lengths of arrays from the state (G3)', () => {
  it('K130 — the backend tone: red only for broken; installed-but-unused is neutral', () => {
    expect(backendTone('ready')).toBe('up')
    expect(backendTone('broken')).toBe('down')
    expect(backendTone('installed')).toBe('muted')
    expect(backendTone('not-installed')).toBe('warn')
    expect(backendTone('unsupported')).toBe('muted')
    expect(backendTone('unknown')).toBe('muted')
  })

  it('counts roots, not every process; outside counts only agent commands', () => {
    expect(counts(view())).toEqual({ inside: 1, outside: 0 })
    expect(confinedGroups(view())[0].children.map(child => child.pid)).toEqual([4101])
  })

  it('a refusal pushed by main triggers a fresh read, never an increment', async () => {
    let push: () => void = () => undefined

    bridge.onChanged.mockImplementation((callback: () => void) => {
      push = callback

      return () => undefined
    })
    await openPane()
    await screen.findByText('Confined')

    const before = bridge.state.mock.calls.length

    act(() => push())
    await waitFor(() => expect(bridge.state.mock.calls.length).toBeGreaterThan(before))
  })
})

type Leaf = ((...args: never[]) => string) | string

function leaves(node: object, prefix = ''): Map<string, Leaf> {
  const out = new Map<string, Leaf>()

  for (const [key, value] of Object.entries(node)) {
    const at = prefix ? `${prefix}.${key}` : key

    if (typeof value === 'object' && value !== null) {
      for (const [inner, leaf] of leaves(value, at)) {
        out.set(inner, leaf)
      }
    } else {
      out.set(at, value as Leaf)
    }
  }

  return out
}

describe('confinement.* copy in 6 locales', () => {
  const english = leaves(CONFINEMENT_COPY.en)
  const locales = Object.keys(CONFINEMENT_COPY) as Locale[]

  it('covers en, zh, zh-hant, ja, ar, pt-PT', () => {
    expect(locales.sort()).toEqual(['ar', 'en', 'ja', 'pt-PT', 'zh', 'zh-hant'])
  })

  it.each(locales)('%s has the identical key set, the same kinds of value, and no empty word', locale => {
    const mine = leaves(CONFINEMENT_COPY[locale])

    expect([...mine.keys()].sort()).toEqual([...english.keys()].sort())

    for (const [key, leaf] of mine) {
      expect(typeof leaf, key).toBe(typeof english.get(key))

      // Every catalogue function takes a number first; the hard-link sentence also takes its paths and their count.
      const text = typeof leaf === 'string' ? leaf : (leaf as (...args: unknown[]) => string)(3, ['/p/a'], 3)

      expect(text.trim().length, key).toBeGreaterThan(0)
    }
  })

  it.each(locales.filter(locale => locale !== 'en'))('%s is translated, not English left in place', locale => {
    const copy = CONFINEMENT_COPY[locale]

    expect(copy.scope).not.toBe(CONFINEMENT_COPY.en.scope)
    expect(copy.verdict.red.label).not.toBe(CONFINEMENT_COPY.en.verdict.red.label)

    // The status details and every reason (F5's "shell blocked" included) are words of this locale too.
    for (const [detail, text] of Object.entries(copy.backendDetail)) {
      expect(text, detail).not.toBe(CONFINEMENT_COPY.en.backendDetail[detail as keyof typeof copy.backendDetail])
    }

    for (const reason of SAMPLE_REASONS) {
      expect(sayReason(copy, reason), reason.code).not.toBe(sayReason(CONFINEMENT_COPY.en, reason))
    }

    for (const failure of ['survivors', 'unverified', 'not-confined', 'invalid'] as const) {
      expect(copy.killFailed[failure](2), failure).not.toBe(CONFINEMENT_COPY.en.killFailed[failure](2))
    }

    expect(copy.hardlinks.blocked('/p', ['/p/a'], 2)).not.toBe(CONFINEMENT_COPY.en.hardlinks.blocked('/p', ['/p/a'], 2))
    expect(copy.hardlinks.cannotScan('/p', ['/p/a'], 2)).not.toBe(
      CONFINEMENT_COPY.en.hardlinks.cannotScan('/p', ['/p/a'], 2)
    )
    expect(copy.hardlinks.group('/p', 500)).not.toBe(CONFINEMENT_COPY.en.hardlinks.group('/p', 500))
    expect(copy.hardlinks.allow(500)).not.toBe(CONFINEMENT_COPY.en.hardlinks.allow(500))
    expect(copy.hardlinks.cachesUnscanned).not.toBe(CONFINEMENT_COPY.en.hardlinks.cachesUnscanned)

    for (const [failure, text] of Object.entries(copy.hardlinks.ackFailed)) {
      expect(text, failure).not.toBe(
        CONFINEMENT_COPY.en.hardlinks.ackFailed[failure as keyof typeof copy.hardlinks.ackFailed]
      )
    }
  })

  it.each(locales)('%s: the hard-link refusal is one sentence that names up to 3 paths and counts the rest', locale => {
    for (const sentence of ['blocked', 'cannotScan'] as const) {
      const text = CONFINEMENT_COPY[locale].hardlinks[sentence]('/proj', ['/proj/a', '/proj/b', '/proj/c'], 5)

      for (const file of ['/proj', '/proj/a', '/proj/b', '/proj/c']) {
        expect(text, sentence).toContain(file)
      }

      expect(text, sentence).toMatch(/2|5/)
      expect(text.split(/[.。]\s*/).filter(Boolean), sentence).toHaveLength(1)
    }
  })

  it.each(locales)('%s: the group line carries the folder and the count, the caches line is one line', locale => {
    const copy = CONFINEMENT_COPY[locale].hardlinks

    expect(copy.group('/proj/node_modules/.pnpm', 500)).toContain('/proj/node_modules/.pnpm')
    expect(copy.group('/proj/node_modules/.pnpm', 500)).toContain('500')
    expect(copy.allow(500)).toContain('500')
    expect(copy.cachesUnscanned).not.toContain('\n')
    expect(copy.cachesUnscanned.split(/[.。]\s*/).filter(Boolean)).toHaveLength(1)
  })

  it('the scope line says what is measured: the browser and media helpers are confined too, MCP servers are off', () => {
    // V3-UP r5 (ruling 56, critic r4 m3): the browser runs inside the same sandbox; MCP servers do not start at all
    expect(CONFINEMENT_COPY.en.scope).toMatch(/Confined: the terminal, code execution, the file tools, and the browser/)
    expect(CONFINEMENT_COPY.en.scope).toMatch(/Off while confined: MCP servers/)
    expect(CONFINEMENT_COPY.en.scope).not.toMatch(/Not confined/)
  })
})

describe('G8 — theme: every colour is a token (K0 probe with its control)', () => {
  const HEX = /(?<![\w-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g
  const COLOR_FN = /(?<![\w-])(?:rgba?|hsla?|oklch|lab|lch|color)\(/gi
  const NAMED = /\b(?:red|green|blue|white|black|gray|grey|orange|yellow|purple|pink|transparent)\b/gi

  const COLOR_PROPS =
    /(?:^|[{;])\s*(color|background(?:-color)?|border(?:-[a-z-]+)?|outline(?:-color)?|fill|stroke|box-shadow)\s*:\s*([^;}]+)/gm

  const offTokens = (css: string): string[] => {
    const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const hits = [...(body.match(HEX) ?? []), ...(body.match(COLOR_FN) ?? [])]

    for (const match of body.matchAll(COLOR_PROPS)) {
      hits.push(...(match[2].match(NAMED) ?? []))
    }

    return hits
  }

  const css = readFileSync(path.join(import.meta.dirname, 'containers.css'), 'utf8')

  it('containers.css has 0 off-token colours', () => {
    expect(offTokens(css)).toEqual([])
  })

  it('the probe flags an injected off-token colour (control)', () => {
    expect(offTokens(`${css}\n.x { color: #ff3b30; }\n`)).toEqual(['#ff3b30'])
    expect(offTokens(`${css}\n.x { background: rgb(255 0 0); }\n`)).toEqual(['rgb('])
    expect(offTokens(`${css}\n.x { border-top: 1px solid red; }\n`)).toEqual(['red'])
  })

  it('every colour-bearing declaration reads a variable', () => {
    for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(COLOR_PROPS)) {
      expect(match[2], match[0]).toMatch(/var\(--/)
    }
  })
})

describe('how the Containers window opens (Settings › Machine › Appearance)', () => {
  afterEach(() => setDockWindowSize('maximized'))

  const frame = () => window.document.querySelector<HTMLElement>('[data-ic-window="containers"]')

  it('opens maximized by default', async () => {
    await openPane()

    expect(frame()?.dataset.expanded).toBe('true')
  })

  it('opens on its frame with the choice "normal size"', async () => {
    setDockWindowSize('normal')
    await openPane()

    expect(frame()).not.toBeNull()
    expect(frame()?.dataset.expanded).toBeUndefined()
  })
})
