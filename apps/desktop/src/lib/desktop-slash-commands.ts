interface CommandsCatalogSection {
  name: string
  pairs: [string, string][]
}

export interface CommandsCatalogLike {
  categories?: CommandsCatalogSection[]
  pairs?: [string, string][]
  skill_count?: number
  skills?: SkillCatalogMap
  warning?: string
}

/**
 * Per-skill ranking data from `commands.catalog`, keyed by slash command.
 * Absent on older backends — every helper below degrades to "no ranking,
 * hide nothing".
 */
interface SkillCatalogEntry {
  /** Where the skill came from; matches `/api/skills` provenance ('agent' = 'local'). */
  origin?: 'bundled' | 'hub' | 'local'
  /** Observed activity (use + view + patch) — the same number Capabilities shows. */
  usage?: number
}

type SkillCatalogMap = Record<string, SkillCatalogEntry>

interface DesktopSlashCompletion {
  display: string
  meta: string
  text: string
}

export interface DesktopThemeCommandOption {
  description: string
  label: string
  name: string
}

/** The compaction command — typed by the user and sent by the Compact button. */
export const COMPRESS_COMMAND = '/compress'

/**
 * Local client action a command resolves to. Each id maps to exactly one
 * handler in the dispatcher (`use-prompt-actions`), so adding a command never
 * means adding a branch to a switch ladder — you add a row here + a handler
 * keyed by the id.
 */
export type DesktopActionId =
  | 'branch'
  | 'browser'
  | 'compress'
  | 'diagnostics'
  | 'handoff'
  | 'help'
  | 'journey'
  | 'new'
  | 'profile'
  | 'skills'
  | 'skin'
  | 'title'
  | 'permissions'
  | 'wake'

/** A command fulfilled by opening a desktop overlay picker. */
export type DesktopPickerId = 'model' | 'session'

/** Why a known Hermes command has no desktop UI surface. */
type DesktopUnavailableReason = 'advanced' | 'composer-voice' | 'messaging' | 'settings' | 'terminal'

/**
 * How the desktop fulfils a command. This is the single discriminator the
 * dispatcher, popover, pills, and pickers all read — no parallel block-lists.
 *
 * - `action`     → handled by a local client handler (new chat, branch, …)
 * - `picker`     → opens an overlay (`/model`, `/resume`); a typed arg is
 *                  resolved by that picker instead of falling through
 * - `rpc`        → dedicated gateway RPC named on the surface. The dispatcher
 *                  calls it directly with the params built by `buildParams`,
 *                  bypassing `slash.exec` / `command.dispatch`. Reserved for
 *                  commands that have a first-class RPC handler in
 *                  `tui_gateway/server.py` (e.g. `/save` → session.save).
 * - `exec`       → runs on the backend via slash.exec / command.dispatch and
 *                  renders its text output inline. Only commands WITHOUT a
 *                  dedicated RPC should stay here.
 * - `unavailable`→ a known command with genuinely no desktop UI (terminal-only,
 *                  messaging-only, …); shows a reason instead of executing
 */
export type DesktopCommandSurface =
  | { kind: 'action'; action: DesktopActionId }
  | { kind: 'picker'; picker: DesktopPickerId }
  | {
      kind: 'rpc'
      rpc: string
      timeoutMs?: number
      buildParams: (ctx: SlashCommandBuildCtx) => Record<string, unknown>
    }
  | { kind: 'exec' }
  | { kind: 'unavailable'; reason: DesktopUnavailableReason }

/**
 * Inputs a `buildParams` function receives. The dispatcher passes session id,
 * the typed arg, and the canonical command name so handlers can construct
 * the exact JSON the gateway method expects.
 */
interface SlashCommandBuildCtx {
  arg: string
  command: string
  name: string
  sessionId: string
}

/**
 * How arguments behave in the Desktop composer.
 *
 * - `options` → a finite completion list; picking or fully typing an option may
 *               commit the complete directive as a chip.
 * - `text`    → arbitrary prose; the command and its argument stay editable.
 * - `mixed`   → offers subcommand completions but also accepts arbitrary prose.
 */
type DesktopSlashArgumentMode = 'mixed' | 'options' | 'text'

interface DesktopCommandSpec {
  /** Canonical command, leading slash included (e.g. `/resume`). */
  name: string
  /** Popover/help label; omitted for unavailable commands (never surfaced). */
  description?: string
  aliases?: string[]
  surface: DesktopCommandSurface
  /**
   * Hide from the slash popover / completions while still letting it execute.
   * Used for picker commands reachable from chrome (the model picker lives on
   * the status bar), so the popover doesn't dead-end on inline completion.
   */
  hidden?: boolean
  /** Composer behavior for text following the command token. */
  argumentMode?: DesktopSlashArgumentMode
  /**
   * The backend catalog section this command belongs in when the desktop has to list it itself (an action or a
   * picker the registry does not offer this surface: `/mode`, `/skills`, `/permissions`, `/handoff`). Absent on a
   * command the backend always lists.
   */
  category?: DesktopCommandCategory
}

/** The registry's own category names (hermes_cli/commands.py), so a desktop-native row sits with its kin. */
type DesktopCommandCategory = 'Configuration' | 'Info' | 'Session' | 'Tools & Skills'

const exec = (): DesktopCommandSurface => ({ kind: 'exec' })
const action = (id: DesktopActionId): DesktopCommandSurface => ({ kind: 'action', action: id })
const picker = (id: DesktopPickerId): DesktopCommandSurface => ({ kind: 'picker', picker: id })
const unavailable = (reason: DesktopUnavailableReason): DesktopCommandSurface => ({ kind: 'unavailable', reason })

/**
 * Route a command directly to its dedicated gateway RPC. Prefer this over
 * `exec()` whenever `tui_gateway/server.py` exposes a `@method(...)` for the
 * command — bypassing `slash.exec` keeps the path short and the response
 * structured.
 *
 * The dispatcher calls `requestGateway(surface.rpc, surface.buildParams(ctx))`
 * and then runs `renderRpcResult` to format the response.
 */
const rpc = (
  rpcName: string,
  buildParams: (ctx: SlashCommandBuildCtx) => Record<string, unknown>,
  timeoutMs?: number
): DesktopCommandSurface => ({ kind: 'rpc', rpc: rpcName, timeoutMs, buildParams })

/**
 * THE source of truth for desktop slash commands. Everything below — execution
 * gating, popover suggestions, catalog filtering, pill grouping, and the
 * dispatcher's behavior — derives from this one table.
 */
const DESKTOP_COMMAND_SPECS: readonly DesktopCommandSpec[] = [
  // Local client actions
  { name: '/new', description: 'Start a new desktop chat', aliases: ['/reset'], surface: action('new') },
  {
    name: '/branch',
    description: 'Branch the latest message into a new chat',
    aliases: ['/fork'],
    surface: action('branch')
  },
  // V3-F: the permission mode is the app's (Settings › Agent › Permissions); the old yolo/approvals
  // commands open that picker instead of writing Hermes' approval policy from the window.
  {
    name: '/permissions',
    description: 'Open the permission mode picker',
    aliases: ['/yolo', '/approvals'],
    surface: action('permissions'),
    category: 'Configuration'
  },
  // V3-B: the word the owner reaches for. Same picker, same rule: the mode changes only from the user's own click.
  {
    name: '/mode',
    description: 'Open the permission mode picker (Manual · Automatic · Ignore)',
    surface: action('permissions'),
    category: 'Configuration'
  },
  // V3-B: every skill the agent can open, grouped (icloneOS, from your library, learned, upstream, hub), one line
  // each, with what this machine lacks for a ported one. Local: the list is the bundle catalog plus commands.catalog.
  {
    name: '/skills',
    description: 'List every skill, grouped, one line each',
    surface: action('skills'),
    category: 'Tools & Skills'
  },
  {
    name: '/wake',
    description: 'Control the desktop wake-word listener [on|off|status]',
    surface: action('wake'),
    argumentMode: 'options'
  },
  {
    name: '/handoff',
    description: 'Hand off this session to a messaging platform',
    surface: action('handoff'),
    argumentMode: 'options',
    category: 'Session'
  },
  { name: '/profile', description: 'Switch the active Hermes profile', surface: action('profile') },
  {
    name: '/skin',
    description: 'Switch desktop theme or cycle to the next one',
    surface: action('skin'),
    argumentMode: 'options'
  },
  { name: '/title', description: 'Rename the current session', surface: action('title'), argumentMode: 'text' },
  { name: '/help', description: 'Show desktop slash commands', aliases: ['/commands'], surface: action('help') },
  {
    name: '/browser',
    description: 'Manage browser CDP connection [connect|disconnect|status] (local gateway only)',
    surface: action('browser'),
    argumentMode: 'options'
  },
  {
    name: '/journey',
    description: 'Open the memory graph — skills + memories over time',
    aliases: ['/learning', '/memory-graph'],
    surface: action('journey')
  },

  // Overlay pickers
  { name: '/model', description: 'Switch the model for this session', surface: picker('model'), hidden: true },
  {
    name: '/resume',
    description: 'Resume a saved session',
    aliases: ['/sessions', '/switch'],
    surface: picker('session'),
    // `mixed`, not `options`: the argument is a free-text search the picker
    // fuzzy-matches against titles and previews, so multi-word queries have to
    // stay typeable. Its completion list also always carries a trailing
    // "Browse all sessions…" action row, which meant Space-to-accept could
    // never fall through — the first space wiped the composer and threw the
    // user into the overlay.
    argumentMode: 'mixed'
  },

  // Backend-executed commands that render useful inline output.
  // Commands with a dedicated gateway RPC (@method in tui_gateway/server.py)
  // route to it directly via `rpc(...)` — bypassing slash.exec avoids the
  // slash-worker pipe timeout and the "not a quick/plugin/skill command"
  // fallback noise for commands the dispatcher doesn't handle inline.
  // These commands have gateway RPCs, but their established desktop behavior
  // carries richer CLI semantics: /agents includes delegations, /stop cancels
  // them, /steer falls back to a next-turn prompt, and /usage is a formatted
  // live report. Keep them on slash.exec until their RPC contracts are fully
  // equivalent.
  {
    name: '/agents',
    description: 'Show active desktop sessions and running tasks',
    aliases: ['/tasks'],
    surface: exec()
  },
  {
    name: '/background',
    description: 'Run a prompt in the background',
    aliases: ['/bg', '/btw'],
    surface: exec(),
    argumentMode: 'text'
  },
  // /compress must be an action (session.compress RPC), not exec: the slash
  // worker route times out on large sessions (30s WS / 45s pipe) before the
  // LLM summarise call finishes, then command.dispatch surfaces a bogus
  // "not a quick/plugin/skill command: compress" (#44456).
  {
    name: COMPRESS_COMMAND,
    description: 'Compress this conversation context',
    aliases: ['/compact'],
    surface: action('compress'),
    argumentMode: 'text'
  },
  // Ruling 47 (V3-FX M3): the runtime's /debug uploads the report and logs to a public paste service or Nous storage. On desktop it
  // opens the local report (saved to a file the owner chooses); nothing is ever sent to the runtime's upload path.
  {
    name: '/debug',
    description: 'Save a diagnostics report to a file (nothing is uploaded)',
    surface: action('diagnostics'),
    argumentMode: 'text'
  },
  {
    name: '/goal',
    description: 'Manage the standing goal for this session',
    surface: exec(),
    argumentMode: 'mixed'
  },
  {
    name: '/loop',
    description: 'Re-run a prompt on a recurring interval in this session',
    aliases: ['/proactive'],
    surface: exec(),
    argumentMode: 'mixed'
  },
  {
    name: '/personality',
    description: 'Switch personality for this session',
    surface: exec(),
    argumentMode: 'options'
  },
  {
    name: '/queue',
    description: 'Queue a prompt for the next turn',
    aliases: ['/q'],
    surface: exec(),
    argumentMode: 'text'
  },
  { name: '/retry', description: 'Retry the last user message', surface: exec() },
  { name: '/rollback', description: 'List or restore filesystem checkpoints', surface: exec() },
  {
    name: '/save',
    description: 'Save the current transcript to JSON',
    surface: rpc('session.save', ctx => ({ session_id: ctx.sessionId }))
  },
  {
    name: '/status',
    description: 'Show current session status',
    surface: rpc('session.status', ctx => ({ session_id: ctx.sessionId }))
  },
  {
    name: '/steer',
    description: 'Steer the current run after the next tool call',
    surface: exec(),
    argumentMode: 'text'
  },
  { name: '/stop', description: 'Stop running background processes', surface: exec() },
  {
    name: '/tools',
    description: 'List or toggle tools available to the agent',
    surface: exec(),
    argumentMode: 'options'
  },
  { name: '/undo', description: 'Remove the last user/assistant exchange', surface: exec() },
  { name: '/usage', description: 'Show token usage for this session', surface: exec() },
  { name: '/version', description: 'Show Hermes Agent version', aliases: ['/v'], surface: exec() },

  // V3-B inventory: registry commands the gateway offers to every surface (cli_only = false) that the desktop had no
  // row for. They always ran here — as "extension" commands through slash.exec — but the popover filed them under
  // Skills. Named now, so they sit under Commands with the registry's own line and the inventory can classify them.
  {
    name: '/blueprint',
    description: 'Set up an automation from a blueprint template',
    aliases: ['/bp'],
    surface: exec(),
    argumentMode: 'mixed'
  },
  { name: '/bundles', description: 'List skill bundles (aliases /<name> for multiple skills)', surface: exec() },
  {
    name: '/codex-runtime',
    description: 'Toggle codex app-server runtime for OpenAI/Codex models',
    aliases: ['/codex_runtime'],
    surface: exec(),
    argumentMode: 'options'
  },
  {
    name: '/context',
    description: 'Show the context window: usage gauge, categories, compression stats',
    aliases: ['/ctx'],
    surface: exec(),
    argumentMode: 'options'
  },
  { name: '/diff', description: 'Show git changes in the working directory', surface: exec(), argumentMode: 'mixed' },
  { name: '/egress', description: 'Show Docker egress proxy status', surface: exec(), argumentMode: 'options' },
  {
    name: '/heartbeat',
    description: 'Set a recurring prompt that re-enters this session when idle',
    aliases: ['/hb'],
    surface: exec(),
    argumentMode: 'mixed'
  },
  {
    name: '/init',
    description: 'Generate or update AGENTS.md project instructions from a repo scan',
    surface: exec(),
    argumentMode: 'text'
  },
  {
    name: '/learn',
    description: 'Learn a reusable skill from anything you describe',
    surface: exec(),
    argumentMode: 'text'
  },
  {
    name: '/memory',
    description: 'Review pending memory writes / toggle the approval gate',
    surface: exec(),
    argumentMode: 'mixed'
  },
  {
    name: '/moa',
    description: 'Run one prompt through the Mixture of Agents preset',
    surface: exec(),
    argumentMode: 'text'
  },
  {
    name: '/refine',
    description: 'Review this conversation now and save lessons to memory/skills',
    surface: exec(),
    argumentMode: 'text'
  },
  {
    name: '/review',
    description: 'Spawn an independent subagent to review the work just discussed',
    surface: exec(),
    argumentMode: 'text'
  },
  {
    name: '/subgoal',
    description: 'Add or manage extra criteria on the active goal',
    surface: exec(),
    argumentMode: 'mixed'
  },
  {
    name: '/suggestions',
    description: 'Review suggested automations (accept/dismiss)',
    aliases: ['/suggest'],
    surface: exec(),
    argumentMode: 'mixed'
  },
  { name: '/topup', description: 'Show your Nous balance and manage billing on the portal', surface: exec() },
  { name: '/whoami', description: 'Show your slash command access (admin / user)', surface: exec() },

  // No desktop surface, but carry an alias (underscore spelling variants).
  { name: '/reload-mcp', aliases: ['/reload_mcp'], surface: unavailable('advanced') },
  { name: '/reload-skills', aliases: ['/reload_skills'], surface: unavailable('advanced') },
  // V3-B inventory: registry commands the gateway marks cli_only that still appear in its catalog, with their aliases.
  { name: '/prompt', aliases: ['/compose'], surface: unavailable('terminal') },
  { name: '/subscription', aliases: ['/upgrade'], surface: unavailable('terminal') },
  { name: '/timestamps', aliases: ['/ts'], surface: unavailable('terminal') }
  // Any other categorised registry command the desktop has no row for (the runtime's terminal-only verbs, including
  // the ones it may add tomorrow) is fenced from the backend's own catalog at run time: src/lib/desktop-slash-fence.ts.
]

// Known commands with no desktop surface (and no alias) — a flat name list
// per reason beats 40 identical object literals.
const NO_DESKTOP_SURFACE: Record<DesktopUnavailableReason, readonly string[]> = {
  terminal: [
    '/battery',
    '/busy',
    '/clear',
    '/config',
    '/copy',
    '/cron',
    '/density',
    '/details',
    '/exit',
    '/export',
    '/focus',
    '/footer',
    '/gateway',
    '/history',
    '/image',
    '/import',
    '/indicator',
    '/logs',
    '/mouse',
    '/palette',
    '/paste',
    '/platforms',
    '/plugins',
    '/quit',
    '/redraw',
    '/reload',
    '/restart',
    '/sb',
    '/set-home',
    '/sethome',
    '/snap',
    '/snapshot',
    '/statusbar',
    '/toolsets',
    '/update',
    '/verbose',
    '/worktree'
  ],
  // V3-B inventory: the registry's gateway_only commands (messaging platforms; the gateway catalog never lists them).
  messaging: ['/approve', '/deny', '/pause', '/platform', '/start', '/topic'],
  // V3-B: /skills is a desktop action now (DESKTOP_COMMAND_SPECS); nothing is settings-only any more.
  settings: [],
  advanced: ['/curator', '/fast', '/insights', '/kanban', '/reasoning'],
  // /voice arms SERVER-side capture (voice.record → PortAudio on the backend
  // host) — meaningless on desktop, which has its own composer-native voice
  // conversation (mic menu / Ctrl+B) with client-side capture and playback.
  // Point the user at the button instead of a generic "advanced" shrug.
  'composer-voice': ['/voice']
}

const ALL_SPECS: readonly DesktopCommandSpec[] = [
  ...DESKTOP_COMMAND_SPECS,
  ...(Object.entries(NO_DESKTOP_SURFACE) as [DesktopUnavailableReason, readonly string[]][]).flatMap(
    ([reason, names]) => names.map(name => ({ name, surface: unavailable(reason) }))
  )
]

const SPEC_BY_NAME = new Map<string, DesktopCommandSpec>(ALL_SPECS.map(spec => [spec.name, spec]))

const ALIAS_TO_CANONICAL = new Map<string, string>(
  ALL_SPECS.flatMap(spec => (spec.aliases ?? []).map(alias => [alias, spec.name] as const))
)

const UNAVAILABLE_MESSAGE: Record<DesktopUnavailableReason, (command: string) => string> = {
  advanced: command =>
    `${command} is not shown in the desktop slash palette. Use the relevant desktop control or terminal interface instead.`,
  'composer-voice': () =>
    'Voice chat lives in the composer here: click the microphone button and choose "Start voice chat" (or press Ctrl+B).',
  messaging: command => `${command} is only used from messaging platforms.`,
  settings: command => `${command} is managed from the desktop sidebar.`,
  terminal: command => `${command} is only available in the terminal interface.`
}

const PICKER_UNAVAILABLE_MESSAGE: Record<DesktopPickerId, (command: string) => string> = {
  model: command => `${command} uses the desktop model picker instead of a slash command.`,
  session: command => `${command} uses the desktop session picker instead of a slash command.`
}

function normalizeCommand(command: string): string {
  const trimmed = command.trim()
  const base = (trimmed.startsWith('/') ? trimmed : `/${trimmed}`).split(/\s+/, 1)[0]?.toLowerCase() || ''

  return base
}

function canonicalDesktopSlashCommand(command: string): string {
  const normalized = normalizeCommand(command)

  return ALIAS_TO_CANONICAL.get(normalized) || normalized
}

/** Resolve a command (or alias) to its desktop spec, or null for unknown/extension commands. */
export function resolveDesktopCommand(command: string): DesktopCommandSpec | null {
  return SPEC_BY_NAME.get(canonicalDesktopSlashCommand(command)) ?? null
}

function isKnownHermesSlashCommand(command: string): boolean {
  const normalized = normalizeCommand(command)

  return SPEC_BY_NAME.has(normalized) || ALIAS_TO_CANONICAL.has(normalized)
}

/**
 * An "extension" command is anything the backend surfaces that is NOT one of
 * Hermes' built-in slash commands — i.e. skill commands (`/gif-search`,
 * `/codex`, …) and user-defined quick commands. These are user-activated, so
 * they appear in the desktop slash palette and execute when typed.
 */
export function isDesktopSlashExtensionCommand(command: string): boolean {
  const normalized = normalizeCommand(command)

  if (!normalized || normalized === '/') {
    return false
  }

  return !isKnownHermesSlashCommand(normalized)
}

/** Gates execution: true unless the command is a known no-desktop-surface command. */
export function isDesktopSlashCommand(command: string): boolean {
  const spec = resolveDesktopCommand(command)

  if (spec) {
    return spec.surface.kind !== 'unavailable'
  }

  return isDesktopSlashExtensionCommand(command)
}

/** Gates discovery in the popover/completions. */
export function isDesktopSlashSuggestion(command: string): boolean {
  const normalized = normalizeCommand(command)

  // Aliases stay hidden so the popover isn't cluttered with duplicates.
  if (ALIAS_TO_CANONICAL.has(normalized)) {
    return false
  }

  const spec = SPEC_BY_NAME.get(normalized)

  if (spec) {
    return spec.surface.kind !== 'unavailable' && !spec.hidden
  }

  // Skill / quick commands the backend provides.
  return isDesktopSlashExtensionCommand(normalized)
}

/**
 * True for commands the desktop fulfils by opening an overlay picker
 * (`/model`, `/resume`/`/sessions`/`/switch`). Optionally pin to one picker.
 */
export function isPickerCommand(command: string, picker?: DesktopPickerId): boolean {
  const surface = resolveDesktopCommand(command)?.surface

  if (surface?.kind !== 'picker') {
    return false
  }

  return picker ? surface.picker === picker : true
}

/** Back-compat shim for the model picker check. */
export function isModelPickerCommand(command: string): boolean {
  return isPickerCommand(command, 'model')
}

export function desktopSlashUnavailableMessage(command: string): string | null {
  const canonical = canonicalDesktopSlashCommand(command)
  const surface = SPEC_BY_NAME.get(canonical)?.surface

  if (!surface) {
    return null
  }

  if (surface.kind === 'unavailable') {
    return UNAVAILABLE_MESSAGE[surface.reason](canonical)
  }

  if (surface.kind === 'picker') {
    return PICKER_UNAVAILABLE_MESSAGE[surface.picker](canonical)
  }

  return null
}

/** The reason-tagged message for a backend verb the fence (desktop-slash-fence.ts) keeps off the desktop. */
export function desktopSlashTerminalOnlyMessage(command: string): string {
  return UNAVAILABLE_MESSAGE.terminal(normalizeCommand(command))
}

/** One row per spec, as the V3-B inventory gate reads the table (RESUME/run/gates/V3B/slash_inventory.ts). */
interface DesktopSlashInventoryRow {
  name: string
  aliases: string[]
  kind: DesktopCommandSurface['kind']
  /** The action id, picker id, RPC name or unavailable reason. */
  detail: string
  hidden: boolean
  description: string
  argumentMode: DesktopSlashArgumentMode | null
}

export function desktopSlashInventory(): DesktopSlashInventoryRow[] {
  return ALL_SPECS.map(spec => {
    const surface = spec.surface

    const detail =
      surface.kind === 'action'
        ? surface.action
        : surface.kind === 'picker'
          ? surface.picker
          : surface.kind === 'rpc'
            ? surface.rpc
            : surface.kind === 'unavailable'
              ? surface.reason
              : 'slash.exec'

    return {
      name: spec.name,
      aliases: [...(spec.aliases ?? [])],
      kind: surface.kind,
      detail,
      hidden: Boolean(spec.hidden),
      description: spec.description ?? '',
      argumentMode: spec.argumentMode ?? null
    }
  })
}

export function desktopSlashDescription(command: string, fallback = ''): string {
  return SPEC_BY_NAME.get(canonicalDesktopSlashCommand(command))?.description || fallback
}

export function desktopSlashCommandArgumentMode(command: string): DesktopSlashArgumentMode | null {
  return resolveDesktopCommand(command)?.argumentMode ?? null
}

export function desktopSkinSlashCompletions(
  themes: DesktopThemeCommandOption[],
  activeThemeName: string,
  argPrefix: string
): DesktopSlashCompletion[] {
  const prefix = argPrefix.trim().toLowerCase()

  const commands: DesktopSlashCompletion[] = [
    {
      text: '/skin list',
      display: '/skin list',
      meta: 'Show available desktop themes'
    },
    {
      text: '/skin next',
      display: '/skin next',
      meta: 'Cycle to the next desktop theme'
    },
    ...themes.map(theme => ({
      text: `/skin ${theme.name}`,
      display: `/skin ${theme.name}`,
      meta: `${theme.label}${theme.name === activeThemeName ? ' (current)' : ''} - ${theme.description}`
    }))
  ]

  if (!prefix) {
    return commands
  }

  return commands.filter(item => item.text.slice('/skin '.length).toLowerCase().startsWith(prefix))
}

/**
 * Order skill rows by how much the user actually uses them, most-used first,
 * A–Z within a tie. A `/` menu sorted alphabetically buries the handful of
 * skills someone reaches for daily under a hundred they have never opened.
 *
 * `pruneUnusedBuiltins` additionally drops bundled skills with no recorded
 * activity — the ones that ship with Hermes and were never asked for. It is
 * for BROWSING (a bare `/`) only: typing a query is a search, and a search
 * must never hide a match.
 *
 * Older backends send no `skills` map; then nothing is reordered or dropped.
 */
export function rankSkillCommands<T extends { text: string }>(
  rows: readonly T[],
  skills: SkillCatalogMap | undefined,
  { pruneUnusedBuiltins = false }: { pruneUnusedBuiltins?: boolean } = {}
): T[] {
  if (!skills) {
    return [...rows]
  }

  const entryOf = (row: T): SkillCatalogEntry | undefined => skills[canonicalDesktopSlashCommand(row.text)]
  const usageOf = (row: T): number => entryOf(row)?.usage ?? 0

  const kept = pruneUnusedBuiltins
    ? rows.filter(row => {
        const entry = entryOf(row)

        // Unknown to the map (a quick command, a newer skill the catalog
        // hasn't classified) stays — only a confirmed never-used built-in goes.
        return !entry || entry.origin !== 'bundled' || (entry.usage ?? 0) > 0
      })
    : [...rows]

  return kept.sort((a, b) => usageOf(b) - usageOf(a) || a.text.localeCompare(b.text))
}

/**
 * V3-B (F7): the commands the desktop fulfils ITSELF — an action or a picker with a category of its own — that the
 * backend catalog does not list for this surface (`/mode` has no registry twin; `/skills` and `/handoff` are
 * cli_only there). They are desktop rows, so the desktop lists them: in the bare popover, in typed completion and
 * in /help. `present` = the lower-cased names the backend already offers.
 */
function desktopNativeSpecs(present: ReadonlySet<string>): DesktopCommandSpec[] {
  return DESKTOP_COMMAND_SPECS.filter(
    spec =>
      spec.category !== undefined &&
      (spec.surface.kind === 'action' || spec.surface.kind === 'picker') &&
      !spec.hidden &&
      !present.has(spec.name)
  )
}

/** The catalog with the desktop-native rows added to their sections (and to the flat list). Pure. */
function withDesktopNativeCommands(catalog: CommandsCatalogLike): CommandsCatalogLike {
  const present = new Set<string>()

  for (const section of catalog.categories ?? []) {
    for (const [command] of section.pairs) {
      present.add(canonicalDesktopSlashCommand(command))
    }
  }

  for (const [command] of catalog.pairs ?? []) {
    present.add(canonicalDesktopSlashCommand(command))
  }

  const native = desktopNativeSpecs(present)

  if (!native.length) {
    return catalog
  }

  const rows = native.map(spec => [spec.name, spec.description ?? ''] as [string, string])
  const categories = catalog.categories?.map(section => ({ ...section, pairs: [...section.pairs] }))

  if (categories) {
    for (const spec of native) {
      const section = categories.find(candidate => candidate.name === spec.category)
      const row: [string, string] = [spec.name, spec.description ?? '']

      if (section) {
        section.pairs.push(row)
      } else {
        categories.push({ name: spec.category ?? '', pairs: [row] })
      }
    }
  }

  return {
    ...catalog,
    ...(categories ? { categories } : {}),
    pairs: [...(catalog.pairs ?? []), ...rows]
  }
}

/** Typed completion of the desktop-native commands: `/mo` → `/mode`. Names only, never aliases. */
export function desktopNativeSlashCompletions(query: string): DesktopSlashCompletion[] {
  const needle = `/${query.trim().toLowerCase()}`

  return desktopNativeSpecs(new Set())
    .filter(spec => spec.name.startsWith(needle))
    .map(spec => ({ text: spec.name, display: spec.name, meta: spec.description ?? '' }))
}

export function filterDesktopCommandsCatalog(raw: CommandsCatalogLike): CommandsCatalogLike {
  const catalog = withDesktopNativeCommands(raw)

  const categories = catalog.categories
    ?.map(section => ({
      ...section,
      pairs: section.pairs
        .filter(([command]) => isDesktopSlashSuggestion(command))
        .map(([command, description]) => [command, desktopSlashDescription(command, description)] as [string, string])
    }))
    .filter(section => section.pairs.length > 0)

  const pairs = catalog.pairs
    ?.filter(([command]) => isDesktopSlashSuggestion(command))
    .map(([command, description]) => [command, desktopSlashDescription(command, description)] as [string, string])

  // Recount skill commands from the filtered output so /help's footer reflects
  // what the user actually sees. Backend's skill_count includes commands the
  // desktop hides (terminal-only, picker-owned, advanced), producing a footer
  // like "60 skill commands available" while only ~29 appear in the list.
  const filteredCommands = new Set<string>()

  for (const section of categories ?? []) {
    for (const [command] of section.pairs) {
      filteredCommands.add(canonicalDesktopSlashCommand(command))
    }
  }

  for (const [command] of pairs ?? []) {
    filteredCommands.add(canonicalDesktopSlashCommand(command))
  }

  let skillCount = 0

  for (const command of filteredCommands) {
    if (isDesktopSlashExtensionCommand(command)) {
      skillCount += 1
    }
  }

  const hasSkillCount = catalog.skill_count !== undefined || skillCount > 0

  return {
    ...catalog,
    ...(categories ? { categories } : {}),
    ...(pairs ? { pairs } : {}),
    ...(hasSkillCount ? { skill_count: skillCount } : {})
  }
}
