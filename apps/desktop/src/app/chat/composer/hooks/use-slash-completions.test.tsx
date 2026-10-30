import type { Unstable_TriggerItem } from '@assistant-ui/core'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HermesGateway } from '@/hermes'
import { queryClient } from '@/lib/query-client'
import { invalidateSlashCompletions } from '@/lib/slash-completion-cache'

import { isSkillItem } from '../composer-utils'
import { ComposerTriggerPopover } from '../trigger-popover'

import { useSlashCompletions } from './use-slash-completions'

const CATALOG = {
  categories: [{ name: 'Session', pairs: [['/new', 'Start a new session']] }],
  pairs: [
    ['/new', 'Start a new session'],
    ['/work', 'Kick off a task in a fresh worktree']
  ]
}

// A catalog shaped like a real install: a couple of skills the user lives in,
// a bundled one they have never opened, and one of their own they haven't
// either.
const RANKED_CATALOG = {
  categories: [{ name: 'Session', pairs: [['/new', 'Start a new session']] }],
  pairs: [
    ['/new', 'Start a new session'],
    ['/docx', 'Edit Word documents'],
    ['/research', 'Look it up before answering'],
    ['/research-paper-writing', 'Write an academic paper'],
    ['/work', 'Kick off a task in a fresh worktree']
  ],
  skills: {
    '/docx': { usage: 0, origin: 'local' },
    '/research': { usage: 60, origin: 'local' },
    '/research-paper-writing': { usage: 0, origin: 'bundled' },
    '/work': { usage: 172, origin: 'local' }
  }
}

const commandsOf = (items: readonly Unstable_TriggerItem[]) =>
  items.map(item => (item.metadata as { command?: string })?.command)

function harness(gateway: HermesGateway) {
  const api: { search?: (query: string) => readonly Unstable_TriggerItem[] } = {}

  function Probe() {
    const { adapter } = useSlashCompletions({ gateway })
    api.search = adapter.search

    return null
  }

  render(<Probe />)

  return api as { search: (query: string) => readonly Unstable_TriggerItem[] }
}

/** Drive the adapter until its async fetch has settled into `search`'s result. */
async function completions(api: { search: (query: string) => readonly Unstable_TriggerItem[] }, query: string) {
  await act(async () => {
    api.search(query)
    await Promise.resolve()
  })

  // The debounce is skipped only for cached queries; give the timer a beat.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 120))
  })

  return api.search(query)
}

afterEach(() => {
  cleanup()
  queryClient.clear()
})

describe('useSlashCompletions', () => {
  it('serves the bare-slash catalog from cache instead of re-requesting it', async () => {
    const request = vi.fn().mockResolvedValue(CATALOG)
    const api = harness({ request } as unknown as HermesGateway)

    await completions(api, '')
    expect(request).toHaveBeenCalledTimes(1)

    // Reopening `/` must not hit the gateway again.
    queryClient.setQueryData(['unrelated'], 1)
    await completions(api, '')
    expect(request).toHaveBeenCalledTimes(1)

    // …until something that changes the command set invalidates it.
    await act(async () => invalidateSlashCompletions())
    await completions(api, '')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('offers skill commands on a bare slash, not just built-ins', async () => {
    const request = vi.fn().mockResolvedValue(CATALOG)
    const api = harness({ request } as unknown as HermesGateway)

    const items = await completions(api, '')
    const work = items.find(item => (item.metadata as { command?: string })?.command === '/work')

    expect((work?.metadata as { group?: string })?.group).toBe('Skills')
  })

  // A `/` typed mid-message is a reference dropped into prose, so the trigger
  // filters the list to skills (use-composer-trigger). A bare mid-message `/`
  // resolves to the same empty query as an opening `/`, so that filter runs
  // over the catalog — which listed no skill-group rows at all, leaving the
  // inline popover empty. Asserted through isSkillItem, the real predicate.
  it('leaves only skills for a mid-message slash', async () => {
    const request = vi.fn().mockResolvedValue(CATALOG)
    const api = harness({ request } as unknown as HermesGateway)

    const inline = (await completions(api, '')).filter(isSkillItem)

    expect(inline.map(item => (item.metadata as { command?: string })?.command)).toEqual(['/work'])
  })

  // An alphabetical `/` menu buries the skills someone runs daily under the
  // ones that shipped with Hermes and were never opened.
  it('orders skills by use and hides never-used built-ins on a bare slash', async () => {
    const request = vi.fn().mockResolvedValue(RANKED_CATALOG)
    const api = harness({ request } as unknown as HermesGateway)

    const skills = commandsOf((await completions(api, '')).filter(isSkillItem))

    expect(skills).toEqual(['/work', '/research', '/docx'])
  })

  // Typing is a search, and a search that hides a match is broken — the
  // never-used built-in still shows, just below the one she actually uses.
  it('ranks a typed query by use without hiding anything', async () => {
    const request = vi.fn().mockImplementation((method: string) =>
      Promise.resolve(
        method === 'commands.catalog'
          ? RANKED_CATALOG
          : {
              items: [
                { text: '/research-paper-writing', display: '/research-paper-writing', meta: 'Write a paper' },
                { text: '/research', display: '/research', meta: 'Look it up' }
              ]
            }
      )
    )

    const api = harness({ request } as unknown as HermesGateway)

    // Warm the catalog first: the popover always opens on a bare `/` before a
    // query is typed, which is where the usage map comes from.
    await completions(api, '')

    expect(commandsOf(await completions(api, 'research'))).toEqual(['/research', '/research-paper-writing'])
  })
  it('offers no arguments for a command the desktop fences (the runtime still lists its options)', async () => {
    const request = vi.fn().mockImplementation((method: string) =>
      Promise.resolve(
        method === 'commands.catalog'
          ? CATALOG
          : {
              items: [
                { text: 'on', display: 'on', meta: 'Turn it on' },
                { text: 'off', display: 'off', meta: 'Turn it off' }
              ],
              replace_from: 8
            }
      )
    )

    const api = harness({ request } as unknown as HermesGateway)

    expect(await completions(api, 'prompt ')).toEqual([])
    expect(await completions(api, 'compose ')).toEqual([])
    expect(request.mock.calls.filter(([method]) => method === 'complete.slash')).toEqual([])
  })
})

// V3-B — the words a row carries (also-alias, library tag, needs), the data-driven fence of terminal-only backend
// verbs, and the popover's cost with a library-sized skill list.
describe('useSlashCompletions (V3-B)', () => {
  const FENCED_CATALOG = {
    categories: [
      {
        name: 'Session',
        pairs: [
          ['/new', 'Start a new session'],
          ['/compress', 'Compress this conversation context']
        ]
      },
      { name: 'Tools & Skills', pairs: [['/fence-me', 'A terminal-only verb of the runtime']] }
    ],
    pairs: [
      ['/new', 'Start a new session'],
      ['/compress', 'Compress this conversation context'],
      ['/fence-me', 'A terminal-only verb of the runtime'],
      ['/ridervoice', "Use when speaking text in the owner's own voice. More."],
      ['/hm-qa', 'Use when testing everything. More.'],
      ['/work', 'Kick off a task in a fresh worktree']
    ],
    canon: { '/fm': '/fence-me', '/compact': '/compress' },
    skills: {
      '/ridervoice': { usage: 3, origin: 'local' },
      '/hm-qa': { usage: 2, origin: 'local' },
      '/work': { usage: 1, origin: 'local' }
    }
  }

  const ICLONE_CATALOG = {
    schema: 1,
    category: 'iclone',
    count: 2,
    skills: [
      {
        name: 'ridervoice',
        version: '1.0.0',
        description: 'x',
        whenToOpen: 'x',
        tags: [],
        relatedSkills: [],
        port: {
          version: '1.0.0',
          portedAt: '2026-10-21T10:00:00.000Z',
          requires: { os: ['macos'], bins: ['ffmpeg'], mcp: [], paths: [] },
          touches: ['X'],
          needs: [{ kind: 'bin', name: 'ffmpeg' }]
        }
      },
      {
        name: 'hm-qa',
        version: '1.0.0',
        description: 'x',
        whenToOpen: 'x',
        tags: [],
        relatedSkills: [],
        port: {
          version: '1.0.0',
          portedAt: '2026-10-21T10:00:00.000Z',
          requires: { os: [], bins: [], mcp: [], paths: [] },
          touches: [],
          needs: []
        }
      }
    ]
  }

  const metaOf = (items: readonly Unstable_TriggerItem[], command: string) =>
    (items.find(item => (item.metadata as { command?: string })?.command === command)?.metadata as { meta?: string })
      ?.meta

  const withBridge = () => {
    ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
      icloneSkills: { catalog: vi.fn().mockResolvedValue(ICLONE_CATALOG), last: vi.fn(), sync: vi.fn() }
    }
  }

  afterEach(() => {
    delete (window as { hermesDesktop?: unknown }).hermesDesktop
  })

  it('the /compress row says "also /compact"; /compact itself is still one row, not two', async () => {
    const request = vi.fn().mockResolvedValue(FENCED_CATALOG)
    const api = harness({ request } as unknown as HermesGateway)
    const items = await completions(api, '')

    expect(metaOf(items, '/compress')).toBe('Compress this conversation context · also /compact')
    expect(commandsOf(items)).not.toContain('/compact')
  })

  it('a ported skill row is tagged "from your library" and names what this machine lacks', async () => {
    withBridge()
    const request = vi.fn().mockResolvedValue(FENCED_CATALOG)
    const api = harness({ request } as unknown as HermesGateway)
    const items = await completions(api, '')

    expect(metaOf(items, '/hm-qa')).toBe('Use when testing everything. More. · from your library')
    expect(metaOf(items, '/ridervoice')).toBe(
      "Use when speaking text in the owner's own voice. More. · from your library · needs ffmpeg"
    )
    expect(metaOf(items, '/work')).toBe('Kick off a task in a fresh worktree')
  })

  it('the tags follow a typed query too', async () => {
    withBridge()

    const request = vi
      .fn()
      .mockImplementation((method: string) =>
        Promise.resolve(
          method === 'commands.catalog'
            ? FENCED_CATALOG
            : { items: [{ text: '/ridervoice', display: '/ridervoice', meta: 'Use when speaking.' }] }
        )
      )

    const api = harness({ request } as unknown as HermesGateway)

    await completions(api, '')
    expect(metaOf(await completions(api, 'rider'), '/ridervoice')).toBe(
      'Use when speaking. · from your library · needs ffmpeg'
    )
  })

  it('a categorised backend verb the desktop has no spec for gets no row, no alias row and no arguments', async () => {
    const request = vi.fn().mockImplementation((method: string) =>
      Promise.resolve(
        method === 'commands.catalog'
          ? FENCED_CATALOG
          : {
              items: [
                { text: '/fence-me', display: '/fence-me', meta: 'x' },
                { text: '/fm', display: '/fm', meta: 'x' },
                { text: '/new', display: '/new', meta: 'Start a new session' }
              ]
            }
      )
    )

    const api = harness({ request } as unknown as HermesGateway)

    expect(commandsOf(await completions(api, ''))).not.toContain('/fence-me')
    expect(commandsOf(await completions(api, 'f'))).toEqual(['/new'])
    expect(await completions(api, 'fence-me ')).toEqual([])
    expect(await completions(api, 'fm ')).toEqual([])
  })

  it('B9: the bare-slash popover with 54 skills — compute AND the real list render — opens well under 150 ms', async () => {
    withBridge()
    const pairs: [string, string][] = [['/new', 'Start a new session']]
    const skills: Record<string, { usage: number; origin: string }> = {}

    for (let i = 0; i < 54; i++) {
      pairs.push([`/skill-${i}`, `Use when skill ${i} matches. More words about it.`])
      skills[`/skill-${i}`] = { usage: (i % 7) + 1, origin: i % 3 ? 'local' : 'bundled' }
    }

    const request = vi.fn().mockResolvedValue({ categories: FENCED_CATALOG.categories, pairs, skills, canon: {} })
    const api = harness({ request } as unknown as HermesGateway)

    // Warm the caches once (the gateway round trip is the backend's time, not the popover's), then measure the
    // path the user feels: a fresh compute of the list from the cached catalog plus the real popover component
    // painting every row into the DOM. jsdom paints no pixels; this is the React render path, not a frame.
    await completions(api, '')

    const started = performance.now()
    const items = api.search('')

    const { container } = render(
      <ComposerTriggerPopover
        activeIndex={0}
        items={items}
        kind="/"
        loading={false}
        onHover={() => undefined}
        onPick={() => undefined}
      />
    )

    const elapsed = performance.now() - started

    expect(items.length).toBeGreaterThanOrEqual(54)
    expect(container.querySelectorAll('[role="listbox"] button').length).toBe(items.length)
    expect(elapsed).toBeLessThan(150)
  })

  // V3-B r2 (F7): the desktop's own commands appear where every other command does — the bare list under their
  // registry section, typed completion by prefix — without the backend knowing them.
  it('F7: the bare / list carries /skills under Tools & Skills and /mode under Configuration', async () => {
    const request = vi.fn().mockResolvedValue(FENCED_CATALOG)
    const api = harness({ request } as unknown as HermesGateway)
    const items = await completions(api, '')

    const groupOf = (command: string) =>
      (items.find(item => (item.metadata as { command?: string })?.command === command)?.metadata as { group?: string })
        ?.group

    expect(groupOf('/skills')).toBe('Tools & Skills')
    expect(groupOf('/mode')).toBe('Configuration')
    expect(commandsOf(items).filter(c => c === '/mode')).toHaveLength(1)
    expect(metaOf(items, '/mode')).toContain('Manual')
    expect(isSkillItem(items.find(item => (item.metadata as { command?: string })?.command === '/skills')!)).toBe(false)
  })

  it('F7: typing /mo completes /mode and /sk completes /skills, after the backend rows and never twice', async () => {
    const request = vi
      .fn()
      .mockImplementation((method: string, params?: { text?: string }) =>
        Promise.resolve(
          method === 'commands.catalog'
            ? FENCED_CATALOG
            : params?.text === '/sk'
              ? { items: [{ text: '/skills', display: '/skills', meta: 'Manage skills' }] }
              : { items: [{ text: '/model', display: '/model', meta: 'Switch model' }] }
        )
      )

    const api = harness({ request } as unknown as HermesGateway)

    const mo = await completions(api, 'mo')
    expect(commandsOf(mo)).toEqual(['/mode'])
    expect(metaOf(mo, '/mode')).toContain('Manual')

    const sk = await completions(api, 'sk')
    expect(commandsOf(sk)).toEqual(['/skills'])
    expect(metaOf(sk, '/skills')).toBe('List every skill, grouped, one line each')
  })
})
