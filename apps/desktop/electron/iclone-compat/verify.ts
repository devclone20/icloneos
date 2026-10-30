// Contract verification (RESUME/contracts/P4_upstream.md §3.2 verdict, §3.4 rules): the app's consumer lock against one
// or more provider specs (served.py spec@1). Pure and synchronous; the CLI at the bottom is the gate's E4 entry point.
import fs from 'node:fs'
import path from 'node:path'

import type { JsonType, Schema, Schemas } from './schema.ts'
// Node runs this file directly (the gates' E4 CLI) and its ESM loader needs the literal `.ts` specifier, which the
// electron tsconfig only accepts on type imports. Types still resolve through it.
// @ts-expect-error TS5097: value import with a `.ts` extension, required by Node type stripping
import { acceptsType, enumValues, objectShape, schemaAt } from './schema.ts'

type Level = 'GREEN' | 'INFO' | 'AMBER' | 'UNKNOWN' | 'RED'

export interface Finding {
  rule: string
  level: Level
  name: string
  rev: string
  detail?: string
}

interface Card {
  root: string
  level: Level
  items: number
  names: string[]
  rules: string[]
  upstream: string[]
  ticket: string | null
  sites: number
}

interface VerifyOptions {
  kind?: string
  // false when the target is not a descendant of the installed runtime (a rollback).
  isDescendant?: boolean
  probe?: { unsafe?: boolean } | null
  canary?: { ok?: boolean; scenario?: string } | null
  // Upstream commits that touched a runtime file, with their subjects (SEM-TOUCH).
  touched?: { file: string; subjects: string[] }[]
  sites?: Record<string, string[]>
  // Compat-lane ledger lines (adoption.ts `ledgerLinks`): a card with the same root carries that ticket and its culprits.
  tickets?: TicketLink[]
}

export interface TicketLink {
  ticket: string
  root: string
  upstream: string[]
}

function linkTickets(cards: Card[], links: TicketLink[] = []): Card[] {
  return cards.map(card => {
    const link = links.filter(l => l.root === card.root).at(-1)

    return link ? { ...card, ticket: link.ticket, upstream: [...link.upstream] } : card
  })
}

type Lock = Record<string, any>
type Spec = Record<string, any>

const RANK: Record<Level, number> = { GREEN: 0, INFO: 1, AMBER: 2, UNKNOWN: 3, RED: 4 }

const worst = (levels: Level[]): Level =>
  levels.reduce<Level>((a, b) => (RANK[b] > RANK[a] && b !== 'INFO' ? b : a), 'GREEN')

// Wire verbs of the request/response pairs that server→client requests replaced (folding, §3.4).
const PAIR_VERBS = new Set(['respond', 'request', 'expire', 'cancel', 'cancelled', 'expired'])
// JSON-RPC reserved codes belong to the protocol, not to the provider's error census.
const isProtocolCode = (c: number) => Math.abs(c) >= 32000 && Math.abs(c) <= 32768

const keysOf = (x: unknown): string[] =>
  Array.isArray(x)
    ? x.map(e => (typeof e === 'string' ? e : e?.name)).filter(Boolean)
    : x && typeof x === 'object'
      ? Object.keys(x)
      : []

const bare = (k: string) => k.replace(/\?$/, '')

function readPath(read: string): { path: string[]; optional: boolean } {
  const segs = read.split('.')

  return { path: segs.map(s => s.replace(/\?$/, '')), optional: segs.some(s => s.endsWith('?')) }
}

function restKey(route: string): string {
  const p = (route.split(' ')[1] ?? route).split('?')[0]

  return p
    .replace(/(?<=[^/])\{\}$/, '')
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/\/$/, '')
}

function restServed(route: string, served: string[]): boolean {
  const want = restKey(route)
  const rx = new RegExp(`^${want.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{\\?\}/g, '[^/]+')}(/|$)`)

  // A lock entry may be a base URL the app extends at runtime: any served route under it keeps it alive.
  return served.some(s => {
    const k = restKey(s)

    return k === want || rx.test(k)
  })
}

function lockTypes(t: unknown): JsonType[] {
  if (typeof t !== 'string') {
    return []
  }

  return t.split('|').filter((x): x is JsonType => x !== 'opaque' && x !== 'unknown' && x !== 'undefined') as JsonType[]
}

function rulesForSpec(lock: Lock, spec: Spec, opts: VerifyOptions, prev: Spec | null): Finding[] {
  const out: Finding[] = []
  const rev = String(spec.rev ?? '')

  const add = (rule: string, level: Level, name: string, detail?: string) =>
    out.push({ rule, level, name, rev, ...(detail ? { detail } : {}) })

  const schemas: Schemas = spec.schemas ?? {}

  const sMethods: Record<string, any> =
    spec.methods && !Array.isArray(spec.methods)
      ? spec.methods
      : Object.fromEntries(keysOf(spec.methods).map(n => [n, {}]))

  const lMethods: Record<string, any> = lock.methods ?? {}
  const typed = spec.specTier !== 'ast'

  const schemaOf = (ref: unknown): Schema | undefined =>
    typeof ref === 'string' && ref !== 'opaque' ? (schemas[ref] ?? { $ref: ref }) : undefined

  if (!typed) {
    add(
      'NO-OPENRPC',
      'UNKNOWN',
      String(spec.describe ?? rev),
      'provider spec is AST-only: params and results unverified'
    )
  }

  for (const [name, m] of Object.entries(lMethods)) {
    const sm = sMethods[name]
    const guard = typeof m?.guardedBy === 'string' ? m.guardedBy : null
    const needs = typeof m?.requires === 'string' ? m.requires : null

    // The new path of a dual path runs only against a runtime that serves its capability method.
    if (needs && !sMethods[needs]) {
      if (!sm) {
        add('M-GATED', 'INFO', name, `new path; called only where ${needs} is served`)
      }

      continue
    }

    // A dual-path legacy call (contract P4c D2) runs only against a runtime without its guard method.
    if (guard && sMethods[guard]) {
      if (!sm) {
        add('M-GUARDED', 'INFO', name, `legacy path; not called where ${guard} is served`)
      }

      continue
    }

    if (!sm) {
      add('M-GONE', 'RED', name, m?.via === 'js' ? 'called from plugin.js' : undefined)

      continue
    }

    if (!typed) {
      continue
    }

    const params = schemaOf(sm.params)
    const shape = params && objectShape(params, schemas)

    if (shape && m.params && typeof m.params === 'object') {
      const sent = Object.keys(m.params)
      const sentBare = new Set(sent.map(bare))

      for (const k of sent) {
        const prop = shape.properties[bare(k)]

        if (!prop) {
          if (shape.closed) {
            add('P-UNKNOWN', 'RED', `${name}#${bare(k)}`)
          }

          continue
        }

        const types = lockTypes(m.params[k])

        if (types.length && !types.some(t => acceptsType(prop, t, schemas))) {
          add('P-TYPE', 'RED', `${name}#${bare(k)}`, `sent ${types.join('|')}`)
        }
      }

      for (const r of shape.required) {
        if (!sentBare.has(r)) {
          add('P-REQUIRED', 'RED', `${name}#${r}`)
        }
      }

      for (const k of Object.keys(shape.properties)) {
        if (!shape.required.has(k) && !sentBare.has(k)) {
          add('P-OPT-NEW', 'INFO', `${name}#${k}`)
        }
      }
    }

    const result = schemaOf(sm.result)
    const rshape = result && objectShape(result, schemas)

    if (rshape) {
      const reads = (m.resultReads ?? []) as string[]

      for (const read of reads) {
        const { path: p, optional } = readPath(read)
        const top = p[0].replace(/\[\]$/, '')

        if (!(top in rshape.properties)) {
          add('R-READ-GONE', rshape.closed ? 'RED' : 'AMBER', `${name}#${p.join('.')}`)

          continue
        }

        if (!optional && p.length === 1 && !rshape.required.has(top)) {
          add('R-READ-OPTIONAL', 'AMBER', `${name}#${top}`)
        }

        enumWidened(`${name}#${p.join('.')}`, prev?.methods?.[name]?.result, sm.result, p, prev, spec, add)
      }

      const readTops = new Set(reads.map(r => readPath(r).path[0].replace(/\[\]$/, '')))

      if (reads.length) {
        for (const k of Object.keys(rshape.properties)) {
          if (!readTops.has(k)) {
            add('R-FIELD-NEW', 'INFO', `${name}#${k}`)
          }
        }
      }
    }
  }

  for (const name of Object.keys(sMethods)) {
    if (!(name in lMethods)) {
      add('M-NEW', 'INFO', name)
    }
  }

  const sr = lock.serverRequests ?? {}
  const known = new Set([...keysOf(sr.handled), ...keysOf(sr.declineOk)])

  for (const name of keysOf(spec.serverRequests)) {
    if (known.has(name)) {
      continue
    }

    if (sr.answersUnknown) {
      add('SR-NEW', 'INFO', name)
    } else {
      add('SR-UNHANDLED', 'RED', name)
    }
  }

  const notes: Record<string, any> = spec.notifications ?? {}

  if (Object.keys(notes).length) {
    for (const [name, e] of Object.entries<any>(lock.events ?? {})) {
      if (!(name in notes)) {
        add('E-GONE', 'AMBER', name)

        continue
      }

      for (const read of (e?.payloadReads ?? []) as string[]) {
        const { path: p } = readPath(read)
        enumWidened(
          `${name}#${p.join('.')}`,
          prev?.notifications?.[name]?.payload,
          notes[name]?.payload,
          p,
          prev,
          spec,
          add
        )
      }
    }

    for (const name of Object.keys(notes)) {
      if (!(name in (lock.events ?? {}))) {
        add('E-NEW', 'INFO', name)
      }
    }
  }

  const rest: string[] = spec.rest ?? []

  if (rest.length) {
    for (const r of Object.keys(lock.rest ?? {})) {
      if (!restServed(r, rest)) {
        add('REST-GONE', 'RED', r)
      }
    }
  }

  const cli: string[] = spec.cli?.serve ?? []

  if (cli.length) {
    for (const f of lock.cli?.serve ?? []) {
      if (f !== '--help' && f !== '-h' && !cli.includes(f)) {
        add('CLI-GONE', 'RED', f)
      }
    }
  }

  if (Array.isArray(spec.env)) {
    for (const v of lock.env ?? []) {
      if (!spec.env.includes(v)) {
        add('FLAG-GONE', 'RED', v)
      }
    }
  }

  const codes: number[] = spec.errorCodes ?? []

  if (codes.length) {
    for (const c of lock.errorCodes ?? []) {
      if (!isProtocolCode(c) && !codes.includes(c)) {
        add('ERR-GONE', 'AMBER', String(c))
      }
    }
  }

  const cfg: string[] = spec.configKeys ?? []

  if (cfg.length) {
    for (const [k, mode] of Object.entries(lock.config ?? {})) {
      if (mode === 'write' && !cfg.some(c => c === k || c.startsWith(`${k}.`))) {
        add('CFG-GONE-WRITTEN', 'AMBER', k)
      }
    }
  }

  if (Array.isArray(spec.disk)) {
    for (const d of Object.keys(lock.disk ?? {})) {
      if (!spec.disk.includes(d)) {
        add('DISK-GONE', 'AMBER', d)
      }
    }
  }

  const handlerFiles: Record<string, string> = spec.handlerFiles ?? {}

  for (const t of opts.touched ?? []) {
    for (const [m, f] of Object.entries(handlerFiles)) {
      if (f === t.file && m in lMethods) {
        add('SEM-TOUCH', 'AMBER', m, t.subjects.join(' | '))
      }
    }
  }

  const deps: Record<string, unknown> = lock.engineDeps ?? {}

  const present: Record<string, boolean> = {
    openrpc: !typed || !!spec.openrpcSha256,
    health: !rest.length || rest.some(r => restKey(r) === restKey(String(deps.health ?? '').split('#')[0])),
    schemaVersion: spec.stateVersions?.db != null,
    configVersion: spec.stateVersions?.config != null,
    receipt: !Array.isArray(spec.receipt) || keysOf(deps.receipt).every(f => spec.receipt.includes(f))
  }

  for (const dep of Object.keys(deps)) {
    if (present[dep] === false) {
      add('ENGINE-DEP-GONE', 'UNKNOWN', dep, String(deps[dep]))
    }
  }

  return out
}

function enumWidened(
  name: string,
  before: unknown,
  after: unknown,
  p: string[],
  prev: Spec | null,
  spec: Spec,
  add: (rule: string, level: Level, name: string, detail?: string) => void
) {
  if (!prev || typeof before !== 'string' || typeof after !== 'string') {
    return
  }

  const old = enumValues(
    schemaAt(prev.schemas?.[before] ?? { $ref: before }, p, prev.schemas ?? {}),
    prev.schemas ?? {}
  )

  const now = enumValues(schemaAt(spec.schemas?.[after] ?? { $ref: after }, p, spec.schemas ?? {}), spec.schemas ?? {})

  if (!old || !now) {
    return
  }

  const gained = now.filter(v => !old.some(o => JSON.stringify(o) === JSON.stringify(v)))

  if (gained.length) {
    add('ENUM-WIDE', 'AMBER', name, gained.map(String).join(','))
  }
}

function stateRules(specs: Spec[], opts: VerifyOptions): { findings: Finding[]; state: Record<string, unknown> } {
  const live = specs[0]?.stateVersions ?? {}
  const target = specs[specs.length - 1]?.stateVersions ?? {}
  const rev = String(specs[specs.length - 1]?.rev ?? '')

  const state = {
    liveDb: live.db ?? null,
    targetDb: target.db ?? null,
    liveConfig: live.config ?? null,
    targetConfig: target.config ?? null,
    oneWay: false
  }

  const findings: Finding[] = []
  const lower = (a: unknown, b: unknown) => typeof a === 'number' && typeof b === 'number' && b < a

  if (opts.isDescendant === false || lower(live.db, target.db) || lower(live.config, target.config)) {
    findings.push({
      rule: 'DOWNGRADE',
      level: 'RED',
      name: 'state',
      rev,
      detail: `db ${state.liveDb}->${state.targetDb}, config ${state.liveConfig}->${state.targetConfig}`
    })
  } else if (specs.length > 1 && (lower(target.db, live.db) || lower(target.config, live.config))) {
    state.oneWay = true
    findings.push({ rule: 'ONE-WAY', level: 'INFO', name: 'state', rev })
  }

  if (opts.probe?.unsafe) {
    findings.push({ rule: 'PROBE-UNSAFE', level: 'RED', name: 'probe', rev })
  }

  if (opts.canary && opts.canary.ok === false) {
    findings.push({ rule: 'CANARY-FAIL', level: 'AMBER', name: opts.canary.scenario ?? 'canary', rev })
  }

  return { findings, state }
}

const FAMILY: Record<string, string> = {
  'M-GONE': 'methods',
  'M-GUARDED': 'methods',
  'M-GATED': 'methods',
  'P-UNKNOWN': 'params',
  'P-REQUIRED': 'params',
  'P-TYPE': 'params',
  'R-READ-GONE': 'results',
  'R-READ-OPTIONAL': 'results',
  'ENUM-WIDE': 'results',
  'E-GONE': 'events',
  'REST-GONE': 'surfaces',
  'CLI-GONE': 'surfaces',
  'FLAG-GONE': 'surfaces',
  'ERR-GONE': 'surfaces',
  'CFG-GONE-WRITTEN': 'surfaces',
  'DISK-GONE': 'surfaces',
  DOWNGRADE: 'state',
  'SEM-TOUCH': 'semantics'
}

// Items that share a successor fold into one card: `x.respond` + the `x.request` event + server request `x`.
function fold(findings: Finding[], serverRequests: Set<string>, sites: Record<string, string[]> = {}): Card[] {
  const cards = new Map<
    string,
    { level: Level[]; items: number; names: Set<string>; rules: Set<string>; sites: Set<string> }
  >()

  for (const f of findings) {
    if (f.level === 'INFO' || f.level === 'GREEN') {
      continue
    }

    let root = FAMILY[f.rule] ?? 'engine'
    let member = f.name
    const segs = f.name.split('.')
    const successor = segs.slice(0, -1).join('.')

    if (f.rule === 'SR-UNHANDLED') {
      root = 'server-requests'
    } else if (
      (f.rule === 'M-GONE' || f.rule === 'E-GONE') &&
      PAIR_VERBS.has(segs[segs.length - 1]) &&
      serverRequests.has(successor)
    ) {
      root = 'server-requests'
      member = successor
    }

    const c = cards.get(root) ?? { level: [], items: 0, names: new Set(), rules: new Set(), sites: new Set() }
    c.level.push(f.level)
    c.items += 1
    c.names.add(member)
    c.rules.add(f.rule)

    for (const s of sites[f.name] ?? []) {
      c.sites.add(s)
    }

    cards.set(root, c)
  }

  return [...cards.entries()]
    .map(([root, c]) => ({
      root,
      level: worst(c.level),
      items: c.items,
      names: [...c.names].sort(),
      rules: [...c.rules].sort(),
      upstream: [],
      ticket: null,
      sites: c.sites.size
    }))
    .sort((a, b) => RANK[b.level] - RANK[a.level] || b.items - a.items || (a.root < b.root ? -1 : 1))
}

function hash(text: string): string {
  let h = 0x811c9dc5

  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  }

  return h.toString(16).padStart(8, '0')
}

export function verify(lock: Lock | null, specs: Spec[], opts: VerifyOptions = {}) {
  const t0 = performance.now()
  const target = specs[specs.length - 1] ?? {}
  const findings: Finding[] = []

  if (!lock) {
    findings.push({ rule: 'LOCK-MISSING', level: 'UNKNOWN', name: 'lock', rev: String(target.rev ?? '') })
  }

  if (!specs.length) {
    findings.push({ rule: 'FETCH-FAILED', level: 'UNKNOWN', name: 'spec', rev: '' })
  }

  const perSpec = specs.map((spec, i) => {
    const own = lock ? rulesForSpec(lock, spec, opts, i > 0 ? specs[0] : null) : []
    findings.push(...own)

    return {
      rev: String(spec.rev ?? ''),
      describe: spec.describe ?? null,
      specTier: spec.specTier ?? null,
      level: worst(own.map(f => f.level))
    }
  })

  const st = stateRules(specs, opts)
  findings.push(...st.findings)
  const srs = new Set(specs.flatMap(s => keysOf(s.serverRequests)))
  const cards = linkTickets(fold(findings, srs, opts.sites), opts.tickets)
  const contractHash = String(target.openrpcSha256 ?? '').slice(0, 12)
  const to = String(target.rev ?? '')

  return {
    schema: 1,
    id: `v-${to.slice(0, 11)}-${contractHash.slice(0, 8)}-${hash(JSON.stringify(findings)).slice(0, 4)}`,
    kind: opts.kind ?? 'preview',
    level: worst(findings.map(f => f.level)),
    runtime: {
      from: String(specs[0]?.rev ?? '').slice(0, 10),
      to: to.slice(0, 11),
      contractHash,
      isDescendant: opts.isDescendant ?? null,
      specCoverage: target.specTier === 'ast' ? ['rpc', 'events', 'state'] : ['rpc', 'events', 'sr', 'state']
    },
    state: st.state,
    cards,
    findings,
    perSpec,
    probe: null,
    computedMs: Math.round((performance.now() - t0) * 100) / 100
  }
}

function cli(argv: string[]) {
  const take = (flag: string) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]] : []))
  const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'))
  const lockPath = take('--lock')[0]

  if (!lockPath) {
    process.stderr.write(
      'usage: node verify.ts --lock <lock.json> --spec <installed> [--spec <target>] [--kind <kind>]\n'
    )

    return 2
  }

  const lock = fs.existsSync(lockPath) ? read(lockPath) : null
  const specs = take('--spec').map(read)
  const sitesPath = lockPath.replace(/\.json$/, '.sites.json')
  const sitesDoc = fs.existsSync(sitesPath) ? read(sitesPath) : {}
  const sites: Record<string, string[]> = { ...(sitesDoc.methods ?? {}), ...(sitesDoc.events ?? {}) }

  // The committed ledger sits beside the contract folder: iclone/contract/<lock> -> iclone/upstream/adoption/.
  const ledgerPath =
    take('--ledger')[0] ?? path.join(path.dirname(lockPath), '..', 'upstream', 'adoption', 'ledger.jsonl')

  const tickets: TicketLink[] = fs.existsSync(ledgerPath)
    ? fs
        .readFileSync(ledgerPath, 'utf8')
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l))
        .filter(l => l.lane === 'compat' && l.ticket && l.root)
        .map(l => ({ ticket: l.ticket, root: l.root, upstream: l.upstream ?? [] }))
    : []

  const v = verify(lock, specs, { kind: take('--kind')[0], sites, tickets })
  process.stdout.write(`${JSON.stringify(v, null, 1)}\n`)

  return 0
}

if (/verify\.ts$/.test(process.argv[1] ?? '')) {
  process.exitCode = cli(process.argv.slice(2))
}
