import '../econ/econ.css'
import './containers.css'

/**
 * V3-G — the Containers window: what each agent runs on this Mac, inside its confinement or outside it, the
 * profile and its grants, every command line live, Follow and Kill, the refusals and the backends. It opens in the
 * one window chassis every Dock app uses and is built from the EconomyOS parts only (design freeze S24). It renders
 * `state` and nothing else: main folds that from `ps` on every read (G3, G9).
 */
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '@/i18n'
import type { ConfinementCopy } from '@/i18n/en/confinement'
import type { ActivityClass, ConfinementStateView } from '@/iclone-shared/confinement'
import { $confinement, acknowledgeHardlink, explainConfined, killConfined, watchConfinement } from '@/store/confinement'

import {
  Action,
  AppFrame,
  Cell,
  Empty,
  Note,
  Pill,
  RailItem,
  RailSection,
  Row,
  Rows,
  SectionTitle,
  SkeletonRows,
  Stat,
  StatRow
} from '../econ/ui'
import { IcWindow, useWindowExpanded } from '../window'

import { useContainersCopy } from './containers-copy'
import {
  agentName,
  backendTone,
  confinedGroups,
  counts,
  followed,
  sayReason,
  shortSha,
  verdictTone
} from './containers-data'
import { $containersOpen } from './containers-dock'
import { IcContainer } from './ic-container'

type Section = 'agents' | 'backends' | 'live' | 'profiles' | 'refusals'

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

function ContainersPane({ onClose }: { onClose: () => void }) {
  const copy = useContainersCopy()
  const chrome = useI18n().t.desktop.home
  const { error, state, status } = useStore($confinement)
  const { expanded, toggle: toggleExpanded } = useWindowExpanded('containers')
  const [section, setSection] = useState<Section>('live')
  const [follow, setFollow] = useState<number | null>(null)
  const [note, setNote] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)

  useEffect(() => watchConfinement(), [])

  const kill = useCallback(
    async (pid: number) => {
      const result = await killConfined(pid)

      setNote(
        result.ok
          ? { kind: 'info', text: copy.killed(result.killed.length) }
          : { kind: 'error', text: copy.killFailed[result.reason](result.survivors.length) }
      )
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

  const title = copy.title

  return (
    <IcWindow
      expanded={expanded}
      head={<Head copy={copy} state={state} title={title} />}
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
      {status === 'unavailable' ? (
        <Empty icon={<IcContainer size={28} />} title={copy.unavailable} />
      ) : !state ? (
        <>
          {error ? <Note kind="error">{error}</Note> : null}
          <SkeletonRows rows={7} />
        </>
      ) : (
        <AppFrame
          aside={
            follow !== null ? (
              <Follow copy={copy} onKill={kill} onStop={() => setFollow(null)} pid={follow} state={state} />
            ) : undefined
          }
          rail={<Rail copy={copy} onSelect={setSection} section={section} state={state} />}
        >
          {note ? <Note kind={note.kind}>{note.text}</Note> : null}
          {section === 'live' && (
            <Live copy={copy} onAllowHardlink={allowHardlink} onFollow={setFollow} onKill={kill} state={state} />
          )}
          {section === 'agents' && <Agents copy={copy} state={state} />}
          {section === 'profiles' && <Profiles copy={copy} state={state} />}
          {section === 'refusals' && <Refusals copy={copy} state={state} />}
          {section === 'backends' && <Backends copy={copy} state={state} />}
        </AppFrame>
      )}
    </IcWindow>
  )
}

function Head({ copy, state, title }: { copy: ConfinementCopy; state: ConfinementStateView | null; title: string }) {
  if (!state) {
    return <h2>{title}</h2>
  }

  const tally = counts(state)

  return (
    <>
      <h2>{title}</h2>
      <span className="icont__verdict" data-verdict={state.verdict}>
        <Pill tone={verdictTone(state.verdict)}>{copy.verdict[state.verdict].label}</Pill>
        <span className="icont__verdict-hint">{copy.verdict[state.verdict].hint}</span>
      </span>
      <span className="icont__tally">
        {copy.backendName[state.backend]} · {copy.insideCount(tally.inside)} · {copy.outsideCount(tally.outside)}
      </span>
    </>
  )
}

function Rail({
  copy,
  onSelect,
  section,
  state
}: {
  copy: ConfinementCopy
  onSelect: (section: Section) => void
  section: Section
  state: ConfinementStateView
}) {
  const tally = counts(state)

  return (
    <RailSection>
      <RailItem
        active={section === 'live'}
        count={tally.outside > 0 ? tally.outside : tally.inside}
        label={copy.tabs.live}
        onClick={() => onSelect('live')}
        tone={tally.outside > 0 ? 'down' : undefined}
      />
      <RailItem
        active={section === 'agents'}
        count={state.agents.length}
        label={copy.tabs.agents}
        onClick={() => onSelect('agents')}
      />
      <RailItem
        active={section === 'profiles'}
        count={state.profiles.length}
        label={copy.tabs.profiles}
        onClick={() => onSelect('profiles')}
      />
      <RailItem
        active={section === 'refusals'}
        count={state.refusals.length}
        label={copy.tabs.refusals}
        onClick={() => onSelect('refusals')}
      />
      <RailItem active={section === 'backends'} label={copy.tabs.backends} onClick={() => onSelect('backends')} />
    </RailSection>
  )
}

function className(copy: ConfinementCopy, cls: ActivityClass | null): string {
  return cls ? copy.classes[cls].name : '—'
}

function Live({
  copy,
  onAllowHardlink,
  onFollow,
  onKill,
  state
}: {
  copy: ConfinementCopy
  onAllowHardlink: (root: string, dir: string, digest: string) => void
  onFollow: (pid: number) => void
  onKill: (pid: number) => Promise<void>
  state: ConfinementStateView
}) {
  const groups = confinedGroups(state)
  const agentCommands = state.outside.filter(process => process.kind === 'agent-command')
  const others = state.outside.filter(process => process.kind !== 'agent-command')

  return (
    <div className="icont__live">
      {state.reasons.length > 0 ? (
        <Note kind={state.verdict === 'red' ? 'error' : undefined}>
          <b>{state.verdict === 'red' ? copy.reasons : copy.notes}</b>{' '}
          {state.reasons.map(reason => sayReason(copy, reason)).join(' · ')}
        </Note>
      ) : null}
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
                      <span className="icont__command" title={group.dir}>
                        {copy.hardlinks.group(group.dir, group.count)}
                      </span>
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
                  {group.paths.map(file => (
                    <Row key={file}>
                      <Cell grow mono muted>
                        <span className="icont__command icont__command--child" title={file}>
                          {file}
                        </span>
                      </Cell>
                    </Row>
                  ))}
                </div>
              ))}
            </Rows>
          ) : null}
        </div>
      ))}
      <Note>
        {copy.scope} {copy.hardlinks.cachesUnscanned}
      </Note>

      <SectionTitle
        end={<span className="icont__muted">{copy.defaultClass(copy.classes[state.defaultClass].name)}</span>}
      >
        {copy.inside} · {groups.length}
      </SectionTitle>
      {groups.length === 0 ? (
        <Empty title={copy.empty.inside} />
      ) : (
        <Rows>
          {groups.map(group => (
            <div className="icont__group" key={group.root.pid}>
              <Row>
                <Cell mono width={64}>
                  {group.root.pid}
                </Cell>
                <Cell width={96}>
                  <Pill tone={group.root.widened || !group.root.profileKnown ? 'down' : 'tone'}>
                    {className(copy, group.root.cls)}
                  </Pill>
                </Cell>
                <Cell muted width={120}>
                  {group.root.sessionId ?? copy.noSession}
                </Cell>
                <Cell mono muted width={56}>
                  {copy.elapsed(group.root.elapsedSec)}
                </Cell>
                <Cell grow mono>
                  <span className="icont__command" title={group.root.command}>
                    {group.root.command}
                  </span>
                </Cell>
                <Cell align="end">
                  <span className="icont__actions">
                    <Action kind="quiet" onClick={() => onFollow(group.root.pid)}>
                      {copy.follow}
                    </Action>
                    <Action onClick={() => void onKill(group.root.pid)} title={copy.killTip(group.root.pid)}>
                      {copy.kill}
                    </Action>
                  </span>
                </Cell>
              </Row>
              {group.children.map(child => (
                <Row key={child.pid}>
                  <Cell mono muted width={64}>
                    {child.pid}
                  </Cell>
                  <Cell grow mono muted>
                    <span className="icont__command icont__command--child" title={child.command}>
                      {child.command}
                    </span>
                  </Cell>
                </Row>
              ))}
            </div>
          ))}
        </Rows>
      )}

      <SectionTitle>
        {copy.outside} · {agentCommands.length}
      </SectionTitle>
      {agentCommands.length === 0 && others.length === 0 ? (
        <Empty title={copy.empty.outside} />
      ) : (
        <Rows>
          {[...agentCommands, ...others].map(process => (
            <Row key={process.pid}>
              <Cell mono width={64}>
                {process.pid}
              </Cell>
              <Cell width={200}>
                <Pill tone={process.kind === 'agent-command' ? 'down' : 'muted'}>{copy.kinds[process.kind]}</Pill>
              </Cell>
              <Cell mono muted width={56}>
                {copy.elapsed(process.elapsedSec)}
              </Cell>
              <Cell grow mono muted>
                <span className="icont__command" title={process.command}>
                  {process.command}
                </span>
              </Cell>
            </Row>
          ))}
        </Rows>
      )}
    </div>
  )
}

function Follow({
  copy,
  onKill,
  onStop,
  pid,
  state
}: {
  copy: ConfinementCopy
  onKill: (pid: number) => Promise<void>
  onStop: () => void
  pid: number
  state: ConfinementStateView
}) {
  const [lines, setLines] = useState<string[]>([])
  const group = followed(state, pid)

  useEffect(() => {
    let live = true

    void explainConfined(pid).then(next => live && setLines(next))

    return () => {
      live = false
    }
  }, [pid])

  return (
    <div className="icont__follow">
      <SectionTitle
        end={
          <Action kind="quiet" onClick={onStop}>
            {copy.stopFollowing}
          </Action>
        }
      >
        {copy.following(pid)}
      </SectionTitle>
      {lines.map(line => (
        <p className="icont__explain" key={line}>
          {line}
        </p>
      ))}
      {group ? (
        <>
          <Rows>
            {[group.root, ...group.children].map(process => (
              <Row key={process.pid}>
                <Cell mono width={64}>
                  {process.pid}
                </Cell>
                <Cell grow mono muted>
                  <span className="icont__command" title={process.command}>
                    {process.command}
                  </span>
                </Cell>
              </Row>
            ))}
          </Rows>
          <Action onClick={() => void onKill(pid)} title={copy.killTip(pid)}>
            {copy.kill}
          </Action>
        </>
      ) : (
        <Empty title={copy.empty.inside} />
      )}
    </div>
  )
}

function Agents({ copy, state }: { copy: ConfinementCopy; state: ConfinementStateView }) {
  if (state.agents.length === 0) {
    return <Empty title={copy.empty.agents} />
  }

  return (
    <div className="icont__agents">
      {state.agents.map(agent => (
        <section className="icont__agent" key={agent.sessionId}>
          <SectionTitle
            end={
              <span className="icont__muted">
                {copy.insideCount(agent.inside)} · {copy.outsideCount(agent.outside)}
              </span>
            }
          >
            {agentName(agent, copy.unattributed)}
          </SectionTitle>
          <Rows>
            {agent.actions.map(action => (
              <Row key={`${action.ts}-${action.kind}-${action.target}`}>
                <Cell mono muted width={84}>
                  {action.ts.slice(11, 19)}
                </Cell>
                <Cell width={80}>
                  <Pill tone={action.kind === 'refuse' ? 'down' : action.kind === 'use' ? 'up' : 'muted'}>
                    {action.kind}
                  </Pill>
                </Cell>
                <Cell muted width={120}>
                  {action.tool}
                </Cell>
                <Cell grow mono>
                  <span className="icont__command" title={action.target}>
                    {action.target}
                  </span>
                </Cell>
              </Row>
            ))}
          </Rows>
        </section>
      ))}
    </div>
  )
}

function Profiles({ copy, state }: { copy: ConfinementCopy; state: ConfinementStateView }) {
  return (
    <div className="icont__profiles">
      {state.profiles.map(profile => (
        <section className="icont__profile" key={profile.cls}>
          <SectionTitle
            end={
              <span className="icont__actions">
                {profile.cls === state.defaultClass ? <Pill tone="tone">{copy.active}</Pill> : null}
                <Pill tone="muted">{shortSha(profile.sha256)}</Pill>
              </span>
            }
          >
            {copy.classes[profile.cls].name}
          </SectionTitle>
          <p className="icont__explain">{copy.classes[profile.cls].summary}</p>
          <StatRow>
            <Stat label={copy.reads} value={profile.reads.length} />
            <Stat label={copy.writes} value={profile.writes.length} />
          </StatRow>
          <p className="icont__explain">{copy.network[profile.network]}</p>
          <p className="icont__explain icont__muted">
            {copy.writes}: {profile.writes.join(' · ')}
          </p>
          <p className="icont__explain icont__muted">{copy.never(profile.denied.length)}</p>
        </section>
      ))}
    </div>
  )
}

function Refusals({ copy, state }: { copy: ConfinementCopy; state: ConfinementStateView }) {
  if (state.refusals.length === 0) {
    return <Empty title={copy.empty.refusals} />
  }

  return (
    <Rows>
      {state.refusals.map(refusal => (
        <Row key={`${refusal.ts}-${refusal.pid}-${refusal.operation}-${refusal.target}`}>
          <Cell mono muted width={84}>
            {refusal.ts.slice(11, 19)}
          </Cell>
          <Cell mono width={140}>
            {refusal.process} ({refusal.pid})
          </Cell>
          <Cell width={150}>
            <Pill tone="down">{refusal.operation}</Pill>
          </Cell>
          <Cell grow mono muted>
            <span className="icont__command" title={refusal.target}>
              {refusal.target}
            </span>
          </Cell>
        </Row>
      ))}
    </Rows>
  )
}

function Backends({ copy, state }: { copy: ConfinementCopy; state: ConfinementStateView }) {
  return (
    <Rows>
      {state.backends.map(backend => (
        <Row key={backend.id}>
          <Cell width={170}>{copy.backendName[backend.id]}</Cell>
          <Cell width={150}>
            <span className="icont__actions">
              <Pill tone={backendTone(backend.status)}>{copy.backendStatus[backend.status]}</Pill>
              {backend.id === state.backend ? <Pill tone="tone">{copy.active}</Pill> : null}
            </span>
          </Cell>
          <Cell mono muted width={64}>
            {backend.version ?? '—'}
          </Cell>
          <Cell grow muted>
            <span className="icont__detail">
              {copy.backendDetail[backend.detail]}
              {backend.ownerStep ? <code className="icont__owner-step">{backend.ownerStep}</code> : null}
            </span>
          </Cell>
        </Row>
      ))}
    </Rows>
  )
}
