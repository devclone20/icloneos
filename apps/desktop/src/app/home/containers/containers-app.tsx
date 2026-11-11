import '../econ/econ.css'
import './containers.css'

/**
 * The Containers window: every confined command the agent runs, from its start to its end. Activity lists the live
 * ones and the recent ones; the inspector shows one in full — its lifecycle, its profile and grants, and why each
 * refusal happened — and stops it. Refusals, Profiles, Agents and Machine explain the rest. It opens in the one
 * window chassis every Dock app uses, is built from the EconomyOS parts only, and renders `state` and nothing else:
 * main folds that on every read, and containers-data.ts shapes it.
 */
import { useStore } from '@nanostores/react'
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual'
import { Ban, Check, ChevronRight, CircleDashed, Square, X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ISOLATION_TITLE, IsolationControl, IsolationOffLine } from '@/components/permissions/isolation-control'
import { OverflowTip, Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import type { ConfinementCopy } from '@/i18n/en/confinement'
import type {
  ActivityClass,
  ConfinementStateView,
  OutsideProcessView,
  RefusalWhy,
  RunPhase,
  RunView
} from '@/iclone-shared/confinement'
import {
  $confinement,
  acknowledgeHardlink,
  readConfinementOnce,
  readHardlinkGroupPaths,
  stopRun,
  watchConfinement
} from '@/store/confinement'

import {
  Action,
  AppFrame,
  Cell,
  CopyText,
  Empty,
  IconAction,
  Note,
  Pill,
  RailItem,
  RailSection,
  Row,
  Rows,
  SearchBox,
  SectionTitle,
  SkeletonRows,
  Tabs,
  Toolbar
} from '../econ/ui'
import { useEconPanelEscape } from '../home-escape'
import { IcWindow, useWindowExpanded } from '../window'

import { allowFolder, type FolderNotes } from './containers-allow'
import { useContainersCopy } from './containers-copy'
import {
  agentName,
  agentRows,
  backendTone,
  clock,
  endedSince,
  failedMeaning,
  filterCounts,
  filterRuns,
  firstLine,
  folderToOffer,
  groupRuns,
  homeRelative,
  isLive,
  launcherTone,
  macFaults,
  modesStopReason,
  moveSelection,
  narrowedKey,
  newestNarrowed,
  notesBeforeStop,
  originCounts,
  type OriginFilter,
  type PaneNote,
  phaseLabel,
  phasesOf,
  phaseTone,
  plainDetail,
  ranOnceMark,
  READ_STALE_AFTER_MS,
  refusalGroups,
  type RefusalKind,
  refusalKinds,
  refusalsOf,
  refusedBeforeStart,
  runAgent,
  type RunFilter,
  runSeconds,
  runsOfAgent,
  runtimeTone,
  sayActionKind,
  sayOperation,
  sayReason,
  sayTool,
  sayWhy,
  secondsBetween,
  shortSha,
  splitHousekeeping,
  splitScope,
  stopNoteOf,
  stopResultNote,
  tally,
  timeline,
  unfoldedBecause,
  verdictTone,
  whyCounts
} from './containers-data'
import { $containersOpen } from './containers-dock'
import { useKeepFocus } from './containers-focus'
import { FirstScanStatus } from './first-scan-status'
import { IcContainer } from './ic-container'

type Section = 'activity' | 'agents' | 'mac' | 'profiles' | 'refusals'

/** `blocked`: another Dock window took the stage, so this one closes. */
export function ContainersWindow({ blocked }: { blocked: boolean }) {
  const open = useStore($containersOpen)

  useEffect(() => {
    if (blocked) {
      $containersOpen.set(false)
    }
  }, [blocked])

  return open && !blocked ? <ContainersPane onClose={() => $containersOpen.set(false)} /> : null
}

/** The row of a run, for focus after Up/Down or Escape (ids are run-token names, so no selector escaping). */
function focusRun(id: string | null): void {
  if (id === null) {
    return
  }

  const holder = [...document.querySelectorAll<HTMLElement>('[data-run]')].find(node => node.dataset.run === id)

  holder?.querySelector<HTMLElement>('.e-row')?.focus()
}

function ContainersPane({ onClose }: { onClose: () => void }) {
  const copy = useContainersCopy()
  const chrome = useI18n().t.desktop.home
  const { error, state, status } = useStore($confinement)
  const { expanded, toggle: toggleExpanded } = useWindowExpanded('containers')
  const [section, setSection] = useState<Section>('activity')
  const [filter, setFilter] = useState<RunFilter>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [note, setNote] = useState<PaneNote | null>(null)
  const [stopNotes, setStopNotes] = useState<Readonly<Record<string, PaneNote>>>({})
  const [folderNotes, setFolderNotes] = useState<FolderNotes>({})
  const [stopping, setStopping] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [seen, setSeen] = useState<ConfinementStateView | null>(null)
  const [overdueRead, setOverdueRead] = useState<ConfinementStateView | null | undefined>(undefined)
  const L = copy.ledger

  useEffect(() => watchConfinement(), [])

  // A read that never settles rejects nothing, so the store stays 'ready' with its last answer. Only the age of that
  // answer can say so: every read replaces `state`, which restarts this clock.
  useEffect(() => {
    const timer = window.setTimeout(() => setOverdueRead(state), READ_STALE_AFTER_MS)

    return () => window.clearTimeout(timer)
  }, [state])

  // A run that was live in the last read and is not now is said once, politely, to a screen reader. Compared while
  // rendering the new read (React's "adjust state on a new prop" pattern), so no effect and no ref mirror the store.
  if (state && state !== seen) {
    const ended = seen ? endedSince(phasesOf(seen.runs), state.runs) : []

    setSeen(state)

    if (ended.length > 0) {
      setAnnouncement(
        ended.map(run => L.announce(firstLine(ranOnceMark(run.command).command), phaseLabel(L, run))).join('. ')
      )
    }
  }

  const open = useCallback((id: string) => {
    setSelected(id)
    setInspecting(true)
  }, [])

  const close = useCallback(() => {
    setInspecting(false)
    focusRun(selected)
  }, [selected])

  const stop = useCallback(
    async (run: RunView) => {
      setStopping(run.id)
      setStopNotes(notes => notesBeforeStop(notes, run.id))

      const said = stopResultNote(copy, await stopRun(run.id))

      setStopping(current => (current === run.id ? null : current))
      setStopNotes(notes => ({ ...notes, [run.id]: said }))

      // A failure is already an alert where it is drawn; said twice it would be read twice.
      if (said.kind !== 'error') {
        setAnnouncement(said.text)
      }
    },
    [copy]
  )

  // Synchronous up to the bridge call: the preload attaches the proof of this very click (data-confinement-confirm).
  // One click allows the files under one directory, exactly as shown (the digest): a link planted since asks again.
  const allowHardlink = useCallback(
    (root: string, dir: string, digest: string) => {
      void acknowledgeHardlink(root, dir, digest).then(result =>
        setNote(
          result.ok
            ? { kind: 'info', text: copy.hardlinks.allowed(result.count) }
            : { kind: 'error', text: copy.hardlinks.ackFailed[result.reason] }
        )
      )
    },
    [copy]
  )

  // The same rule as Allow on a hard link: synchronous up to the bridge call, so the preload can prove this very click.
  const allowThisFolder = useCallback((folder: string) => {
    void allowFolder(folder).then(note => {
      setFolderNotes(notes => ({ ...notes, [folder]: note }))
      void readConfinementOnce()
    })
  }, [])

  const reviewHardlinks = useCallback(() => {
    setSection('activity')
    window.requestAnimationFrame(() =>
      window.document.querySelector<HTMLElement>('[data-hardlink-root] [data-confinement-confirm] button')?.focus()
    )
  }, [])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && inspecting) {
      event.stopPropagation()
      close()
    }
  }

  useEconPanelEscape(inspecting, close)

  const onFocusCapture = useKeepFocus()
  // main's answer stopped arriving: everything below is the last read, and the verdict must not read as live.
  const overdue = overdueRead === state
  const stale = state !== null && (status === 'error' || overdue)

  const title = copy.title
  const inspected = inspecting && state && selected ? (state.runs.find(run => run.id === selected) ?? null) : null

  return (
    <IcWindow
      expanded={expanded}
      head={<h2>{title}</h2>}
      id="containers"
      kind="containers"
      label={chrome.windowLabel(title)}
      labels={{
        close: chrome.closeWindow(title),
        expand: chrome.expandWindow(title),
        retract: chrome.retractWindow(title),
        opacity: chrome.windowOpacity(title)
      }}
      onClose={onClose}
      onToggleExpanded={toggleExpanded}
      placement="self"
    >
      <p aria-atomic="true" aria-live="polite" className="icont__sr">
        {announcement}
      </p>
      {status === 'unavailable' ? (
        <Empty icon={<IcContainer size={28} />} title={copy.unavailable} />
      ) : !state && (error || overdue) ? (
        <Empty
          action={<Action onClick={() => void readConfinementOnce()}>{L.noRead.retry}</Action>}
          hint={L.noRead.hint}
          icon={<IcContainer size={28} />}
          title={L.noRead.title}
        />
      ) : !state ? (
        <SkeletonRows rows={7} />
      ) : (
        <div className="icont" onFocusCapture={onFocusCapture} onKeyDown={onKeyDown} tabIndex={-1}>
          <AppFrame
            aside={
              inspecting && selected ? (
                <Inspector
                  copy={copy}
                  folderNotes={folderNotes}
                  note={inspected ? stopNoteOf(stopNotes, inspected) : null}
                  onAllowFolder={allowThisFolder}
                  onClose={close}
                  onOpenMachine={() => setSection('mac')}
                  onReviewHardlinks={reviewHardlinks}
                  onStop={stop}
                  run={inspected}
                  stale={stale}
                  state={state}
                  stopping={stopping === selected}
                />
              ) : undefined
            }
            rail={<Rail copy={copy} onSelect={setSection} section={section} stale={stale} state={state} />}
          >
            <div className="icont__page" data-section={section}>
              <Lead
                copy={copy}
                onOpenBackends={() => setSection('mac')}
                section={section}
                stale={stale}
                state={state}
              />
              <div className="icont__scroll">
                <div className="icont__standing" data-standing="">
                  {stale ? <Note kind="warn">{L.stale.note(clock(state.at))}</Note> : null}
                  {state.verdict === 'red' && state.reasons.length > 0 ? (
                    <Note kind="error">
                      <b>{copy.reasons}</b> {state.reasons.map(reason => sayReason(copy, reason)).join(' · ')}
                    </Note>
                  ) : null}
                </div>
                <div className="icont__body">
                  {section === 'refusals' ? <IsolationOffLine /> : null}
                  {section === 'activity' && note ? <Note kind={note.kind}>{note.text}</Note> : null}
                  {section === 'activity' && (
                    <Activity
                      copy={copy}
                      filter={filter}
                      folderNotes={folderNotes}
                      inspected={inspecting ? selected : null}
                      onAllowFolder={allowThisFolder}
                      onAllowHardlink={allowHardlink}
                      onFilter={setFilter}
                      onOpen={open}
                      onQuery={setQuery}
                      onSelect={setSelected}
                      onStop={stop}
                      query={query}
                      selected={selected}
                      stale={stale}
                      state={state}
                      stopNotes={stopNotes}
                      stopping={stopping}
                    />
                  )}
                  {section === 'refusals' && <Refusals copy={copy} onOpen={open} state={state} />}
                  {section === 'profiles' && <Profiles copy={copy} state={state} />}
                  {section === 'agents' && <Agents copy={copy} state={state} />}
                  {section === 'mac' && <Machine copy={copy} state={state} />}
                </div>
              </div>
            </div>
          </AppFrame>
        </div>
      )}
    </IcWindow>
  )
}

/**
 * The window's top is its title and nothing else, so what the head used to say lives here: each subtopic opens with its
 * own name and its own facts, always in the same place. The verdict belongs to the commands (Activity) and to what holds
 * them (Backends); blocked attempts belong to Refusals, where they read as the sandbox at work, never as a fault. The
 * pill stands in one place on every tab, and from the other four it opens Backends, where the control is.
 */
function Lead({
  copy,
  onOpenBackends,
  section,
  stale,
  state
}: {
  copy: ConfinementCopy
  onOpenBackends: () => void
  section: Section
  stale: boolean
  state: ConfinementStateView
}) {
  const L = copy.ledger
  const T = L.tally
  const counted = tally(state)
  // The lead is the title and the pill. A sentence stands under them only when something is wrong; green and off are the
  // pill, with the whole verdict in its Tip.
  const saysVerdict = (section === 'activity' || section === 'mac') && (stale || state.verdict === 'red')
  const verdict = stale ? L.stale : copy.verdict[state.verdict]
  const inside = state.agents.reduce((sum, agent) => sum + agent.inside, 0)
  const outside = state.agents.reduce((sum, agent) => sum + agent.outside, 0)

  return (
    <header className="icont__lead">
      <div className="icont__lead-top">
        <h3 className="icont__lead-title">{L.tabs[section === 'mac' ? 'machine' : section]}</h3>
        <span className="icont__verdict" data-verdict={stale ? 'stale' : state.verdict}>
          <Tip label={verdict.hint}>
            {section === 'mac' ? (
              <span className="icont__verdict-pill">
                <Pill tone={stale ? 'warn' : verdictTone(state.verdict)}>{verdict.label}</Pill>
              </span>
            ) : (
              <button
                aria-label={`${verdict.label}: ${L.tabs.machine}`}
                className="icont__verdict-pill"
                data-verdict-open=""
                onClick={onOpenBackends}
                type="button"
              >
                <Pill tone={stale ? 'warn' : verdictTone(state.verdict)}>{verdict.label}</Pill>
              </button>
            )}
          </Tip>
        </span>
      </div>
      <div className="icont__lead-line">
        {saysVerdict ? (
          <Tip label={verdict.hint}>
            <span className="icont__verdict-hint">{L.headLine[stale ? 'stale' : state.verdict]}</span>
          </Tip>
        ) : null}
        {/* The Running segment holds the live count. Said here only as the last read's, or beside the runtime's own. */}
        {section === 'activity' && (stale || counted.housekeeping > 0) ? (
          <span className="icont__tally">
            {stale ? <span data-tally="running">{T.runningAtLastRead(counted.running)}</span> : null}
            {counted.housekeeping > 0 ? <span>{T.housekeeping(counted.housekeeping)}</span> : null}
          </span>
        ) : null}
        {section === 'refusals' ? (
          <span className="icont__tally">
            <Tip label={T.blockedTip}>
              <span data-blocked={counted.blockedLastHour}>
                {T.blocked(counted.blockedLastHour, counted.blockedMore)}
              </span>
            </Tip>
            {/* A part of the blocked count, said beside it as the runtime's claim (its mark is its own word, not a fact). */}
            {counted.blockedByRuntime > 0 ? (
              <span data-blocked-by="runtime">{T.blockedByRuntime(counted.blockedByRuntime, counted.blockedMore)}</span>
            ) : null}
          </span>
        ) : null}
        {section === 'agents' ? (
          <span className="icont__tally">
            <span>{copy.insideCount(inside)}</span>
            <span>{copy.outsideCount(outside)}</span>
          </span>
        ) : null}
      </div>
    </header>
  )
}

function Rail({
  copy,
  onSelect,
  section,
  stale,
  state
}: {
  copy: ConfinementCopy
  onSelect: (section: Section) => void
  section: Section
  stale: boolean
  state: ConfinementStateView
}) {
  const L = copy.ledger
  const counted = tally(state)
  const faults = macFaults(state)

  return (
    <RailSection>
      <RailItem
        active={section === 'activity'}
        count={counted.running}
        label={L.tabs.activity}
        onClick={() => onSelect('activity')}
        tone={counted.running > 0 && !stale ? 'up' : undefined}
      />
      {/* Refusals are the sandbox working: a count, never a red mark. The same count the view's All tab shows. */}
      <RailItem
        active={section === 'refusals'}
        count={state.refusals.length + refusedBeforeStart(state).length}
        label={L.tabs.refusals}
        onClick={() => onSelect('refusals')}
      />
      <RailItem
        active={section === 'profiles'}
        count={state.profiles.length + 1}
        label={L.tabs.profiles}
        onClick={() => onSelect('profiles')}
      />
      <RailItem
        active={section === 'agents'}
        count={state.agents.length}
        label={L.tabs.agents}
        onClick={() => onSelect('agents')}
      />
      <RailItem
        active={section === 'mac'}
        count={faults}
        label={L.tabs.machine}
        onClick={() => onSelect('mac')}
        tone={faults > 0 ? 'down' : undefined}
      />
    </RailSection>
  )
}

const className = (copy: ConfinementCopy, cls: ActivityClass | null): string => (cls ? copy.classes[cls].name : '—')

/** The status mark: a dot that breathes only while the root runs (and holds still under reduced motion). `stale`: the
 *  run was live at the last read, which nobody can vouch for now, so the dot neither breathes nor claims a state. */
function Dot({ label, phase, stale = false }: { label?: string; phase: RunPhase; stale?: boolean }) {
  const dot = (
    <span
      aria-hidden={label ? undefined : 'true'}
      aria-label={label}
      className="icont__dot"
      data-live={phase === 'running' && !stale ? 'true' : undefined}
      data-tone={stale ? 'muted' : phaseTone(phase)}
      role={label ? 'img' : undefined}
    />
  )

  return label ? <Tip label={label}>{dot}</Tip> : dot
}

/** The ended phases' glyphs; live phases keep the dot. With `label`, the glyph carries the phase words itself (its name
 *  and a Tip), so the row may hide the phase text when the inspector narrows the list. */
function Glyph({
  ended = false,
  label,
  phase,
  stale
}: {
  /** RunView.backgroundEnded: over, and how it ended is not known, so never the success check. */
  ended?: boolean
  label?: string
  phase: RunPhase
  stale?: boolean
}) {
  const icon =
    phase === 'exited' ? (
      ended ? (
        <CircleDashed data-glyph="unknown-end" size={12} strokeWidth={2} />
      ) : (
        <Check size={12} strokeWidth={2.2} />
      )
    ) : phase === 'failed' ? (
      <X size={12} strokeWidth={2.2} />
    ) : phase === 'stopped' ? (
      <Square size={10} strokeWidth={2.2} />
    ) : phase === 'refused' ? (
      <Ban size={12} strokeWidth={2} />
    ) : phase === 'unknown' ? (
      <CircleDashed size={12} strokeWidth={2} />
    ) : null

  if (!icon) {
    return <Dot phase={phase} stale={stale} />
  }

  return label ? (
    <Tip label={label}>
      <span aria-label={label} className="icont__glyph" data-tone={phaseTone(phase)} role="img">
        {icon}
      </span>
    </Tip>
  ) : (
    <span aria-hidden="true" className="icont__glyph" data-tone={phaseTone(phase)}>
      {icon}
    </span>
  )
}

/** F45d-5: how the launcher says it ran the command, after the command and the first thing to give way. */
function RanOnce({ mark }: { mark: null | string }) {
  return mark ? (
    <span className="icont__ran-once" data-ran-once="">
      {mark}
    </span>
  ) : null
}

/** The command cell's line: a quiet Runtime mark first when the runtime marked the run as its own, then the command's
 *  first line, ellipsized. The whole text is in a Tip: when the line is cut off, or always when more lines follow. */
function CommandLine({ copy, run }: { copy: ConfinementCopy['ledger']; run: RunView }) {
  const { command, mark } = ranOnceMark(run.command)
  const shown = firstLine(command)
  const Hint = shown === command.trim() ? OverflowTip : Tip

  return (
    <span className="icont__command-line">
      {run.origin === 'runtime' ? (
        <span className="icont__origin" data-origin="runtime">
          <Pill tone="muted">{copy.runtimeBadge}</Pill>
        </span>
      ) : null}
      <Hint label={run.command}>
        <span className="icont__command">{shown}</span>
      </Hint>
      <RanOnce mark={mark} />
    </span>
  )
}

/** The refused count on a row: always the refused red. Its severity is the kernel's count; the run's origin is the
 *  runtime's own word (forgeable by a steered runtime), so it never softens how a refusal is shown. */
function RefusedBadge({ copy, run }: { copy: ConfinementCopy['ledger']; run: RunView }) {
  return run.refusals > 0 ? (
    <span className="icont__refused" data-origin={run.origin}>
      <Pill tone="down">{copy.refusedBadge(run.refusals)}</Pill>
    </span>
  ) : null
}

/** Why a command never started: the app's sentence for the code, and the sentence the refusal itself carried, in full. */
function RefusedWords({ copy, lead, run }: { copy: ConfinementCopy['ledger']; lead?: ReactNode; run: RunView }) {
  const detail = plainDetail(run.refusedDetail)
  // fx32p: the launcher's sentence is the code's sentence with the path in it, so it is said once.
  const whole = run.refusedReason === 'cwd-gone' && detail

  return (
    <>
      <p className="icont__explain">
        {lead}
        {whole || copy.refusedCode[run.refusedReason ?? 'other']}
      </p>
      {detail && !whole ? (
        <p className="icont__explain icont__said" data-refused-detail="">
          {detail}
        </p>
      ) : null}
    </>
  )
}

/** A run given less than it asked for: said in its own words, with the only thing that can be done about it here. */
function NarrowedNote({
  copy,
  folderNotes,
  offer,
  onAllow,
  run,
  short
}: {
  copy: ConfinementCopy['ledger']
  folderNotes: FolderNotes
  offer: string | null
  onAllow: (folder: string) => void
  run: RunView
  short?: boolean
}) {
  const key = narrowedKey(run)
  const outcome = offer ? folderNotes[offer] : undefined

  return (
    <div className="icont__narrowed" data-narrowed={key} data-short={short ? 'true' : undefined}>
      <p className="icont__narrowed-text">
        <span className="icont__narrowed-lead">{copy.narrowed.lead[key]}</span>
        {short ? null : ` ${copy.narrowed.why[key]}`}
      </p>
      {offer && !short ? (
        <div className="icont__allow" data-allow-folder={offer}>
          <code className="icont__allow-path">{offer}</code>
          {outcome && outcome !== 'failed' ? (
            <p className="icont__allow-means" data-allow-next={outcome} role="status">
              {outcome === 'allowed'
                ? copy.narrowed.allowed
                : outcome === 'allowed-plan'
                  ? copy.narrowed.allowedPlan
                  : copy.narrowed.allowedAsks}
            </p>
          ) : (
            <div className="icont__allow-act">
              {/* The preload takes the proof of this click from this mark; main allows nothing without it. */}
              <span data-confinement-confirm="">
                <Action onClick={() => onAllow(offer)}>{copy.narrowed.allow}</Action>
              </span>
              <p className="icont__allow-means" role={outcome === 'failed' ? 'alert' : undefined}>
                {outcome === 'failed' ? copy.narrowed.allowFailed : copy.narrowed.allowMeans}
              </p>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

function ModesStopNote({ copy, run }: { copy: ConfinementCopy['ledger']; run: RunView }) {
  const reason = modesStopReason(run.stoppedDetail)

  return (
    <div className="icont__narrowed" data-stopped-by-modes="">
      <p className="icont__narrowed-text">
        <span className="icont__narrowed-lead">{copy.stoppedByModes}</span>
        {reason ? ` ${reason}` : ''}
      </p>
    </div>
  )
}

/** What works when git could not write this repository's config. Each line was measured under the real profile
 *  (git-push-advice.live.test.ts). */
function GitInstead({ copy }: { copy: ConfinementCopy['ledger'] }) {
  return (
    <div className="icont__instead" data-git-instead="">
      <SectionTitle>{copy.gitInstead.title}</SectionTitle>
      {[copy.gitInstead.push, copy.gitInstead.identity].map(line => (
        <div className="icont__cmd" key={line}>
          <pre className="icont__cmd-text">{line}</pre>
          <CopyText text={line} />
        </div>
      ))}
    </div>
  )
}

const refusedWhy = (copy: ConfinementCopy['ledger'], run: RunView): string | undefined =>
  run.phase === 'refused' ? copy.refusedCode[run.refusedReason ?? 'other'] : undefined

function PhaseWords({ label, phase, why }: { label: string; phase: RunPhase; why?: string }) {
  const words = (
    <span aria-hidden="true" className="icont__phase" data-tone={phaseTone(phase)}>
      {label}
    </span>
  )

  return why ? <Tip label={why}>{words}</Tip> : words
}

function StopAction({
  copy,
  onStop,
  run,
  stopping
}: {
  copy: ConfinementCopy['ledger']
  onStop: (run: RunView) => Promise<void>
  run: RunView
  stopping: boolean
}) {
  return (
    <span className="icont__danger">
      <Action disabled={stopping} onClick={() => void onStop(run)} title={copy.stopTip}>
        {stopping ? copy.stopping : copy.stop}
      </Action>
    </span>
  )
}

/** How a Stop ended, in one form wherever it is said: under the run's row, and in the inspector. */
function StopResult({ note }: { note: PaneNote }) {
  return (
    <div className="icont__stop-result" data-stop-result={note.kind}>
      <Note kind={note.kind}>{note.text}</Note>
    </div>
  )
}

/** Who ran a command, in a row: the iNFT's name, or what it is when it has none (a session id is not a name). */
function RunAgent({ copy, run, state }: { copy: ConfinementCopy; run: RunView; state: ConfinementStateView }) {
  const said = runAgent(state, run, copy.noSession)

  return said === run.sessionId ? (
    <Tip label={said}>
      <span>{copy.ledger.agentSession}</span>
    </Tip>
  ) : (
    <bdi>{said}</bdi>
  )
}

function Activity({
  copy,
  filter,
  inspected,
  onAllowHardlink,
  onFilter,
  onOpen,
  onQuery,
  onSelect,
  onStop,
  query,
  selected,
  stale,
  state,
  stopNotes,
  stopping,
  folderNotes,
  onAllowFolder
}: {
  copy: ConfinementCopy
  filter: RunFilter
  folderNotes: FolderNotes
  inspected: string | null
  onAllowFolder: (folder: string) => void
  onAllowHardlink: (root: string, dir: string, digest: string) => void
  onFilter: (filter: RunFilter) => void
  onOpen: (id: string) => void
  onQuery: (query: string) => void
  onSelect: (id: string | null) => void
  onStop: (run: RunView) => Promise<void>
  query: string
  selected: string | null
  stale: boolean
  state: ConfinementStateView
  stopNotes: Readonly<Record<string, PaneNote>>
  stopping: string | null
}) {
  const L = copy.ledger

  // The inspector says it for the run it shows, so an open inspector does not read the result twice.
  const rowNote = (run: RunView) => {
    const note = run.id === inspected ? null : stopNoteOf(stopNotes, run)

    return (
      <>
        {note ? <StopResult note={note} /> : null}
        {run.id !== inspected && run.stoppedByModes ? <ModesStopNote copy={L} run={run} /> : null}
        {run.id !== inspected && run.narrowed ? (
          <NarrowedNote
            copy={L}
            folderNotes={folderNotes}
            offer={folderToOffer(run, state.runs)}
            onAllow={onAllowFolder}
            run={run}
            short={!fullNotes.has(run.id)}
          />
        ) : null}
      </>
    )
  }

  // The runtime's own commands (the shell session set-up, its probes) are confined runs like the rest; the uneventful
  // ones are kept out of the default list behind one disclosure (isFoldedHousekeeping says which, and why a claim of
  // housekeeping alone never hides a run): the agent's commands are what the owner came to read.
  const [showHousekeeping, setShowHousekeeping] = useState(false)
  const split = useMemo(() => splitHousekeeping(state.runs, state.at), [state.at, state.runs])
  const listed = showHousekeeping ? state.runs : split.listed
  const visible = useMemo(() => filterRuns(listed, filter, query), [filter, query, listed])
  const { recent, running } = groupRuns(visible)
  const fullNotes = useMemo(() => newestNarrowed(visible), [visible])
  const order = [...running, ...recent].map(run => run.id)
  const per = filterCounts(listed)
  const escaped = state.outside.filter(process => process.kind === 'agent-command')

  // One agent behind every row: its name in each says nothing.
  const oneAgent = new Set(visible.map(run => runAgent(state, run, copy.noSession))).size <= 1

  // On the Recent line when there is one; otherwise beside the filters, so a folded run can always come back.
  const housekeeping =
    split.folded.length > 0 ? (
      <Tip label={L.housekeeping.hint}>
        <button
          aria-expanded={showHousekeeping}
          className="e-btn e-btn--quiet icont__housekeeping"
          data-shown={showHousekeeping ? 'true' : undefined}
          onClick={() => setShowHousekeeping(shown => !shown)}
          type="button"
        >
          <span>{L.housekeeping.toggle(split.folded.length)}</span>
          <span className="icont__housekeeping-act">
            {showHousekeeping ? L.housekeeping.hide : L.housekeeping.show}
          </span>
        </button>
      </Tip>
    ) : null

  const onListKey = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return
    }

    event.preventDefault()

    const next = moveSelection(order, selected, event.key === 'ArrowDown' ? 1 : -1)

    onSelect(next)
    focusRun(next)
  }

  return (
    <div className="icont__activity">
      <FirstScanStatus className="icont__muted" />
      {state.hardlinks.map(block => (
        <div className="icont__hardlinks" data-hardlink-root={block.root} key={block.root}>
          <Note kind="error">
            {block.kind === 'cannot-scan'
              ? copy.hardlinks.cannotScan(block.root, block.paths, block.count)
              : copy.hardlinks.blocked(block.root, block.paths, block.count)}
          </Note>
          {block.groups.length > 0 ? (
            <Rows>
              {block.groups.map(group => (
                <div className="icont__group" key={group.dir}>
                  <Row>
                    <Cell grow mono>
                      <Tip label={group.dir}>
                        <span className="icont__command">{copy.hardlinks.group(group.dir, group.count)}</span>
                      </Tip>
                    </Cell>
                    <Cell align="end">
                      <span data-confinement-confirm="">
                        <Action
                          onClick={() => onAllowHardlink(block.root, group.dir, group.digest)}
                          title={copy.hardlinks.allowTip}
                        >
                          {copy.hardlinks.allow(group.count)}
                        </Action>
                      </span>
                    </Cell>
                  </Row>
                  <HardlinkGroupFiles
                    count={group.count}
                    paths={group.paths}
                    source={{ root: block.root, dir: group.dir, digest: group.digest }}
                  />
                </div>
              ))}
            </Rows>
          ) : null}
          <p className="icont__explain icont__muted">{copy.hardlinks.cachesUnscanned}</p>
        </div>
      ))}

      {escaped.length > 0 ? (
        <section className="icont__escaped">
          <SectionTitle>
            {L.groups.outside} · {escaped.length}
          </SectionTitle>
          <Rows>
            {escaped.map(process => (
              <Row key={process.pid}>
                <Cell width={14}>
                  <span aria-hidden="true" className="icont__dot" data-tone="down" />
                </Cell>
                <Cell mono width={64}>
                  {process.pid}
                </Cell>
                <Cell width={200}>
                  <Pill tone="down">{copy.kinds[process.kind]}</Pill>
                </Cell>
                <Cell grow mono muted>
                  <OverflowTip label={process.command}>
                    <span className="icont__command">{process.command}</span>
                  </OverflowTip>
                </Cell>
              </Row>
            ))}
          </Rows>
        </section>
      ) : null}

      {/* Nothing to filter or search: the empty state stands alone, and the disclosure can still bring a run back. */}
      {listed.length > 0 ? (
        <Toolbar end={<SearchBox onChange={onQuery} placeholder={L.search} value={query} />}>
          <div aria-label={L.filterLabel} className="icont__segments" role="group">
            <Tabs
              items={(['all', 'running', 'failed', 'refused'] as const).map(id => ({
                id,
                // The narrow window shows the tab's own short word; the whole name stays the segment's accessible name.
                label:
                  id === 'refused' ? (
                    <>
                      <span className="icont__seg-long">{L.filter.refused}</span>
                      <span aria-hidden="true" className="icont__seg-short">
                        {L.tabs.refusals}
                      </span>
                    </>
                  ) : (
                    L.filter[id]
                  ),
                count: id === 'all' ? undefined : per[id]
              }))}
              onChange={onFilter}
              value={filter}
            />
          </div>
          {recent.length === 0 ? housekeeping : null}
        </Toolbar>
      ) : null}

      <IsolationOffLine />

      {listed.length === 0 ? (
        <>
          <Empty hint={L.empty.runsHint} icon={<IcContainer size={28} />} title={L.empty.runs} />
          {housekeeping}
        </>
      ) : visible.length === 0 ? (
        <Empty hint={L.empty.filteredHint} title={L.empty.filtered} />
      ) : (
        <div
          aria-label={L.listLabel}
          className="icont__list"
          data-one-agent={oneAgent ? 'true' : undefined}
          onKeyDown={onListKey}
          role="group"
        >
          {running.length > 0 ? (
            <>
              <SectionTitle>
                {stale ? L.stale.group : L.groups.running} · {running.length}
              </SectionTitle>
              <Rows>
                {running.map(run => (
                  <div
                    className="icont__run"
                    data-group="running"
                    data-origin={run.origin}
                    data-run={run.id}
                    key={run.id}
                  >
                    <div className="icont__run-line">
                      <Row active={selected === run.id} onClick={() => onOpen(run.id)}>
                        <Cell>
                          <Dot
                            label={run.phase === 'background' ? L.phase.background : undefined}
                            phase={run.phase}
                            stale={stale}
                          />
                        </Cell>
                        <Cell grow mono>
                          <CommandLine copy={L} run={run} />
                        </Cell>
                        <Cell>
                          {run.phase === 'background' ? (
                            <span
                              aria-hidden="true"
                              className="icont__phase"
                              data-phase="background"
                              data-tone={stale ? 'muted' : 'warn'}
                            >
                              {L.phase.background}
                            </span>
                          ) : (
                            <Pill tone="tone">{className(copy, run.cls)}</Pill>
                          )}
                        </Cell>
                        <Cell>
                          <RefusedBadge copy={L} run={run} />
                        </Cell>
                        <Cell muted>
                          {/* Session ids share their date prefix: the tail is what tells two agents apart. */}
                          <span className="icont__tail">
                            <RunAgent copy={copy} run={run} state={state} />
                          </span>
                        </Cell>
                        <Cell muted>
                          <span className="icont__num">{L.duration(runSeconds(run, state.at))}</span>
                        </Cell>
                        <Cell muted>
                          <span className="icont__num">{L.processes(run.live)}</span>
                        </Cell>
                        <Cell>{null}</Cell>
                      </Row>
                      <span className="icont__run-stop">
                        <StopAction copy={L} onStop={onStop} run={run} stopping={stopping === run.id} />
                      </span>
                    </div>
                    {rowNote(run)}
                  </div>
                ))}
              </Rows>
            </>
          ) : null}
          {recent.length > 0 ? (
            <>
              <SectionTitle end={housekeeping}>
                {L.groups.recent} · {recent.length}
              </SectionTitle>
              <Rows>
                {recent.map(run => (
                  <div className="icont__run" data-origin={run.origin} data-run={run.id} key={run.id}>
                    <Row active={selected === run.id} onClick={() => onOpen(run.id)}>
                      <Cell>
                        <Glyph ended={run.backgroundEnded} label={phaseLabel(L, run)} phase={run.phase} />
                      </Cell>
                      <Cell grow mono>
                        <CommandLine copy={L} run={run} />
                      </Cell>
                      <Cell>
                        {/* The glyph carries these words for assistive tech (and alone, once the list narrows), so they
                            are read once. Why a command never started is one hover away, without opening it. */}
                        <PhaseWords label={phaseLabel(L, run)} phase={run.phase} why={refusedWhy(L, run)} />
                      </Cell>
                      <Cell>
                        <RefusedBadge copy={L} run={run} />
                      </Cell>
                      <Cell muted>
                        <span className="icont__tail">
                          <RunAgent copy={copy} run={run} state={state} />
                        </span>
                      </Cell>
                      <Cell muted>
                        <span className="icont__num">
                          {L.ago(secondsBetween(run.endedAt ?? run.startedAt, state.at))}
                        </span>
                      </Cell>
                      <Cell muted>
                        <span className="icont__num">
                          {run.phase === 'refused' || !run.endedAt ? '—' : L.duration(runSeconds(run, state.at))}
                        </span>
                      </Cell>
                      <Cell>
                        <span aria-hidden="true" className="icont__open">
                          <ChevronRight size={14} strokeWidth={1.8} />
                        </span>
                      </Cell>
                    </Row>
                    {rowNote(run)}
                  </div>
                ))}
              </Rows>
            </>
          ) : null}
          {state.runsCut > 0 ? (
            <p className="icont__explain icont__muted" data-runs-cut={state.runsCut}>
              {L.runsCut(state.runs.length, state.runsCut)}
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}

/** One kind of refusal: what happened and how often, its path, and one plain sentence. The never list keeps its own
 *  rule beside a shell's look, since that is the fact worth reading there. */
function WhyItem({
  at,
  cls,
  copy,
  kind: { count, refusal }
}: {
  at?: string
  cls: ActivityClass | null
  copy: ConfinementCopy
  kind: RefusalKind
}) {
  const L = copy.ledger

  return (
    <li className="icont__why" data-count={count}>
      <span className="icont__why-op">
        {at ? <span className="icont__num icont__muted">{clock(at)} </span> : null}
        {refusal.shellLook
          ? L.refusals.looked(count)
          : count > 1
            ? `${sayOperation(L, refusal.operation)} · ${L.refusals.times(count)}`
            : sayOperation(L, refusal.operation)}
      </span>
      <code className="icont__path">{refusal.target}</code>
      {refusal.shellLook ? <span className="icont__why-rule">{L.refusals.shellLook}</span> : null}
      {!refusal.shellLook || refusal.why === 'never-list' ? (
        <span className="icont__why-rule">{sayWhy(copy, refusal, cls)}</span>
      ) : null}
    </li>
  )
}

function Inspector({
  copy,
  folderNotes,
  note,
  onAllowFolder,
  onClose,
  onOpenMachine,
  onReviewHardlinks,
  onStop,
  run,
  stale,
  state,
  stopping
}: {
  copy: ConfinementCopy
  folderNotes: FolderNotes
  note: PaneNote | null
  onAllowFolder: (folder: string) => void
  onClose: () => void
  onOpenMachine: () => void
  onReviewHardlinks: () => void
  onStop: (run: RunView) => Promise<void>
  run: RunView | null
  stale: boolean
  state: ConfinementStateView
  stopping: boolean
}) {
  const L = copy.ledger

  const closeButton = (
    <IconAction label={L.inspector.close} onClick={onClose}>
      <X size={13} strokeWidth={1.8} />
    </IconAction>
  )

  if (!run) {
    return (
      <div aria-label={L.inspector.label} className="icont__inspector" role="region">
        <div className="icont__inspector-head" tabIndex={-1}>
          <span />
          {closeButton}
        </div>
        <Empty title={L.inspector.gone} />
      </div>
    )
  }

  const refusals = refusalsOf(state, run.id)
  const nodes = timeline(run, refusals, state.at)
  const live = isLive(run)
  const unverified = live && stale
  const phase = phaseLabel(L, run)
  const listedBecause = unfoldedBecause(run, state.at)

  const remedy =
    run.refusedReason === 'hard-links' || run.refusedReason === 'cannot-scan' ? (
      <Action onClick={onReviewHardlinks}>{L.remedy.reviewHardlinks}</Action>
    ) : run.refusedReason === 'launcher-unavailable' ? (
      <Action onClick={onOpenMachine}>{L.remedy.openMachine}</Action>
    ) : null

  return (
    <div aria-label={L.inspector.label} className="icont__inspector" data-inspector={run.id} role="region">
      <div className="icont__inspector-head" tabIndex={-1}>
        <span className="icont__status" data-tone={unverified ? 'muted' : phaseTone(run.phase)}>
          <Glyph ended={run.backgroundEnded} phase={run.phase} stale={unverified} />
          {unverified ? L.stale.atLastRead(phase) : phase}
        </span>
        {closeButton}
      </div>

      <div className="icont__cmd">
        <pre className="icont__cmd-text">{run.command}</pre>
        <CopyText text={run.command} />
      </div>

      <p className="icont__explain" data-summary="">
        {run.origin === 'runtime' ? `${L.inspector.runtimeLead} ` : ''}
        {unverified ? L.stale.hint : failedMeaning(L, run)}
        {live && !stale ? ` ${L.runningFor(L.duration(runSeconds(run, state.at)))} · ${L.processes(run.live)}.` : ''}
      </p>
      {listedBecause ? (
        <p className="icont__explain icont__muted" data-listed-because={listedBecause}>
          {L.housekeeping.listedBecause[listedBecause]}
        </p>
      ) : null}

      {run.narrowed ? (
        <NarrowedNote
          copy={L}
          folderNotes={folderNotes}
          offer={folderToOffer(run, state.runs)}
          onAllow={onAllowFolder}
          run={run}
        />
      ) : null}
      {run.stoppedByModes && modesStopReason(run.stoppedDetail) ? (
        <p className="icont__explain icont__said" data-modes-reason="">
          {modesStopReason(run.stoppedDetail)}
        </p>
      ) : null}

      {live ? <StopAction copy={L} onStop={onStop} run={run} stopping={stopping} /> : null}
      {note ? <StopResult note={note} /> : null}

      <SectionTitle>{L.inspector.lifecycle}</SectionTitle>
      <ol className="icont__timeline">
        {nodes.map((node, index) => (
          <li
            className="icont__node"
            data-kind={node.kind}
            data-tone={
              node.kind === 'refusal' || node.kind === 'refused'
                ? 'down'
                : node.kind === 'end'
                  ? phaseTone(run.phase)
                  : node.kind === 'live'
                    ? stale
                      ? 'muted'
                      : 'up'
                    : node.kind === 'no-end'
                      ? 'warn'
                      : 'muted'
            }
            key={`${node.kind}-${index}`}
          >
            <span aria-hidden="true" className="icont__node-mark" />
            <span className="icont__node-time">{'ts' in node ? clock(node.ts) : ''}</span>
            <span className="icont__node-label">
              {node.kind === 'start'
                ? L.timeline.started
                : node.kind === 'refusal'
                  ? `${L.timeline.refused} · ${sayOperation(L, node.refusal.operation)}${node.count ? ` · ${L.refusals.times(node.count)}` : ''}`
                  : node.kind === 'end'
                    ? L.timeline.ended(phase, L.duration(node.seconds))
                    : node.kind === 'live'
                      ? stale
                        ? L.stale.atLastRead(L.runningFor(L.duration(node.seconds)))
                        : L.runningFor(L.duration(node.seconds))
                      : node.kind === 'no-end'
                        ? L.timeline.noEnd
                        : L.timeline.refusedBeforeStart}
              {node.kind === 'refusal' ? <code className="icont__path">{node.refusal.target}</code> : null}
            </span>
          </li>
        ))}
      </ol>

      <SectionTitle>{L.inspector.facts}</SectionTitle>
      <dl className="icont__facts">
        <dt>{L.facts.kind}</dt>
        <dd>{L.kind[run.kind]}</dd>
        <dt>{L.facts.issuedBy}</dt>
        <dd>{L.origin[run.origin]}</dd>
        <dt>{L.facts.profile}</dt>
        <dd>
          {className(copy, run.cls)} · <span className="icont__mono">{shortSha(run.profileSha) || L.facts.none}</span>
        </dd>
        <dt>{L.facts.project}</dt>
        <dd className="icont__mono">{run.projectRoot ?? run.cwd ?? L.facts.none}</dd>
        <dt>{L.facts.network}</dt>
        <dd>{run.network ? L.facts.granted : L.facts.notGranted}</dd>
        <dt>{L.facts.writes}</dt>
        <dd>{run.writeProject ? L.facts.allowed : L.facts.readOnly}</dd>
        <dt>{L.facts.agent}</dt>
        <dd>{runAgent(state, run, copy.noSession)}</dd>
        <dt>{L.facts.rootPid}</dt>
        <dd className="icont__mono">{run.rootPid ?? L.facts.none}</dd>
        <dt>{L.facts.alive}</dt>
        <dd className="icont__num">{run.live}</dd>
      </dl>

      {run.phase === 'refused' ? (
        <>
          <SectionTitle>{L.inspector.notStarted}</SectionTitle>
          <RefusedWords copy={L} run={run} />
          {run.reportedBy === 'runtime' ? (
            <p className="icont__explain icont__muted" data-reported-by="runtime">
              {L.inspector.reportedByRuntime}
            </p>
          ) : null}
          {remedy}
        </>
      ) : (
        <>
          <SectionTitle>{refusals.length === 0 && run.refusals === 0 ? L.tabs.refusals : L.inspector.why}</SectionTitle>
          {refusals.length === 0 && run.refusals === 0 ? (
            <p className="icont__explain icont__muted">{L.inspector.whyNone}</p>
          ) : (
            <ul className="icont__whys">
              {refusalKinds(refusals).map(kind => (
                <WhyItem cls={run.cls} copy={copy} key={kind.key} kind={kind} />
              ))}
            </ul>
          )}
          {run.refusals > refusals.length ? (
            <p className="icont__explain icont__muted">{L.inspector.whyMore(run.refusals - refusals.length)}</p>
          ) : null}
          {refusals.some(refusal => refusal.why === 'git-config') ? <GitInstead copy={L} /> : null}
        </>
      )}
    </div>
  )
}

/**
 * A group's head where the title is data (a command, an agent's session id): printed verbatim — never through the
 * uppercase section label, which would misquote it — on one line that ellipsizes, the whole text in a Tip, so the end
 * slot (the phase and Details) always stays in view. `sub` is a quiet line under the title.
 */
function GroupHead({ end, mono, sub, title }: { end?: ReactNode; mono?: boolean; sub?: ReactNode; title: string }) {
  return (
    <div className="icont__group-head">
      <div className="icont__group-text">
        <OverflowTip label={title}>
          <h3 className="icont__group-title" data-mono={mono ? 'true' : undefined}>
            {title}
          </h3>
        </OverflowTip>
        {sub ? <p className="icont__group-sub">{sub}</p> : null}
      </div>
      {end ? <div className="icont__group-end">{end}</div> : null}
    </div>
  )
}

function Refusals({
  copy,
  onOpen,
  state
}: {
  copy: ConfinementCopy
  onOpen: (id: string) => void
  state: ConfinementStateView
}) {
  const L = copy.ledger
  const [why, setWhy] = useState<'all' | 'before-start' | RefusalWhy>('all')
  const [origin, setOrigin] = useState<OriginFilter>('all')
  const chips = whyCounts(state)
  const issued = originCounts(state)
  const refusedRuns = refusedBeforeStart(state)
  const refusedByRuntime = refusedBeforeStart(state, 'runtime').length
  const showOrigin = issued.runtime + refusedByRuntime > 0

  // The Issued by control shows only while the runtime has refusals of its own; when it goes, its filter goes with it,
  // so no filter stays applied without a control on screen.
  if (!showOrigin && origin !== 'all') {
    setOrigin('all')
  }

  const issuedBy = showOrigin ? origin : 'all'
  const groups = why === 'before-start' ? [] : refusalGroups(state, why, issuedBy)
  const notStarted = why === 'all' || why === 'before-start' ? refusedBeforeStart(state, issuedBy) : []

  // One kind: All and that kind are the same list, so there is nothing to choose, and no filter stays applied unseen.
  const oneKind = chips.length + (refusedRuns.length > 0 ? 1 : 0) <= 1

  if (oneKind && why !== 'all') {
    setWhy('all')
  }

  if (state.refusals.length === 0 && refusedRuns.length === 0) {
    return <Empty hint={L.empty.refusalsHint} icon={<IcContainer size={28} />} title={L.empty.refusals} />
  }

  const day = state.refusalDay

  const olderInParts =
    day && day.rows !== null && day.olderRows !== null && day.olderRows > 0 ? (
      <p className="icont__muted" data-refusals-older-parts={day.olderRows}>
        {L.refusals.olderInParts(day.rows, day.olderRows)}
      </p>
    ) : null

  return (
    <div className="icont__refusals">
      {olderInParts}
      {oneKind && !showOrigin ? null : (
        <Toolbar>
          <Tabs
            items={[
              { id: 'all' as const, label: L.refusals.all, count: state.refusals.length + refusedRuns.length },
              ...(refusedRuns.length > 0
                ? [{ id: 'before-start' as const, label: L.refusals.beforeStart, count: refusedRuns.length }]
                : []),
              ...chips.map(chip => ({ id: chip.why, label: L.whyName[chip.why], count: chip.count }))
            ]}
            onChange={setWhy}
            value={why}
          />
          {/* Who issued the run each refusal belongs to: shown once the runtime has refusals of its own. */}
          {showOrigin ? (
            <div aria-label={L.refusals.originLabel} className="icont__segments" role="group">
              <Tabs
                items={[
                  { id: 'all' as const, label: L.refusals.all },
                  {
                    id: 'agent' as const,
                    label: L.refusals.origin.agent,
                    count: issued.agent + refusedRuns.length - refusedByRuntime
                  },
                  { id: 'runtime' as const, label: L.refusals.origin.runtime, count: issued.runtime + refusedByRuntime }
                ]}
                onChange={setOrigin}
                value={origin}
              />
            </div>
          ) : null}
        </Toolbar>
      )}
      {groups.length === 0 && notStarted.length === 0 ? (
        <Empty hint={L.empty.filteredHint} title={L.empty.filtered} />
      ) : null}
      {notStarted.map(run => (
        <section className="icont__refusal-group" data-before-start={run.id} data-origin={run.origin} key={run.id}>
          <GroupHead
            end={
              <span className="icont__actions">
                <span className="icont__phase" data-tone={phaseTone(run.phase)}>
                  {phaseLabel(L, run)}
                </span>
                <Action kind="quiet" onClick={() => onOpen(run.id)}>
                  {L.refusals.inspect}
                </Action>
              </span>
            }
            mono
            title={firstLine(ranOnceMark(run.command).command)}
          />
          <RefusedWords
            copy={L}
            lead={
              <>
                <span className="icont__num icont__muted">{clock(run.endedAt ?? run.startedAt)}</span>{' '}
              </>
            }
            run={run}
          />
        </section>
      ))}
      {groups.map(group => (
        <section className="icont__refusal-group" data-origin={group.run?.origin} key={group.runId ?? 'unattributed'}>
          <GroupHead
            end={
              group.run ? (
                <span className="icont__actions">
                  <span className="icont__phase" data-tone={phaseTone(group.run.phase)}>
                    {phaseLabel(L, group.run)}
                  </span>
                  <Action kind="quiet" onClick={() => group.runId && onOpen(group.runId)}>
                    {L.refusals.inspect}
                  </Action>
                </span>
              ) : undefined
            }
            mono={group.run !== null}
            sub={
              group.run?.origin === 'runtime' ? (
                <>
                  <span className="icont__origin" data-origin="runtime">
                    <Pill tone="muted">{L.runtimeBadge}</Pill>
                  </span>{' '}
                  {L.refusals.byRuntime}
                </>
              ) : undefined
            }
            title={
              group.run
                ? firstLine(ranOnceMark(group.run.command).command)
                : group.runId
                  ? L.refusals.evicted
                  : L.refusals.unattributed
            }
          />
          <ul className="icont__whys">
            {refusalKinds(group.refusals).map(kind => (
              <WhyItem at={kind.refusal.ts} cls={group.run?.cls ?? null} copy={copy} key={kind.key} kind={kind} />
            ))}
          </ul>
          {group.run && group.refusals.some(refusal => refusal.why === 'git-config') ? <GitInstead copy={L} /> : null}
        </section>
      ))}
    </div>
  )
}

function PathList({ label, paths }: { label: string; paths: readonly string[] }) {
  return paths.length > 0 ? (
    <p className="icont__explain icont__muted">
      {label}: <span className="icont__mono">{paths.join(' · ')}</span>
    </p>
  ) : null
}

/** The never list in the same one-line summary as the class cards; every path one per line, home said as `~`, on
 *  request. */
function NeverList({ copy, paths }: { copy: ConfinementCopy; paths: readonly string[] }) {
  const [open, setOpen] = useState(false)

  if (paths.length === 0) {
    return null
  }

  return (
    <div className="icont__never">
      <p className="icont__explain icont__muted">
        {copy.never(paths.length)}{' '}
        <button
          aria-expanded={open}
          className="e-btn e-btn--quiet icont__disclose"
          onClick={() => setOpen(shown => !shown)}
          type="button"
        >
          {open ? copy.ledger.runtime.showFewer : copy.ledger.runtime.showAll(paths.length)}
        </button>
      </p>
      {open ? (
        <ul className="icont__paths">
          {paths.map(path => (
            <li key={path}>{homeRelative(path)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** A path list on request: the block itself stays two lines and one quiet line. */
function PathsOnRequest({
  copy,
  lists
}: {
  copy: ConfinementCopy
  lists: readonly { label: string; paths: readonly string[] }[]
}) {
  const [open, setOpen] = useState(false)
  const count = lists.reduce((sum, list) => sum + list.paths.length, 0)

  return count > 0 ? (
    <>
      <button
        aria-expanded={open}
        className="e-btn e-btn--quiet icont__disclose"
        onClick={() => setOpen(shown => !shown)}
        type="button"
      >
        {open ? copy.ledger.runtime.showFewer : copy.ledger.runtime.showAll(count)}
      </button>
      {open ? (
        <span className="icont__block-paths">
          {lists.map(list => (
            <PathList key={list.label} label={list.label} paths={list.paths} />
          ))}
        </span>
      ) : null}
    </>
  ) : null
}

function Block({
  children,
  hash,
  name,
  pill,
  runtime,
  summary
}: {
  children: ReactNode
  hash: string | null
  name: string
  pill: ReactNode
  runtime?: string
  summary: ReactNode
}) {
  return (
    <section className="icont__profile" data-runtime={runtime}>
      <div className="icont__block-top">
        <h3 className="icont__block-name">{name}</h3>
        {pill}
        {hash ? (
          <span className="icont__hash">
            <Pill tone="muted">{shortSha(hash)}</Pill>
          </span>
        ) : null}
      </div>
      <p className="icont__block-text">{summary}</p>
      {children}
    </section>
  )
}

function Profiles({ copy, state }: { copy: ConfinementCopy; state: ConfinementStateView }) {
  const L = copy.ledger
  const runtime = state.runtime
  const said = (paths: readonly string[]): string => paths.join('\n')
  // The same never list on every class is one fact: it is said once, above them. A class that differs keeps its own.
  const shared = state.profiles.length > 1 && new Set(state.profiles.map(p => said(p.denied))).size === 1
  const sharedNever = shared ? state.profiles[0].denied : []

  return (
    <div className="icont__profiles">
      {shared ? (
        <p className="icont__explain icont__muted icont__profiles-never">{copy.never(sharedNever.length)}</p>
      ) : null}
      {state.profiles.map(profile => (
        <Block
          hash={profile.sha256}
          key={profile.cls}
          name={copy.classes[profile.cls].name}
          pill={profile.cls === state.defaultClass ? <Pill tone="tone">{copy.active}</Pill> : null}
          summary={copy.classes[profile.cls].summary}
        >
          <p className="icont__block-quiet">
            <span className="icont__num">
              {copy.reads} {profile.reads.length}
            </span>
            <span className="icont__num">
              {copy.writes} {profile.writes.length}
            </span>
            <span>{copy.network[profile.network]}</span>
            <PathsOnRequest
              copy={copy}
              lists={[
                { label: copy.reads, paths: profile.reads },
                { label: copy.writes, paths: profile.writes }
              ]}
            />
          </p>
          {shared ? null : <p className="icont__block-quiet">{copy.never(profile.denied.length)}</p>}
        </Block>
      ))}

      <Block
        hash={runtime.profileSha}
        name={L.runtime.title}
        pill={<Pill tone={runtimeTone(runtime.state)}>{L.runtime.state[runtime.state]}</Pill>}
        runtime={runtime.state}
        summary={
          <>
            {runtime.state === 'off' ? L.runtime.off : `${L.runtime.summary} ${L.runtime.stateMeaning[runtime.state]}`}
            {runtime.state !== 'off' && runtime.launcher === 'down'
              ? ` ${copy.reason['launcher-down']({ code: 'launcher-down' })}`
              : ''}
          </>
        }
      >
        {/* What the profile allows, once main has built one for a runtime; a runtime never started has none. */}
        {runtime.state !== 'off' && runtime.profileSha ? (
          <>
            <p className="icont__block-quiet">
              <span className="icont__num">
                {copy.reads} {runtime.reads.length}
              </span>
              <span className="icont__num">
                {copy.writes} {runtime.writes.length}
              </span>
              <PathsOnRequest
                copy={copy}
                lists={[
                  { label: copy.reads, paths: runtime.reads },
                  { label: copy.writes, paths: runtime.writes }
                ]}
              />
            </p>
            <NeverList copy={copy} paths={runtime.denied} />
          </>
        ) : null}
      </Block>
    </div>
  )
}

const isNamed = (agent: ConfinementStateView['agents'][number]): boolean =>
  agent.inft !== null || agent.sessionId === 'unattributed'

function Agents({ copy, state }: { copy: ConfinementCopy; state: ConfinementStateView }) {
  if (state.agents.length === 0) {
    return (
      <Empty hint={copy.ledger.empty.agentsHint} icon={<IcContainer size={28} />} title={copy.ledger.empty.agents} />
    )
  }

  return (
    <div className="icont__agents">
      {state.agents.map(agent => (
        <section className="icont__agent" key={agent.sessionId}>
          <GroupHead
            end={
              <span className="icont__muted">
                {copy.ledger.agentRuns(runsOfAgent(state, agent.sessionId))}
                {/* One session: the page's own line already says these two. */}
                {state.agents.length > 1
                  ? ` · ${copy.insideCount(agent.inside)} · ${copy.outsideCount(agent.outside)}`
                  : null}
              </span>
            }
            // A session id is an identifier, not a name: it is said under what the agent is.
            sub={isNamed(agent) ? undefined : <span className="icont__mono">{agent.sessionId}</span>}
            title={isNamed(agent) ? agentName(agent, copy.unattributed) : copy.ledger.agentSession}
          />
          <Rows>
            {agentRows(state, agent).map(({ action, count }) => (
              <Row key={`${action.ts}-${action.kind}-${action.target}`}>
                <Cell mono muted width={84}>
                  {clock(action.ts)}
                </Cell>
                <Cell width={80}>
                  {action.kind === 'refuse' || action.kind === 'use' ? (
                    <Pill tone={action.kind === 'refuse' ? 'down' : 'up'}>
                      {sayActionKind(copy.ledger, action.kind)}
                    </Pill>
                  ) : null}
                </Cell>
                <Cell muted width={120}>
                  {sayTool(copy.ledger, action.tool)}
                </Cell>
                <Cell grow mono>
                  <span className="icont__command-line">
                    <OverflowTip label={action.target}>
                      <span className="icont__command">{ranOnceMark(action.target).command}</span>
                    </OverflowTip>
                    <RanOnce mark={ranOnceMark(action.target).mark} />
                  </span>
                </Cell>
                {count > 1 ? (
                  <Cell muted>
                    <span className="icont__num" data-merged={count}>
                      ×{count}
                    </span>
                  </Cell>
                ) : null}
              </Row>
            ))}
          </Rows>
        </section>
      ))}
    </div>
  )
}

function ProcessRows({ copy, processes }: { copy: ConfinementCopy; processes: readonly OutsideProcessView[] }) {
  return (
    <Rows>
      {processes.map(process => (
        <Row key={process.pid}>
          <Cell mono>{process.pid}</Cell>
          <Cell muted>
            <span className="icont__said" data-kind={process.kind}>
              {copy.kinds[process.kind]}
            </span>
          </Cell>
          <Cell muted>
            <span className="icont__num icont__muted">{copy.ledger.duration(process.elapsedSec)}</span>
          </Cell>
          <Cell grow mono muted>
            <OverflowTip label={process.command}>
              <span className="icont__command icont__tail icont__muted">
                <bdi>{process.command}</bdi>
              </span>
            </OverflowTip>
          </Cell>
        </Row>
      ))}
    </Rows>
  )
}

function Machine({ copy, state }: { copy: ConfinementCopy; state: ConfinementStateView }) {
  const L = copy.ledger
  const { launcher, state: runtime } = state.runtime
  // The processes the kernel holds in the runtime profile (Hermes, its own children, the launcher's stub carrying a
  // confined command) are listed under that profile, never among the processes outside the command sandboxes: they
  // are confined, by the other profile. `kind: 'runtime'` is the kernel's mark, read by main; never a reading of argv.
  // Off, nothing holds them: the same processes are listed as what they are, outside any sandbox.
  const held = new Set(runtime === 'off' ? [] : state.runtime.pids)
  const notCommands = state.outside.filter(process => process.kind !== 'agent-command')

  const heldInRuntime = (process: OutsideProcessView) =>
    runtime !== 'off' && (held.has(process.pid) || process.kind === 'runtime')

  const inRuntime = notCommands.filter(heldInRuntime)
  const others = notCommands.filter(process => !heldInRuntime(process))

  return (
    <div className="icont__mac">
      <div className="icont__mac-col">
        <div className="icont__iso">
          {state.isolation?.available ? <SectionTitle>{ISOLATION_TITLE}</SectionTitle> : null}
          <IsolationControl />
        </div>

        {/* What confinement covers belongs to the control: its limit, read right under it. */}
        {state.enabled ? (
          <div className="icont__cover" data-scope="">
            <Rows>
              {splitScope(copy.scope).map(part => (
                <Row key={part.label}>
                  <Cell>{part.label}</Cell>
                  <Cell grow muted>
                    <span className="icont__detail">{part.text}</span>
                  </Cell>
                </Row>
              ))}
              <Row>
                <Cell>{L.machine.caches}</Cell>
                <Cell grow muted>
                  <span className="icont__detail">{copy.hardlinks.cachesUnscanned}</span>
                </Cell>
              </Row>
            </Rows>
          </div>
        ) : null}

        {state.verdict !== 'red' && state.reasons.length > 0 ? (
          <Note>
            <b>{copy.notes}</b> {state.reasons.map(reason => sayReason(copy, reason)).join(' · ')}
          </Note>
        ) : null}

        <SectionTitle>{L.machine.runtime}</SectionTitle>
        <Rows>
          <Row>
            <Cell>{L.runtime.title}</Cell>
            <Cell>
              <Pill tone={runtimeTone(runtime)}>{L.runtime.state[runtime]}</Pill>
            </Cell>
            <Cell>{null}</Cell>
            <Cell grow muted>
              <span className="icont__detail">{L.runtime.stateMeaning[runtime]}</span>
            </Cell>
          </Row>
          <Row>
            <Cell>{L.runtime.launcher}</Cell>
            <Cell>
              <Pill tone={launcherTone(launcher)}>{L.runtime.launcherState[launcher]}</Pill>
            </Cell>
            <Cell>{null}</Cell>
            <Cell grow muted>
              <span className="icont__detail">{L.runtime.launcherMeaning[launcher]}</span>
            </Cell>
          </Row>
        </Rows>

        <SectionTitle>{L.machine.sandboxes}</SectionTitle>
        <Rows>
          {state.backends.map(backend => (
            <Row key={backend.id}>
              <Cell>{copy.backendName[backend.id]}</Cell>
              <Cell>
                <span className="icont__actions">
                  {/* Off, a sandbox that works holds nothing: it reads as present, never as at work. */}
                  <Pill tone={backendTone(!state.enabled && backend.status === 'ready' ? 'installed' : backend.status)}>
                    {copy.backendStatus[backend.status]}
                  </Pill>
                  {state.enabled && backend.id === state.backend ? <Pill tone="tone">{copy.active}</Pill> : null}
                </span>
              </Cell>
              <Cell mono muted>
                {backend.version}
              </Cell>
              <Cell grow muted>
                <span className="icont__detail">
                  {!state.enabled && backend.detail === 'enforcing'
                    ? copy.backendEnforcingOff
                    : copy.backendDetail[backend.detail]}
                  {backend.ownerStep ? <code className="icont__owner-step">{backend.ownerStep}</code> : null}
                </span>
              </Cell>
            </Row>
          ))}
        </Rows>
      </div>

      <div className="icont__mac-col">
        {inRuntime.length > 0 ? (
          <>
            <SectionTitle>
              {L.machine.held} · {inRuntime.length}
            </SectionTitle>
            <ProcessRows copy={copy} processes={inRuntime} />
          </>
        ) : null}

        <SectionTitle>
          {L.machine.processes}
          {others.length > 0 ? ` · ${others.length}` : null}
        </SectionTitle>
        {others.length === 0 ? (
          <p className="icont__explain icont__muted">{L.machine.processesEmpty}</p>
        ) : (
          <ProcessRows copy={copy} processes={others} />
        )}
      </div>
    </div>
  )
}

/** The files listed under one hard-link group, by the shown name: CF4 (B2-n4) lists the first ones and, for a larger
 *  group, a toggle to every file. Main sends the first HARDLINK_GROUP_PATHS_SENT with the state; CF5 (B3-n2) pages
 *  the rest in on "Show N more" (`source`: the group as main named it), so every one of `count` is reachable. */
const GROUP_FILES_SHOWN = 3
/** What main pages at once (hardlinks.ts HARDLINK_GROUP_PATHS_SENT). */
const HARDLINK_PAGE = 1_000
/** B6-n2: a group's files are windowed, so a 20 000-link group mounts a viewport of rows, not 20 000. The rows are
 *  single-line (the cells ellipsize), so one fixed height holds at every type size the containers use. */
const GROUP_FILE_ROW_HEIGHT = 38
const GROUP_FILES_VISIBLE = 10
const GROUP_FILES_OVERSCAN = 6

function groupFilesViewportHeight(rows: number): number {
  return Math.min(rows, GROUP_FILES_VISIBLE) * GROUP_FILE_ROW_HEIGHT
}

export function HardlinkGroupFiles({
  count,
  paths,
  source
}: {
  count: number
  paths: readonly string[]
  source?: { root: string; dir: string; digest: string }
}) {
  const copy = useContainersCopy()
  const [all, setAll] = useState(false)
  const [more, setMore] = useState<{ digest: string; paths: readonly string[] }>({ digest: '', paths: [] })
  const [loading, setLoading] = useState(false)
  // A page read for another set of files (the group changed) is dropped.
  const loaded = more.digest === (source?.digest ?? '') ? [...paths, ...more.paths] : paths
  const shown = all ? loaded : loaded.slice(0, GROUP_FILES_SHOWN)
  const left = count - loaded.length
  const setSize = Math.max(count, loaded.length)

  const viewportHeight = groupFilesViewportHeight(shown.length)
  const scrollable = shown.length > GROUP_FILES_VISIBLE
  const viewportRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: shown.length,
    estimateSize: () => GROUP_FILE_ROW_HEIGHT,
    getItemKey: index => shown[index] ?? index,
    getScrollElement: () => viewportRef.current,
    initialRect: { width: 0, height: viewportHeight },
    // The viewport's height is derived from the row count (inline style below), so a box that reports no height
    // (layout-less render, not yet laid out) is given that derived height instead of windowing zero rows.
    observeElementRect: (instance, report) =>
      observeElementRect(instance, rect =>
        report(rect.height > 0 ? rect : { width: rect.width, height: groupFilesViewportHeight(instance.options.count) })
      ),
    overscan: GROUP_FILES_OVERSCAN
  })

  const loadMore = async () => {
    if (!source || loading) {
      return
    }

    setLoading(true)

    const page = await readHardlinkGroupPaths({ ...source, offset: loaded.length })

    setLoading(false)

    if (page && page.length > 0) {
      setMore({ digest: source.digest, paths: [...loaded.slice(paths.length), ...page] })
    }
  }

  return (
    <>
      <div
        data-hardlink-files=""
        // A new height (Show all, Show fewer, a short group paging past ten) is a new viewport, so the virtualizer
        // re-reads its rect rather than windowing to the old height where no resize is observed.
        key={viewportHeight}
        ref={viewportRef}
        role="list"
        style={{ height: viewportHeight, overflowX: 'hidden', overflowY: scrollable ? 'auto' : 'hidden' }}
        tabIndex={scrollable ? 0 : undefined}
      >
        <div role="none" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map(item => {
            const file = shown[item.index] ?? ''

            return (
              <div
                aria-posinset={item.index + 1}
                aria-setsize={setSize}
                className="e-row"
                key={item.key}
                role="listitem"
                style={{ height: GROUP_FILE_ROW_HEIGHT, left: 0, position: 'absolute', top: item.start }}
              >
                <Cell grow mono muted>
                  <OverflowTip label={file}>
                    <span className="icont__command icont__command--child">{file}</span>
                  </OverflowTip>
                </Cell>
              </div>
            )
          })}
        </div>
      </div>
      {all && left > 0 && source ? (
        <Row>
          <Cell grow muted>
            <button
              className="icont__command icont__command--child underline-offset-2 hover:underline"
              data-hardlink-show-more=""
              disabled={loading}
              onClick={() => void loadMore()}
              type="button"
            >
              {copy.hardlinks.showMore(Math.min(left, HARDLINK_PAGE))}
            </button>
          </Cell>
        </Row>
      ) : null}
      {count > GROUP_FILES_SHOWN && loaded.length > GROUP_FILES_SHOWN ? (
        <Row>
          <Cell grow muted>
            <button
              aria-expanded={all}
              className="icont__command icont__command--child underline-offset-2 hover:underline"
              data-hardlink-show-all=""
              onClick={() => setAll(value => !value)}
              type="button"
            >
              {all ? copy.hardlinks.showFewer : copy.hardlinks.showAll(count)}
            </button>
          </Cell>
        </Row>
      ) : null}
    </>
  )
}
