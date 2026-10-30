// RTB-6: every install failure ends in a diagnosis, ONE fix the app can do for the user to approve, or a skip —
// never in a dead card. Pure classification of a failed bootstrap stage (or a backend that died at start) from what
// the runner reported: the stage, its error and the tail of its output. Shared by main (the persisted status Settings
// shows) and the renderer (the install overlay and the post-install failure card).

export type InstallFailureClass =
  | 'cancelled'
  | 'disk'
  | 'integrity'
  | 'interpreter'
  | 'killed'
  | 'network'
  | 'permission'
  | 'resolver'
  | 'slow'
  | 'stalled'
  | 'unknown'

/** The one fix the app offers for a class. `retry` resumes (finished stages and installed packages are reused). */
export type InstallFixAction = 'open-network-settings' | 'open-storage-settings' | 'repair' | 'retry' | 'reveal-folder'

export interface InstallDiagnosis {
  class: InstallFailureClass
  fix: InstallFixAction
  /** The stage that failed, when known. */
  stage: null | string
  /** The package that failed inside the dependency stage, when the output names one. */
  packageName: null | string
  /** Bytes the install still needs, when the output says (disk class). */
  neededBytes: null | number
  /** The single most telling line, for "Show details" (never above the fold). */
  evidence: null | string
}

interface Rule {
  class: InstallFailureClass
  test: RegExp
}

// Order matters: the most specific evidence first (a hash mismatch during a download is integrity, not network).
const RULES: Rule[] = [
  { class: 'cancelled', test: /\bcancelled by user\b/i },
  // r2: the first-launch budget ran out while the install was still moving — a slow network or a busy Mac, not a hang.
  { class: 'slow', test: /\[iclone-install-watchdog\] ceiling/i },
  { class: 'stalled', test: /\[iclone-install-watchdog\] (?:no progress|no output)/i },
  { class: 'disk', test: /\bENOSPC\b|No space left on device|not enough (?:free )?(?:disk )?space|disk (?:is )?full/i },
  {
    class: 'permission',
    test: /\bEACCES\b|\bEPERM\b|\bEROFS\b|Read-only file system|Permission denied|Operation not permitted|not writable/i
  },
  {
    class: 'integrity',
    test: /sha-?256 mismatch|hash mismatch|checksum (?:mismatch|failed)|digest (?:mismatch|does not match)|Hash mismatch|integrity check failed|realized bytes do not match/i
  },
  {
    class: 'network',
    test: /\bENOTFOUND\b|\bEAI_AGAIN\b|getaddrinfo|Could not resolve host|Temporary failure in name resolution|nodename nor servname|\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b|\bENETUNREACH\b|\bEHOSTUNREACH\b|Network is unreachable|Connection (?:refused|reset|timed out)|error sending request|Failed to (?:fetch|download)|dns error|ProxyError|Proxy (?:Authentication Required|connection failed)|tunnel connection failed|407 Proxy|CERTIFICATE_VERIFY_FAILED|certificate verify failed|SSL(?:Error|: [A-Z_]+)|HTTP (?:status|error) 5\d\d|Failed to connect/i
  },
  {
    class: 'resolver',
    test: /No solution found when resolving|Failed to build|failed to build|Could not find a version|error: command '.*' failed|Building wheel .* failed|incompatible with this platform|no matching distribution|unsatisfiable/i
  },
  {
    class: 'interpreter',
    test: /python3?(?:\.\d+)?: (?:command )?not found|No interpreter found|No Python (?:found|interpreter)|bootstrap Python (?:missing|not found)|python[\d.]*: No such file or directory|ICLONE_RUNTIME_PY/i
  },
  {
    class: 'killed',
    test: /\bSIGKILL\b|\bSIGTERM\b|\bexit(?: code)?[ =]?137\b|\bKilled: 9\b|killed by (?:the )?(?:OS|signal)/i
  }
]

const FIX: Record<InstallFailureClass, InstallFixAction> = {
  cancelled: 'retry',
  disk: 'open-storage-settings',
  integrity: 'repair',
  interpreter: 'repair',
  killed: 'retry',
  network: 'retry',
  permission: 'reveal-folder',
  resolver: 'repair',
  slow: 'retry',
  stalled: 'retry',
  unknown: 'repair'
}

const NEEDED_BYTES = /need(?:s|ed)?\s+(?:at least\s+)?(\d+(?:\.\d+)?)\s?([KMGT]i?B)\b/i

const UNIT: Record<string, number> = {
  GB: 1e9,
  GiB: 2 ** 30,
  KB: 1e3,
  KiB: 2 ** 10,
  MB: 1e6,
  MiB: 2 ** 20,
  TB: 1e12,
  TiB: 2 ** 40
}

const FAILED_PACKAGE = /^\s*(?:✗\s+([A-Za-z0-9][\w.+-]*):|⚠ optional\s+([A-Za-z0-9][\w.+-]*)\b)/

export interface DiagnoseInput {
  stage?: null | string
  error?: null | string
  /** Tail of the output (newest last); only the last ~80 lines are read. */
  log?: readonly string[]
}

/** Classify a failure: the error is read first, then the output newest-first — the LAST telling line wins (critic
 * minor 1); within one line the most specific class wins (RULES order). */
export function diagnoseInstallFailure({ stage = null, error = null, log = [] }: DiagnoseInput): InstallDiagnosis {
  const lines = [error ?? '', ...log.slice(-80).slice().reverse()].filter(Boolean)
  let found: null | { cls: InstallFailureClass; line: string } = null

  for (const line of lines) {
    const rule = RULES.find(candidate => candidate.test.test(line))

    if (rule) {
      found = { cls: rule.class, line }

      break
    }
  }

  const cls = found?.cls ?? 'unknown'
  let neededBytes: null | number = null

  if (cls === 'disk') {
    for (const line of lines) {
      const match = NEEDED_BYTES.exec(line)

      if (match && UNIT[match[2]]) {
        neededBytes = Math.round(Number(match[1]) * UNIT[match[2]])

        break
      }
    }
  }

  const packageLine = log
    .slice(-80)
    .slice()
    .reverse()
    .map(line => {
      const match = FAILED_PACKAGE.exec(line)

      return match ? (match[1] ?? match[2] ?? null) : null
    })
    .find(Boolean)

  return {
    class: cls,
    evidence: (found?.line ?? error ?? null)?.trim().slice(0, 400) || null,
    fix: FIX[cls],
    neededBytes,
    packageName: packageLine ?? null,
    stage
  }
}
