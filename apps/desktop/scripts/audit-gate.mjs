#!/usr/bin/env node
// audit-gate.mjs — G-42: no critical or high npm advisory in a package the app ships.
//
//   node scripts/audit-gate.mjs                     run `npm audit --json` at the repo root (network) and judge it
//                                                   only if npm's http log shows the registry answered (see runAudit)
//   node scripts/audit-gate.mjs [--save <file>]     ... and save the repo lock's report, stamped with how it was
//                                                   audited, for a later --report
//   node scripts/audit-gate.mjs --report <file>     judge a saved report instead (offline): one this gate saved, or an
//                                                   `npm audit --json` report given an `audited.args` stamp by hand
//       [--lock <package-lock.json>]               the lockfile whose shipped set is judged (default: the repo's;
//                                                   a SUB_LOCKS, APP_LOCKS or ACP_LOCKS lock: its own rules and waivers)
//
// The runtime's other npm locks (SUB_LOCKS: the WhatsApp bridge and the Photon sidecar, v0.0.4 review M2) are judged
// too, each on its own: `npm audit --json --package-lock-only` in its folder (the lock is what `npm ci` installs on
// the user's machine), every non-dev package of the lock ships, the same severities fail, and each lock has its own
// waiver list under the same rules (tied, stale, expired). The app's bundled locks (APP_LOCKS: the Privy sign-in page,
// iclone/privy/login-island, bundled into privy-login.js and shipped as an extraResources entry; v0.0.5) are judged
// the same way. So is the optional ACP CLI's lock (ACP_LOCKS: apps/desktop/acp-cli-lock, shipped as Resources/acp-pin
// and installed from it at first use, only when the user adds the ACP CLI; v0.0.5).
//
// What ships is the set THIRD_PARTY_NOTICES.md lists: the closure third-party-closure.mjs computes from the lockfile
// (desktopRoots + computeClosure), the desktop workspace's runtime dependencies plus Electron. Electron is a
// devDependency of the workspace (electron-builder wants it there) but its frameworks are what the app runs in, so
// `npm audit --omit=dev` never sees it: the gate reads the FULL report and keeps only the lock nodes of that closure.
// npm's report cannot show what it covered (it lists only the vulnerable packages, and metadata.dependencies counts
// the whole tree whatever --omit says; measured on npm 11), so every report the gate judges carries an `audited.args`
// stamp (runAudit writes it) and a stamp that omits a class a shipped package belongs to is refused (assertReportScope). Build tools, test runners and the other workspaces (vite,
// ui-tui, web, node-gyp) are outside it and are reported, never judged.
//
// A finding is one advisory (a `via` object of the report) of severity high or critical on a shipped node. Every
// finding fails unless WAIVED names that exact name@version and advisory id; a waiver that matches no finding fails
// too (stale: drop it), so the list can only shrink to what is still true, a waiver that does not name what removes
// it and by which version (`until`, e.g. "fixed by the next Electron (v0.0.5)") is refused (untied), and a waiver whose `until` version the
// app has reached is refused (expired). Exit 0 green, 1 red, 2 cannot judge.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { computeClosure, desktopRoots } from './third-party-closure.mjs'
import { isMain } from './utils.mjs'

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(DESKTOP, '..', '..')

/**
 * The version being released: the desktop workspace's own `version`, which electron-builder stamps on the app and
 * its artifacts (the root package.json is the monorepo's and never ships).
 */
export const APP_VERSION = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')).version

export const FAILING_SEVERITIES = Object.freeze(['critical', 'high'])

/**
 * Known findings on shipped packages, each by exact name@version and advisory id, with the reason it is not fixed
 * yet. This list records a declared debt, not an acceptance: every entry names what removes it in `until` (the plan
 * item and the version that drops it), and the gate refuses an entry without one (UNTIED, red: v0.0.4 review S5) and
 * an entry whose version the app has reached (EXPIRED, red: v0.0.4 review R2-4).
 */
export const WAIVED = Object.freeze({
  // Empty: no shipped package has a critical or high advisory. Electron 44.10.1 has none of the advisories that the
  // Electron 40.10.2 entry here used to waive (audit-gate.fixtures/npm-audit-2026-11-01.json).
})

/**
 * The runtime's other npm locks (G-45; v0.0.4 review M2), by folder from the repo root, each with its own waivers
 * (same rules as WAIVED). Both ship in the runtime as `deps` rows (runtime-artifact.mjs) and are installed from their
 * lock on the user's machine when the bridge is turned on, so a high there is a high in what the app ships.
 */
export const SUB_LOCKS = Object.freeze({
  'scripts/whatsapp-bridge': Object.freeze({}),
  'plugins/platforms/photon/sidecar': Object.freeze({})
})

// The accepted risks of the Privy sign-in page's lock (owner decision 2026-11-03/04): one entry per finding, each with
// its own advisory. The `until` version forces the next release to re-decide them (the gate refuses an expired waiver).
const SIGN_IN_UNTIL =
  'v0.0.8: re-decided each release; removed when a compatible fix exists (backlog: SECURITY.md §3.3)'
const SIGN_IN_DECIDED =
  'accepted by the owner 2026-11-03/04, re-decided 2026-11-05 for v0.0.6 by the security review; removed when a ' +
  'compatible fix exists; ' +
  're-reviewed 2026-11-10 for v0.0.7: still no compatible fix (zod 3.25.76 is the last 3.x, the fix is only in 4.6.6+; ' +
  '@privy-io/react-auth 3.51.3, the newest, moves @privy-io/api-base to 2.0.0 without zod but still needs x402 ^0.7.1 ' +
  '(zod ^3.24.2; every x402 up to 1.2.0 still needs zod 3 and wagmi 2), @coinbase/cdp-sdk still needs zod ^3.25.76 and ' +
  '@reown/appkit-wallet 1.8.24 still pins zod 3.22.4; wagmi 2.19.5, the last 2.x, pins @wagmi/connectors 6.2.0 > ' +
  '@walletconnect/ethereum-provider 2.21.1 > @walletconnect/utils 2.21.1 > query-string 7.1.3, which needs ' +
  'decode-uri-component ^0.2.2, and 0.5.1 is ESM-only, so no override is safe); the lock and privy-login.js are ' +
  'unchanged since 2026-11-02 (sha256 4e56921f and 3287799b); in privy-login.js the only zod parse calls are zod\'s own ' +
  'internals (no shipped code parses data with a zod schema), no array schema has a size constraint, and ' +
  'decode-uri-component is absent'
const SIGN_IN_ZOD_NO_FIX =
  'no compatible fix: GHSA-mrhx-c7xc-m3w5 is fixed only in zod 4.6.6, no 3.x release has it, and the consumers need ' +
  'zod 3 (@privy-io/api-base ^3.25.76, @coinbase/cdp-sdk ^3.25.76, x402 ^3.24.2, @reown/appkit-wallet 3.22.4 exact); ' +
  'the newest @privy-io/react-auth (3.51.2, checked 2026-11-05) still resolves it; '
const SIGN_IN_ZOD_WORST =
  'worst case: the sign-in window runs out of memory (a DoS of the sign-in window only), no data or code is exposed; '

/**
 * The app's own npm locks bundled into what electron-builder packages (G-42, v0.0.5): by folder from the repo root,
 * each with its own waivers (same rules as WAIVED: tied, stale, expired). The Privy sign-in page is built from
 * iclone/privy/login-island's lock by esbuild into iclone/privy/privy-login.js, which ships through build.files
 * (apps/desktop/package.json, to "iclone-privy": privy.html, privy-login.js, privy-preload.cjs). The gate judges every
 * non-dev package of the lock; the esbuild metafile decides what is in the bundle.
 */
export const APP_LOCKS = Object.freeze({
  'iclone/privy/login-island': Object.freeze({
    'zod@3.25.76': Object.freeze({
      until: SIGN_IN_UNTIL,
      severity: 'high',
      reason:
        SIGN_IN_ZOD_NO_FIX +
        'this copy is in privy-login.js, but no shipped code parses anything with its schemas (checked 2026-11-04); ' +
        SIGN_IN_ZOD_WORST +
        SIGN_IN_DECIDED,
      advisories: Object.freeze({
        'GHSA-mrhx-c7xc-m3w5': 'HIGH, CWE-770: memory exhaustion validating oversized constrained collections'
      })
    }),
    // The two nested copies (@reown/appkit-wallet and @wagmi/connectors), both 3.22.4: one name@version, one entry.
    'zod@3.22.4': Object.freeze({
      until: SIGN_IN_UNTIL,
      severity: 'high',
      reason:
        SIGN_IN_ZOD_NO_FIX +
        'these copies are in the lock but not in privy-login.js (esbuild metafile, 2026-11-04); ' +
        SIGN_IN_ZOD_WORST +
        SIGN_IN_DECIDED,
      advisories: Object.freeze({
        'GHSA-mrhx-c7xc-m3w5': 'HIGH, CWE-770: memory exhaustion validating oversized constrained collections'
      })
    }),
    'decode-uri-component@0.2.2': Object.freeze({
      until: SIGN_IN_UNTIL,
      severity: 'high',
      reason:
        'no compatible fix: GHSA-qr28-fpjm-wq7f is fixed only in 0.5.1, and the consumer is query-string 7 ' +
        "(@wagmi/connectors > @walletconnect/utils > query-string 7.1.3 > decode-uri-component 0.2.2); npm's only " +
        'fix is a semver-major @privy-io/react-auth; neither package is in privy-login.js, they are in the lock only ' +
        '(esbuild metafile, 2026-11-04); worst case if that changes: the sign-in window hangs on a malformed ' +
        'percent-encoded input (a DoS of the sign-in window only), no data or code is exposed; ' +
        SIGN_IN_DECIDED,
      advisories: Object.freeze({
        'GHSA-qr28-fpjm-wq7f': 'HIGH, CWE-400/407: denial of service via quadratic replacement of percent-encoded runs'
      })
    })
  })
})

// The accepted risks of the optional ACP CLI's lock (owner decision 2026-11-03/04): one entry per finding, each with
// its own advisory, matched by name@version and id (a GHSA id, or npm's own id when the advisory has no GHSA; a re-keyed
// npm synthetic id also matches when every high advisory in its chain is waived here). The `until` version forces the
// next release to re-decide them (the gate refuses an expired waiver).
const ACP_CLI_UNTIL =
  'v0.0.8: re-decided each release; removed when a compatible fix exists (backlog: move the ACP CLI to acp-node-v2, ' +
  'which itself still needs zod 3 through @account-kit/infra)'
const ACP_CLI_WORST =
  'only the optional ACP CLI is affected (installed from this lock only when the user adds it); in the module graph ' +
  'of the CLI, zod parses local configuration objects and the modules that import it build no array schema ' +
  '(checked 2026-11-04); worst case: the ACP CLI process runs out of memory or stalls, no data or code is exposed; ' +
  'accepted by the owner 2026-11-03/04, re-decided 2026-11-05 for v0.0.6 by the security review; removed when a ' +
  'compatible fix exists; ' +
  're-reviewed 2026-11-10 for v0.0.7: still no compatible fix (zod 3.25.76 is the last 3.x; the newest ' +
  '@virtuals-protocol/acp-cli 1.0.40 needs acp-node ^0.3.0-beta.40 and acp-node-v2 ^0.1.15, both through ' +
  '@account-kit/infra 4.88.5, which needs zod ^3.22.4); acp-cli-lock is unchanged since 2026-11-01 (sha256 dc5a9c6b), ' +
  'and the install still runs only on the user\'s gesture (iclone:acp-tools:install, gestureOk)'
// npm's own id for the meta-advisory it writes on acp-node (no GHSA: no acp-node release is outside the vulnerable
// range). npm derives that id from whichever vulnerable dependency it resolves first (@aa-sdk/core or
// @account-kit/infra, both only through zod), so the same lock gives one of two ids from run to run (v0.0.5,
// work/v005rel-acpgate/today/REKEY_CHECK.md). ACP_LOCKS therefore judge with `matchSynthetic` (see judge()): a
// re-keyed npm id on this same name@version is waived only when its whole chain bottoms out in waived GHSAs.
export const ACP_NODE_NPM_ADVISORY =
  'npm-1txMmhaogPxbj7reguNwwkMchCH+SRUpDXCtKakoRl5f4mKoKdab1Hvm+oz6p3pLhTTHkLAOr+YLrf/ylFhtIA=='

/**
 * The optional ACP CLI's npm lock (G-42, v0.0.5): by folder from the repo root, with its own waivers (same rules as
 * WAIVED: tied, stale, expired, severity). apps/desktop/acp-cli-lock ships as the acp-pin extraResources entry
 * (apps/desktop/package.json), and the app installs the CLI from it at first use (electron/iclone-acp-tools/), only
 * when the user adds the ACP CLI: every non-dev package of that lock is what the app installs.
 */
export const ACP_LOCKS = Object.freeze({
  'apps/desktop/acp-cli-lock': Object.freeze({
    'zod@3.25.76': Object.freeze({
      until: ACP_CLI_UNTIL,
      severity: 'high',
      reason:
        'no compatible fix: GHSA-mrhx-c7xc-m3w5 is fixed only in zod 4.6.6, no 3.x release has it, and the ACP ' +
        "CLI's dependencies require zod ^3 (@aa-sdk/core, @account-kit/infra, @alchemy/common, abitype); " +
        ACP_CLI_WORST,
      advisories: Object.freeze({
        'GHSA-mrhx-c7xc-m3w5': 'HIGH, CWE-770: memory exhaustion validating oversized constrained collections'
      })
    }),
    '@virtuals-protocol/acp-node@0.3.0-beta-subscription.2': Object.freeze({
      until: ACP_CLI_UNTIL,
      severity: 'high',
      reason:
        'no compatible fix: an effect of zod 3 (GHSA-mrhx-c7xc-m3w5) through @account-kit/infra and @aa-sdk/core; ' +
        'npm writes its own advisory on acp-node because no acp-node release is outside the vulnerable range ' +
        '(the package is deprecated for acp-node-v2); ' +
        ACP_CLI_WORST,
      advisories: Object.freeze({
        [ACP_NODE_NPM_ADVISORY]:
          'HIGH, CWE-770 (npm meta-advisory, no GHSA): depends on vulnerable versions of @account-kit/infra or ' +
          '@aa-sdk/core (npm names whichever it resolves first; both only through zod GHSA-mrhx-c7xc-m3w5)'
      })
    })
  })
})

/** Extra `npm audit` arguments for a sub-lock: judge the lock itself (its folder has no node_modules in the repo). */
export const SUB_LOCK_AUDIT_ARGS = Object.freeze(['--package-lock-only'])

/** Lock node path -> name@version for every package a standalone lock installs without dev dependencies. */
export function lockNodes(lock) {
  const nodes = new Map()

  for (const [path, row] of Object.entries(lock?.packages ?? {})) {
    if (!path || row.dev || row.link) {
      continue
    }

    const name = row.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)

    nodes.set(path, `${name}@${row.version}`)
  }

  return nodes
}

const GHSA_RE = /GHSA(-[23456789cfghjmpqrvwx]{4}){3}/

/** The advisory's stable id: the GHSA id of its URL, else npm's numeric source. */
export function advisoryId(via) {
  const ghsa = String(via.url ?? '').match(GHSA_RE)

  return ghsa ? ghsa[0] : `npm-${via.source}`
}

const SYNTHETIC_TITLE = 'Depends on vulnerable versions of '

/**
 * True only for the shape npm gives its OWN "depends on vulnerable versions" entry: a string (hash) source, no url,
 * and that title. A real advisory has an integer source (and usually a GHSA url), so it is never synthetic here.
 */
export function isNpmSyntheticVia(via) {
  return (
    typeof via?.source === 'string' &&
    !via.url &&
    typeof via.title === 'string' &&
    via.title.startsWith(SYNTHETIC_TITLE)
  )
}

/** True for a waiver key that names an npm synthetic id: `npm-<hash>` (never a GHSA, never `npm-<integer>`). */
export function isSyntheticAdvisory(advisory) {
  return advisory.startsWith('npm-') && !GHSA_RE.test(advisory) && !/^npm-\d+$/.test(advisory)
}

/**
 * Every advisory id of a FAILING severity (high/critical: the only ones the gate judges anywhere) reachable through a
 * vulnerability's `via` chain (package-name strings followed into report.vulnerabilities; objects give their id),
 * excluding npm's own synthetic entries. Lower-severity advisories in the chain are ignored exactly as the gate ignores
 * them on every node. Returns null, so the caller refuses the match, when the chain cannot be followed (a named package
 * missing from the report) or reaches a high/critical advisory that is neither a GHSA nor npm-synthetic.
 */
export function chainAdvisories(report, name, seen = new Set()) {
  if (seen.has(name)) {
    return new Set()
  }

  seen.add(name)

  const all = report.vulnerabilities ?? {}
  const vuln = Object.hasOwn(all, name) ? all[name] : null

  if (!vuln || typeof vuln !== 'object') {
    return null
  }

  const out = new Set()

  for (const via of vuln.via ?? []) {
    if (typeof via === 'string') {
      const sub = chainAdvisories(report, via, seen)

      if (sub === null) {
        return null
      }

      for (const advisory of sub) {
        out.add(advisory)
      }
    } else if (typeof via === 'object' && via && FAILING_SEVERITIES.includes(via.severity)) {
      if (isNpmSyntheticVia(via)) {
        continue
      }

      const advisory = advisoryId(via)

      if (!GHSA_RE.test(advisory)) {
        return null
      }

      out.add(advisory)
    }
  }

  return out
}

/** Lock node path -> name@version, for every node of the shipped closure. */
export function shippedNodes(lock) {
  const nodes = new Map()

  for (const [id, row] of computeClosure(lock, desktopRoots(lock))) {
    for (const path of row.paths) {
      nodes.set(path, id)
    }
  }

  return nodes
}

/**
 * Why npm gave no report: the first non-empty of error.summary, error.detail, message, error.code. npm 11 answers an
 * unreachable registry with `summary: ""` and `detail: ""` and puts the reason in `message` (measured), so a `??`
 * chain stops at the empty summary and says nothing.
 */
export function reportReason(report) {
  const candidates = [report?.error?.summary, report?.error?.detail, report?.message, report?.error?.code]
  const found = candidates.map(value => (typeof value === 'string' ? value.trim() : '')).find(Boolean)

  return found ? found.split('\n')[0] : 'not an npm audit --json report (auditReportVersion 2)'
}

/** Throws unless `report` is an `npm audit --json` report (auditReportVersion 2). */
export function assertReport(report) {
  if (!report || report.auditReportVersion !== 2 || typeof report.vulnerabilities !== 'object') {
    throw new Error(`cannot judge: ${reportReason(report)}`)
  }
}

/** The report with the record of how npm audited it: the `npm` arguments, under `audited`. */
export function stampAudited(report, args) {
  return { ...report, audited: { args: [...args] } }
}

/** The dependency classes `--omit` leaves out of an audit (`--omit=dev`, `--omit dev`, `--omit=dev,optional`). */
export function omittedClasses(args) {
  const omitted = new Set()

  for (const [index, arg] of args.entries()) {
    const value = arg.startsWith('--omit=') ? arg.slice('--omit='.length) : arg === '--omit' ? args[index + 1] : null

    for (const name of String(value ?? '').split(',')) {
      if (name.trim()) {
        omitted.add(name.trim())
      }
    }
  }

  return omitted
}

// The lock row flags that put a package in each `--omit` class (`devOptional`: reachable only through dev or optional).
const CLASS_FLAGS = Object.freeze({
  dev: ['dev', 'devOptional'],
  optional: ['optional', 'devOptional'],
  peer: ['peer']
})

/**
 * Throws unless the report says it audited every shipped node: one without an `audited.args` stamp cannot say what
 * it covered, and one audited with `--omit=<class>` never saw the shipped packages of that class (electron is a
 * devDependency the app ships: an `--omit=dev` report is silent about it whatever its advisories).
 */
export function assertReportScope(report, lock, nodes) {
  const args = report?.audited?.args

  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) {
    throw new Error(
      'cannot judge: the report does not say how npm audited it (no "audited.args"): npm lists only the vulnerable ' +
        'packages, so a full report and an --omit=dev one look alike; save one with node scripts/audit-gate.mjs --save <file>'
    )
  }

  const omitted = [...omittedClasses(args)]
  const packages = lock?.packages ?? {}
  const unseen = [...nodes]
    .filter(([path]) => omitted.some(name => (CLASS_FLAGS[name] ?? [name]).some(flag => packages[path]?.[flag])))
    .map(([, id]) => id)
  const ids = [...new Set(unseen)].sort()

  if (ids.length > 0) {
    throw new Error(
      `cannot judge: the report was audited with --omit=${omitted.join(',')}, which leaves out ${ids.length} shipped ` +
        `package(s) (${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''}): run npm audit --json without --omit`
    )
  }
}

/**
 * Judge a report against the lock's shipped set. Returns
 *   failing  [{ id, advisory, severity, title, node }]  high/critical on a shipped node, not waived
 *   waived   [{ ..., reason }]                           the same, named by WAIVED
 *   stale    [{ id, advisory }]                          waivers that match no finding
 *   untied   [id]                                        waivers with no versioned `until` (refused: findings fail)
 *   expired  [{ id, until }]                             waivers whose `until` version <= appVersion (refused too)
 *   mismatched [{ id, advisory, accepted, severity }]    a waived advisory whose severity is not the one the waiver
 *                                                       accepted (`severity`, e.g. 'high'; re-rated, or none recorded):
 *                                                       refused, red, never silently waived at another rating
 *   outside  [name]                                      packages with a high/critical advisory that do not ship
 *   shipped  number                                      packages in the shipped set
 */
export function judge(
  report,
  lock,
  waived = WAIVED,
  appVersion = APP_VERSION,
  nodesOf = shippedNodes,
  { matchSynthetic = false } = {}
) {
  const current = parseVersion(appVersion)

  if (!current) {
    throw new Error(`cannot judge: the app version ${JSON.stringify(appVersion)} is not x.y.z`)
  }

  assertReport(report)

  const nodes = nodesOf(lock)

  assertReportScope(report, lock, nodes)

  const findings = []
  const outside = new Set()

  for (const [name, vuln] of Object.entries(report.vulnerabilities)) {
    const advisories = (vuln.via ?? []).filter(
      via => typeof via === 'object' && FAILING_SEVERITIES.includes(via.severity)
    )

    if (advisories.length === 0) {
      continue
    }

    const shippedHere = (vuln.nodes ?? []).filter(node => nodes.has(node))

    if (shippedHere.length === 0) {
      outside.add(name)

      continue
    }

    for (const node of shippedHere) {
      for (const via of advisories) {
        findings.push({
          id: nodes.get(node),
          advisory: advisoryId(via),
          severity: via.severity,
          title: via.title,
          node,
          name,
          synthetic: isNpmSyntheticVia(via)
        })
      }
    }
  }

  // A waiver must say what removes it and by which version. One whose `until` names no version is refused outright:
  // it waives nothing (its findings fail) and is reported UNTIED, never STALE. One whose version the app being released
  // has reached is refused the same way and reported EXPIRED: the version that was to remove it is this one.
  const untied = Object.entries(waived)
    .filter(([, entry]) => !isTied(entry))
    .map(([id]) => id)
  const expired = Object.entries(waived)
    .filter(([, entry]) => isTied(entry) && compareVersions(current, untilVersion(entry.until)) >= 0)
    .map(([id, entry]) => ({ id, until: entry.until }))
  const refused = new Set([...untied, ...expired.map(e => e.id)])
  const tied = Object.fromEntries(Object.entries(waived).filter(([id]) => !refused.has(id)))

  const used = new Set()
  const failing = []
  const accepted = []
  const mismatched = []

  // The GHSAs this lock waives (tied entries only: an expired or untied waiver waives nothing, so it can tie nothing),
  // for the synthetic-id match below.
  const waivedGhsa = new Set(
    Object.values(tied).flatMap(entry => Object.keys(entry.advisories ?? {}).filter(a => GHSA_RE.test(a)))
  )

  // matchSynthetic (ACP_LOCKS only): npm's synthetic id for a "depends on vulnerable versions" entry changes from run to
  // run. Such a finding (npm's own shape: a hash source, no url, that title) is waived by the synthetic waiver of the
  // SAME name@version when the severity is the same and every HIGH/CRITICAL advisory its via chain reaches is a GHSA
  // this lock already waives (lower ones are ignored, as everywhere in the gate). An unfollowable chain, one reaching no
  // GHSA, or one reaching a high/critical advisory that is not a GHSA is never matched. Each synthetic waiver ties at
  // most ONE synthetic finding (npm writes one per package); the waiver it matches is used, not STALE.
  const syntheticUsed = new Map()
  const syntheticMatch = finding => {
    if (!matchSynthetic || !finding.synthetic) {
      return null
    }

    const entry = tied[finding.id]
    const key = Object.keys(entry?.advisories ?? {}).find(isSyntheticAdvisory)

    if (!key || entry.severity !== finding.severity) {
      return null
    }

    const prior = syntheticUsed.get(`${finding.id} ${key}`)

    if (prior !== undefined && prior !== finding.advisory) {
      return null
    }

    const chain = chainAdvisories(report, finding.name)

    if (!chain || chain.size === 0 || ![...chain].every(a => waivedGhsa.has(a))) {
      return null
    }

    syntheticUsed.set(`${finding.id} ${key}`, finding.advisory)

    return key
  }

  for (const finding of findings) {
    const entry = tied[finding.id]
    const why = entry?.advisories?.[finding.advisory]
    const synthetic = why ? null : syntheticMatch(finding)

    if (synthetic) {
      used.add(`${finding.id} ${synthetic}`)
      accepted.push({
        ...finding,
        reason:
          `${entry.advisories[synthetic]} (npm re-keyed its synthetic id; every high/critical advisory in its chain ` +
          'is a GHSA waived in this lock)'
      })
    } else if (why && entry.severity !== finding.severity) {
      used.add(`${finding.id} ${finding.advisory}`)
      mismatched.push({
        id: finding.id,
        advisory: finding.advisory,
        accepted: entry.severity ?? 'none',
        severity: finding.severity
      })
    } else if (why) {
      used.add(`${finding.id} ${finding.advisory}`)
      accepted.push({ ...finding, reason: why })
    } else {
      failing.push(finding)
    }
  }

  const stale = Object.entries(tied).flatMap(([id, entry]) =>
    Object.keys(entry.advisories ?? {})
      .filter(advisory => !used.has(`${id} ${advisory}`))
      .map(advisory => ({ id, advisory }))
  )

  return {
    failing,
    waived: accepted,
    stale,
    untied,
    expired,
    mismatched,
    appVersion: current.join('.'),
    outside: [...outside].sort(),
    shipped: new Set(nodes.values()).size
  }
}

/** `x.y.z` (an optional leading `v`) -> [x, y, z], else null. */
export function parseVersion(text) {
  const match = String(text ?? '').match(/^v?(\d+)\.(\d+)\.(\d+)$/)

  return match ? match.slice(1).map(Number) : null
}

/** Numeric x.y.z order: negative, 0 or positive. */
export function compareVersions(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/** The version a waiver's `until` names, e.g. "fixed by the next Electron (v0.0.5)" -> [0, 0, 5]; null when it names none or several. */
export function untilVersion(until) {
  const found = [...String(until ?? '').matchAll(/\bv(\d+\.\d+\.\d+)\b/g)]

  return found.length === 1 ? parseVersion(found[0][1]) : null
}

/** A waiver is tied when its `until` names what removes it and exactly one version (vX.Y.Z) that drops it. */
export function isTied(entry) {
  return typeof entry?.until === 'string' && untilVersion(entry.until) !== null
}

/** The report lines and the exit code for a verdict. */
export function render(verdict, waived = WAIVED) {
  const lines = []

  for (const f of verdict.failing) {
    lines.push(`FAIL ${f.id} ${f.severity} ${f.advisory} ${f.title} (${f.node})`)
  }

  for (const s of verdict.stale) {
    lines.push(`STALE waiver ${s.id} ${s.advisory}: matches no finding in this report; drop it from WAIVED`)
  }

  const untied = verdict.untied ?? []

  for (const id of untied) {
    lines.push(
      `UNTIED waiver ${id}: names no versioned \`until\` (what removes it, e.g. "fixed by the next Electron (v0.0.5)"); refused`
    )
  }

  const expired = verdict.expired ?? []

  for (const { id, until } of expired) {
    lines.push(`EXPIRED waiver ${id}: until ${until}, and this is v${verdict.appVersion ?? APP_VERSION}; refused`)
  }

  const mismatched = verdict.mismatched ?? []

  for (const m of mismatched) {
    lines.push(
      `SEVERITY waiver ${m.id} ${m.advisory}: accepted at ${m.accepted}, the report rates it ${m.severity}; refused (re-decide it)`
    )
  }

  const byPackage = new Map()

  for (const w of verdict.waived) {
    byPackage.set(w.id, [...(byPackage.get(w.id) ?? []), w])
  }

  for (const [id, list] of byPackage) {
    lines.push(
      `WAIVED ${id} until ${waived[id].until}: ${list.length} advisor${list.length === 1 ? 'y' : 'ies'} — ` +
        waived[id].reason
    )

    for (const w of list) {
      lines.push(`  ${w.severity} ${w.advisory}: ${w.reason}`)
    }
  }

  const red =
    verdict.failing.length > 0 ||
    verdict.stale.length > 0 ||
    untied.length > 0 ||
    expired.length > 0 ||
    mismatched.length > 0

  lines.push(
    `[audit-gate] ${red ? 'RED' : 'GREEN'}: ${verdict.shipped} shipped packages; critical/high on them: ` +
      `${verdict.failing.length} failing, ${verdict.waived.length} waived, ${verdict.stale.length} stale waiver(s), ${untied.length} untied waiver(s), ` +
      `${expired.length} expired waiver(s), ${mismatched.length} severity mismatch(es); ` +
      `not shipped, not judged: ${verdict.outside.length ? verdict.outside.join(', ') : 'none'}`
  )

  return { lines, code: red ? 1 : 0 }
}

/**
 * The command line wins over the environment and every .npmrc (measured): with offline=true anywhere, a plain
 * `npm audit --json` asks nobody and prints a well-formed report with 0 vulnerabilities and exit 0.
 */
// --include=<class> keeps every class in the audit whatever `omit` an .npmrc or the environment sets (the command line
// wins; --include beats --omit in npm): the shipped set has dev (electron) and optional packages.
export const AUDIT_ARGS = Object.freeze([
  'audit',
  '--json',
  '--offline=false',
  '--loglevel=http',
  '--include=dev',
  '--include=optional',
  '--include=peer'
])

// npm's own http log line for the audit request: the bulk advisory endpoint, or the quick-audit one npm falls back to.
const REGISTRY_ANSWERED = /^npm http fetch POST 200 (\S+\/-\/npm\/v1\/security\/(?:advisories\/bulk|audits\/quick)) /gm

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

/**
 * The registry whose advisories count (review R1-A minor 6): the project's own .npmrc `registry=` when it pins one,
 * else npm's public registry. Never the user's or the environment's: a mirror that answers 200 with an empty list
 * would otherwise make the gate green.
 */
export function expectedRegistry(repo = REPO) {
  let registry = DEFAULT_REGISTRY

  try {
    for (const line of readFileSync(join(repo, '.npmrc'), 'utf8').split('\n')) {
      const pinned = line.match(/^\s*registry\s*=\s*(\S+)\s*$/)

      if (pinned) {
        registry = pinned[1]
      }
    }
  } catch {
    // No project .npmrc: the public registry.
  }

  return new URL(registry.endsWith('/') ? registry : `${registry}/`).href
}

/** Every audit endpoint npm's http log shows answering 200, in order. */
export function auditAnswers(httpLog) {
  return [...String(httpLog ?? '').matchAll(REGISTRY_ANSWERED)].map(match => match[1])
}

/** The audit endpoint under `registry` that npm's http log shows answering 200, or null. */
export function registryEvidence(httpLog, registry = DEFAULT_REGISTRY) {
  return (
    auditAnswers(httpLog).find(url => {
      try {
        return new URL(url).href.startsWith(registry)
      } catch {
        return false
      }
    }) ?? null
  )
}

/**
 * Run the audit and prove the registry answered it. The report cannot prove that by itself: an offline npm writes the
 * same auditReportVersion 2 shape, dependency counts included, as a clean tree would, with 0 vulnerabilities. The
 * witness is npm's http log (stderr at --loglevel=http): "npm http fetch POST 200 <registry>/-/npm/v1/security/
 * advisories/bulk". No such line, no verdict: once WAIVED is empty, a report nobody answered would otherwise be green.
 * If npm changes that line the gate says "cannot judge", never green. The answer must come from expectedRegistry():
 * the command line names it (it beats the environment and every .npmrc), and an answer from any other host is refused.
 */
export function runAudit(cwd, spawn = spawnSync, registry = expectedRegistry(cwd), extra = []) {
  const args = [...AUDIT_ARGS, ...extra, `--registry=${registry}`]
  const run = spawn('npm', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1 << 28
  })

  if (run.error) {
    throw new Error(`cannot judge: npm audit did not run (${run.error.message})`)
  }

  let report

  try {
    report = JSON.parse(run.stdout)
  } catch {
    throw new Error(
      `cannot judge: npm audit printed no JSON (exit ${run.status}): ${String(run.stderr).trim().slice(-300)}`
    )
  }

  const endpoint = registryEvidence(run.stderr, registry)
  const elsewhere = auditAnswers(run.stderr).filter(url => url !== endpoint)

  if (!endpoint && elsewhere.length > 0) {
    throw new Error(
      `cannot judge: the audit was answered by ${elsewhere.join(', ')}, not by the expected registry ${registry}`
    )
  }

  if (!endpoint) {
    const why =
      report?.auditReportVersion === 2
        ? 'npm wrote a report without asking the registry (offline?)'
        : reportReason(report)

    throw new Error(
      `cannot judge: no evidence the registry answered the audit (no "POST 200 …/-/npm/v1/security/advisories/bulk" ` +
        `in npm's http log): ${why}`
    )
  }

  return { report: stampAudited(report, args), endpoint }
}

/**
 * Every lock the gate judges: the repo's (the desktop closure, WAIVED) first, then each SUB_LOCKS folder, then each
 * APP_LOCKS folder, then each ACP_LOCKS folder (every non-dev package of its own lock, its own waivers, audited from
 * the lock with the repo's expected registry).
 */
export function gateTargets(repo = REPO) {
  return [
    { label: null, dir: repo, waived: WAIVED, nodesOf: shippedNodes, extra: [] },
    ...Object.entries({ ...SUB_LOCKS, ...APP_LOCKS, ...ACP_LOCKS }).map(([dir, waived]) => ({
      label: dir,
      dir: join(repo, dir),
      waived,
      nodesOf: lockNodes,
      extra: SUB_LOCK_AUDIT_ARGS,
      matchSynthetic: Object.hasOwn(ACP_LOCKS, dir)
    }))
  ]
}

/** Judge one target online: its audit, its lock, its waivers. Returns the report lines and the exit code. */
export function judgeTarget(target, { spawn = spawnSync, registry = expectedRegistry(REPO) } = {}) {
  const lock = JSON.parse(readFileSync(join(target.dir, 'package-lock.json'), 'utf8'))
  const online = runAudit(target.dir, spawn, registry, target.extra)
  const { lines, code } = render(
    judge(online.report, lock, target.waived, APP_VERSION, target.nodesOf, { matchSynthetic: target.matchSynthetic }),
    target.waived
  )
  const head = target.label ? [`[audit-gate] lock ${target.label}:`] : []

  return { lines: [...head, `registry: ${online.endpoint} answered 200`, ...lines], code, report: online.report }
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: { report: { type: 'string' }, lock: { type: 'string' }, save: { type: 'string' } }
  })

  try {
    if (values.report) {
      const lockFile = values.lock ? resolve(values.lock) : join(REPO, 'package-lock.json')
      const target = gateTargets().find(t => resolve(t.dir) === dirname(lockFile)) ?? gateTargets()[0]
      const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
      const report = JSON.parse(readFileSync(resolve(values.report), 'utf8'))
      const { lines, code } = render(
        judge(report, lock, target.waived, APP_VERSION, target.nodesOf, { matchSynthetic: target.matchSynthetic }),
        target.waived
      )

      console.log([`report: ${values.report} (saved)`, ...lines].join('\n'))
      process.exitCode = code
    } else {
      // Every lock is judged even after a red one, so one run names every finding; any red makes the gate red.
      const verdicts = gateTargets().map(target => judgeTarget(target))

      if (values.save) {
        // The repo lock's report, stamped with how it was audited, for a later --report.
        writeFileSync(resolve(values.save), `${JSON.stringify(verdicts[0].report, null, 2)}\n`)
        verdicts[0].lines.push(`[audit-gate] report saved: ${values.save}`)
      }

      console.log(verdicts.flatMap(v => v.lines).join('\n'))
      process.exitCode = Math.max(...verdicts.map(v => v.code))
    }
  } catch (error) {
    console.error(`[audit-gate] ${error.message}`)
    process.exitCode = 2
  }
}
