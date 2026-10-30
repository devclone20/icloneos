import { useI18n } from '@/i18n'
import { arAgentUpdate } from '@/i18n/ar/arAgentUpdate'
import { type AgentUpdateCopy, enAgentUpdate } from '@/i18n/en'
import { jaAgentUpdate } from '@/i18n/ja/jaAgentUpdate'
import { ptPtAgentUpdate } from '@/i18n/pt-PT/ptPtAgentUpdate'
import type { Locale } from '@/i18n/types'
import { zhHantAgentUpdate } from '@/i18n/zh-hant/zhHantAgentUpdate'
import { zhAgentUpdate } from '@/i18n/zh/zhAgentUpdate'
import { formatAgo, toEpochMs } from '@/iclone-shared/time'
import type {
  IcloneAgentInstalled,
  IcloneAgentLastUpdate,
  IcloneAgentUpdateCheck,
  IcloneRuntimeStatus,
  IcloneUpdatePolicyInfo
} from '@/types/iclone-updates'

import { withAgentUpdateWords } from '../machine/agent-update-words'

const COPY: Record<Locale, AgentUpdateCopy> = {
  ar: arAgentUpdate,
  en: enAgentUpdate,
  ja: jaAgentUpdate,
  'pt-PT': ptPtAgentUpdate,
  zh: zhAgentUpdate,
  'zh-hant': zhHantAgentUpdate
}

export function agentUpdateCopy(locale: Locale): AgentUpdateCopy & { aboutTitle: string } {
  return withAgentUpdateWords(COPY[locale] ?? enAgentUpdate, locale)
}

export function useAgentUpdateCopy(): { copy: AgentUpdateCopy & { aboutTitle: string }; locale: Locale } {
  const { locale } = useI18n()

  return { copy: agentUpdateCopy(locale), locale }
}

export function shortSha(sha: null | string | undefined): null | string {
  return sha ? sha.slice(0, 7) : null
}

/** `0.21.5` → `v0.21.5`; a tag or an already-prefixed value stays as it is. */
export function versionLabel(version: null | string | undefined): null | string {
  if (!version) {
    return null
  }

  return /^\d/.test(version) ? `v${version}` : version
}

/**
 * What the Latest row and the Update button may promise. The check names the newest stable release it can prove is
 * in the tip and how literally it names it: `versionBasis: 'exact'` means the tip IS that release's commit, so the
 * bare `v0.22.2` is the truth; `'newer'` means the release is merged in and the tip carries commits after it, so
 * `v0.22.2+`. An absent basis (a check stored before the field existed) is read as `'newer'` — a bare name would
 * promise a release the user is not getting. With containment unknown `version` is null and the row keeps its
 * version-free answer.
 *
 * The parameter is structural on purpose: the shape travels from the check result, not from an exported type.
 */
export function latestVersionLabel(
  latest: null | undefined | { version: null | string; versionBasis?: 'exact' | 'newer' }
): null | string {
  const label = versionLabel(latest?.version)

  if (label === null) {
    return null
  }

  return latest?.versionBasis === 'exact' ? label : `${label}+`
}

/** `6 Oct 2026, 05:23` in the UI language: when something happened, to the minute; null when unreadable. */
export function momentLabel(iso: null | string | undefined, locale: Locale): null | string {
  const ms = toEpochMs(iso)

  return ms === null ? null : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
}

/** `6 Oct 2026` in the UI language; null for a missing or unreadable date. */
export function dayLabel(iso: null | string | undefined, locale: Locale): null | string {
  const ms = toEpochMs(iso)

  if (ms === null) {
    return null
  }

  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(ms)
}

export function checkedAgoLabel(checkedAt: string, copy: AgentUpdateCopy, nowMs = Date.now()): null | string {
  const ms = toEpochMs(checkedAt)

  if (ms === null) {
    return null
  }

  const age = formatAgo(
    ms,
    { days: copy.daysAgo, hours: copy.hoursAgo, minutes: copy.minAgo, now: copy.justNow },
    { nowMs, rounding: 'floor' }
  )

  return copy.checkedAgo(age)
}

/** A full and a short sha name the same commit when one is a prefix of the other (7+ characters). */
function sameCommit(a: null | string | undefined, b: null | string | undefined): boolean {
  if (!a || !b || Math.min(a.length, b.length) < 7) {
    return false
  }

  const [x, y] = [a.toLowerCase(), b.toLowerCase()]

  return x.startsWith(y) || y.startsWith(x)
}

/**
 * The version of the install whose sha is shown, never another install's. The backend's own version string can
 * come from a different root (the lab runs the repo snapshot), so it names the agent only when no sha is known;
 * the last receipt names it when it updated to this very sha. Otherwise the row shows the sha and date alone.
 */
function installedVersion(
  sha: null | string,
  own: null | string | undefined,
  lastUpdate: IcloneAgentLastUpdate | null | undefined,
  runtimeVersion: null | string | undefined
): null | string {
  if (own) {
    return own
  }

  if (!sha) {
    return runtimeVersion ?? null
  }

  return lastUpdate?.to.version && sameCommit(lastUpdate.to.sha, sha) ? lastUpdate.to.version : null
}

/**
 * What runs now: the last check's reading when there is one, else the local reads the pane already
 * makes (runtime HEAD, the runtime version, the pin) — never a network call.
 */
export function installedAgent(
  check: IcloneAgentUpdateCheck | null,
  runtime: IcloneRuntimeStatus | null,
  runtimeVersion: null | string | undefined,
  policy: IcloneUpdatePolicyInfo | null
): IcloneAgentInstalled | null {
  const lastUpdate = runtime?.lastUpdate

  if (check) {
    const { sha, version } = check.installed

    return { ...check.installed, version: installedVersion(sha, version, lastUpdate, runtimeVersion) }
  }

  if (!runtime?.head && !runtimeVersion) {
    return null
  }

  const sha = runtime?.head?.sha ?? null

  return {
    branch: runtime?.branch ?? null,
    date: runtime?.head?.date ?? null,
    dirty: runtime?.dirty ?? null,
    sha,
    version: installedVersion(sha, null, lastUpdate, runtimeVersion),
    verifiedWithRelease: Boolean(sha && policy?.pin.sha && policy.pin.sha === sha)
  }
}

/** The version the release was verified with, for the Restore label. */
export function verifiedVersion(check: IcloneAgentUpdateCheck | null, policy: IcloneUpdatePolicyInfo | null): string {
  return versionLabel(check?.verified.version) ?? shortSha(check?.verified.sha) ?? shortSha(policy?.pin.sha) ?? ''
}

/** `…/pre-update-2026-10-06-224523.zip` → `2026-10-06 22:45`: the backup named by when it was made, not by its file. */
export function backupStamp(path: string): string {
  const m = /(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})\d{2}\.zip$/.exec(path)

  return m ? `${m[1]} ${m[2]}:${m[3]}` : basename(path)
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export type AgentVerdict = 'newer' | 'unknown' | 'verified' | 'verified-but-flagged'

/**
 * ONE verdict on the installed agent, read by Settings › Updates and About alike: the installed sha against the
 * release pin decides verified/newer; the compat flag can only qualify a verified pin, never contradict it.
 */
export function agentVerdict(
  installed: Pick<IcloneAgentInstalled, 'verifiedWithRelease'> | null,
  flagged: boolean
): AgentVerdict {
  if (!installed) {
    return 'unknown'
  }

  if (installed.verifiedWithRelease) {
    return flagged ? 'verified-but-flagged' : 'verified'
  }

  return 'newer'
}

/**
 * About's status icon for a pinned runtime, read from the same verdict as the line beside it: a green check only for a
 * verified agent, the warning for a verified-then-flagged one, and no icon where nothing was verified (newer, unknown).
 */
export type AboutAgentTone = 'flagged' | 'none' | 'verified'

export function aboutAgentTone(verdict: AgentVerdict): AboutAgentTone {
  return verdict === 'verified' ? 'verified' : verdict === 'verified-but-flagged' ? 'flagged' : 'none'
}

/** About's one-line reading of the verdict: the same three answers Updates gives, never a fourth wording. */
export function aboutAgentLine(verdict: AgentVerdict, version: string, copy: AgentUpdateCopy): string {
  if (verdict === 'newer') {
    return copy.aboutNewer(version)
  }

  return verdict === 'verified-but-flagged' ? copy.aboutFlagged(version) : copy.aboutVerified(version)
}

/**
 * The verdict in the words of the Installed pill, for any other line that names it: the engine's level strings
 * (`amber:3-roots`, RED/AMBER/GREEN) never reach the screen.
 */
export function agentVerdictWords(verdict: AgentVerdict, copy: AgentUpdateCopy): string {
  switch (verdict) {
    case 'verified':
      return copy.verified

    case 'verified-but-flagged':
      return `${copy.verified} · ${copy.compatibility(copy.compatibilityWords.RED)}`

    case 'newer':
      return copy.newer

    case 'unknown':
      return copy.unknown
  }
}
