import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Pill, SectionHeading, SettingsContent } from '@/app/settings/primitives'
import { SettingRow } from '@/app/settings/setting-row'
import { Button } from '@/components/ui/button'
import { codiconIcon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { CONFINEMENT_ON_BY_DEFAULT, type ConfinementVerdict } from '@/iclone-shared/confinement'
import type { PermissionIntegrityFinding } from '@/iclone-shared/permissions'
import { triggerHaptic } from '@/lib/haptics'
import { $confinement, readConfinementOnce } from '@/store/confinement'
import { $permissions, revokePermissionGrant, watchPermissions } from '@/store/permissions'
import { $currentCwd } from '@/store/session'

import { AuditList } from './audit-list'
import { FunctionMatrix } from './function-matrix'
import { ModePicker } from './mode-picker'

const ModeIcon = codiconIcon('shield')
const FloorIcon = codiconIcon('circle-slash')
const GrantIcon = codiconIcon('key')
const AuditIcon = codiconIcon('history')
const FunctionsIcon = codiconIcon('layers')

/**
 * Settings › Agent › Permissions (V3-F §5): the mode picker, the grants the user gave (revocable), the never list and
 * the activity from main's audit chain. Everything here is a view of main's state; the only writes are the user's own
 * clicks on `data-perm-mode-confirm` controls. The chain's health is `state.chain` as main verified it (against the
 * signed anchor, knowing whether the key pre-existed) — never a bare verifier run over the files, which is GREEN on an
 * empty directory and cannot tell a new log from a wiped one.
 */
/** r3: how often the open pane re-reads main's confinement state (the Containers app itself polls every second). */
export const CONFINEMENT_NOTE_POLL_MS = 5_000

/**
 * V3-FX M2: which confinement line is true now. Main's live verdict decides: green = confined (the default line), off
 * = the owner chose This Mac, red = on but not working now, or the last read failed (r3: never a stale green). Before
 * main answers nothing is claimed; a build without the confinement bridge (web) states the shared default.
 */
export function shellNoteFor(
  status: 'error' | 'loading' | 'ready' | 'unavailable',
  state: { verdict: ConfinementVerdict } | null
): 'off' | 'on' | 'pending' | 'red' {
  // r3: a read that failed after a good one never keeps a stale "confined": the state is unknown now.
  if (status === 'error') {
    return 'red'
  }

  if (state) {
    return state.verdict === 'green' ? 'on' : state.verdict
  }

  if (status === 'unavailable') {
    return CONFINEMENT_ON_BY_DEFAULT ? 'on' : 'off'
  }

  return 'pending'
}

/** The alert lines for main's integrity findings, in main's order, one per distinct sentence. */
export function integrityLines(
  findings: readonly PermissionIntegrityFinding[] | undefined,
  copy: Record<'functions' | 'grants' | 'mode', Record<PermissionIntegrityFinding['problem'], string>>
): { key: string; text: string }[] {
  const lines: { key: string; text: string }[] = []

  for (const finding of findings ?? []) {
    const text = copy[finding.file === 'fnGrants' ? 'grants' : finding.file][finding.problem]

    if (!lines.some(line => line.text === text)) {
      lines.push({ key: `${finding.file}:${finding.problem}`, text })
    }
  }

  return lines
}

export function PermissionsPane() {
  const copy = useI18n().t.settings.permissions
  const { records, state, status } = useStore($permissions)
  const cwd = useStore($currentCwd)
  // FX-6: the note says what confinement does now (main's live state when the Containers pane has read it, else the
  // shared default it starts with).
  const confinement = useStore($confinement)

  // V3-FX M2: the note states main's LIVE confinement (the same state the Containers app shows), read here even when
  // Containers was never opened, again whenever main announces a change.
  // r3: and while the pane is open, a light poll (main announces only refusals, not a backend going red or This Mac).
  useEffect(() => {
    void readConfinementOnce()

    const off = window.hermesDesktop?.icloneConfinement?.onChanged(() => void readConfinementOnce())
    const timer = window.setInterval(() => void readConfinementOnce(), CONFINEMENT_NOTE_POLL_MS)

    return () => {
      off?.()
      window.clearInterval(timer)
    }
  }, [])
  const [scope, setScope] = useState<'project' | 'standing'>('standing')

  useEffect(() => watchPermissions(cwd || null), [cwd])

  // FX-2 r1b / M1: the Keychain setting now and at launch (read without touching the keychain). Off is the usual reason
  // for "Manual only" and the line names the fix; turned on since launch, the line says the modes follow a restart.
  const [keychain, setKeychain] = useState<{ on: boolean; atLaunch: boolean } | null>(null)
  const [restartRefused, setRestartRefused] = useState(false)

  useEffect(() => {
    let live = true

    void window.hermesDesktop
      ?.keychainState?.()
      .then(result => live && setKeychain(result ?? null))
      .catch(() => undefined)

    return () => {
      live = false
    }
  }, [state?.enforcement])

  if (status === 'unavailable') {
    return (
      <SettingsContent>
        <p className="pt-4 text-[0.8125rem] text-(--ui-text-tertiary)">{copy.refused.unavailable}</p>
      </SettingsContent>
    )
  }

  if (!state) {
    return <SettingsContent>{null}</SettingsContent>
  }

  const projectKey = state.project
  const projectMode = projectKey ? state.mode.projects[projectKey] : undefined
  const current = scope === 'project' && projectMode ? projectMode : state.mode.standing

  return (
    <SettingsContent>
      <div className="grid gap-6 pt-2" data-permissions-pane="">
        <section>
          <SectionHeading icon={ModeIcon} title={copy.title} />
          <p className="mb-2 text-[0.8125rem] text-(--ui-text-tertiary)">{copy.lead}</p>
          <p
            className={
              state.enforcement === 'not-enforced' || state.enforcement === 'degraded'
                ? 'mb-2 text-[0.75rem] leading-4 text-(--ic-danger)'
                : 'mb-2 text-[0.75rem] leading-4 text-(--ui-text-tertiary)'
            }
            data-permission-enforcement={state.enforcement}
            role={state.enforcement === 'not-enforced' || state.enforcement === 'degraded' ? 'alert' : undefined}
          >
            {state.enforcement === 'degraded' && keychain && !keychain.on
              ? copy.enforcement['keychain-off']
              : state.enforcement === 'degraded' && keychain && !keychain.atLaunch
                ? copy.enforcement['keychain-restart']
                : copy.enforcement[state.enforcement]}
          </p>
          {state.enforcement === 'degraded' && keychain?.on && !keychain.atLaunch ? (
            // r3: the way the line names — a clean relaunch, after which the modes use the Keychain.
            <div className="mb-2">
              <Button
                data-keychain-restart=""
                onClick={() => {
                  setRestartRefused(false)
                  void Promise.resolve(window.hermesDesktop?.keychainRestart?.())
                    .catch(() => null)
                    // r4: main said no (the setting changed meanwhile, or not this window): say so, never stay silent.
                    .then(result => result !== true && setRestartRefused(true))
                }}
                size="sm"
                variant="outline"
              >
                {copy.restartNow}
              </Button>
              {restartRefused ? (
                <p className="pt-1 text-[0.75rem] leading-4 text-(--ui-text-tertiary)" data-keychain-restart-refused="">
                  {copy.restartRefused}
                </p>
              ) : null}
            </div>
          ) : null}
          {/* A-1: a state file main refused or could not verify at launch — one alert each, deduplicated by wording
              (the two grant files share theirs); what is in force instead is in the sentence (store.ts). */}
          {integrityLines(state.integrity, copy.integrity).map(line => (
            <p
              className="mb-2 text-[0.75rem] leading-4 text-(--ic-danger)"
              data-permission-integrity={line.key}
              key={line.key}
              role="alert"
            >
              {line.text}
            </p>
          ))}
          <div aria-label={copy.scope.label} className="mb-1 flex flex-wrap items-center gap-1.5" role="radiogroup">
            <span className="me-1 text-[0.75rem] text-(--ui-text-tertiary)">{copy.scope.label}</span>
            <Button
              aria-checked={scope === 'standing'}
              onClick={() => setScope('standing')}
              role="radio"
              size="sm"
              variant={scope === 'standing' ? 'outline' : 'ghost'}
            >
              {copy.scope.standing}
            </Button>
            <Button
              aria-checked={scope === 'project'}
              disabled={!projectKey}
              onClick={() => setScope('project')}
              role="radio"
              size="sm"
              variant={scope === 'project' ? 'outline' : 'ghost'}
            >
              {projectKey ? copy.scope.project(projectKey) : copy.scope.noProject}
            </Button>
          </div>
          <ModePicker
            current={current}
            target={
              scope === 'project' && projectKey
                ? { scope: 'project', key: projectKey }
                : { scope: 'standing', key: null }
            }
          />
          <p className="pt-2 text-[0.75rem] leading-4 text-(--ui-text-tertiary)" data-permission-shell-note="">
            {copy.shellNote[shellNoteFor(confinement.status, confinement.state)]}
          </p>
        </section>

        <section>
          <SectionHeading icon={FunctionsIcon} title={copy.functions.title} />
          <p className="mb-2 text-[0.8125rem] text-(--ui-text-tertiary)">{copy.functions.lead}</p>
          <FunctionMatrix
            ceilings={state.ceilings}
            levels={state.functions}
            sealed={state.sealed}
            unconfirmed={state.unconfirmed}
          />
        </section>

        <section data-permission-grants="">
          <SectionHeading icon={GrantIcon} title={copy.grants.title} />
          {state.grants.length === 0 && state.fnGrants.length === 0 ? (
            <p className="text-[0.8125rem] text-(--ui-text-tertiary)">{copy.grants.empty}</p>
          ) : (
            state.grants.map(grant => (
              <SettingRow
                control={
                  <Button
                    data-perm-mode-confirm=""
                    onClick={() => {
                      triggerHaptic('selection')
                      void revokePermissionGrant(grant.id)
                    }}
                    size="sm"
                    variant="outline"
                  >
                    {copy.grants.revoke}
                  </Button>
                }
                detail={grant.project ?? grant.sessionId ?? undefined}
                hint={copy.grants.scope[grant.scope]}
                key={grant.id}
                title={copy.classes[grant.cls]}
              />
            ))
          )}
          {state.fnGrants.map(grant => (
            <SettingRow
              control={
                <Button
                  data-perm-mode-confirm=""
                  onClick={() => {
                    triggerHaptic('selection')
                    void revokePermissionGrant(grant.id)
                  }}
                  size="sm"
                  variant="outline"
                >
                  {copy.grants.revoke}
                </Button>
              }
              detail={grant.project ?? grant.sessionId ?? undefined}
              hint={copy.grants.scope[grant.scope]}
              key={grant.id}
              title={copy.functions.grantFor(copy.functions.functions[grant.fn].name)}
            />
          ))}
        </section>

        <section data-permission-floor="">
          <SectionHeading icon={FloorIcon} title={copy.floor.title} />
          {copy.floor.items.map(item => (
            <SettingRow key={item} title={item} />
          ))}
        </section>

        <section>
          <SectionHeading
            aside={
              <Pill tone={state.chain.ok ? 'muted' : 'warn'}>
                {state.chain.ok ? copy.audit.chainOk(state.chain.records) : copy.audit.chainBroken}
              </Pill>
            }
            icon={AuditIcon}
            title={copy.audit.title}
          />
          <AuditList records={records} />
        </section>
      </div>
    </SettingsContent>
  )
}
