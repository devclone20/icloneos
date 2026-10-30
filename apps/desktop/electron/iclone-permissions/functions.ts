/**
 * V3-F2 — per-function permission levels (owner decision 10). One pure module: what each level means, how the levels
 * of the functions a call touches combine with the global mode, and which level changes are raises. The Hermes plugin
 * evaluates the same rule in `plugins/iclone-permissions/policy.py` from the signed body; both are held equal by
 * `plugins/iclone-permissions/tests/fixtures/functions.json` (functions.test.ts writes nothing: it compares).
 *
 * The classifier is not involved: it keeps producing one class, its facts and its floor. A call's functions (the
 * candidates) come from the plugin's separate mapping module (`functions.py`). With every function at `mode` — the
 * shipped default — `decideFunctions` IS V3-F's `decide` (contract V3F2 §0, gate F2-2).
 */
import {
  F2_LOOSENING_ENABLED,
  FUNCTION_LEVELS,
  type FunctionLevel,
  type FunctionLevels,
  isFunctionLevel,
  isPermissionFunction,
  levelOffered,
  PERMISSION_FUNCTIONS,
  type PermissionFunction
} from '../../src/iclone-shared/permissions'

import {
  ACTION_CLASSES,
  type ActionClass,
  type ActionFacts,
  type Ceiling,
  cellOutcome,
  decide,
  type DecideInput,
  type Decision,
  MODE_TABLE,
  type ModeCell,
  type Outcome,
  type PermissionMode
} from './modes'

export type { FunctionLevel, FunctionLevels, PermissionFunction }
export { FUNCTION_LEVELS, isFunctionLevel, isPermissionFunction, PERMISSION_FUNCTIONS }

/** The shipped default of every row: follow the global mode (V3-F behaviour). */
const DEFAULT_FUNCTION_LEVEL: FunctionLevel = 'mode'

export const DEFAULT_FUNCTION_LEVELS: Readonly<FunctionLevels> = Object.freeze(
  Object.fromEntries(PERMISSION_FUNCTIONS.map(fn => [fn, DEFAULT_FUNCTION_LEVEL])) as FunctionLevels
)

type UserLevel = Exclude<FunctionLevel, 'mode'>

// Reading belongs to no function and is free at every level (the mapping never gives an R call a function).
const row = (cell: ModeCell): Record<ActionClass, ModeCell> => ({
  R: 'A',
  Wp: cell,
  Wo: cell,
  X: cell,
  N: cell,
  $: cell,
  M: cell,
  S: cell,
  I: cell,
  D: cell
})

/** §2: the cell each user level puts where the global mode's cell was. */
export const LEVEL_CELLS: Readonly<Record<UserLevel, Readonly<Record<ActionClass, ModeCell>>>> = {
  ignore: row('A'),
  automatic: {
    R: 'A',
    Wp: 'A',
    Wo: 'Q',
    X: 'A:safe',
    N: 'A',
    $: 'A:clean',
    M: 'A:clean',
    S: 'Q',
    I: 'A:unprivileged',
    D: 'A:project'
  },
  askOnce: row('Q'),
  askAlways: row('Q'),
  manual: row('R!')
}

/** Every fact a cell reads, in its three states (absent = not measured, false, true): 81 combinations. */
const FACT_STATES = [undefined, false, true] as const

const ALL_FACTS: readonly ActionFacts[] = FACT_STATES.flatMap(dangerous =>
  FACT_STATES.flatMap(getOnly =>
    FACT_STATES.flatMap(inProject => FACT_STATES.map(privileged => ({ dangerous, getOnly, inProject, privileged })))
  )
)

/**
 * How strict one row is for one class and fact set: allow 0 < an ask a grant may lift 1 < an ask nothing standing
 * lifts (Ask always) 2 < refuse 3. Follow mode is the global mode's cell. Floors and Privacy switches are the same at
 * every level, so they never make one level stricter than another. A change revokes the row's function grants, so at
 * the moment of the change Ask once and the mode lift the same asks (class grants).
 */
function strictness(level: FunctionLevel, mode: PermissionMode, cls: ActionClass, facts: ActionFacts): number {
  const outcome = cellOutcome(level === 'mode' ? MODE_TABLE[mode][cls] : LEVEL_CELLS[level][cls], facts)

  if (outcome === 'ask') {
    return level === 'askAlways' ? 2 : 1
  }

  return outcome === 'allow' ? 0 : 3
}

/**
 * R2-m5 (§7) — "lowering is immediate": a change is a raise (gesture + native old → new confirm) only when the new
 * level is laxer than what the row resolves to TODAY for some class and fact set, Follow mode resolved against every
 * mode in effect now (the standing mode and each project or chat override). Anything as strict or stricter everywhere
 * applies at once.
 */
export function isRaise(from: FunctionLevel, to: FunctionLevel, modesInEffect: readonly PermissionMode[]): boolean {
  if (from === to) {
    return false
  }

  // No mode known is the strict reading: Plan refuses everything but reading and safe GETs.
  const modes: readonly PermissionMode[] = modesInEffect.length > 0 ? modesInEffect : ['plan']

  return modes.some(mode =>
    ACTION_CLASSES.some(cls =>
      ALL_FACTS.some(facts => strictness(to, mode, cls, facts) < strictness(from, mode, cls, facts))
    )
  )
}

const SEVERITY: Readonly<Record<Outcome, number>> = { allow: 0, ask: 1, refuse: 2 }

/**
 * R2-m4 — between candidates that all ask, the stricter level names the ask (its sheet offers its scopes): Ask always
 * (once only) beats Ask once, which beats the mode, so the sheet never offers a longer scope than a row allows.
 */
const ASK_TIE: Readonly<Record<FunctionLevel, number>> = {
  ignore: 0,
  automatic: 0,
  mode: 1,
  askOnce: 2,
  manual: 3,
  askAlways: 4
}

/** The new candidate replaces the winner: stricter outcome, or the same ask from a stricter level. */
const stricter = (one: FunctionDecision, winner: FunctionDecision): boolean =>
  SEVERITY[one.outcome] > SEVERITY[winner.outcome] ||
  (one.outcome === 'ask' && winner.outcome === 'ask' && ASK_TIE[one.level] > ASK_TIE[winner.level])

/** Which grant lifted an ask (`rule: 'grant'`): the owner's late Allow once, a function grant, or a class grant. */
type GrantedBy = 'class' | 'fn' | 'once'

export interface FunctionDecision extends Decision {
  /** The function whose level decided (the strictest candidate), or null when the call has no function. */
  fn: PermissionFunction | null
  level: FunctionLevel
  by: GrantedBy | null
  /**
   * R4-UNREAD: the call was not fully read and rows at a user level took part — the decision is an ask or a refusal,
   * and an ask offers once only (no grant it could leave would lift the next unread call).
   */
  unread?: true
}

interface FunctionDecideInput extends Omit<DecideInput, 'granted'> {
  /** The call's functions from the plugin's mapping (`functions.py`); empty = none (V3-F decides). */
  fns: readonly PermissionFunction[]
  levels: Readonly<Partial<Record<PermissionFunction, FunctionLevel>>>
  /** A live V3-F class grant covers this call (never true for `$`: class grants never cover spending). */
  classGranted: boolean
  /** The owner's own Allow once for this very call arrived after the plugin stopped waiting (main only). */
  onceGranted?: boolean
  /** A live grant for this function (given on an Ask once sheet). */
  fnGranted?: (fn: PermissionFunction) => boolean
  /**
   * R3-MONO: the parts of a text line, each read by the plugin as a line of its own (`functions.Part`), with main's
   * own switch and class grant for the part's class. A row at a user level decides on the line AND on every part
   * that touches it; the strictest term wins.
   */
  parts?: readonly FunctionPart[]
  /**
   * R4-UNREAD — a call that is not FULLY READ: the plugin did not read its parts (its signed body set no level,
   * main's does: the policy is being republished), could not read them within its counted caps (it sends `[]`), or
   * says so (R5-G: outside the closed grammar, `unread: true`). Every row at a user level is then a candidate, none
   * allows without an ask, and no standing grant lifts the ask (only the owner's own once for this very call). R5-D:
   * the parts it carries are still terms, and one OFF switch anywhere refuses it. Reading (`R`) stays free.
   */
  partsUnread?: boolean
  /** R5-D (d): some Privacy switch is OFF. An unread call may touch every function, so it meets every switch. */
  switchesOff?: boolean
}

/** One part of a call, as main decides it (see `parts`). */
interface FunctionPart {
  cls: ActionClass
  facts: ActionFacts
  floor: string | null
  ceiling: Ceiling | undefined
  classGranted: boolean
  fns: readonly PermissionFunction[]
}

type LevelTerm = Pick<FunctionPart, 'ceiling' | 'classGranted' | 'cls' | 'facts' | 'floor'>

/** R4-UNREAD: a text call that was not fully read (reading itself is never unread: it belongs to no function). */
const unreadCall = (input: FunctionDecideInput): boolean => !!input.partsUnread && input.cls !== 'R'

const grantedBy = (
  input: FunctionDecideInput,
  fn: PermissionFunction,
  level: FunctionLevel,
  classGranted = input.classGranted
): GrantedBy | null => {
  if (input.onceGranted) {
    return 'once'
  }

  // R4-UNREAD: no standing grant (for the function or for a class) lifts what was not fully read
  if (level === 'askAlways' || level === 'manual' || (level !== 'mode' && unreadCall(input))) {
    return null
  }

  if (level !== 'mode' && input.fnGranted?.(fn)) {
    return 'fn'
  }

  return classGranted ? 'class' : null
}

/** One user level on one class (the line's or a part's), in V3-F's order: floor, OFF, cell, undecided, grant. */
function levelTerm(
  input: FunctionDecideInput,
  fn: PermissionFunction,
  level: UserLevel,
  term: LevelTerm
): FunctionDecision {
  const by = grantedBy(input, fn, level, term.classGranted)
  const cell = LEVEL_CELLS[level][term.cls]

  if (term.floor) {
    return { outcome: 'refuse', rule: 'floor', cell, fn, level, by: null }
  }

  // R5-D (d): an unread call meets every switch — one OFF anywhere refuses it
  if (term.ceiling === 'off' || (unreadCall(input) && input.switchesOff)) {
    return { outcome: 'refuse', rule: 'ceiling', cell, fn, level, by: null }
  }

  const read = cellOutcome(cell, term.facts ?? {})
  const outcome = read === 'allow' && unreadCall(input) ? 'ask' : read

  if (outcome === 'allow' && term.ceiling === 'undecided' && term.cls !== 'R') {
    return by
      ? { outcome: 'allow', rule: 'grant', cell, fn, level, by }
      : { outcome: 'ask', rule: 'ceiling', cell, fn, level, by: null }
  }

  if (outcome === 'ask' && by) {
    return { outcome: 'allow', rule: 'grant', cell, fn, level, by }
  }

  return { outcome, rule: 'function', cell, fn, level, by: null }
}

/** One candidate: its level's cell in V3-F's order — floor, ceiling OFF, cell, undecided ceiling, grant. */
function decideOne(input: FunctionDecideInput, fn: PermissionFunction): FunctionDecision {
  const raw = input.levels[fn]
  // A level the signed body or file does not name is the default; a malformed one is Ask always (never wider).
  const level: FunctionLevel = raw === undefined ? DEFAULT_FUNCTION_LEVEL : isFunctionLevel(raw) ? raw : 'askAlways'

  if (level === 'mode') {
    const by = grantedBy(input, fn, level)
    const decision = decide({ ...input, granted: by !== null })

    // R5-D: a row at Follow mode decides V3-F on every part read that touches it too (its class, facts, floor,
    // switch — OFF refuses, undecided asks — and class grant); the strictest term wins
    let strictest: FunctionDecision = { ...decision, fn, level, by: decision.rule === 'grant' ? by : null }

    for (const part of input.parts ?? []) {
      if (part.fns.includes(fn)) {
        const partBy = grantedBy(input, fn, level, part.classGranted)
        const term = decide({ ...input, ...part, granted: partBy !== null })

        if (SEVERITY[term.outcome] > SEVERITY[strictest.outcome]) {
          strictest = { ...term, fn, level, by: term.rule === 'grant' ? partBy : null }
        }
      }
    }

    return strictest
  }

  // R3-MONO: the whole line, then every part that touches this row; the strictest term wins (the first on a tie).
  // R5-D (c): every part read is a term, unread or not.
  let one = levelTerm(input, fn, level, {
    cls: input.cls,
    facts: input.facts ?? {},
    floor: input.floor ?? null,
    ceiling: input.ceiling,
    classGranted: input.classGranted
  })

  for (const part of input.parts ?? []) {
    if (part.fns.includes(fn)) {
      const term = levelTerm(input, fn, level, part)

      if (SEVERITY[term.outcome] > SEVERITY[one.outcome]) {
        one = term
      }
    }
  }

  return one
}

/** Candidates in the fixed function order, valid and unique (the plugin's list is data, never trusted for order). */
export function orderFunctions(fns: readonly unknown[]): PermissionFunction[] {
  const wanted = new Set(fns.filter(isPermissionFunction))

  return PERMISSION_FUNCTIONS.filter(fn => wanted.has(fn))
}

/**
 * The decision for one call (§5): no candidate ⇒ V3-F `decide`; otherwise the strictest candidate (refuse > ask >
 * allow; an ask tie goes to the stricter level, other ties to the function order). Adding a candidate can only keep
 * or tighten the outcome.
 */
export function decideFunctions(input: FunctionDecideInput): FunctionDecision {
  // R4-UNREAD: an unread call is decided by every row at a user level too, whatever functions it names
  const userRows = unreadCall(input)
    ? PERMISSION_FUNCTIONS.filter(fn => input.levels[fn] !== undefined && input.levels[fn] !== 'mode')
    : []

  const fns = orderFunctions([...input.fns, ...userRows])

  if (fns.length === 0) {
    const by: GrantedBy | null = input.onceGranted ? 'once' : input.classGranted ? 'class' : null
    const decision = decide({ ...input, granted: by !== null })

    return { ...decision, fn: null, level: 'mode', by: decision.rule === 'grant' ? by : null }
  }

  let winner: FunctionDecision | null = null

  for (const fn of fns) {
    const one = decideOne(input, fn)

    if (!winner || stricter(one, winner)) {
      winner = one
    }
  }

  return userRows.length > 0 ? { ...(winner as FunctionDecision), unread: true } : (winner as FunctionDecision)
}

const MONEY_FUNCTIONS: readonly PermissionFunction[] = ['payments', 'trading', 'shopping', 'acp']
const MESSAGE_FUNCTIONS: readonly PermissionFunction[] = ['email', 'messaging']

/**
 * The tools whose text (a command, typed input, code) the plugin maps through its word tables — `_SHELL_TOOLS` in
 * `functions.py`; the fixture holds the two lists equal.
 */
export const SHELL_TEXT_TOOLS: readonly string[] = [
  'cronjob',
  'cronjob_manage',
  'execute_code',
  'process',
  'process_manage',
  'terminal'
]

/**
 * R3-U — the tools no row governs (`_NO_FUNCTION` in `functions.py`; the fixture holds the two lists equal): reads, GETs,
 * provider calls, the screen, the app's own panes, delegation. Their empty list is real. Any OTHER tool that reaches
 * main with an empty list is every function (the plugin's R2-M1, re-applied by main).
 */
export const NO_FUNCTION_TOOLS: readonly string[] = [
  'a2a_discover',
  'a2a_history',
  'a2a_list',
  'annotate_preview',
  'apply_layout',
  'browser_back',
  'browser_get_images',
  'browser_navigate',
  'browser_scroll',
  'browser_snapshot',
  'browser_vault_list',
  'browser_vault_unlock',
  'browser_vision',
  'clarify',
  'close_terminal',
  'computer_use',
  'delegate_task',
  'desktop_preview',
  'drive_preview',
  'feishu_doc_read',
  'feishu_drive_list_comment_replies',
  'feishu_drive_list_comments',
  'focus_pane',
  'gui_tour',
  'image_generate',
  'kanban_attachments',
  'kanban_list',
  'kanban_show',
  'manage_catalog',
  'manage_connections',
  'meet_leave',
  'meet_status',
  'meet_transcript',
  'read_file',
  'read_terminal',
  'read_window_below',
  'search_files',
  'session_search',
  'setup_mcp',
  'show_tip',
  'skill_view',
  'skills_list',
  'spotify_albums',
  'spotify_devices',
  'spotify_library',
  'spotify_playback',
  'spotify_playlists',
  'spotify_queue',
  'spotify_search',
  'text_to_speech',
  'tip',
  'todo',
  'todo_list',
  'tour',
  'video_analyze',
  'video_generate',
  'vision_analyze',
  'web_extract',
  'web_search',
  'x_search',
  'xai_video_edit',
  'xai_video_extend',
  'yb_query_group_info',
  'yb_query_group_members',
  'yb_search_sticker'
]

/**
 * V3-UP r3 — the Tool Search lookups and the bundled memory providers' queries: no row governs them either (reads of
 * the session's own catalog; provider calls). A list of their own so the shipped V3-F2 fixture (functions.json) stays
 * as it was; `functions.py` `_NO_FUNCTION_PROVIDER_READS` is the plugin's copy and
 * `tests/fixtures/functions_provider_reads.json` holds the two equal (functions-provider-reads.test.ts).
 */
export const NO_FUNCTION_PROVIDER_READS: readonly string[] = [
  'brv_query',
  'brv_status',
  'retaindb_context',
  'retaindb_list_files',
  'retaindb_profile',
  'retaindb_read_file',
  'retaindb_search',
  'tool_describe',
  'tool_search',
  'viking_browse',
  'viking_read',
  'viking_search'
]

/** R3-MONO family closure over a union: any money row ⇒ all four money rows, any message row ⇒ both. */
function closeFamilies(fns: Iterable<PermissionFunction>): Set<PermissionFunction> {
  const out = new Set(fns)

  for (const family of [MONEY_FUNCTIONS, MESSAGE_FUNCTIONS]) {
    if (family.some(fn => out.has(fn))) {
      family.forEach(fn => out.add(fn))
    }
  }

  return out
}

/**
 * R2-m1 / R3-MONO — main re-applies the plugin's coverage (§4.5) itself and never trusts the plugin's list alone: it
 * can only ADD rows. The same function as the plugin's `cover` (fixture `coverCodes`). Text tools: an empty set is
 * Shell; `$` ⇒ every money row, `M` ⇒ both message rows; a Shell part on a `$`/`M` line ⇒ every money and message
 * row; then the families are closed over the union, whatever class the line has. Structured tools keep the row their
 * name pins: `$` ⇒ every money row, `M` with no message row ⇒ both. Any tool: delete/write classes ⇒ Files. R3-U: any
 * other tool with an empty list ⇒ every function.
 */
export function coverFunctions(
  tool: string,
  cls: ActionClass,
  fns: readonly PermissionFunction[]
): PermissionFunction[] {
  if (cls === 'R') {
    return orderFunctions(fns)
  }

  let out = new Set<PermissionFunction>(orderFunctions(fns))
  const text = SHELL_TEXT_TOOLS.includes(tool)
  const add = (list: readonly PermissionFunction[]) => list.forEach(fn => out.add(fn))

  // R3-U: a tool that is neither a text tool nor a no-function tool, sent with an empty list, is every function
  if (out.size === 0 && !text && !NO_FUNCTION_TOOLS.includes(tool) && !NO_FUNCTION_PROVIDER_READS.includes(tool)) {
    add(PERMISSION_FUNCTIONS)
  }

  if (text && out.size === 0) {
    out.add('shell')
  }

  if (cls === '$') {
    add(MONEY_FUNCTIONS)
  }

  if (cls === 'M' && (text || !MESSAGE_FUNCTIONS.some(fn => out.has(fn)))) {
    add(MESSAGE_FUNCTIONS)
  }

  if (text && (cls === '$' || cls === 'M') && out.has('shell')) {
    add(MONEY_FUNCTIONS)
    add(MESSAGE_FUNCTIONS)
  }

  if (cls === 'D' || cls === 'Wp' || cls === 'Wo') {
    out.add('files')
  }

  if (text) {
    out = closeFamilies(out)
  }

  return orderFunctions([...out])
}

/**
 * R4-UNREAD — is a call's reading incomplete? The plugin says so (R5-G: `unread: true`, the call is outside the
 * closed grammar or past the counted work; it may still carry the parts it read), or a text call is not read (`null`)
 * or read but not fully (`[]`: a read call always carries its whole line as part 0, so an empty list is never a
 * reading). Main does not parse: it obeys the flag and the list.
 */
export function partsUnreadFor(
  tool: string,
  parts: readonly unknown[] | null | undefined,
  unread: boolean = false
): boolean {
  return unread || (SHELL_TEXT_TOOLS.includes(tool) && (!parts || parts.length === 0))
}

/**
 * Levels read from disk or a request: every function present, anything unknown is the default — and, with the
 * loosening levels off (`F2_LOOSENING_ENABLED`, the r5 contingency), so is a loosening level the file still holds.
 */
export function normalizeLevels(value: unknown): FunctionLevels {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

  const reachable = (level: unknown): level is FunctionLevel =>
    isFunctionLevel(level) && levelOffered(level, F2_LOOSENING_ENABLED)

  return Object.fromEntries(
    PERMISSION_FUNCTIONS.map(fn => [fn, reachable(raw[fn]) ? raw[fn] : DEFAULT_FUNCTION_LEVEL])
  ) as FunctionLevels
}

/**
 * Unsealed runs only (modeFor is Manual there): Manual and Ask always stay, every other level follows the (Manual)
 * mode (V3-F §2). A sealed run must NOT reuse this for pending rows — 'mode' follows the standing mode there.
 */
export function clampUnsealed(levels: FunctionLevels): FunctionLevels {
  return Object.fromEntries(
    PERMISSION_FUNCTIONS.map(fn => [
      fn,
      levels[fn] === 'manual' || levels[fn] === 'askAlways' ? levels[fn] : DEFAULT_FUNCTION_LEVEL
    ])
  ) as FunctionLevels
}

/** Door scopes for an ask the winning function decided: Ask always is once only; Ask once may remember, `$` too. */
export function functionGrantScopes(
  level: FunctionLevel
): readonly ('once' | 'project' | 'session' | 'standing')[] | null {
  if (level === 'askAlways' || level === 'manual') {
    return ['once']
  }

  return level === 'askOnce' ? ['once', 'session', 'project', 'standing'] : null
}
