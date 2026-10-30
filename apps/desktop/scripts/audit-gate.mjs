#!/usr/bin/env node
// audit-gate.mjs — G-42: no critical or high npm advisory in a package the app ships.
//
//   node scripts/audit-gate.mjs                     run `npm audit --json` at the repo root (network) and judge it
//                                                   only if npm's http log shows the registry answered (see runAudit)
//   node scripts/audit-gate.mjs --report <file>     judge a saved `npm audit --json` report instead (offline)
//       [--lock <package-lock.json>]               the lockfile whose shipped set is judged (default: the repo's;
//                                                   a SUB_LOCKS lock is judged by its own rules and waivers)
//
// The runtime's other npm locks (SUB_LOCKS: the WhatsApp bridge and the Photon sidecar, v0.0.4 review M2) are judged
// too, each on its own: `npm audit --json --package-lock-only` in its folder (the lock is what `npm ci` installs on
// the user's machine), every non-dev package of the lock ships, the same severities fail, and each lock has its own
// waiver list under the same rules (tied, stale, expired).
//
// What ships is the set THIRD_PARTY_NOTICES.md lists: the closure third-party-closure.mjs computes from the lockfile
// (desktopRoots + computeClosure), the desktop workspace's runtime dependencies plus Electron. Electron is a
// devDependency of the workspace (electron-builder wants it there) but its frameworks are what the app runs in, so
// `npm audit --omit=dev` never sees it: the gate reads the FULL report (a saved one must be `npm audit --json` without
// --omit) and keeps only the lock nodes of that closure. Build tools, test runners and the other workspaces (vite,
// ui-tui, web, node-gyp) are outside it and are reported, never judged.
//
// A finding is one advisory (a `via` object of the report) of severity high or critical on a shipped node. Every
// finding fails unless WAIVED names that exact name@version and advisory id; a waiver that matches no finding fails
// too (stale: drop it), so the list can only shrink to what is still true, a waiver that does not name what removes
// it and by which version (`until`, e.g. "G-44 (v0.0.5)") is refused (untied), and a waiver whose `until` version the
// app has reached is refused (expired). Exit 0 green, 1 red, 2 cannot judge.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
  'electron@40.10.2': {
    until: 'G-44 (v0.0.5)',
    reason:
      'no Electron 40 release fixes these (the 40 line ends at 40.10.6); the fix is an Electron major upgrade, ' +
      'which moves the notices frameworks section, the native add-ons and the packaging (G-42 report, global plan). ' +
      'Their preconditions exist in the app: webviewTag (session-windows.ts), sandboxed iframes ' +
      '(preview-artifact.tsx), a window-open handler (main/windows.ts), a privileged protocol (media-protocol.ts); ' +
      'the certificate one applies to all TLS traffic; removed by G-44 (Electron >= 42.11.16, v0.0.5)',
    advisories: {
      'GHSA-9f4c-93c8-jc8g': 'sandboxed iframe can bypass allow-popups (fixed in 41.10.3)',
      'GHSA-hq2x-r82h-9wj4': 'popups from sandboxed iframes drop the inherited sandbox (fixed in 41.10.4)',
      'GHSA-gr2m-v5gq-v685': 'windows opened from a sandboxed top-level document do not inherit it (fixed in 41.10.6)',
      'GHSA-j84w-jfhq-vhvj': 'file and http protocol handlers allow cross-origin reads (fixed in 41.10.6)',
      'GHSA-9qh4-3jw8-366w': '<webview> can enable Node.js integration in Web Workers (fixed in 41.10.6)',
      'GHSA-jr5w-w6x2-84p9': 'mitigation for compromised eMudhra intermediate certificates (fixed in 42.11.16)'
    }
  }
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

/** The advisory's stable id: the GHSA id of its URL, else npm's numeric source. */
export function advisoryId(via) {
  const ghsa = String(via.url ?? '').match(/GHSA(-[23456789cfghjmpqrvwx]{4}){3}/)

  return ghsa ? ghsa[0] : `npm-${via.source}`
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

/**
 * Judge a report against the lock's shipped set. Returns
 *   failing  [{ id, advisory, severity, title, node }]  high/critical on a shipped node, not waived
 *   waived   [{ ..., reason }]                           the same, named by WAIVED
 *   stale    [{ id, advisory }]                          waivers that match no finding
 *   untied   [id]                                        waivers with no versioned `until` (refused: findings fail)
 *   expired  [{ id, until }]                             waivers whose `until` version <= appVersion (refused too)
 *   outside  [name]                                      packages with a high/critical advisory that do not ship
 *   shipped  number                                      packages in the shipped set
 */
export function judge(report, lock, waived = WAIVED, appVersion = APP_VERSION, nodesOf = shippedNodes) {
  const current = parseVersion(appVersion)

  if (!current) {
    throw new Error(`cannot judge: the app version ${JSON.stringify(appVersion)} is not x.y.z`)
  }

  assertReport(report)

  const nodes = nodesOf(lock)
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
          node
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

  for (const finding of findings) {
    const entry = tied[finding.id]
    const why = entry?.advisories?.[finding.advisory]

    if (why) {
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

/** The version a waiver's `until` names, e.g. "G-44 (v0.0.5)" -> [0, 0, 5]; null when it names none or several. */
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
    lines.push(`UNTIED waiver ${id}: names no versioned \`until\` (what removes it, e.g. "G-44 (v0.0.5)"); refused`)
  }

  const expired = verdict.expired ?? []

  for (const { id, until } of expired) {
    lines.push(`EXPIRED waiver ${id}: until ${until}, and this is v${verdict.appVersion ?? APP_VERSION}; refused`)
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

  const red = verdict.failing.length > 0 || verdict.stale.length > 0 || untied.length > 0 || expired.length > 0

  lines.push(
    `[audit-gate] ${red ? 'RED' : 'GREEN'}: ${verdict.shipped} shipped packages; critical/high on them: ` +
      `${verdict.failing.length} failing, ${verdict.waived.length} waived, ${verdict.stale.length} stale waiver(s), ${untied.length} untied waiver(s), ` +
      `${expired.length} expired waiver(s); ` +
      `not shipped, not judged: ${verdict.outside.length ? verdict.outside.join(', ') : 'none'}`
  )

  return { lines, code: red ? 1 : 0 }
}

/**
 * The command line wins over the environment and every .npmrc (measured): with offline=true anywhere, a plain
 * `npm audit --json` asks nobody and prints a well-formed report with 0 vulnerabilities and exit 0.
 */
export const AUDIT_ARGS = Object.freeze(['audit', '--json', '--offline=false', '--loglevel=http'])

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
  const run = spawn('npm', [...AUDIT_ARGS, ...extra, `--registry=${registry}`], {
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

  return { report, endpoint }
}

/**
 * Every lock the gate judges: the repo's (the desktop closure, WAIVED) first, then each SUB_LOCKS folder (every
 * non-dev package of its own lock, its own waivers, audited from the lock with the repo's expected registry).
 */
export function gateTargets(repo = REPO) {
  return [
    { label: null, dir: repo, waived: WAIVED, nodesOf: shippedNodes, extra: [] },
    ...Object.entries(SUB_LOCKS).map(([dir, waived]) => ({
      label: dir,
      dir: join(repo, dir),
      waived,
      nodesOf: lockNodes,
      extra: SUB_LOCK_AUDIT_ARGS
    }))
  ]
}

/** Judge one target online: its audit, its lock, its waivers. Returns the report lines and the exit code. */
export function judgeTarget(target, { spawn = spawnSync, registry = expectedRegistry(REPO) } = {}) {
  const lock = JSON.parse(readFileSync(join(target.dir, 'package-lock.json'), 'utf8'))
  const online = runAudit(target.dir, spawn, registry, target.extra)
  const { lines, code } = render(judge(online.report, lock, target.waived, APP_VERSION, target.nodesOf), target.waived)
  const head = target.label ? [`[audit-gate] lock ${target.label}:`] : []

  return { lines: [...head, `registry: ${online.endpoint} answered 200`, ...lines], code }
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { report: { type: 'string' }, lock: { type: 'string' } } })

  try {
    if (values.report) {
      const lockFile = values.lock ? resolve(values.lock) : join(REPO, 'package-lock.json')
      const target = gateTargets().find(t => resolve(t.dir) === dirname(lockFile)) ?? gateTargets()[0]
      const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
      const report = JSON.parse(readFileSync(resolve(values.report), 'utf8'))
      const { lines, code } = render(judge(report, lock, target.waived, APP_VERSION, target.nodesOf), target.waived)

      console.log([`report: ${values.report} (saved)`, ...lines].join('\n'))
      process.exitCode = code
    } else {
      // Every lock is judged even after a red one, so one run names every finding; any red makes the gate red.
      const verdicts = gateTargets().map(target => judgeTarget(target))

      console.log(verdicts.flatMap(v => v.lines).join('\n'))
      process.exitCode = Math.max(...verdicts.map(v => v.code))
    }
  } catch (error) {
    console.error(`[audit-gate] ${error.message}`)
    process.exitCode = 2
  }
}
