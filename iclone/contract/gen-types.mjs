#!/usr/bin/env node
// Runtime-contract types (RESUME/contracts/P4_upstream.md §3.1): GatewayMethods, GatewayEventMap and ServerRequestMap
// from one provider spec (served.py spec@1), or from the union of several given oldest first (the N/N+1 dual path).
// In a union, a name that some spec lacks carries `@since <rev>` (first spec that serves it) and/or `@until <rev>`
// (first spec that no longer serves it); its type comes from the newest spec that serves it.
//
//   node iclone/contract/gen-types.mjs [--spec <spec.json> ...] [--out <file>]
//   node iclone/contract/gen-types.mjs --check [--runtime <checkout>]
//
// Without --spec it reads the committed iclone/contract/runtime.spec.json; without --out it writes the committed
// A/src/types/runtime-contract.generated.ts. Output is prettier-formatted with the app's config, so a rerun on the
// same inputs is byte-identical (the P4a.lock.fresh gate).
//
// --check is the staleness check of the whole chain: it serves the runtime checkout afresh (served.py --runtime, files
// only; default $HERMES_HOME/hermes-agent) into a temp dir, then requires the committed spec to equal that serve and the
// committed types to equal gen-types of the committed spec. Exit 0 = fresh, 1 = stale, 2 = the check could not run.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.join(HERE, '..', '..', 'apps', 'desktop')
const TARGET = path.join(APP, 'src', 'types', 'runtime-contract.generated.ts')
const GENERATOR = 'iclone/contract/gen-types.mjs@1'
const IDENT = /^[A-Za-z_$][\w$]*$/
const SIMPLE = /^[\w$.]+$/
const COMBINATORS = new Set(['anyOf', 'oneOf', 'allOf'])

function parseArgs(argv) {
  const out = { spec: [], out: null, check: false, runtime: null, runtimePin: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--spec' && argv[i + 1]) out.spec.push(argv[++i])
    else if (a === '--out' && argv[i + 1]) out.out = argv[++i]
    else if (a === '--check') out.check = true
    else if (a === '--runtime-pin') out.runtimePin = true
    else if (a === '--runtime' && argv[i + 1]) out.runtime = argv[++i]
    else {
      process.stderr.write(`gen-types: unknown or incomplete argument ${a}\n`)
      process.exit(2)
    }
  }
  return out
}

const typeName = name => {
  const s = String(name).replace(/[^\w$]/g, '_')
  return /^\d/.test(s) ? `_${s}` : s
}
const refName = ref => String(ref).split('/').pop()
const propKey = k => (IDENT.test(k) ? k : JSON.stringify(k))
const literal = v => (v !== null && typeof v === 'object' ? 'unknown' : JSON.stringify(v))
const wrap = t => (SIMPLE.test(t) || /^"(?:[^"\\]|\\.)*"$/.test(t) ? t : `(${t})`)

function union(parts) {
  const uniq = [...new Set(parts)]
  if (uniq.includes('unknown')) return 'unknown'
  const live = uniq.filter(t => t !== 'never')
  return live.length ? live.join(' | ') : 'never'
}

// JSON Schema (2020-12 as pydantic emits it) to a TS type expression. Validation-only keywords (not, if/then/else,
// bounds, patterns) narrow values a type cannot express, so they widen to the base type here; schema.ts checks them.
function tsType(s, known) {
  if (s === false) return 'never'
  if (s === true || s === null || typeof s !== 'object' || Array.isArray(s)) return 'unknown'
  if (typeof s.$ref === 'string') {
    const n = refName(s.$ref)
    return known.has(n) ? typeName(n) : 'unknown'
  }
  if ('const' in s) return literal(s.const)
  if (Array.isArray(s.enum)) return union(s.enum.map(literal))
  const branches = [...(Array.isArray(s.anyOf) ? s.anyOf : []), ...(Array.isArray(s.oneOf) ? s.oneOf : [])]
  const { allOf } = s
  const rest = Object.fromEntries(Object.entries(s).filter(([k]) => !COMBINATORS.has(k)))
  if (Array.isArray(allOf) && allOf.length) {
    const parts = [
      ...allOf.map(x => tsType(x, known)),
      ...(Object.keys(rest).some(isStructural) ? [tsType(rest, known)] : [])
    ]
    const live = [...new Set(parts)].filter(t => t !== 'unknown')
    const inter = live.length ? live.map(wrap).join(' & ') : 'unknown'
    return branches.length ? `${wrap(inter)} & ${wrap(union(branches.map(x => tsType(x, known))))}` : inter
  }
  if (branches.length) return union(branches.map(x => tsType(x, known)))
  const types = Array.isArray(s.type) ? s.type : typeof s.type === 'string' ? [s.type] : inferTypes(s)
  if (!types.length) return 'unknown'
  return union([...types.map(t => typeFor(t, s, known)), ...(s.nullable === true ? ['null'] : [])])
}

function isStructural(k) {
  return [
    'type',
    'properties',
    'additionalProperties',
    'patternProperties',
    'items',
    'prefixItems',
    'enum',
    'const',
    '$ref'
  ].includes(k)
}

function inferTypes(s) {
  if (s.properties || s.additionalProperties !== undefined || s.patternProperties) return ['object']
  if (s.items !== undefined || s.prefixItems) return ['array']
  return []
}

function typeFor(t, s, known) {
  switch (t) {
    case 'string':
      return 'string'
    case 'integer':
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array':
      return arrayType(s, known)
    case 'object':
      return objectType(s, known)
    default:
      return 'unknown'
  }
}

function arrayType(s, known) {
  if (Array.isArray(s.prefixItems)) {
    const head = s.prefixItems.map(x => tsType(x, known))
    const tail = s.items === false ? [] : [`...${wrap(tsType(s.items ?? true, known))}[]`]
    return `[${[...head, ...tail].join(', ')}]`
  }
  return `${wrap(tsType(s.items ?? true, known))}[]`
}

function objectType(s, known) {
  const props = s.properties && typeof s.properties === 'object' ? s.properties : {}
  const required = new Set(Array.isArray(s.required) ? s.required : [])
  const members = Object.keys(props).map(k => `${propKey(k)}${required.has(k) ? '' : '?'}: ${tsType(props[k], known)}`)
  const ap = s.additionalProperties
  const patterns =
    s.patternProperties && typeof s.patternProperties === 'object' ? Object.values(s.patternProperties) : []
  const extras = [
    ...(ap && typeof ap === 'object' ? [tsType(ap, known)] : ap === true ? ['unknown'] : []),
    ...patterns.map(x => tsType(x, known))
  ]
  const extra = extras.length ? union(extras) : !members.length && ap !== false ? 'unknown' : null
  if (!members.length) return `Record<string, ${extra ?? 'never'}>`
  const body = `{ ${members.join('; ')} }`
  return extra ? `${body} & Record<string, ${extra}>` : body
}

const label = spec => `${spec.describe ?? 'unknown'} (${String(spec.rev ?? '').slice(0, 10)}, ${spec.specTier ?? '?'})`
const names = x =>
  Array.isArray(x) ? x.map(e => (typeof e === 'string' ? e : e?.name)).filter(Boolean) : Object.keys(x ?? {})
const entryOf = (x, name) => (Array.isArray(x) ? {} : (x?.[name] ?? {}))

function section(specs, pick, render, known) {
  const all = [...new Set(specs.flatMap(s => names(pick(s))))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const last = specs.length - 1
  return all.map(name => {
    const here = specs.map(s => names(pick(s)).includes(name))
    const first = here.indexOf(true)
    const latest = here.lastIndexOf(true)
    const marks = []
    if (first > 0) marks.push(`@since ${String(specs[first].rev ?? '').slice(0, 10)} (${specs[first].describe ?? '?'})`)
    if (latest < last) {
      const gone = specs[latest + 1]
      marks.push(
        `@until ${String(gone.rev ?? '').slice(0, 10)} (${gone.describe ?? '?'}): not served from this revision`
      )
    }
    const doc = marks.length ? `/** ${marks.join(' ')} */\n` : ''
    return `${doc}${propKey(name)}: ${render(entryOf(pick(specs[latest]), name), known)}`
  })
}

const refType = (ref, known) =>
  typeof ref === 'string' && ref !== 'opaque' && known.has(refName(ref)) ? typeName(refName(ref)) : 'unknown'
const pairType = (e, known) => `{ params: ${refType(e.params, known)}; result: ${refType(e.result, known)} }`

function block(kind, name, members) {
  return members.length
    ? `export interface ${name} {\n${members.join('\n')}\n}`
    : `// No ${kind} in the provider spec.\nexport type ${name} = Record<string, never>`
}

// The per-route effort vocabulary (served.py `effortRoutes`) is data, not a type: the composer's Effort menu lists only
// what the route sends verbatim. A union takes the newest spec that carries it.
function effortRoutes(specs) {
  const er = [...specs].reverse().find(s => s.effortRoutes && typeof s.effortRoutes === 'object')?.effortRoutes
  return er
    ? [
        "/** Reasoning-effort levels per route, read from the runtime's tables (served.py effortRoutes). */\n" +
          `export const EFFORT_ROUTES = ${JSON.stringify(er)} as const`
      ]
    : []
}

export function generate(specs) {
  // Union: the newest definition of a schema name wins (specs are given oldest first).
  const schemas = Object.assign({}, ...specs.map(s => (s.schemas && typeof s.schemas === 'object' ? s.schemas : {})))
  const known = new Set(Object.keys(schemas))
  const from = specs.length === 1 ? label(specs[0]) : `the union of ${specs.map(label).join(' -> ')}`
  const parts = [
    `// Generated by ${GENERATOR} from ${from}. Do not edit; rerun the generator.`,
    block(
      'methods',
      'GatewayMethods',
      section(specs, s => s.methods, pairType, known)
    ),
    block(
      'notifications',
      'GatewayEventMap',
      section(
        specs,
        s => s.notifications,
        (e, k) => refType(e.payload, k),
        known
      )
    ),
    block(
      'server requests',
      'ServerRequestMap',
      section(specs, s => s.serverRequests, pairType, known)
    ),
    'export type GatewayMethod = keyof GatewayMethods',
    "export type GatewayParams<M extends GatewayMethod> = GatewayMethods[M]['params']",
    "export type GatewayResult<M extends GatewayMethod> = GatewayMethods[M]['result']",
    'export type GatewayEvent = keyof GatewayEventMap',
    'export type ServerRequest = keyof ServerRequestMap',
    ...[...known]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map(n => `export type ${typeName(n)} = ${tsType(schemas[n], known)}`),
    ...effortRoutes(specs)
  ]
  return `${parts.join('\n\n')}\n`
}

async function render(specs) {
  const prettier = createRequire(path.join(APP, 'package.json'))('prettier')
  const config = (await prettier.resolveConfig(TARGET)) ?? {}
  return prettier.format(generate(specs), { ...config, parser: 'typescript', filepath: TARGET })
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))

// Key order is not part of the contract; a reordered but equal spec is fresh.
const canonical = v =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map(k => [k, canonical(v[k])])
        )
      : v

async function check(runtimeArg) {
  const runtime = path.resolve(
    runtimeArg ?? path.join(process.env.HERMES_HOME || path.join(os.homedir(), '.hermes'), 'hermes-agent')
  )
  const committedFile = path.join(HERE, 'runtime.spec.json')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-spec-check-'))
  try {
    const freshFile = path.join(tmp, 'runtime.spec.json')
    const served = spawnSync(
      'python3',
      ['-B', path.join(HERE, 'served.py'), '--runtime', runtime, '--out', freshFile],
      { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
    )
    if (served.status !== 0 || !fs.existsSync(freshFile)) {
      process.stderr.write(`gen-types --check: served.py failed (${served.status}): ${served.stderr.trim()}\n`)
      return 2
    }
    const committed = readJson(committedFile)
    const fresh = readJson(freshFile)
    const problems = []
    if (committed.rev !== fresh.rev || committed.openrpcSha256 !== fresh.openrpcSha256) {
      problems.push(
        `runtime moved: committed ${committed.describe} (${committed.rev}), runtime ${fresh.describe} (${fresh.rev})`
      )
    }
    const keys = [...new Set([...Object.keys(committed), ...Object.keys(fresh)])].sort()
    const drifted = keys.filter(k => JSON.stringify(canonical(committed[k])) !== JSON.stringify(canonical(fresh[k])))
    if (drifted.length) problems.push(`runtime.spec.json differs from a fresh serve in: ${drifted.join(', ')}`)
    const types = await render([committed])
    const onDisk = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : ''
    if (types !== onDisk)
      problems.push(`${path.relative(path.join(HERE, '..', '..'), TARGET)} is not gen-types of the committed spec`)
    for (const p of problems) process.stderr.write(`gen-types --check: STALE ${p}\n`)
    if (problems.length) {
      process.stderr.write(
        'gen-types --check: refresh with served.py --runtime <checkout> --out iclone/contract/runtime.spec.json, then gen-types.mjs\n'
      )
      return 1
    }
    process.stderr.write(
      `gen-types --check: fresh at ${fresh.describe} (${Object.keys(fresh.schemas ?? {}).length} schemas)\n`
    )
    return 0
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// The runtime pin (Track A) is bundled: iclone/RUNTIME_PIN.json is hand-bumped monthly
// (RESUME/guides/monthly-curated-update.md) and compiled into A/electron/runtime-pin.generated.ts.
export const RUNTIME_PIN_JSON = path.join(HERE, '..', 'RUNTIME_PIN.json')
export const RUNTIME_PIN_TARGET = path.join(APP, 'electron', 'runtime-pin.generated.ts')

export function renderRuntimePin(raw) {
  const pin = typeof raw === 'string' ? JSON.parse(raw) : raw
  const want = { sha: /^[0-9a-f]{40}$/, tarball_sha256: /^[0-9a-f]{64}$/, install_sh_sha256: /^[0-9a-f]{64}$/ }
  for (const [key, re] of Object.entries(want)) {
    if (typeof pin[key] !== 'string' || !re.test(pin[key])) throw new Error(`RUNTIME_PIN.json: bad ${key}`)
  }
  if (!/^\d+\.\d+\.\d+$/.test(pin.min_app ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(pin.date ?? '')) {
    throw new Error('RUNTIME_PIN.json: bad min_app or date')
  }
  // V3-RT: a `source: "repo"` pin is the runtime built from this repository; the app verifies an installed runtime
  // against the bundled manifest whose sha256 is compiled in here.
  const repo = pin.source === 'repo'
  if (repo && (!/^[0-9a-f]{64}$/.test(pin.manifest_sha256 ?? '') || !Number.isInteger(pin.files))) {
    throw new Error('RUNTIME_PIN.json: bad manifest_sha256 or files')
  }
  if (repo && !/^[0-9a-f]{40}$/.test(pin.upstream ?? '')) throw new Error('RUNTIME_PIN.json: bad upstream')
  const value = {
    sha: pin.sha,
    date: pin.date,
    tarballSha256: pin.tarball_sha256,
    installShSha256: pin.install_sh_sha256,
    minApp: pin.min_app,
    verified: String(pin.verified ?? ''),
    source: repo ? 'repo' : 'upstream',
    upstream: repo ? pin.upstream : pin.sha,
    manifestSha256: repo ? pin.manifest_sha256 : '',
    files: repo ? pin.files : 0
  }
  const body = Object.entries(value)
    .map(([k, v]) => `  ${k}: ${typeof v === 'number' ? v : `'${v}'`}`)
    .join(',\n')
  return (
    '// GENERATED by iclone/contract/gen-types.mjs --runtime-pin from iclone/RUNTIME_PIN.json. Do not edit.\n' +
    'export const RUNTIME_PIN = {\n' +
    body +
    '\n} as const\n'
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.runtimePin) {
    // One truth: the pin's `verified` restates the verdict extract.mjs computed for its rev, never a hand-typed one.
    const pinText = fs.readFileSync(RUNTIME_PIN_JSON, 'utf8')
    const computed = readJson(path.join(HERE, 'runtime.lock.json'))?.verifiedAgainst?.result
    if (JSON.parse(pinText).verified !== computed) {
      process.stderr.write(`gen-types: RUNTIME_PIN.json verified must be the lock's computed ${computed}\n`)
      process.exitCode = 1
      return
    }
    fs.writeFileSync(RUNTIME_PIN_TARGET, renderRuntimePin(pinText))
    process.stderr.write(`gen-types: RUNTIME_PIN.json -> ${path.relative(process.cwd(), RUNTIME_PIN_TARGET)}\n`)
    return
  }
  if (args.check) {
    process.exitCode = await check(args.runtime).catch(err => {
      process.stderr.write(`gen-types --check: could not run: ${err.message}\n`)
      return 2
    })
    return
  }
  const files = args.spec.length ? args.spec : [path.join(HERE, 'runtime.spec.json')]
  const specs = files.map(readJson)
  const text = await render(specs)
  const out = path.resolve(args.out ?? TARGET)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, text)
  process.stderr.write(`gen-types: ${specs.length} spec(s) -> ${path.relative(process.cwd(), out)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
