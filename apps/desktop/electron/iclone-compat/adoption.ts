// Adoption engine (contract §3.1, decisions 10 and 14): extract -> classify -> denoise -> cluster -> relevance -> score ->
// digest, plus upstream-day (verify at an upstream rev -> P0 ADP tickets + P4c rows). Reads the APP repo's `upstream`
// objects only, through the one git helper; with `--out` it writes nothing in the repo. Output is byte-stable: no clock,
// every list sorted. CLI:
//   node adoption.ts scan [--full] [--repo <app>] [--out <backlog.json>]
//   node adoption.ts upstream-day --rev <sha> --out <dir> [--repo <app>]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { readJsonFileSync } from '../lib/fs-json'

// electron tsconfig only accepts on type imports. Types still resolve through it.
// @ts-expect-error TS5097: value import with a `.ts` extension, required by Node type stripping
import { repoGit } from './runtime-git.ts'
import type { TicketLink } from './verify.ts'
// @ts-expect-error TS5097: value import with a `.ts` extension, required by Node type stripping
import { verify } from './verify.ts'

type Disposition = 'adopt' | 'watch' | 'ignore'

export interface Commit {
  sha: string
  at: number
  parents: string[]
  subject: string
  files: string[]
}

interface Feature {
  id: string
  state: 'pristine' | 'diverged' | 'replaced' | 'absent'
  paths: string[]
}

interface PolicyRule {
  paths?: string[]
  // 'all': every touched file must match (noise rules); 'any' (default): one file is enough.
  match?: 'all' | 'any'
  subject?: string
  disposition: Disposition
  term?: string
}

interface Policy {
  version: number
  rules: PolicyRule[]
  overrides?: PolicyRule[]
}

interface LedgerLine {
  v: number
  at: string
  by: string
  cs: string
  upstream: string[]
  patch_ids?: string[]
  decision: string
  lane: 'compat' | 'adopt'
  ticket?: string
  root?: string
}

interface InboxRow {
  week: string
  sha: string
  at: string
  subject: string
  score: number
  terms: string[]
  disposition: Disposition
  cluster: string | null
}

const SCOPE = ['apps/desktop', 'apps/shared']
const INBOX_PER_WEEK = 12
const CLUSTER_WINDOW_S = 72 * 3600
// guard.ts's OPENRPC_PATH: this module runs under Node type stripping, and guard.ts's imports have no extensions.
const OPENRPC_PATH = 'apps/shared/src/gateway-contract.openrpc.json'

// Ordered, first match wins, ends in the catch-all. Overrides run after: security is raised, telemetry is lowered.
const DEFAULT_POLICY: Policy = {
  version: 2,
  rules: [
    { paths: ['**/*.md', '**/docs/**', '**/*.txt'], match: 'all', disposition: 'ignore', term: 'docs' },
    {
      paths: ['**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock'],
      match: 'all',
      disposition: 'ignore',
      term: 'lockfile'
    },
    { paths: ['apps/shared/src/gateway-contract*'], disposition: 'watch', term: 'contract' },
    { paths: ['apps/desktop/electron/**', 'apps/desktop/src/**', 'apps/shared/**'], disposition: 'watch' },
    { paths: ['**'], disposition: 'watch' }
  ],
  overrides: [
    { subject: '\\b(security|secur|cve|xss|csrf|vuln|sanitiz|inject|exploit)', disposition: 'adopt', term: 'security' },
    { subject: '\\b(telemetry|analytics|tracking|posthog|sentry)\\b', disposition: 'watch', term: 'privacy' }
  ]
}

const TEST_FILE = /(^|\/)(__tests__|__mocks__|tests?|e2e|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.snap$/
const LOCALE_FILE = /(^|\/)(locales?|i18n|translations)\//
const FMT_SUBJECT = /^(style|fmt|format|lint)(\([^)]*\))?!?:|^(run |apply )?(prettier|eslint --fix)\b/i
const REVERT_SUBJECT = /^Revert "(.+)"$/

export function globToRegExp(glob: string): RegExp {
  let rx = ''

  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]

    if (ch === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      rx += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (ch === '*') {
      rx += '[^/]*'
    } else if (ch === '?') {
      rx += '[^/]'
    } else {
      rx += /[\\^$.|+()[\]{}]/.test(ch) ? `\\${ch}` : ch
    }
  }

  return new RegExp(`^${rx}$`)
}

const globCache = new Map<string, RegExp>()

function matchesGlob(file: string, glob: string): boolean {
  let rx = globCache.get(glob)

  if (!rx) {
    rx = globToRegExp(glob)
    globCache.set(glob, rx)
  }

  return rx.test(file)
}

export function parseLog(text: string): Commit[] {
  const out: Commit[] = []

  for (const chunk of text.split('\x1e')) {
    if (!chunk.trim()) {
      continue
    }

    const [head, ...rest] = chunk.split('\n')
    const [sha, at, parents, subject] = head.split('\x1f')
    const files = rest.map(f => f.trim()).filter(Boolean)
    out.push({ sha, at: Number(at), parents: parents ? parents.split(' ') : [], subject: subject ?? '', files })
  }

  return out
}

export function isoWeek(epochS: number): string {
  const d = new Date(epochS * 1000)
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dow = day.getUTCDay() || 7
  day.setUTCDate(day.getUTCDate() + 4 - dow)
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((day.getTime() - yearStart) / 86400000 + 1) / 7)

  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// Noise never reaches a human: tests-only, locale-only, formatting, merges, revert pairs inside the range, duplicates
// (same subject and file set: a cherry-pick; exact patch-ids are computed at import, for decided commits only).
export function noiseOf(commits: Commit[]): Map<string, string> {
  const noise = new Map<string, string>()
  const bySubject = new Map<string, string>()
  const seen = new Set<string>()

  for (const c of commits) {
    bySubject.set(c.subject, c.sha)
  }

  for (const c of [...commits].sort((a, b) => a.at - b.at || (a.sha < b.sha ? -1 : 1))) {
    const reverted = REVERT_SUBJECT.exec(c.subject)?.[1]
    const signature = `${c.subject}\x00${[...c.files].sort().join('\x00')}`

    if (c.parents.length > 1) {
      noise.set(c.sha, 'merge')
    } else if (reverted && bySubject.has(reverted)) {
      noise.set(c.sha, 'revert')
      noise.set(bySubject.get(reverted) as string, 'reverted')
    } else if (c.files.length > 0 && c.files.every(f => TEST_FILE.test(f))) {
      noise.set(c.sha, 'tests')
    } else if (c.files.length > 0 && c.files.every(f => LOCALE_FILE.test(f))) {
      noise.set(c.sha, 'locale')
    } else if (FMT_SUBJECT.test(c.subject)) {
      noise.set(c.sha, 'fmt')
    } else if (seen.has(signature) && !noise.has(c.sha)) {
      noise.set(c.sha, 'duplicate')
    }

    seen.add(signature)
  }

  return noise
}

// Commits that touch the same non-hub file share a cluster while the whole cluster spans <= 72 h. Hub files (touched by
// > 1 % of the range, at least 10 commits) would glue everything together, so they never link.
export function clusterOf(commits: Commit[]): Map<string, { id: string; size: number }> {
  const parent = new Map<string, string>()

  const find = (x: string): string => {
    let r = x

    while (parent.get(r) !== r) {
      r = parent.get(r) as string
    }

    parent.set(x, r)

    return r
  }

  const sorted = [...commits].sort((a, b) => a.at - b.at || (a.sha < b.sha ? -1 : 1))
  const order = new Map(sorted.map((c, i) => [c.sha, i]))
  const span = new Map<string, [number, number]>()
  const touches = new Map<string, Commit[]>()

  for (const c of sorted) {
    parent.set(c.sha, c.sha)
    span.set(c.sha, [c.at, c.at])

    for (const f of c.files) {
      const list = touches.get(f)

      if (list) {
        list.push(c)
      } else {
        touches.set(f, [c])
      }
    }
  }

  const hub = Math.max(10, Math.ceil(commits.length * 0.01))

  for (const list of touches.values()) {
    if (list.length > hub) {
      continue
    }

    for (let i = 1; i < list.length; i++) {
      const a = find(list[i - 1].sha)
      const b = find(list[i].sha)
      const [sa, ea] = span.get(a) as [number, number]
      const [sb, eb] = span.get(b) as [number, number]

      if (a !== b && Math.max(ea, eb) - Math.min(sa, sb) <= CLUSTER_WINDOW_S) {
        // The oldest commit names the cluster, so ids are stable as the range grows.
        const [root, child] = (order.get(a) ?? 0) < (order.get(b) ?? 0) ? [a, b] : [b, a]
        parent.set(child, root)
        span.set(root, [Math.min(sa, sb), Math.max(ea, eb)])
      }
    }
  }

  const size = new Map<string, number>()
  sorted.forEach(c => size.set(find(c.sha), (size.get(find(c.sha)) ?? 0) + 1))
  const out = new Map<string, { id: string; size: number }>()
  sorted.forEach(c => out.set(c.sha, { id: `CL-${find(c.sha).slice(0, 10)}`, size: size.get(find(c.sha)) ?? 1 }))

  return out
}

const subjectCache = new Map<string, RegExp>()

function ruleMatches(rule: PolicyRule, c: Commit): boolean {
  let rx = rule.subject ? subjectCache.get(rule.subject) : undefined

  if (rule.subject && !rx) {
    rx = new RegExp(rule.subject, 'i')
    subjectCache.set(rule.subject, rx)
  }

  if (rx && !rx.test(c.subject)) {
    return false
  }

  if (!rule.paths) {
    return true
  }

  const hit = (f: string) => rule.paths?.some(g => matchesGlob(f, g)) ?? false

  return rule.match === 'all' ? c.files.length > 0 && c.files.every(hit) : c.files.some(hit)
}

function ledgerDecision(decision: string): Disposition {
  if (decision === 'adopt' || decision === 'implemented') {
    return 'adopt'
  }

  return decision === 'ignore' || decision === 'rejected-after-study' ? 'ignore' : 'watch'
}

export function buildBacklog(opts: {
  commits: Commit[]
  policy?: Policy
  features?: Feature[]
  ledger?: LedgerLine[]
  range: { from: string; to: string; mode: 'full' | 'incremental' }
}) {
  const policy = opts.policy ?? DEFAULT_POLICY
  const noise = noiseOf(opts.commits)
  const clusters = clusterOf(opts.commits)
  const decided = new Map<string, Disposition>()

  for (const line of opts.ledger ?? []) {
    for (const sha of line.upstream ?? []) {
      decided.set(sha.slice(0, 10), ledgerDecision(line.decision))
    }
  }

  const dispositions: Record<string, Disposition> = {}
  const counts: Record<string, number> = { adopt: 0, watch: 0, ignore: 0 }
  const noiseCounts: Record<string, number> = {}
  const candidates: (InboxRow & { atS: number })[] = []

  for (const c of opts.commits) {
    const terms: string[] = []
    let score = 0
    let disposition: Disposition
    const n = noise.get(c.sha)
    const ledger = decided.get(c.sha.slice(0, 10))

    if (n) {
      disposition = 'ignore'
      noiseCounts[n] = (noiseCounts[n] ?? 0) + 1
    } else if (ledger) {
      disposition = ledger
    } else {
      const rule = policy.rules.find(r => ruleMatches(r, c))
      disposition = rule?.disposition ?? 'watch'

      if (rule?.term) {
        terms.push(rule.term)
        score += rule.term === 'contract' ? 4 : 0
      }

      for (const o of policy.overrides ?? []) {
        if (ruleMatches(o, c)) {
          disposition = o.disposition
          terms.push(o.term ?? o.disposition)
          score += o.term === 'security' ? 5 : o.term === 'privacy' ? -2 : 0
        }
      }

      for (const f of opts.features ?? []) {
        if (c.files.some(file => f.paths.some(g => matchesGlob(file, g)))) {
          const live = f.state === 'pristine' || f.state === 'diverged'
          terms.push(`feature:${f.id}${live ? '' : `(${f.state})`}`)
          score += live ? 3 : -3
        }
      }

      const subjectTerms: [RegExp, string, number][] = [
        [/^fix|\bfix(es|ed)?\b/i, 'fix', 2],
        [/^feat/i, 'feat', 2],
        [/^perf|\bperformance\b/i, 'perf', 1],
        [/BREAKING|^[a-z]+(\([^)]*\))?!:/, 'breaking', 3]
      ]

      for (const [rx, term, pts] of subjectTerms) {
        if (rx.test(c.subject)) {
          terms.push(term)
          score += pts
        }
      }

      const cl = clusters.get(c.sha)

      if (cl && cl.size >= 3) {
        terms.push(`cluster:${cl.size}`)
        score += 1
      }
    }

    dispositions[c.sha] = disposition
    counts[disposition] += 1

    if (disposition !== 'ignore' && !ledger) {
      candidates.push({
        week: isoWeek(c.at),
        sha: c.sha,
        at: new Date(c.at * 1000).toISOString(),
        atS: c.at,
        subject: c.subject,
        score,
        terms,
        disposition,
        cluster: clusters.get(c.sha)?.id ?? null
      })
    }
  }

  const byWeek = new Map<string, typeof candidates>()
  candidates.forEach(r => byWeek.set(r.week, [...(byWeek.get(r.week) ?? []), r]))
  const inbox: InboxRow[] = []

  for (const week of [...byWeek.keys()].sort().reverse()) {
    const rows = (byWeek.get(week) ?? []).sort((a, b) => b.score - a.score || b.atS - a.atS || (a.sha < b.sha ? -1 : 1))
    rows.slice(0, INBOX_PER_WEEK).forEach(({ atS: _atS, ...row }) => inbox.push(row))
  }

  return {
    schema: 1,
    mode: opts.range.mode,
    range: { from: opts.range.from, to: opts.range.to },
    commits: opts.commits.length,
    counts,
    noise: Object.fromEntries(Object.entries(noiseCounts).sort()),
    clusters: new Set([...clusters.values()].filter(c => c.size > 1).map(c => c.id)).size,
    dispositions,
    inbox
  }
}

// ---------------------------------------------------------------- repo I/O (read-only)

export function readLedger(file: string): LedgerLine[] {
  let text = ''

  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }

  return text
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as LedgerLine)
}

function adoptionPaths(repo: string) {
  const dir = path.join(repo, 'iclone', 'upstream', 'adoption')

  return {
    dir,
    ledger: path.join(dir, 'ledger.jsonl'),
    policy: path.join(dir, 'policy.json'),
    features: path.join(dir, 'features.json'),
    cursor: path.join(dir, 'CURSOR'),
    base: path.join(repo, 'iclone', 'UPSTREAM_BASE'),
    lock: path.join(repo, 'iclone', 'contract', 'runtime.lock.json'),
    served: path.join(repo, 'iclone', 'contract', 'served.py')
  }
}

function firstSha(file: string): string | null {
  try {
    return /^\s*([0-9a-f]{7,40})\b/m.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? null
  } catch {
    return null
  }
}

// The saved backlog lives in the repo's git dir, never in a committed path (contract §3.2).
export function backlogPath(repo: string): string {
  return path.resolve(repo, repoGit(repo, ['rev-parse', '--git-dir']).trim(), 'iclone', 'adoption', 'backlog.json')
}

export function scan(repo: string, full: boolean) {
  const p = adoptionPaths(repo)
  const ledger = readLedger(p.ledger)
  const base = firstSha(p.base) ?? '10b38830'
  // Incremental: CURSOR, else where the last saved scan ended (the git-dir backlog), else the newest ledger sha, else base.
  const saved = full ? null : readJsonFileSync<{ range?: { to?: string } }>(backlogPath(repo))
  const cursor = full ? base : (firstSha(p.cursor) ?? saved?.range?.to ?? ledger.at(-1)?.upstream?.[0] ?? base)
  const to = repoGit(repo, ['rev-parse', 'upstream/main']).trim()

  const log = repoGit(repo, [
    'log',
    '--no-renames',
    '--format=%x1e%H%x1f%at%x1f%P%x1f%s',
    '--name-only',
    `${cursor}..${to}`,
    '--',
    ...SCOPE
  ])

  const policy = readJsonFileSync<Policy>(p.policy)
  const features = readJsonFileSync<Feature[] | { features: Feature[] }>(p.features)

  return buildBacklog({
    commits: parseLog(log),
    policy: policy && Array.isArray(policy.rules) ? policy : DEFAULT_POLICY,
    features: Array.isArray(features) ? features : (features?.features ?? []),
    ledger,
    range: { from: cursor, to, mode: full ? 'full' : 'incremental' }
  })
}

// ---------------------------------------------------------------- upstream-day (decision 10)

interface DayCard {
  root: string
  level: string
  items: number
  names: string[]
  upstream: string[]
  ticket: string | null
  sites: number
}

function escapeRx(s: string): string {
  return s.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')
}

// Culprits: the newest commits up to `rev` whose diff adds or removes a line holding a card name as a string literal, in
// the contract file and the runtime's gateway code; the newest contract commit when the names are not literal. A
// server-request card searches the gone `<name>.respond` methods. `-G -n 5` stops at the first hits; `-S` (decision 10's
// wording) counts occurrences in every blob of the range and takes minutes on the full history.
function culprits(repo: string, base: string, rev: string, names: string[], root = ''): string[] {
  const literal = names.map(n => n.split('#')[0]).map(n => (root === 'server-requests' ? `${n}.respond` : n))
  const tokens = [...new Set(literal.filter(n => n.length >= 3))].slice(0, 6)
  const range = `${base}..${rev}`

  const found =
    tokens.length > 0
      ? repoGit(repo, [
          'log',
          '-n',
          '5',
          '--format=%H',
          `-G["'](${tokens.map(escapeRx).join('|')})["']`,
          range,
          '--',
          OPENRPC_PATH,
          'tui_gateway'
        ])
          .split('\n')
          .filter(Boolean)
      : []

  if (found.length > 0) {
    return found
  }

  const last = repoGit(repo, ['log', '-n', '1', '--format=%H', range, '--', OPENRPC_PATH]).trim()

  return [last || repoGit(repo, ['rev-parse', rev]).trim()]
}

function ticketBody(id: string, card: DayCard, rev: string, sites: string[], subjects: Map<string, string>): string {
  return [
    `# ${id} · P0 · ${card.root} (${card.level})`,
    '',
    `- Priority: P0. Fix forward within 72 h or the next block (contract decision 9).`,
    `- Detected: upstream-day at \`${rev.slice(0, 10)}\`; lane: compat.`,
    `- Culprit upstream commits:`,
    ...card.upstream.map(s => `  - ${s.slice(0, 10)} ${subjects.get(s) ?? ''}`.trimEnd()),
    `- Items (${card.items}): ${card.names.slice(0, 40).join(', ')}${card.names.length > 40 ? ', …' : ''}`,
    `- Call sites (${sites.length}): ${sites.slice(0, 20).join(', ')}${sites.length > 20 ? ', …' : ''}`,
    '- Done when: `verify` passes against BOTH the installed and the target spec (dual path).',
    ''
  ].join('\n')
}

function upstreamDay(repo: string, rev: string, outDir: string) {
  const p = adoptionPaths(repo)
  fs.mkdirSync(path.join(outDir, 'tickets'), { recursive: true })
  const specFile = path.join(outDir, 'spec.json')
  execFileSync('python3', ['-B', p.served, '--repo', repo, '--rev', rev, '--out', specFile], {
    cwd: repo,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  })
  const lock = readJsonFileSync<Parameters<typeof verify>[0]>(p.lock)

  const sitesDoc = readJsonFileSync<{ methods?: Record<string, string[]>; events?: Record<string, string[]> }>(
    p.lock.replace(/\.json$/, '.sites.json')
  )

  const sites: Record<string, string[]> = { ...(sitesDoc?.methods ?? {}), ...(sitesDoc?.events ?? {}) }
  const ledger = readLedger(p.ledger)

  const v = verify(lock, [readJsonFileSync(specFile) ?? {}], {
    kind: 'upstream-day',
    sites,
    tickets: ledgerLinks(ledger)
  })

  const base = firstSha(p.base) ?? '10b38830'
  let next = Math.max(0, ...ledger.map(l => Number(/^ADP-(\d{4})$/.exec(l.ticket ?? '')?.[1] ?? 0))) + 1
  const rows: Record<string, unknown>[] = []

  for (const card of v.cards as DayCard[]) {
    if (card.level !== 'RED') {
      continue
    }

    card.ticket ??= `ADP-${String(next++).padStart(4, '0')}`
    const shas = culprits(repo, base, rev, card.names, card.root)
    card.upstream = [...new Set([...card.upstream, ...shas])]

    const subjects = new Map(
      card.upstream.map(s => [s, repoGit(repo, ['log', '-n', '1', '--format=%s', s]).trim()] as [string, string])
    )

    const cardSites = [...new Set(card.names.flatMap(n => sites[n] ?? sites[`${n}.respond`] ?? []))].sort()
    fs.writeFileSync(
      path.join(outDir, 'tickets', `${card.ticket}.md`),
      ticketBody(card.ticket, card, rev, cardSites, subjects)
    )
    rows.push({
      id: card.ticket,
      root: card.root,
      items: card.names,
      sites: cardSites,
      successor:
        card.root === 'server-requests' ? 'server request (x.request event answered by a response frame)' : null,
      upstream: card.upstream,
      rev
    })
  }

  fs.writeFileSync(path.join(outDir, 'verdict.json'), `${JSON.stringify(v, null, 1)}\n`)
  fs.writeFileSync(path.join(outDir, 'P4c_compat.json'), `${JSON.stringify(rows, null, 1)}\n`)

  return { level: v.level, tickets: rows.length }
}

export function ledgerLinks(ledger: LedgerLine[]): TicketLink[] {
  return ledger
    .filter(l => l.lane === 'compat' && l.ticket && l.root)
    .map(l => ({ ticket: l.ticket as string, root: l.root as string, upstream: l.upstream ?? [] }))
}

function cli(argv: string[]): number {
  const take = (flag: string) => {
    const i = argv.indexOf(flag)

    return i >= 0 ? argv[i + 1] : undefined
  }

  const repo = path.resolve(take('--repo') ?? path.join(path.dirname(process.argv[1] ?? '.'), '..', '..', '..', '..'))
  const out = take('--out')

  if (argv[0] === 'scan') {
    const backlog = `${JSON.stringify(scan(repo, argv.includes('--full')), null, 1)}\n`
    const file = out ? path.resolve(out) : backlogPath(repo)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, backlog)

    return 0
  }

  const rev = take('--rev')

  if (argv[0] === 'upstream-day' && rev && out) {
    const r = upstreamDay(repo, rev, path.resolve(out))
    process.stdout.write(`${JSON.stringify(r)}\n`)

    return 0
  }

  process.stderr.write('usage: node adoption.ts scan [--full] [--out <file>] | upstream-day --rev <sha> --out <dir>\n')

  return 2
}

if (/adoption\.ts$/.test(process.argv[1] ?? '')) {
  process.exitCode = cli(process.argv.slice(2))
}
