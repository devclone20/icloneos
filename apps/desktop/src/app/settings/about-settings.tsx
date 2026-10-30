import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { type Translations, useI18n } from '@/i18n'
import { PUBLIC_LATEST_RELEASE_URL, PUBLIC_RELEASES_URL } from '@/iclone-shared/public-repo'
import { formatAgo } from '@/iclone-shared/time'
import { displayVersion } from '@/iclone-shared/version'
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { loadLastAgentCheck } from '@/store/agent-update'
import { $appUpdate, appUpdatePrimary, checkForAppUpdate, downloadAppUpdate, restartToUpdate } from '@/store/app-update'
import { loadRuntimeStatus } from '@/store/iclone-updates'
import {
  $desktopVersion,
  $updateApply,
  $updateChecking,
  $updatePolicy,
  $updateStatus,
  checkUpdates,
  openUpdatesWindow,
  refreshDesktopVersion,
  refreshUpdatePolicy,
  setDeveloperPolicy,
  startActiveUpdate
} from '@/store/updates'

import { aboutAgentLine, aboutAgentTone, useAgentUpdateCopy, versionLabel } from './app-atualisation/agent-model'
import { useAgentVerdict } from './app-atualisation/use-agent-verdict'
import { CredentialAuditSection } from './credential-audit-section'
import { appUpdateButton, appUpdateLine, useAppUpdateWords } from './machine/app-update-copy'
import { SectionHeading, SettingsContent } from './primitives'
import { SettingRow } from './setting-row'
import { UninstallSection } from './uninstall-section'

// The pass sentence electron/update-policy.ts (DEVELOPER_POLICY_ACK) compares byte for byte; a value, not prose.
const DEVELOPER_ACK_SENTENCE = 'I am the developer of this Mac'

const RELEASE_NOTES_URL = PUBLIC_RELEASES_URL
const INSTALLER_URL = PUBLIC_LATEST_RELEASE_URL

/**
 * The "build out of date" banner is for packaged release builds: a dev bundle (`vite dev`, the lab) always trails the
 * source tree, and a skew without a commit count came from a fallback stamp, not from a release.
 */
function bundleSkewShown(version: ReturnType<typeof $desktopVersion.get>): boolean {
  return !import.meta.env.DEV && version?.bundleOutOfSync === true && (version.bundleCommitsBehind ?? 0) > 0
}

function lastCheckedLabel(ms: number | undefined, a: Translations['settings']['about']) {
  if (!ms) {
    return a.never
  }

  return formatAgo(ms, { days: a.daysAgo, hours: a.hoursAgo, minutes: a.minAgo, now: a.justNow }, { rounding: 'round' })
}

export function AboutSettings() {
  const { t } = useI18n()
  const a = t.settings.about
  const agentCopy = useAgentUpdateCopy().copy
  const desktopVersion = useStore($desktopVersion)
  const version = useStore($desktopVersion)
  const status = useStore($updateStatus)
  const apply = useStore($updateApply)
  const checking = useStore($updateChecking)
  const policy = useStore($updatePolicy)
  const [justChecked, setJustChecked] = useState(false)
  const appUpdate = useStore($appUpdate)
  const appPrimary = appUpdatePrimary(appUpdate)
  const appWords = useAppUpdateWords()
  const appCheckLine = appUpdate && appUpdate.phase !== 'idle' ? appUpdateLine(appWords, appUpdate) : null
  // One fact, one source: the agent's version and its verdict are read exactly as Settings › Updates › Agent reads them.
  const { installed, verdict: agentVerdict } = useAgentVerdict()
  const runtimeVersion = versionLabel(installed?.version) ?? versionLabel(version?.runtimeVersion)

  const [ack, setAck] = useState('')
  const [overrideNote, setOverrideNote] = useState<null | string>(null)

  // The version atom is loaded once at app boot, which makes About show a
  // stale number after a self-update (the running binary is current, the
  // displayed string is not). Re-read on mount so opening About always
  // reflects the running build.
  useEffect(() => {
    void refreshDesktopVersion()
    void refreshUpdatePolicy()
    void loadLastAgentCheck()
    void loadRuntimeStatus()
  }, [])

  const behind = status?.behind ?? 0
  // behind is null when the exact count is unknowable (shallow clone): the
  // backend flags that case via updateAvailable instead of a number.
  const updateAvailable = behind > 0 || Boolean(status?.updateAvailable)
  const supported = status?.supported !== false
  const applying = apply.applying || apply.stage === 'restart'

  const handleCheck = async () => {
    setJustChecked(false)
    // The app updater answers for iclone os itself; the local pin check answers for the runtime. Neither asks Nous.
    const [next] = await Promise.all([checkUpdates(), checkForAppUpdate()])
    setJustChecked(Boolean(next))
  }

  let statusLine: string
  let statusDetail: null | string = null
  let statusTone: 'idle' | 'available' | 'error' | 'flagged' | 'unverified' = 'idle'

  if (status?.pinned && !applying) {
    // Passive: a runtime newer than the verified pin is the user's choice (Settings › Updates › Agent), not an error.
    // The title says what the row is; the version and its verification are the hint.
    const agent = runtimeVersion ?? status.pinSha?.slice(0, 7) ?? ''
    statusLine = agentCopy.aboutTitle
    // Same verdict as Settings › Updates › Agent (useAgentVerdict): the sha against the pin, never a second detector.
    statusDetail = aboutAgentLine(agentVerdict, agent, agentCopy)
    // The icon reads the same verdict as the line: never a green check beside "flagged".
    const tone = aboutAgentTone(agentVerdict)
    statusTone = tone === 'verified' ? 'idle' : tone === 'flagged' ? 'flagged' : 'unverified'
  } else if (!supported) {
    statusLine = a.cantUpdate
    statusTone = 'error'
  } else if (status?.error) {
    statusLine = a.cantReach
    statusTone = 'error'
  } else if (applying) {
    statusLine = a.installing
    statusTone = 'available'
  } else if (updateAvailable) {
    statusLine = behind > 0 ? a.updateReady(behind) : a.updateReadyUnknown
    statusTone = 'available'
  } else if (status) {
    statusLine = a.onLatest
  } else {
    statusLine = a.tapCheck
  }

  return (
    <SettingsContent>
      <div className="flex flex-col items-center gap-3 pt-6 pb-2 text-center">
        <BrandMark className="size-16" />
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{a.heading}</h2>
          <p className="mt-1 text-xs text-muted-foreground" data-about-version>
            {version?.appVersion ? a.version(displayVersion(version.appVersion)) : a.versionUnavailable}
          </p>
          {runtimeVersion && (
            <p className="mt-0.5 text-xs text-muted-foreground" data-about-runtime>
              {appWords.copy.runtime(runtimeVersion)}
            </p>
          )}
        </div>
        {bundleSkewShown(version) && (
          <div className="mx-auto w-full max-w-2xl rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-left text-sm">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0">
                <p className="font-medium">{a.bundleOutOfSync}</p>
                <p className="mt-1 text-xs text-muted-foreground">{a.bundleOutOfSyncDesc}</p>
                <Button asChild className="mt-2" size="sm" variant="textStrong">
                  <a
                    href={INSTALLER_URL}
                    onClick={event => {
                      event.preventDefault()
                      void window.hermesDesktop?.openExternal?.(INSTALLER_URL)
                    }}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <ExternalLink className="size-3" />
                    {a.bundleOutOfSyncAction}
                  </a>
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="mx-auto mt-4 w-full max-w-2xl">
        <SectionHeading icon={RefreshCw} title={a.updates} />

        <div
          className={cn(
            'rounded-xl border px-4 py-1 text-sm',
            statusTone === 'available' && 'border-primary/30 bg-primary/5 text-foreground',
            statusTone === 'error' && 'border-destructive/35 bg-destructive/5 text-destructive',
            statusTone === 'idle' && 'border-border/70 bg-muted/20 text-foreground'
          )}
        >
          <SettingRow
            control={
              <div className="flex flex-wrap items-center gap-4">
                <Button
                  disabled={checking || applying || !supported}
                  onClick={() => void handleCheck()}
                  size="sm"
                  variant="textStrong"
                >
                  {checking ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                  {checking ? a.checking : a.checkNow}
                </Button>
                {(appPrimary.action === 'download' || appPrimary.action === 'restart') && (
                  <Button
                    data-app-update-action={appPrimary.action}
                    onClick={() => void (appPrimary.action === 'download' ? downloadAppUpdate() : restartToUpdate())}
                    size="sm"
                  >
                    {appUpdateButton(appWords, appUpdate)}
                  </Button>
                )}

                {updateAvailable && supported && !applying && (
                  <>
                    <Button onClick={() => startActiveUpdate()} size="sm">
                      {a.updateNow}
                    </Button>
                    <Button onClick={() => openUpdatesWindow()} size="sm" variant="textStrong">
                      {a.seeWhatsNew}
                    </Button>
                  </>
                )}

                <Button
                  onClick={() => {
                    window.location.hash = '#/settings?tab=app-atualisation'
                  }}
                  size="sm"
                  variant="textStrong"
                >
                  {agentCopy.aboutOpen}
                </Button>

                <Button asChild className="ml-auto" size="sm" variant="text">
                  <a
                    href={RELEASE_NOTES_URL}
                    onClick={event => {
                      event.preventDefault()
                      void window.hermesDesktop?.openExternal?.(RELEASE_NOTES_URL)
                    }}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <ExternalLink className="size-3" />
                    {a.releaseNotes}
                  </a>
                </Button>
              </div>
            }
            hint={
              <>
                {statusDetail && (
                  <p className="mt-1 text-xs text-muted-foreground" data-about-agent-status>
                    {statusDetail}
                  </p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  {a.lastChecked(lastCheckedLabel(status?.fetchedAt, a))}
                  {justChecked && !checking ? a.justNowSuffix : ''}
                </p>
                {policy?.runtimeCheckOff && policy.policy === 'curated' && (
                  <p className="mt-1 text-xs text-muted-foreground">{a.runtimeCheckOff}</p>
                )}
                {appCheckLine && <p className="mt-1 text-xs text-muted-foreground">{appCheckLine}</p>}
              </>
            }
            title={
              <span className="flex items-start gap-2">
                {statusTone === 'available' ? (
                  <Codicon className="mt-0.5 size-4 shrink-0 text-primary" name="cloud-download" size="1rem" />
                ) : statusTone === 'flagged' ? (
                  <AlertTriangle
                    className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                    data-about-status-icon="flagged"
                  />
                ) : statusTone === 'error' || statusTone === 'unverified' ? null : (
                  <CheckCircle2
                    className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                    data-about-status-icon="verified"
                  />
                )}
                <span className="font-medium">{statusLine}</span>
              </span>
            }
            wide
          />
        </div>

        <SettingRow
          detail={
            // The release branch is what every user runs, so only a development branch is worth naming.
            status?.branch && status.branch !== 'main' && status.currentSha
              ? a.branchCommit(status.branch, status.currentSha.slice(0, 7))
              : undefined
          }
          hint={a.automaticUpdatesDesc}
          title={a.automaticUpdates}
        />

        {policy?.packaged && policy.policy === 'curated' && (
          <div className="mx-auto mt-4 w-full max-w-2xl">
            <SettingRow
              below={
                <div className="mt-1 grid gap-1">
                  <input
                    aria-label={a.policyAck}
                    className="w-full rounded-md border border-border/70 bg-transparent px-2 py-1 text-xs"
                    onChange={event => setAck(event.target.value)}
                    placeholder={DEVELOPER_ACK_SENTENCE}
                    value={ack}
                  />
                  {overrideNote && <p className="text-xs text-muted-foreground">{overrideNote}</p>}
                </div>
              }
              control={
                <Button
                  disabled={!ack}
                  onClick={() =>
                    void setDeveloperPolicy(ack).then(result =>
                      setOverrideNote(result.ok ? a.policySaved : a.policyWrong)
                    )
                  }
                  size="sm"
                  variant="textStrong"
                >
                  {a.policyUse}
                </Button>
              }
              hint={a.policyHint}
              title={a.policyTitle}
              wide
            />
          </div>
        )}

        <UninstallSection />

        {/* Owner rule: the open-source line closes Settings — brand names stay untranslated. */}
        <p className="pt-6 pb-2 text-center text-xs text-muted-foreground">{a.openSourceLine}</p>
      </div>
      <CredentialAuditSection />
    </SettingsContent>
  )
}
