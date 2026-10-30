import { describe, expect, it } from 'vitest'

import {
  desktopNativeSlashCompletions,
  desktopSkinSlashCompletions,
  desktopSlashCommandArgumentMode,
  desktopSlashDescription,
  desktopSlashInventory,
  desktopSlashTerminalOnlyMessage,
  desktopSlashUnavailableMessage,
  filterDesktopCommandsCatalog,
  isDesktopSlashCommand,
  isDesktopSlashExtensionCommand,
  isDesktopSlashSuggestion,
  isModelPickerCommand,
  isPickerCommand,
  rankSkillCommands,
  resolveDesktopCommand
} from './desktop-slash-commands'

describe('desktop slash command curation', () => {
  it('keeps core desktop chat commands in suggestions', () => {
    expect(isDesktopSlashSuggestion('/new')).toBe(true)
    expect(isDesktopSlashSuggestion('/branch')).toBe(true)
    expect(isDesktopSlashSuggestion('/skin')).toBe(true)
    expect(isDesktopSlashSuggestion('/usage')).toBe(true)
    expect(isDesktopSlashSuggestion('/version')).toBe(true)
    expect(isDesktopSlashSuggestion('/permissions')).toBe(true)
    // V3-F: the retired policy writers are aliases of the picker, never a write
    expect(isDesktopSlashSuggestion('/yolo')).toBe(false)
    expect(isDesktopSlashCommand('/yolo')).toBe(true)
    expect(resolveDesktopCommand('/yolo')?.surface).toEqual({ kind: 'action', action: 'permissions' })
    expect(resolveDesktopCommand('/approvals')?.surface).toEqual({ kind: 'action', action: 'permissions' })
  })

  it('surfaces skill and quick commands (extensions) in suggestions and lets them run', () => {
    expect(isDesktopSlashSuggestion('/my-skill')).toBe(true)
    expect(isDesktopSlashSuggestion('/gif-search')).toBe(true)
    expect(isDesktopSlashCommand('/my-skill')).toBe(true)
  })

  it('hides terminal, messaging, and dedicated-UI commands from suggestions', () => {
    expect(isDesktopSlashSuggestion('/clear')).toBe(false)
    expect(isDesktopSlashSuggestion('/density')).toBe(false)
    expect(isDesktopSlashSuggestion('/redraw')).toBe(false)
    expect(isDesktopSlashSuggestion('/approve')).toBe(false)
    expect(isDesktopSlashSuggestion('/model')).toBe(false)
    expect(isDesktopSlashSuggestion('/palette')).toBe(false)
    expect(isDesktopSlashSuggestion('/voice')).toBe(false)
    expect(isDesktopSlashSuggestion('/curator')).toBe(false)
  })

  it('/voice points at the composer voice button instead of the generic advanced message', () => {
    // /voice arms server-side capture — on the desktop the composer's own
    // voice conversation (mic menu / Ctrl+B) is the surface. A user typing
    // /voice must be told where the button IS, not shrugged at.
    expect(resolveDesktopCommand('/voice')?.surface).toEqual({ kind: 'unavailable', reason: 'composer-voice' })
    expect(isDesktopSlashCommand('/voice')).toBe(false)

    const message = desktopSlashUnavailableMessage('/voice')
    expect(message).toContain('microphone button')
    expect(message).toContain('Ctrl+B')
  })

  it('routes /compact to /compress (context compression), not the TUI display toggle', () => {
    expect(resolveDesktopCommand('/compact')?.name).toBe('/compress')
    expect(isDesktopSlashCommand('/compact')).toBe(true)
    // Alias stays out of the popover so /compress is the single visible entry.
    expect(isDesktopSlashSuggestion('/compact')).toBe(false)
    expect(isDesktopSlashSuggestion('/compress')).toBe(true)
  })

  it('surfaces /tools, /save, and /personality on the desktop', () => {
    expect(isDesktopSlashSuggestion('/tools')).toBe(true)
    expect(isDesktopSlashSuggestion('/save')).toBe(true)
    expect(isDesktopSlashSuggestion('/personality')).toBe(true)
    expect(isDesktopSlashCommand('/tools')).toBe(true)
    expect(isDesktopSlashCommand('/save')).toBe(true)
    expect(isDesktopSlashCommand('/personality')).toBe(true)
    expect(desktopSlashUnavailableMessage('/tools')).toBeNull()
    expect(desktopSlashUnavailableMessage('/save')).toBeNull()
    expect(desktopSlashUnavailableMessage('/personality')).toBeNull()
  })

  // V3-B: the registry's cli_only commands that still ride in the gateway catalog are named, with their aliases;
  // any other categorised backend verb is fenced from the catalog itself (desktop-slash-fence.test.ts).
  it('fences the cli-only registry commands the catalog still lists, aliases included', () => {
    for (const command of [
      '/prompt',
      '/compose',
      '/subscription',
      '/upgrade',
      '/timestamps',
      '/ts',
      '/worktree',
      '/battery'
    ]) {
      expect(resolveDesktopCommand(command)?.surface, command).toEqual({ kind: 'unavailable', reason: 'terminal' })
      expect(isDesktopSlashSuggestion(command), command).toBe(false)
      expect(isDesktopSlashCommand(command), command).toBe(false)
    }

    expect(desktopSlashTerminalOnlyMessage('/anything')).toBe('/anything is only available in the terminal interface.')
  })

  it('V3-B: /skills is a desktop action and /mode opens the same picker as /permissions', () => {
    expect(resolveDesktopCommand('/skills')?.surface).toEqual({ kind: 'action', action: 'skills' })
    expect(isDesktopSlashSuggestion('/skills')).toBe(true)
    expect(isDesktopSlashCommand('/skills')).toBe(true)
    expect(desktopSlashUnavailableMessage('/skills')).toBeNull()
    expect(resolveDesktopCommand('/mode')?.surface).toEqual({ kind: 'action', action: 'permissions' })
    expect(isDesktopSlashSuggestion('/mode')).toBe(true)
    expect(desktopSlashDescription('/mode')).toContain('Manual')
  })

  it('V3-B: the gateway-wide registry commands the desktop had no row for now run under Commands, aliases resolved', () => {
    for (const command of [
      '/learn',
      '/init',
      '/memory',
      '/context',
      '/diff',
      '/whoami',
      '/review',
      '/refine',
      '/subgoal',
      '/moa'
    ]) {
      expect(resolveDesktopCommand(command)?.surface, command).toEqual({ kind: 'exec' })
      expect(isDesktopSlashSuggestion(command), command).toBe(true)
      expect(isDesktopSlashExtensionCommand(command), command).toBe(false)
    }

    expect(resolveDesktopCommand('/ctx')?.name).toBe('/context')
    expect(resolveDesktopCommand('/hb')?.name).toBe('/heartbeat')
    expect(resolveDesktopCommand('/bp')?.name).toBe('/blueprint')
    expect(resolveDesktopCommand('/suggest')?.name).toBe('/suggestions')
    expect(resolveDesktopCommand('/v')?.name).toBe('/version')
  })

  it('V3-B: the inventory classifies every spec with a kind and a detail, no row unnamed', () => {
    const rows = desktopSlashInventory()
    const names = rows.map(row => row.name)

    expect(rows.length).toBeGreaterThanOrEqual(60)
    expect(new Set(names).size).toBe(names.length)

    for (const row of rows) {
      expect(row.name, row.name).toMatch(/^\/[a-z0-9_-]+$/)
      expect(['action', 'picker', 'rpc', 'exec', 'unavailable'], row.name).toContain(row.kind)
      expect(row.detail.length, row.name).toBeGreaterThan(0)

      if (row.kind !== 'unavailable') {
        expect(row.description.length, row.name).toBeGreaterThan(0)
      }
    }

    expect(rows.find(row => row.name === '/compress')).toMatchObject({
      kind: 'action',
      detail: 'compress',
      aliases: ['/compact']
    })
    expect(rows.find(row => row.name === '/skills')).toMatchObject({ kind: 'action', detail: 'skills' })
  })

  it('routes /wake through the desktop wake action instead of the slash worker', () => {
    expect(resolveDesktopCommand('/wake')?.surface).toEqual({ kind: 'action', action: 'wake' })
    expect(desktopSlashCommandArgumentMode('/wake')).toBe('options')
    expect(isDesktopSlashSuggestion('/wake')).toBe(true)
    expect(isDesktopSlashCommand('/wake')).toBe(true)
    expect(desktopSlashUnavailableMessage('/wake')).toBeNull()
  })

  it('treats /browser as an executable action command (local-gateway connect)', () => {
    // /browser used to be terminal-only; it now resolves to a desktop action
    // handler that routes browser.manage RPC when the gateway is local.
    expect(isDesktopSlashCommand('/browser')).toBe(true)
    expect(isDesktopSlashSuggestion('/browser')).toBe(true)
    expect(desktopSlashUnavailableMessage('/browser')).toBeNull()
    expect(resolveDesktopCommand('/browser')?.surface).toEqual({ kind: 'action', action: 'browser' })
    // Bare /browser expands to its sub-action options in the popover.
    expect(desktopSlashCommandArgumentMode('/browser')).toBe('options')
  })

  it('routes /compress through the session-compression action', () => {
    // /compress must be an action (session.compress RPC), not exec: the slash
    // worker route times out on large sessions (#44456).
    expect(resolveDesktopCommand('/compress')?.surface).toEqual({ kind: 'action', action: 'compress' })
    expect(desktopSlashCommandArgumentMode('/compress')).toBe('text')
    expect(isDesktopSlashCommand('/compress')).toBe(true)
    expect(isDesktopSlashSuggestion('/compress')).toBe(true)
    expect(desktopSlashUnavailableMessage('/compress')).toBeNull()
    // /compact is an alias — executes but stays out of the popover.
    expect(resolveDesktopCommand('/compact')?.surface).toEqual({ kind: 'action', action: 'compress' })
    expect(isDesktopSlashCommand('/compact')).toBe(true)
    expect(isDesktopSlashSuggestion('/compact')).toBe(false)
  })

  it('routes only stateless session commands through dedicated gateway RPCs', () => {
    const expected = {
      '/save': 'session.save',
      '/status': 'session.status'
    } as const

    for (const [name, rpcName] of Object.entries(expected)) {
      const surface = resolveDesktopCommand(name)?.surface
      expect(surface?.kind).toBe('rpc')

      if (surface?.kind !== 'rpc') {
        continue
      }

      expect(surface.rpc).toBe(rpcName)
      expect(surface.buildParams({ arg: 'topic A', command: name, name: name.slice(1), sessionId: 's-1' })).toEqual({
        session_id: 's-1'
      })
    }
  })

  it('keeps commands with richer CLI semantics on the slash worker', () => {
    for (const name of ['/agents', '/steer', '/stop', '/usage']) {
      expect(resolveDesktopCommand(name)?.surface).toEqual({ kind: 'exec' })
    }
  })

  it('still routes commands without dedicated RPCs through exec()', () => {
    const execNames = [
      '/background',
      '/goal',
      '/personality',
      '/queue',
      '/retry',
      '/rollback',
      '/tools',
      '/undo',
      '/version'
    ]

    for (const name of execNames) {
      expect(resolveDesktopCommand(name)?.surface).toEqual({ kind: 'exec' })
    }
  })

  it('distinguishes free prose from finite slash option lists', () => {
    expect(desktopSlashCommandArgumentMode('/goal')).toBe('mixed')
    expect(desktopSlashCommandArgumentMode('/steer')).toBe('text')
    expect(desktopSlashCommandArgumentMode('/queue')).toBe('text')
    expect(desktopSlashCommandArgumentMode('/personality')).toBe('options')
    expect(desktopSlashCommandArgumentMode('/handoff')).toBe('options')
    expect(desktopSlashCommandArgumentMode('/version')).toBeNull()
  })

  it('routes /journey (and aliases) to the memory graph overlay action', () => {
    expect(resolveDesktopCommand('/journey')?.surface).toEqual({ kind: 'action', action: 'journey' })
    expect(resolveDesktopCommand('/memory-graph')?.surface).toEqual({ kind: 'action', action: 'journey' })
    expect(resolveDesktopCommand('/learning')?.surface).toEqual({ kind: 'action', action: 'journey' })
    expect(isDesktopSlashCommand('/journey')).toBe(true)
    expect(isDesktopSlashCommand('/memory-graph')).toBe(true)
    expect(isDesktopSlashSuggestion('/journey')).toBe(true)
    // Aliases execute but stay out of the popover.
    expect(isDesktopSlashSuggestion('/memory-graph')).toBe(false)
    expect(desktopSlashUnavailableMessage('/journey')).toBeNull()
  })

  it('allows aliases to execute without cluttering the popover', () => {
    expect(isDesktopSlashSuggestion('/reset')).toBe(false)
    expect(isDesktopSlashCommand('/reset')).toBe(true)
  })

  it('filters built-in catalog noise but keeps skill / quick-command extensions', () => {
    const filtered = filterDesktopCommandsCatalog({
      categories: [
        {
          name: 'Session',
          pairs: [
            ['/new', 'Start a new session'],
            ['/clear', 'Clear terminal screen']
          ]
        },
        {
          name: 'User commands',
          pairs: [['/ship-it', 'Run release checklist']]
        }
      ],
      pairs: [
        ['/new', 'Start a new session'],
        ['/model', 'Switch model'],
        ['/ship-it', 'Run release checklist']
      ],
      skill_count: 2
    })

    // V3-B (F7): the desktop's own rows (/handoff, /permissions, /mode, /skills) ride in under their sections.
    expect(filtered.categories).toEqual([
      {
        name: 'Session',
        pairs: [
          ['/new', 'Start a new desktop chat'],
          ['/handoff', 'Hand off this session to a messaging platform']
        ]
      },
      { name: 'User commands', pairs: [['/ship-it', 'Run release checklist']] },
      {
        name: 'Configuration',
        pairs: [
          ['/permissions', 'Open the permission mode picker'],
          ['/mode', 'Open the permission mode picker (Manual · Automatic · Ignore)']
        ]
      },
      { name: 'Tools & Skills', pairs: [['/skills', 'List every skill, grouped, one line each']] }
    ])
    expect(filtered.pairs?.map(([cmd]) => cmd)).toEqual([
      '/new',
      '/ship-it',
      '/permissions',
      '/mode',
      '/skills',
      '/handoff'
    ])
    expect(filtered.pairs?.[0]).toEqual(['/new', 'Start a new desktop chat'])
    // skill_count is recomputed from the filtered output (only /ship-it is an
    // extension command — /new is a built-in) so the /help footer matches what
    // the user actually sees rather than echoing the unfiltered backend total.
    expect(filtered.skill_count).toBe(1)
  })

  it('recomputes skill_count to reflect only extensions surfaced on desktop', () => {
    const filtered = filterDesktopCommandsCatalog({
      pairs: [
        ['/new', 'Start a new session'],
        ['/clear', 'Clear terminal screen'],
        ['/gif-search', 'Search for a gif'],
        ['/ship-it', 'Run release checklist']
      ],
      skill_count: 12
    })

    expect(filtered.pairs?.map(([cmd]) => cmd)).toEqual([
      '/new',
      '/gif-search',
      '/ship-it',
      '/permissions',
      '/mode',
      '/skills',
      '/handoff'
    ])
    expect(filtered.skill_count).toBe(2)
  })

  it('uses desktop-specific labels for commands with different UI behavior', () => {
    expect(desktopSlashDescription('/branch', 'Branch the current session')).toBe(
      'Branch the latest message into a new chat'
    )
    expect(desktopSlashDescription('/skin', 'Show or change the display skin/theme')).toBe(
      'Switch desktop theme or cycle to the next one'
    )
  })

  it('builds /skin completions from desktop themes', () => {
    const completions = desktopSkinSlashCompletions(
      [
        { name: 'mono', label: 'Mono', description: 'Clean grayscale' },
        { name: 'midnight', label: 'Midnight', description: 'Deep blue' },
        { name: 'slate', label: 'Slate', description: 'Cool slate blue' }
      ],
      'mono',
      'm'
    )

    expect(completions).toEqual([
      {
        text: '/skin mono',
        display: '/skin mono',
        meta: 'Mono (current) - Clean grayscale'
      },
      {
        text: '/skin midnight',
        display: '/skin midnight',
        meta: 'Midnight - Deep blue'
      }
    ])
  })

  it('explains known commands that desktop owns elsewhere', () => {
    expect(desktopSlashUnavailableMessage('/model sonnet')).toContain('model picker')
    expect(desktopSlashUnavailableMessage('/curator')).toContain('not shown in the desktop slash palette')
    expect(desktopSlashUnavailableMessage('/clear')).toContain('terminal interface')
  })

  it('flags /model as a picker-owned command so the desktop opens the overlay', () => {
    expect(isModelPickerCommand('/model')).toBe(true)
    expect(isModelPickerCommand('/model sonnet')).toBe(true)
    expect(isModelPickerCommand('/new')).toBe(false)
    expect(isModelPickerCommand('/skills')).toBe(false)
  })

  it('gives /resume (and its aliases) a first-class session picker surface', () => {
    expect(isPickerCommand('/resume', 'session')).toBe(true)
    expect(isPickerCommand('/sessions', 'session')).toBe(true)
    expect(isPickerCommand('/switch', 'session')).toBe(true)
    // Unlike /model, /resume shows in the popover; its aliases stay hidden.
    expect(isDesktopSlashSuggestion('/resume')).toBe(true)
    expect(isDesktopSlashSuggestion('/sessions')).toBe(false)
    expect(isDesktopSlashCommand('/switch')).toBe(true)
    // The session picker is distinct from the model picker.
    expect(isModelPickerCommand('/resume')).toBe(false)
  })

  it('resolves commands and aliases to their declared surface', () => {
    expect(resolveDesktopCommand('/new')?.surface).toEqual({ kind: 'action', action: 'new' })
    expect(resolveDesktopCommand('/reset')?.surface).toEqual({ kind: 'action', action: 'new' })
    expect(resolveDesktopCommand('/resume')?.surface).toEqual({ kind: 'picker', picker: 'session' })
    expect(resolveDesktopCommand('/usage')?.surface).toEqual({ kind: 'exec' })
    expect(resolveDesktopCommand('/clear')?.surface).toEqual({ kind: 'unavailable', reason: 'terminal' })
    // Skill / quick commands aren't in the registry.
    expect(resolveDesktopCommand('/gif-search')).toBeNull()
  })
})

describe('rankSkillCommands', () => {
  const rows = [
    { text: '/research' },
    { text: '/research-paper-writing' },
    { text: '/work' },
    { text: '/ship-it' },
    { text: '/manim-video' },
    { text: '/docx' }
  ]

  const skills = {
    '/research': { usage: 60, origin: 'local' as const },
    '/research-paper-writing': { usage: 0, origin: 'bundled' as const },
    '/work': { usage: 172, origin: 'local' as const },
    '/manim-video': { usage: 0, origin: 'bundled' as const },
    '/docx': { usage: 0, origin: 'local' as const }
  }

  it('puts the most-used skill first and breaks ties alphabetically', () => {
    expect(rankSkillCommands(rows, skills).map(row => row.text)).toEqual([
      '/work',
      '/research',
      '/docx',
      '/manim-video',
      '/research-paper-writing',
      '/ship-it'
    ])
  })

  it('drops never-used built-ins when browsing, keeping everything else', () => {
    const browsing = rankSkillCommands(rows, skills, { pruneUnusedBuiltins: true }).map(row => row.text)

    expect(browsing).toEqual(['/work', '/research', '/docx', '/ship-it'])
    // A user's own unused skill survives — only shipped-and-ignored goes.
    expect(browsing).toContain('/docx')
    // Unclassified rows (quick commands, skills newer than the map) survive too.
    expect(browsing).toContain('/ship-it')
  })

  it('leaves the backend order untouched when the catalog carries no usage', () => {
    expect(rankSkillCommands(rows, undefined, { pruneUnusedBuiltins: true })).toEqual(rows)
  })

  it('ranks an alias by the canonical command it resolves to', () => {
    const ranked = rankSkillCommands([{ text: '/sessions' }, { text: '/research' }], {
      '/research': { usage: 5, origin: 'local' },
      '/resume': { usage: 900, origin: 'local' }
    })

    expect(ranked.map(row => row.text)).toEqual(['/sessions', '/research'])
  })

  // V3-B r2 (F7): the desktop's own commands are listed by the desktop — in the catalog the popover and /help
  // read, under the registry's own section names, and in typed completion — because the backend cannot list a
  // command it does not have (`/mode`) or marks cli_only (`/skills`, `/handoff`).
  it('F7: the filtered catalog carries /mode, /skills, /permissions and /handoff in their sections, once each', () => {
    const filtered = filterDesktopCommandsCatalog({
      categories: [
        { name: 'Session', pairs: [['/new', 'Start a new session']] },
        { name: 'Tools & Skills', pairs: [['/tools', 'List tools']] }
      ],
      pairs: [
        ['/new', 'Start a new session'],
        ['/tools', 'List tools'],
        ['/my-skill', 'Use when my skill matches.']
      ]
    })

    const section = (name: string) => filtered.categories!.find(s => s.name === name)!.pairs.map(([c]) => c)

    expect(section('Tools & Skills')).toEqual(['/tools', '/skills'])
    expect(section('Configuration')).toEqual(['/permissions', '/mode'])
    expect(section('Session')).toEqual(['/new', '/handoff'])
    expect(filtered.pairs!.map(([c]) => c)).toEqual([
      '/new',
      '/tools',
      '/my-skill',
      '/permissions',
      '/mode',
      '/skills',
      '/handoff'
    ])
    expect(filtered.pairs!.find(([c]) => c === '/mode')![1]).toContain('Manual')
    // Desktop rows are commands, not skills: the skill count stays the backend's extension count.
    expect(filtered.skill_count).toBe(1)
  })

  it('F7: a native row the backend already offers (an older or newer registry) is never added twice', () => {
    const filtered = filterDesktopCommandsCatalog({
      categories: [{ name: 'Tools & Skills', pairs: [['/skills', 'Manage skills']] }],
      pairs: [['/skills', 'Manage skills']]
    })

    expect(filtered.categories!.flatMap(s => s.pairs.map(([c]) => c)).filter(c => c === '/skills')).toHaveLength(1)
    expect(filtered.pairs!.filter(([c]) => c === '/skills')).toHaveLength(1)
    expect(filtered.pairs!.find(([c]) => c === '/skills')![1]).toBe('List every skill, grouped, one line each')
  })

  it('F7: a flat catalog (no categories) still gets the native rows; exec rows the backend lacks are never invented', () => {
    const filtered = filterDesktopCommandsCatalog({ pairs: [['/new', 'Start a new session']] })

    expect(filtered.categories).toBeUndefined()
    expect(filtered.pairs!.map(([c]) => c)).toContain('/mode')
    expect(filtered.pairs!.map(([c]) => c)).toContain('/skills')
    // /retry runs through slash.exec: without the backend offering it, the desktop does not list it.
    expect(filtered.pairs!.map(([c]) => c)).not.toContain('/retry')
    // /model is a hidden picker: never listed.
    expect(filtered.pairs!.map(([c]) => c)).not.toContain('/model')
  })

  it('F7: typed completion of the native rows matches the name prefix only, never an alias', () => {
    expect(desktopNativeSlashCompletions('mo').map(row => row.text)).toEqual(['/mode'])
    expect(desktopNativeSlashCompletions('sk').map(row => row.text)).toEqual(['/skills'])
    expect(desktopNativeSlashCompletions('MODE').map(row => row.text)).toEqual(['/mode'])
    expect(desktopNativeSlashCompletions('yolo')).toEqual([])
    expect(desktopNativeSlashCompletions('zzz')).toEqual([])
    expect(desktopNativeSlashCompletions('').map(row => row.text)).toEqual([
      '/permissions',
      '/mode',
      '/skills',
      '/handoff'
    ])
    expect(desktopNativeSlashCompletions('mo')[0]!.meta).toContain('Manual')
  })
})
