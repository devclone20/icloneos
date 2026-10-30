#!/usr/bin/env node
// Consumer-contract extractor (RESUME/contracts/P4_upstream.md §3.1). Reads the app's code, never the runtime, and
// writes the reviewed lock (runtime.lock.json), the unreviewed call-site file, lock.generated.ts and extract-report.json.
//
//   node iclone/contract/extract.mjs [--app <apps/desktop-like dir>] [--out <dir>] [--cache <dir>] [--allow <json>]
//
// Sources: the renderer TS Program (tsconfig.json), the electron TS Program (tsconfig.electron.json) and a syntactic
// pass over every shipped .js/.mjs/.cjs. Method recall is a sink fixpoint: the seeds are the gateway client's `request`
// (the type behind `$gateway.get()`) and the plugin SDK's `host.request`/`host.requestProfile`; any function that
// forwards one of its parameters into a sink's method slot becomes a sink itself. Names come from checker literal
// types (as const descriptors, unions, conditionals); a non-literal that cannot be traced is reported as unresolved.
// A sink found by its shape alone (`method`, `params`) is unseeded, and so is every wrapper of it: those only yield
// runtime-shaped names (NAME_RE). Functions that speak another JSON-RPC (the chain clients) are excluded by name in
// extract-allow.json `sinks`, and an exclusion that matches no function fails the run.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GENERATOR = 'iclone/contract/extract.mjs@1'
const CACHE_SALT = `${GENERATOR}#16`
const NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/
const TEST_RE = /\.(test|spec|test-d|stories)\.[cm]?[jt]sx?$/
const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', 'fixtures', 'e2e', '__mocks__', 'dist', 'build'])
const GENERATED = new Set(['src/types/runtime-contract.generated.ts', 'electron/iclone-compat/lock.generated.ts'])
const JS_EXT = /\.(js|mjs|cjs)$/
const EVENT_CALLS = new Set([
  'on',
  'once',
  'off',
  'subscribe',
  'unsubscribe',
  'onEvent',
  'addListener',
  'removeListener'
])
const DISCRIMINANT_RE = /(?:^|\.)(?:type|event|eventType|eventName|evt|kind)$/
const ENGINE_DEPS = {
  openrpc: 'apps/shared/src/gateway-contract.openrpc.json',
  health: '/api/health#commit',
  schemaVersion: 'hermes_state_common.py#SCHEMA_VERSION',
  configVersion: 'hermes_cli/config_defaults.py#_config_version',
  receipt: ['outcome', 'pre_update.sha', 'post_update.sha', 'steps']
}

// ------------------------------------------------------------------ args, paths, inputs

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`)
    out[a.slice(2)] = argv[++i]
  }
  return out
}

const ARGS = parseArgs(process.argv.slice(2))
const APP = path.resolve(ARGS.app ?? path.join(HERE, '..', '..', 'apps', 'desktop'))
const OUT = ARGS.out ? path.resolve(ARGS.out) : null
const CACHE = path.resolve(ARGS.cache ?? path.join(APP, 'node_modules', '.cache', 'iclone-contract'))
const requireApp = createRequire(path.join(APP, 'package.json'))
const posix = p => p.split(path.sep).join('/')
const rel = p => posix(path.relative(APP, p))
const sha = s => crypto.createHash('sha256').update(s).digest('hex')
const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}
const ALLOW = readJson(ARGS.allow ? path.resolve(ARGS.allow) : path.join(HERE, 'extract-allow.json'), {})
// `${file}#${fn}` of functions that send another protocol's JSON-RPC: never a sink, never a wrapper.
const SINK_EXCLUDE = new Set((ALLOW.sinks ?? []).map(e => `${e.file}#${e.fn}`))

function shippedFiles() {
  const out = []
  for (const top of ['src', 'electron']) {
    const walk = dir => {
      let ents = []
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full)
        } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name) && !e.name.endsWith('.d.ts') && !TEST_RE.test(e.name)) {
          if (!GENERATED.has(rel(full))) out.push(full)
        }
      }
    }
    walk(path.join(APP, top))
  }
  return out
}

// Provider names known to the pinned spec: only used by the orphan net and to type event literals.
function universe() {
  const spec = readJson(path.join(HERE, 'runtime.spec.json'), {})
  const names = v => (Array.isArray(v) ? v.map(x => (typeof x === 'string' ? x : x.name)) : Object.keys(v ?? {}))
  const srs = names(spec.serverRequests)
  return {
    methods: new Set([...names(spec.methods), ...srs.map(s => `${s}.respond`)]),
    events: new Set([...names(spec.notifications), ...srs.map(s => `${s}.request`)])
  }
}

// The app's server-request policy (src/lib/server-requests/policy.ts, contract P4c D5/D6): read as text, never
// imported. declineOk maps each method to the JSON-RPC error code it is declined with.
function serverRequestPolicy() {
  const out = { advertises: false, handled: [], declineOk: {}, answersUnknown: false }
  let src
  try {
    src = fs.readFileSync(path.join(APP, 'src/lib/server-requests/policy.ts'), 'utf8')
  } catch {
    return out
  }
  const table = src.match(/SERVER_REQUEST_POLICY[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/)?.[1] ?? ''
  const windowOwned = src.match(/WINDOW_OWNED_METHODS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? ''
  const owned = new Set([...windowOwned.matchAll(/'([^']+)'/g)].map(m => m[1]))
  for (const m of table.matchAll(/'?([a-z][a-z0-9_.]*)'?\s*:\s*'(handled|declineOk)'/g)) {
    if (m[2] === 'handled') out.handled.push(m[1])
    else out.declineOk[m[1]] = owned.has(m[1]) ? 4404 : -32601
  }
  out.handled.sort()
  out.declineOk = Object.fromEntries(Object.entries(out.declineOk).sort(([a], [b]) => a.localeCompare(b)))
  const handledAll = out.handled.length + Object.keys(out.declineOk).length > 0
  out.advertises = handledAll && /ADVERTISES_SERVER_REQUESTS\s*=\s*true\b/.test(src)
  out.answersUnknown = /ANSWERS_UNKNOWN_SERVER_REQUESTS\s*=\s*true\b/.test(src)
  return out
}

// ------------------------------------------------------------------ shared syntactic helpers

function strip(ts, e) {
  while (
    e &&
    (ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isTypeAssertionExpression(e) ||
      (ts.isSatisfiesExpression && ts.isSatisfiesExpression(e)))
  ) {
    e = e.expression
  }
  return e
}

const textOf = (ts, e) => (e ? e.getText().replace(/\?\./g, '.').replace(/\s+/g, '') : '')
const calleeName = (ts, c) => {
  const e = strip(ts, c.expression)
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression.text
  return null
}
function ipcKind(ts, c) {
  const e = strip(ts, c.expression)
  if (!ts.isPropertyAccessExpression(e) || !c.arguments.length) return null
  const name = e.name.text
  const obj = textOf(ts, strip(ts, e.expression))
  if (/(^|\.)ipcMain$/.test(obj)) return /^(handle|handleOnce|on|once)$/.test(name) ? 'main' : null
  if (/(^|\.)ipcRenderer$/.test(obj)) return 'ref'
  return name === 'send' && /webContents|win|window|sender/i.test(obj) ? 'push' : null
}
const isFn = (ts, n) =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isConstructorDeclaration(n)

function fnName(ts, f) {
  if (f.name && ts.isIdentifier(f.name)) return f.name.text
  const p = f.parent
  if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && ts.isIdentifier(p.name)) return p.name.text
  return null
}

function templatePattern(ts, n) {
  if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) return n.text
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map(s => `{}${s.literal.text}`).join('')
  return null
}

// One walk per file collects every fact that does not need the checker. Pure function of (path, text): cacheable.
function syntacticFacts(ts, file, sf) {
  const r = rel(file)
  const isElectron = r.startsWith('electron/')
  const f = {
    literals: [],
    groups: [],
    codes: [],
    rest: [],
    serve: [],
    env: [],
    disk: [],
    ipcMain: [],
    ipcPush: [],
    ipcRef: [],
    preloads: []
  }
  // A file-level dual-path guard (contract P4c D2): a comment naming `guardedBy <method>` says every call in the file
  // runs only against a runtime that does not serve that method.
  f.guardedBy = sf.text.match(/(?:\/\/|\/\*|^\s*\*)[^\n]*?\bguardedBy\s+`?([a-z][\w.]*\w)`?/m)?.[1] ?? null
  // The inverse, per call site (contract P4c D2, lead ruling: a comment `requires <method>` on the
  // call's line or up to 3 lines above says that call runs only against a runtime that DOES serve <method> (the new
  // path of a dual path). Recorded as { line, method } so the aggregation can match sites to it.
  f.requires = []
  sf.text.split('\n').forEach((text, i) => {
    const m = text.match(/(?:\/\/|\/\*|^\s*\*)[^\n]*?\brequires\s+`([a-z][\w.]*\w)`/)
    if (m) f.requires.push({ line: i + 1, method: m[1] })
  })
  const line = n => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  let gid = 0
  const visit = n => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const t = n.text
      if (NAME_RE.test(t)) f.literals.push({ name: t, line: line(n), pos: eventPosition(n) })
      if (t.startsWith('/api/') || t.includes('/api/')) restSite(n)
    } else if (ts.isTemplateExpression(n)) {
      const p = templatePattern(ts, n)
      if (p && p.includes('/api/')) restSite(n)
    } else if (ts.isNumericLiteral(n)) {
      codeSite(n, Number(n.text))
    } else if (
      ts.isPrefixUnaryExpression(n) &&
      n.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(n.operand)
    ) {
      codeSite(n, -Number(n.operand.text))
    } else if (ts.isArrayLiteralExpression(n) || ts.isObjectLiteralExpression(n)) {
      const id = ++gid
      for (const el of n.elements ?? n.properties) {
        const k = ts.isObjectLiteralExpression(n) ? el.name : el
        if (k && (ts.isStringLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k)) && NAME_RE.test(k.text)) {
          f.groups.push({ id, name: k.text })
        }
      }
      if (isElectron && ts.isArrayLiteralExpression(n)) {
        const vals = n.elements.filter(e => ts.isStringLiteralLike(e)).map(e => e.text)
        if (vals.includes('serve')) f.serve.push(...vals.filter(v => v.startsWith('--')))
      }
      if (isElectron && ts.isObjectLiteralExpression(n)) {
        for (const p of n.properties) {
          const k = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : null
          if (k && /^(HERMES|PYTHON)[A-Z0-9_]*$/.test(k)) f.env.push(k)
        }
      }
    } else if (ts.isCallExpression(n)) {
      callSite(n)
    } else if (isElectron && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = n.left
      const k = ts.isPropertyAccessExpression(l)
        ? l.name.text
        : ts.isElementAccessExpression(l) && ts.isStringLiteralLike(l.argumentExpression)
          ? l.argumentExpression.text
          : null
      if (k && /^(HERMES|PYTHON)[A-Z0-9_]*$/.test(k) && /env/i.test(textOf(ts, l.expression))) f.env.push(k)
    }
    ts.forEachChild(n, visit)
  }
  function eventPosition(n) {
    const p = n.parent
    if (ts.isCaseClause(p) && p.expression === n) return DISCRIMINANT_RE.test(textOf(ts, p.parent.parent.expression))
    if (ts.isBinaryExpression(p) && /^(==|===|!=|!==)$/.test(p.operatorToken.getText(sf))) {
      return DISCRIMINANT_RE.test(textOf(ts, p.left === n ? p.right : p.left))
    }
    if (ts.isCallExpression(p) && p.arguments[0] === n) return EVENT_CALLS.has(calleeName(ts, p) ?? '')
    return false
  }
  function codeSite(n, v) {
    if (!Number.isInteger(v) || Math.abs(v) < 1000 || Math.abs(v) > 32768) return
    let p = n.parent
    if (ts.isPrefixUnaryExpression(p)) p = p.parent
    const other = ts.isBinaryExpression(p) ? (p.left === n || p.left === n.parent ? p.right : p.left) : null
    const hit =
      (other && /^(==|===|!=|!==)$/.test(p.operatorToken.getText(sf)) && /code$/i.test(textOf(ts, other))) ||
      (ts.isCaseClause(p) && /code$/i.test(textOf(ts, p.parent.parent.expression))) ||
      (ts.isPropertyAssignment(p) && /^code$/i.test(p.name.getText(sf))) ||
      (ts.isVariableDeclaration(p) && /(_CODE|Code|^ERR|ERROR)/.test(p.name.getText(sf)))
    if (hit) f.codes.push(v)
  }
  function restSite(n) {
    const p = templatePattern(ts, n)
    const i = p ? p.indexOf('/api/') : -1
    if (i < 0) return
    // Module specifiers (`./api/client`) and URLs of other hosts are not routes of the runtime's server.
    const par = n.parent
    if (par && (ts.isImportDeclaration(par) || ts.isExportDeclaration(par) || ts.isLiteralTypeNode(par))) return
    if (par && ts.isExternalModuleReference(par)) return
    if (
      par &&
      ts.isCallExpression(par) &&
      par.arguments[0] === n &&
      (par.expression.kind === ts.SyntaxKind.ImportKeyword ||
        /^(require|vi\.(mock|doMock|unmock|importActual|importMock))$/.test(textOf(ts, par.expression)))
    )
      return
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) && !/^[a-z]+:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(p)) return
    const route = p.slice(i).split('?')[0].replace(/\/+$/, '')
    if (!/^\/api\/[A-Za-z0-9_{}\-/.]*$/.test(route)) return
    let verb = 'GET'
    // The verb sits either in an options object next to the route argument (`fetch('/api/x', { method })`) or in the
    // same request descriptor as the route (`api({ path: '/api/x', method })`). Labelling only: the gate matches by path.
    const call = n.parent && ts.isCallExpression(n.parent) ? n.parent : null
    const descriptor =
      par && ts.isPropertyAssignment(par) && par.initializer === n && ts.isObjectLiteralExpression(par.parent)
        ? par.parent
        : null
    for (const a of [...(call?.arguments ?? []), ...(descriptor ? [descriptor] : [])]) {
      if (!ts.isObjectLiteralExpression(a)) continue
      for (const pr of a.properties) {
        if (ts.isPropertyAssignment(pr) && pr.name.getText(sf) === 'method' && ts.isStringLiteralLike(pr.initializer)) {
          verb = pr.initializer.text.toUpperCase()
        }
      }
    }
    f.rest.push(`${verb} ${route}`)
  }
  function callSite(c) {
    const name = calleeName(ts, c)
    const a0 = c.arguments[0]
    const chan = a0 && ts.isStringLiteralLike(a0) && !NAME_RE.test(a0.text) ? a0.text : null
    const obj = ts.isPropertyAccessExpression(strip(ts, c.expression))
      ? textOf(ts, strip(ts, c.expression).expression)
      : ''
    const kind = isElectron && chan && ipcKind(ts, c)
    if (kind) f[{ main: 'ipcMain', ref: 'ipcRef', push: 'ipcPush' }[kind]].push(chan)
    if (isElectron && (name === 'join' || name === 'resolve') && /^path$/.test(obj) && a0) {
      // `preload: path.join(dir, 'x.cjs')` names a renderer preload that lives outside electron/ (paired by basename).
      const last = c.arguments[c.arguments.length - 1]
      if (
        ts.isPropertyAssignment(c.parent) &&
        c.parent.name.getText(sf) === 'preload' &&
        ts.isStringLiteralLike(last)
      ) {
        f.preloads.push(path.posix.basename(last.text))
      }
      if (/hermes_?home|hermeshome|home(dir)?\(\)?$/i.test(textOf(ts, a0)) && /hermes/i.test(textOf(ts, a0))) {
        const segs = c.arguments.slice(1)
        if (segs.length && segs.every(s => ts.isStringLiteralLike(s))) f.disk.push(segs.map(s => s.text).join('/'))
      }
    }
  }
  visit(sf)
  return f
}

// ------------------------------------------------------------------ sink fixpoint (TS checker)

function kindOf(ts, checker, t) {
  if (!t) return 'opaque'
  if (t.isUnion()) {
    const ks = [...new Set(t.types.map(x => kindOf(ts, checker, x)).filter(k => k !== 'undefined'))].sort()
    return ks.length ? ks.join('|') : 'undefined'
  }
  const F = ts.TypeFlags
  if (t.flags & (F.Any | F.Unknown)) return 'opaque'
  if (t.flags & F.StringLike) return 'string'
  if (t.flags & F.NumberLike) return 'number'
  if (t.flags & F.BooleanLike) return 'boolean'
  if (t.flags & F.Undefined || t.flags & F.Void) return 'undefined'
  if (t.flags & F.Null) return 'null'
  if (checker.isArrayType?.(t) || checker.isTupleType?.(t)) return 'array'
  return 'object'
}

function hasUndefined(ts, t) {
  return (
    !!t && (t.flags & ts.TypeFlags.Undefined || (t.isUnion() && t.types.some(x => x.flags & ts.TypeFlags.Undefined)))
  )
}

function literalNames(ts, t) {
  if (!t) return null
  const parts = t.isUnion() ? t.types : [t]
  if (!parts.length || !parts.every(x => x.isStringLiteral())) return null
  return parts.map(x => x.value)
}

function tsPass(ts, configs, files, facts) {
  const fileSet = new Set(files.filter(f => !JS_EXT.test(f)))
  const sites = [] // {file, line, names[], params, reads[], js:false}
  const unresolved = []
  const ipc = { main: [], push: [], ref: [], unresolved: [] }
  const excludedHit = new Set()
  const seen = new Set()
  for (const cfgPath of configs) {
    const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }
    const cfg = ts.getParsedCommandLineOfConfigFile(cfgPath, {}, host)
    if (!cfg) continue
    const opts = { ...cfg.options, noEmit: true, composite: false, declaration: false, incremental: false }
    const program = ts.createProgram({ rootNames: cfg.fileNames, options: opts })
    const checker = program.getTypeChecker()
    trace(`program ${path.basename(cfgPath)}`)
    const mine = program
      .getSourceFiles()
      .filter(sf => fileSet.has(path.resolve(sf.fileName)) && !seen.has(path.resolve(sf.fileName)))
    for (const sf of mine) seen.add(path.resolve(sf.fileName))
    // An IPC channel argument resolves through its type (const ids, imported consts, literal unions); a const
    // annotated `: string` falls back to its initializer.
    const channelValues = arg => {
      if (!arg) return null
      const t = checker.getTypeAtLocation(arg)
      const parts = t.isUnion() ? t.types : [t]
      if (parts.every(p => p.isStringLiteral())) return parts.map(p => p.value)
      const d = resolveSym(ts.isPropertyAccessExpression(arg) ? arg.name : arg)?.valueDeclaration
      const init = d && ts.isVariableDeclaration(d) && ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const && d.initializer
      return init && ts.isStringLiteralLike(strip(ts, init)) ? [strip(ts, init).text] : null
    }
    const resolveSym = node => {
      let s = node && checker.getSymbolAtLocation(node)
      if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s)
      return s
    }
    // seeds
    const sinks = new Map()
    const addSink = (decl, info) => {
      if (!decl || sinks.has(decl)) return false
      sinks.set(decl, info)
      return true
    }
    const methodIdx = d => {
      const ps = d.parameters ?? d.type?.parameters ?? d.initializer?.parameters ?? []
      const i = ps.findIndex(p => ts.isIdentifier(p.name) && p.name.text === 'method')
      return i < 0 ? 0 : i
    }
    const seedFrom = (modRel, exportName, chain) => {
      const sf = program.getSourceFile(path.join(APP, modRel))
      const ms = sf && checker.getSymbolAtLocation(sf)
      const ex = ms && checker.getExportsOfModule(ms).find(s => s.name === exportName)
      if (!ex) return
      let t = checker.getTypeOfSymbolAtLocation(ex, sf)
      for (const step of chain) {
        if (step === '()') t = checker.getNonNullableType(t.getCallSignatures()[0]?.getReturnType() ?? t)
        else {
          const p = t.getProperty(step)
          if (!p) return
          if (step === chain[chain.length - 1] || chain[chain.length - 1] === '*') {
            for (const d of p.declarations ?? []) addSink(d, { m: methodIdx(d), p: methodIdx(d) + 1, name: step })
            return
          }
          t = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(p, sf))
        }
      }
    }
    seedFrom('src/store/gateway.ts', '$gateway', ['get', '()', 'request'])
    seedFrom('src/sdk/index.ts', 'host', ['request'])
    seedFrom('src/sdk/index.ts', 'host', ['requestProfile'])
    const calls = []
    const props = new Map()
    for (const sf of mine) {
      const walk = n => {
        if (ts.isCallExpression(n)) calls.push(n)
        else if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && ts.isIdentifier(n.name)) {
          ;(props.get(n.name.text) ?? props.set(n.name.text, []).get(n.name.text)).push(n)
        }
        ts.forEachChild(n, walk)
      }
      walk(sf)
    }
    const evalNames = (e, depth = 0) => {
      e = strip(ts, e)
      if (!e || depth > 6) return { unresolved: true }
      if (ts.isStringLiteralLike(e)) return { names: [e.text] }
      const lit = literalNames(ts, checker.getTypeAtLocation(e))
      if (lit) return { names: lit }
      if (ts.isConditionalExpression(e))
        return merge(evalNames(e.whenTrue, depth + 1), evalNames(e.whenFalse, depth + 1))
      if (ts.isBinaryExpression(e) && /^(\?\?|\|\|)$/.test(e.operatorToken.getText())) {
        return merge(evalNames(e.left, depth + 1), evalNames(e.right, depth + 1))
      }
      if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
        const s = resolveSym(ts.isIdentifier(e) ? e : e.name)
        const d = s?.valueDeclaration
        if (d && ts.isParameter(d) && isFn(ts, d.parent)) return { param: d.parent.parameters.indexOf(d), fn: d.parent }
        if (d && ts.isBindingElement(d)) {
          let p = d.parent
          while (p && !ts.isParameter(p)) p = ts.isBindingElement(p) || ts.isObjectBindingPattern(p) ? p.parent : null
          if (p && isFn(ts, p.parent)) {
            const prop = (d.propertyName ?? d.name).getText()
            return { param: p.parent.parameters.indexOf(p), fn: p.parent, prop }
          }
        }
        if (d && (ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d)) && d.initializer) {
          return evalNames(d.initializer, depth + 1)
        }
      }
      return { unresolved: true }
    }
    const merge = (a, b) =>
      a.names && b.names
        ? { names: [...a.names, ...b.names] }
        : a.unresolved || b.unresolved
          ? { unresolved: true }
          : a.names
            ? b
            : a
    const paramsShape = e => {
      e = strip(ts, e)
      if (!e) return {}
      if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
        const body = ts.isBlock(e.body) ? e.body.statements.find(st => ts.isReturnStatement(st))?.expression : e.body
        return body ? paramsShape(body) : 'opaque'
      }
      const out = {}
      if (ts.isObjectLiteralExpression(e)) {
        for (const p of e.properties) {
          if (ts.isSpreadAssignment(p)) {
            const t = checker.getTypeAtLocation(p.expression)
            for (const s of t.getProperties())
              out[`${s.name}?`] = kindOf(ts, checker, checker.getTypeOfSymbolAtLocation(s, p))
            continue
          }
          if (!p.name || ts.isComputedPropertyName(p.name)) return 'opaque'
          const t = checker.getTypeAtLocation(ts.isShorthandPropertyAssignment(p) ? p.name : (p.initializer ?? p))
          out[p.name.getText().replace(/^['"]|['"]$/g, '') + (hasUndefined(ts, t) ? '?' : '')] = kindOf(ts, checker, t)
        }
        return out
      }
      const t = checker.getNonNullableType(checker.getTypeAtLocation(e))
      if (t.getStringIndexType() || t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return 'opaque'
      const props = t.getProperties()
      if (!props.length || props.length > 60) return 'opaque'
      for (const s of props) {
        const st = checker.getTypeOfSymbolAtLocation(s, e)
        out[s.name + (s.flags & ts.SymbolFlags.Optional || hasUndefined(ts, st) ? '?' : '')] = kindOf(ts, checker, st)
      }
      return out
    }
    const resultReads = call => {
      let n = call
      while (
        n.parent &&
        (ts.isAwaitExpression(n.parent) ||
          ts.isParenthesizedExpression(n.parent) ||
          ts.isAsExpression(n.parent) ||
          ts.isNonNullExpression(n.parent))
      )
        n = n.parent
      const p = n.parent
      const reads = new Set()
      // A call that resolves to the JSON-RPC response frame: `.result`/`.error` are the envelope, not result fields.
      const awaited = checker.getAwaitedType(checker.getTypeAtLocation(call))
      const envelope =
        awaited &&
        awaited.getProperty('result') &&
        checker
          .getNonNullableType(
            checker.getTypeOfSymbolAtLocation(awaited.getProperty('error') ?? awaited.getProperty('result'), call)
          )
          .getProperty('code')
      if (p && ts.isPropertyAccessExpression(p) && p.expression === n)
        reads.add(p.name.text + (p.questionDotToken ? '?' : ''))
      if (p && ts.isVariableDeclaration(p) && p.initializer === n) {
        if (ts.isObjectBindingPattern(p.name)) {
          for (const el of p.name.elements) reads.add((el.propertyName ?? el.name).getText())
        } else if (ts.isIdentifier(p.name)) {
          const sym = checker.getSymbolAtLocation(p.name)
          let scope = p.parent
          while (scope && !isFn(ts, scope) && !ts.isSourceFile(scope)) scope = scope.parent
          const walk = x => {
            if (
              ts.isPropertyAccessExpression(x) &&
              ts.isIdentifier(x.expression) &&
              x.expression.text === p.name.text
            ) {
              if (checker.getSymbolAtLocation(x.expression) === sym)
                reads.add(x.name.text + (x.questionDotToken ? '?' : ''))
            }
            ts.forEachChild(x, walk)
          }
          if (scope) walk(scope)
        }
      }
      // `.then`/`.catch`/`.finally` read the pending promise, not the result (a thenable result cannot be awaited).
      return [...reads].filter(
        r => !/^(then|catch|finally)\??$/.test(r) && !(envelope && /^(result|error)\??$/.test(r))
      )
    }
    // Fixpoint: sweep every call until no new sink appears. A call is a sink when its callee's declaration or its
    // resolved signature's declaration is a sink, or when its signature is RPC-shaped (`method` then `params`).
    const isOurs = d => !d.getSourceFile().fileName.includes('/node_modules/')
    // RPC-shaped signature: a `method` parameter. Strict when `params` follows (full wrapper semantics); relaxed
    // otherwise (descriptor builders such as `rpc(method, build)`): only literal names are taken from those, and only
    // when the body stores `method` as an object-literal value. A relaxed function that merely formats or logs its
    // `method` is not a sink; one that forwards it into a sink becomes a wrapper through the fixpoint instead.
    const shape = names => {
      const i = names.indexOf('method')
      if (i < 0) return null
      const strict = i + 1 < names.length && /^(params?|payload|args)$/.test(names[i + 1])
      return { m: i, p: strict ? i + 1 : -1, structural: strict ? 'strict' : 'relaxed' }
    }
    const describes = new Map()
    const storesMethod = d => {
      if (describes.has(d)) return describes.get(d)
      const fn = isFn(ts, d) ? d : d.initializer && isFn(ts, strip(ts, d.initializer)) ? strip(ts, d.initializer) : null
      const p = fn?.parameters.find(x => ts.isIdentifier(x.name) && x.name.text === 'method')
      const sym = p && checker.getSymbolAtLocation(p.name)
      let hit = false
      const isParam = e => ts.isIdentifier(e) && checker.getSymbolAtLocation(e) === sym
      const walk = n => {
        if (hit) return
        if (ts.isShorthandPropertyAssignment(n)) hit = checker.getShorthandAssignmentValueSymbol(n) === sym
        else if (ts.isPropertyAssignment(n) && isParam(strip(ts, n.initializer))) hit = true
        if (!hit) ts.forEachChild(n, walk)
      }
      if (sym && fn.body) walk(fn.body)
      describes.set(d, hit)
      return hit
    }
    // A declaration (function, or the variable/property holding one) listed in extract-allow.json `sinks`.
    const excluded = d => {
      const fn = isFn(ts, d) ? d : d.initializer && isFn(ts, strip(ts, d.initializer)) ? strip(ts, d.initializer) : null
      const key = fn && `${rel(d.getSourceFile().fileName)}#${fnName(ts, fn)}`
      if (!key || !SINK_EXCLUDE.has(key)) return false
      excludedHit.add(key)
      return true
    }
    const rpcShape = (d, names) => {
      if (excluded(d)) return null
      const s = shape(names)
      return s && (s.structural === 'strict' || storesMethod(d)) ? s : null
    }
    // A `(method, params)` implementation that only returns a record holding `method` (never passes it to a call)
    // builds data; it does not send.
    const buildsRecord = d => {
      const fn = isFn(ts, d) ? d : d.initializer && isFn(ts, strip(ts, d.initializer)) ? strip(ts, d.initializer) : null
      const p = fn?.body && fn.parameters.find(x => ts.isIdentifier(x.name) && x.name.text === 'method')
      const sym = p && checker.getSymbolAtLocation(p.name)
      if (!sym) return false
      let forwarded = false
      let returned = false
      const isParam = e => ts.isIdentifier(e) && checker.getSymbolAtLocation(e) === sym
      const walk = n => {
        if (forwarded) return
        if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && (n.arguments ?? []).some(a => isParam(strip(ts, a))))
          forwarded = true
        else if (ts.isObjectLiteralExpression(n) && (ts.isReturnStatement(n.parent) || n.parent === fn.body)) {
          returned ||= n.properties.some(pr =>
            ts.isShorthandPropertyAssignment(pr)
              ? checker.getShorthandAssignmentValueSymbol(pr) === sym
              : ts.isPropertyAssignment(pr) && isParam(strip(ts, pr.initializer))
          )
        }
        ts.forEachChild(n, walk)
      }
      walk(fn.body)
      return returned && !forwarded
    }
    // `params` (a parameter with a default) or `{ ...params, profile }` forwards the wrapper's own params parameter.
    const spreadParam = (arg, fn) => {
      const o = arg && strip(ts, arg)
      const own = d => (d && ts.isParameter(d) && d.parent === fn ? fn.parameters.indexOf(d) : -1)
      if (o && ts.isIdentifier(o)) return own(resolveSym(o)?.valueDeclaration)
      if (!o || !ts.isObjectLiteralExpression(o)) return -1
      for (const pr of o.properties) {
        if (!ts.isSpreadAssignment(pr)) continue
        const d = resolveSym(strip(ts, pr.expression))?.valueDeclaration
        if (d && ts.isParameter(d) && d.parent === fn) return fn.parameters.indexOf(d)
      }
      return -1
    }
    // A descriptor factory's params builder: its one parameter typed as a function returning a record.
    const builderParam = fn =>
      fn.parameters.findIndex(
        pr => pr.type && ts.isFunctionTypeNode(pr.type) && /^(Record<|\{)/.test(pr.type.type.getText())
      )
    const paramNames = d => {
      const ps =
        d.parameters ??
        d.type?.parameters ??
        (d.initializer && isFn(ts, d.initializer) ? d.initializer.parameters : null)
      return ps ? ps.map(p => (ts.isIdentifier(p.name) ? p.name.text : '')) : null
    }
    const sinkInfoFor = call => {
      if (!call.arguments.length) return null
      const callee = strip(ts, call.expression)
      const nameNode = ts.isPropertyAccessExpression(callee)
        ? callee.name
        : ts.isElementAccessExpression(callee)
          ? callee.argumentExpression
          : callee
      const decls = resolveSym(nameNode)?.declarations ?? []
      let needType = !decls.length
      for (const d of decls) if (sinks.has(d)) return sinks.get(d)
      for (const d of decls) {
        const pn = paramNames(d)
        if (!pn) needType = true
        else if (isOurs(d) && rpcShape(d, pn) && !buildsRecord(d)) return rpcShape(d, pn)
      }
      if (!needType) return null
      for (const sig of checker.getTypeAtLocation(callee).getCallSignatures()) {
        const d = sig.declaration
        if (d && sinks.has(d)) return sinks.get(d)
        const s =
          d &&
          isOurs(d) &&
          !buildsRecord(d) &&
          rpcShape(
            d,
            sig.parameters.map(p => p.name)
          )
        if (s) return s
      }
      return null
    }
    const restForward = (call, idx) => {
      const sp = call.arguments.findIndex(x => ts.isSpreadElement(x))
      if (sp < 0 || sp > idx) return null
      const s = resolveSym(strip(ts, call.arguments[sp].expression))?.valueDeclaration
      if (!s || !ts.isParameter(s) || !s.dotDotDotToken || !isFn(ts, s.parent)) return null
      return { fn: s.parent, param: s.parent.parameters.indexOf(s) + idx - sp }
    }
    trace('indexed')
    const register = (fn, info) => {
      if (excluded(fn)) return false
      let added = addSink(fn, info)
      if (fn.parent && (ts.isVariableDeclaration(fn.parent) || ts.isPropertyAssignment(fn.parent))) {
        added = addSink(fn.parent, info) || added
      }
      return added
    }
    const done = new Set()
    const descriptors = new Map()
    for (let sweep = 0, changed = true; changed && sweep < 6; sweep++) {
      changed = false
      for (const call of calls) {
        if (done.has(call)) continue
        const info = sinkInfoFor(call)
        if (!info) continue
        done.add(call)
        const sf = call.getSourceFile()
        const site = { file: rel(sf.fileName), line: sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1 }
        let arg = call.arguments[info.m]
        if (arg && info.prop) {
          const a = strip(ts, arg)
          const pa = ts.isObjectLiteralExpression(a) && a.properties.find(p => p.name?.getText() === info.prop)
          if (pa) arg = ts.isShorthandPropertyAssignment(pa) ? pa.name : pa.initializer
          else {
            const ps = checker.getTypeAtLocation(a).getProperty(info.prop)
            const lit = ps && literalNames(ts, checker.getTypeOfSymbolAtLocation(ps, a))
            if (lit) {
              sites.push({ ...site, names: lit, params: 'opaque', reads: resultReads(call), sink: info, call })
              continue
            }
            arg = null
          }
        }
        const v = restForward(call, info.m) ?? (arg ? evalNames(arg) : { unresolved: true })
        if (info.structural === 'relaxed' && !v.names) continue
        if (v.names) {
          const names = [...new Set(v.names)]
          const pArg = info.p >= 0 ? call.arguments[info.p] : undefined
          const configKeys = []
          const o = pArg && strip(ts, pArg)
          if (names.some(n => n.startsWith('config.')) && o && ts.isObjectLiteralExpression(o)) {
            for (const pr of o.properties) {
              if (ts.isPropertyAssignment(pr) && pr.name.getText() === 'key')
                configKeys.push(...(evalNames(pr.initializer).names ?? []))
            }
          }
          sites.push({
            ...site,
            names,
            params: paramsShape(pArg),
            reads: resultReads(call),
            configKeys,
            sink: info,
            call
          })
        } else if (v.fn) {
          const pv = info.p >= 0 && call.arguments[info.p] ? evalNames(call.arguments[info.p]) : {}
          const fwd = info.p >= 0 ? restForward(call, info.p) : null
          let pIdx = fwd?.fn === v.fn ? fwd.param : pv.fn === v.fn ? pv.param : -1
          if (pIdx < 0 && info.p >= 0) pIdx = spreadParam(call.arguments[info.p], v.fn)
          // Provenance: the forwarding CALLS, re-resolved after the fixpoint (see `seeded` below), never the sink info
          // seen now — a callee declared later in the file may only become a seeded wrapper in a later sweep.
          const wrapperInfo = { m: v.param, p: pIdx, prop: v.prop, via: new Set([call]) }
          // A wrapper with several dispatch branches registers on the first one walked; a later branch that does
          // forward the caller's params must still win, or every caller of the wrapper reads as params {}.
          const prev = sinks.get(v.fn)
          if (prev?.via && !prev.via.has(call)) {
            for (const s of new Set([prev, sinks.get(v.fn.parent)])) s?.via?.add(call)
          }
          if (prev && prev.p < 0 && pIdx >= 0 && prev.m === v.param && prev.prop === v.prop && !prev.structural) {
            for (const s of [prev, sinks.get(v.fn.parent)]) if (s && s.p < 0) s.p = pIdx
            changed = true
          } else changed = register(v.fn, wrapperInfo) || changed
        } else {
          const a = arg && strip(ts, arg)
          const pd = a && ts.isPropertyAccessExpression(a) ? resolveSym(a.name)?.declarations?.filter(isOurs) : null
          if (pd?.length && pd.every(d => ts.isPropertySignature(d) || ts.isPropertyDeclaration(d))) {
            for (const d of pd) if (!descriptors.has(d)) descriptors.set(d, { name: a.name.text, done: false })
            continue
          }
          let f = call.parent
          while (f && !isFn(ts, f)) f = f.parent
          unresolved.push({ ...site, fn: (f && fnName(ts, f)) ?? '<module>' })
        }
      }
      // Descriptor properties: every object-literal member contextually typed by a property that reaches a sink.
      for (const [decl, dsc] of descriptors) {
        if (dsc.done) continue
        dsc.done = true
        for (const pa of props.get(dsc.name) ?? []) {
          const ct = checker.getContextualType(pa.parent)
          const members = ct ? (ct.isUnion() ? ct.types : [ct]) : []
          if (!members.some(t => t.getProperty(dsc.name)?.declarations?.includes(decl))) continue
          const sf = pa.getSourceFile()
          const site = { file: rel(sf.fileName), line: sf.getLineAndCharacterOfPosition(pa.getStart(sf)).line + 1 }
          const v = evalNames(ts.isShorthandPropertyAssignment(pa) ? pa.name : pa.initializer)
          if (v.names) sites.push({ ...site, names: [...new Set(v.names)], params: 'opaque', reads: [] })
          else if (v.fn)
            changed = register(v.fn, { m: v.param, p: builderParam(v.fn), structural: 'relaxed' }) || changed
          else unresolved.push({ ...site, fn: dsc.name })
        }
      }
    }
    trace('sweeps')
    // A sink is seeded when it is a seed, or a wrapper that forwards into a seeded sink; a shape-only sink and its
    // wrappers are not. Names reaching an unseeded sink are kept only when they look like runtime names, so another
    // protocol's JSON-RPC client (`eth_call`) never enters the lock while `ping` through the gateway still does.
    const seeded = (info, seen = new Set()) => {
      if (!info || info.structural) return false
      if (!info.via) return true
      if (seen.has(info)) return false
      seen.add(info)
      return [...info.via].some(c => seeded(sinkInfoFor(c), seen))
    }
    // A name the pinned runtime serves is runtime demand whatever sink it reached (bare `ping` included).
    const served = universe().methods
    // Judged after the fixpoint: a callee first met by its shape may have become a seeded wrapper in a later sweep.
    for (let i = sites.length - 1; i >= 0; i--) {
      const { sink, call, ...site } = sites[i]
      const ok = !sink || seeded(sink) || seeded(sinkInfoFor(call))
      site.names = ok ? site.names : site.names.filter(n => NAME_RE.test(n) || served.has(n))
      if (site.names.length) sites[i] = site
      else sites.splice(i, 1)
    }
    for (const call of calls) {
      const sf = call.getSourceFile()
      const file = rel(sf.fileName)
      const kind = file.startsWith('electron/') && ipcKind(ts, call)
      if (!kind || (kind === 'ref' && file !== 'electron/preload.ts')) continue
      const chans = channelValues(call.arguments[0])
      const line = sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1
      if (!chans) ipc.unresolved.push({ file, line, kind })
      else for (const c of chans) if (!NAME_RE.test(c)) ipc[kind].push(c)
    }
    trace('ipc')
  }
  for (const k of ['main', 'push', 'ref']) ipc[k] = [...new Set(ipc[k])].sort()
  return { sites, unresolved, ipc, excludedHit: [...excludedHit].sort() }
}

// ------------------------------------------------------------------ JS pass (syntactic, file-local fixpoint)

function jsPass(ts, file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const r = rel(file)
  const consts = new Map()
  const fnsByName = new Map()
  const calls = new Map()
  const walk = n => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) consts.set(n.name.text, n.initializer)
    if (isFn(ts, n)) {
      const nm = fnName(ts, n)
      if (nm) (fnsByName.get(nm) ?? fnsByName.set(nm, []).get(nm)).push(n)
    }
    if (ts.isCallExpression(n)) {
      const nm = calleeName(ts, n)
      if (nm) (calls.get(nm) ?? calls.set(nm, []).get(nm)).push(n)
    }
    ts.forEachChild(n, walk)
  }
  walk(sf)
  const enclosingParam = id => {
    for (let p = id.parent; p; p = p.parent) {
      if (isFn(ts, p)) {
        const i = p.parameters.findIndex(x => ts.isIdentifier(x.name) && x.name.text === id.text)
        if (i >= 0) return { fn: p, param: i }
      }
    }
    return null
  }
  const evalJs = (e, depth = 0) => {
    e = strip(ts, e)
    if (!e || depth > 6) return { unresolved: true }
    if (ts.isStringLiteralLike(e)) return { names: [e.text] }
    if (ts.isConditionalExpression(e)) return mergeJs(evalJs(e.whenTrue, depth + 1), evalJs(e.whenFalse, depth + 1))
    if (ts.isBinaryExpression(e) && /^(\?\?|\|\|)$/.test(e.operatorToken.getText(sf))) {
      return mergeJs(evalJs(e.left, depth + 1), evalJs(e.right, depth + 1))
    }
    if (ts.isIdentifier(e)) {
      const p = enclosingParam(e)
      if (p) return p
      if (consts.has(e.text)) return evalJs(consts.get(e.text), depth + 1)
    }
    if (ts.isPropertyAccessExpression(e)) {
      const chain = []
      let x = e
      while (ts.isPropertyAccessExpression(x)) {
        chain.unshift(x.name.text)
        x = strip(ts, x.expression)
      }
      let obj = ts.isIdentifier(x) ? strip(ts, consts.get(x.text)) : null
      for (const k of chain) {
        const pa = obj && ts.isObjectLiteralExpression(obj) && obj.properties.find(p => p.name?.getText(sf) === k)
        obj = pa && ts.isPropertyAssignment(pa) ? strip(ts, pa.initializer) : null
      }
      if (obj) return evalJs(obj, depth + 1)
    }
    return { unresolved: true }
  }
  const mergeJs = (a, b) =>
    a.names && b.names
      ? { names: [...a.names, ...b.names] }
      : a.unresolved || b.unresolved
        ? { unresolved: true }
        : a.names
          ? b
          : a
  const sinks = new Map([
    ['request', { m: 0, p: 1, seed: true }],
    ['requestProfile', { m: 1, p: 2, seed: true }]
  ])
  const sites = []
  const unresolved = []
  const queue = ['request', 'requestProfile']
  const done = new Set()
  while (queue.length) {
    const nm = queue.shift()
    const info = sinks.get(nm)
    for (const call of calls.get(nm) ?? []) {
      if (done.has(call)) continue
      const callee = strip(ts, call.expression)
      if (info.seed && !(ts.isPropertyAccessExpression(callee) && /(^|\.)host$/.test(textOf(ts, callee.expression))))
        continue
      if (!info.seed && !ts.isIdentifier(callee)) continue
      done.add(call)
      const line = sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1
      const v = call.arguments[info.m] ? evalJs(call.arguments[info.m]) : { unresolved: true }
      if (v.names)
        sites.push({
          file: r,
          line,
          names: [...new Set(v.names)],
          params: jsParams(call.arguments[info.p]),
          reads: [],
          js: true
        })
      else if (v.fn && fnName(ts, v.fn)) {
        const name = fnName(ts, v.fn)
        const pv = call.arguments[info.p] ? evalJs(call.arguments[info.p]) : {}
        if (!sinks.has(name)) {
          sinks.set(name, { m: v.param, p: pv.fn === v.fn ? pv.param : -1 })
          queue.push(name)
        }
      } else unresolved.push({ file: r, line, fn: '<js>' })
    }
  }
  function jsParams(e) {
    e = strip(ts, e)
    if (!e) return {}
    if (!ts.isObjectLiteralExpression(e)) return 'opaque'
    const out = {}
    for (const p of e.properties) {
      if (ts.isSpreadAssignment(p) || !p.name || ts.isComputedPropertyName(p.name)) return 'opaque'
      out[p.name.getText(sf).replace(/^['"]|['"]$/g, '')] = 'opaque'
    }
    return out
  }
  return { sites, unresolved, facts: syntacticFacts(ts, file, sf) }
}

// Extra renderer preloads: every file in the repo whose basename an electron `preload:` option names, outside build
// output and dependencies. Their ipcRenderer channels count as preload references (literals or file-local consts).
function extraPreloads(ts, names) {
  const repo = path.resolve(APP, '..', '..')
  const want = new Set(names)
  const skip = new Set([...SKIP_DIRS, 'venv', 'release', 'out', '__pycache__'])
  const found = []
  const walk = dir => {
    let ents = []
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!skip.has(e.name) && !e.name.startsWith('.')) walk(full)
      } else if (e.isFile() && want.has(e.name)) found.push(full)
    }
  }
  if (want.size) walk(repo)
  return found.map(file => {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const consts = new Map()
    const refs = []
    const visit = n => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        ts.isStringLiteralLike(n.initializer)
      ) {
        consts.set(n.name.text, n.initializer.text)
      }
      if (ts.isCallExpression(n) && ipcKind(ts, n) === 'ref') {
        const a0 = strip(ts, n.arguments[0])
        const chan = ts.isStringLiteralLike(a0) ? a0.text : ts.isIdentifier(a0) ? consts.get(a0.text) : null
        if (chan && !NAME_RE.test(chan)) refs.push(chan)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return { file: posix(path.relative(repo, file)), refs }
  })
}

// ------------------------------------------------------------------ assembly

function mergeParams(a, b) {
  if (a === undefined) return b
  if (a === 'opaque' || b === 'opaque')
    return a === 'opaque' && b === 'opaque' ? 'opaque' : typeof a === 'object' ? a : b
  const out = {}
  const bare = k => k.replace(/\?$/, '')
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].map(bare))
  for (const k of keys) {
    const ka = a[k] ?? a[`${k}?`]
    const kb = b[k] ?? b[`${k}?`]
    const optional = ka === undefined || kb === undefined || `${k}?` in a || `${k}?` in b
    const kinds = [...new Set([ka, kb].filter(Boolean).flatMap(x => x.split('|')))].sort().join('|')
    out[optional ? `${k}?` : k] = kinds || 'opaque'
  }
  return out
}

const T0 = Date.now()
function trace(label) {
  if (process.env.ICLONE_EXTRACT_TRACE) process.stderr.write(`[extract] ${label} ${Date.now() - T0} ms\n`)
}

const sortObj = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

async function computedResult(lock) {
  const spec = readJson(path.join(HERE, 'runtime.spec.json'), null)
  const verifyPath = path.join(HERE, '..', '..', 'apps', 'desktop', 'electron', 'iclone-compat', 'verify.ts')
  if (!spec || !fs.existsSync(verifyPath)) return 'unverified'
  try {
    const mod = await import(pathToFileURL(verifyPath).href)
    const v = mod.verify(lock, [spec])
    return `${String(v.level).toLowerCase()}:${(v.cards ?? []).length}-roots`
  } catch {
    return 'unverified'
  }
}

async function main() {
  const t0 = Date.now()
  const ts = requireApp('typescript')
  const files = shippedFiles()
  const hashes = files.map(f => [rel(f), sha(fs.readFileSync(f))])
  const configs = ['tsconfig.json', 'tsconfig.electron.json'].map(c => path.join(APP, c)).filter(c => fs.existsSync(c))
  const inputs = [
    CACHE_SALT,
    ...configs.map(c => fs.readFileSync(c, 'utf8')),
    JSON.stringify(hashes),
    JSON.stringify([...SINK_EXCLUDE].sort()),
    // The TS pass keeps any name the pinned spec serves (see `served`), so the spec's method set is an input.
    JSON.stringify([...universe().methods].sort())
  ]
  fs.mkdirSync(CACHE, { recursive: true })
  const tsKey = path.join(CACHE, `ts-${sha(inputs.join('\n'))}.json`)
  let tsRes = readJson(tsKey, null)
  const cached = !!tsRes
  if (!tsRes) {
    const r = tsPass(ts, configs, files)
    tsRes = { sites: r.sites, unresolved: r.unresolved, ipc: r.ipc, excludedHit: r.excludedHit }
    fs.writeFileSync(tsKey, JSON.stringify(tsRes))
  }
  // per-file facts: syntactic, keyed by file hash
  const perFile = []
  const jsSites = []
  const jsUnresolved = []
  for (const [i, f] of files.entries()) {
    const key = path.join(CACHE, `f-${sha(CACHE_SALT + hashes[i][1] + hashes[i][0])}.json`)
    let entry = readJson(key, null)
    if (!entry) {
      const text = fs.readFileSync(f, 'utf8')
      if (JS_EXT.test(f)) entry = jsPass(ts, f, text)
      else {
        const kind = f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        entry = { facts: syntacticFacts(ts, f, ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, kind)) }
      }
      fs.writeFileSync(key, JSON.stringify(entry))
    }
    perFile.push({ file: hashes[i][0], ...entry.facts })
    if (entry.sites) jsSites.push(...entry.sites)
    if (entry.unresolved) jsUnresolved.push(...entry.unresolved)
  }
  const uni = universe()
  const allow = ALLOW
  const waivers = readJson(path.join(HERE, 'waivers.json'), [])

  // methods
  const methods = {}
  const methodSites = {}
  const guards = new Map(perFile.map(f => [f.file, f.guardedBy ?? null]))
  const requiresBy = new Map(perFile.map(f => [f.file, f.requires ?? []]))
  const requiresOf = s => requiresBy.get(s.file)?.find(r => r.line <= s.line && r.line >= s.line - 3)?.method ?? null
  const tsNames = new Set()
  for (const s of [...tsRes.sites, ...jsSites]) {
    for (const n of s.names) {
      if (!s.js) tsNames.add(n)
      const m = (methods[n] ??= { params: undefined, resultReads: new Set(), js: true })
      m.params = mergeParams(m.params, s.params)
      for (const r of s.reads) m.resultReads.add(r)
      m.js &&= !!s.js
      ;(m.guards ??= new Set()).add(guards.get(s.file) ?? null)
      ;(m.requires ??= new Set()).add(requiresOf(s))
      ;(methodSites[n] ??= []).push(`${s.file}:${s.line}`)
    }
  }
  const lockMethods = {}
  for (const [n, m] of Object.entries(methods).sort(([a], [b]) => (a < b ? -1 : 1))) {
    lockMethods[n] = {
      params: m.params === undefined ? {} : typeof m.params === 'object' ? sortObj(m.params) : m.params,
      resultReads: [...m.resultReads].sort(),
      ...(m.js ? { via: 'js' } : {}),
      // Every call site sits behind the same dual-path guard: verify judges the method only where the guard is absent.
      ...(m.guards.size === 1 && [...m.guards][0] ? { guardedBy: [...m.guards][0] } : {}),
      // Every call site is the new path of a dual path: verify judges the method only where <method> is served.
      ...(m.requires.size === 1 && [...m.requires][0] ? { requires: [...m.requires][0] } : {})
    }
  }

  // events: event positions, provider event names, and groups dominated by either. An event POSITION in a file that
  // extract-allow.json `events` names for that literal is not evidence (a discriminant of another protocol's union,
  // e.g. AP2 mandate constraint types); a provider event name always is, so an entry can never hide a real event.
  const allowEvents = new Set((allow.events ?? []).map(e => `${e.file}#${e.name}`))
  const eventsHit = new Set()
  const isEvt = new Set()
  for (const f of perFile) {
    for (const l of f.literals) {
      const excused = l.pos && allowEvents.has(`${f.file}#${l.name}`)
      if (excused) eventsHit.add(`${f.file}#${l.name}`)
      if ((l.pos && !excused) || uni.events.has(l.name)) isEvt.add(l.name)
    }
  }
  for (const f of perFile) {
    const byGroup = new Map()
    for (const g of f.groups) (byGroup.get(g.id) ?? byGroup.set(g.id, []).get(g.id)).push(g.name)
    for (const names of byGroup.values()) {
      const strong = names.filter(n => isEvt.has(n) && !lockMethods[n]).length
      if (strong && strong * 2 >= names.length) for (const n of names) if (!lockMethods[n]) isEvt.add(n)
    }
  }
  const events = {}
  const eventSites = {}
  const orphans = []
  for (const f of perFile) {
    for (const l of f.literals) {
      if (isEvt.has(l.name)) {
        events[l.name] ??= { payloadReads: [] }
        ;(eventSites[l.name] ??= []).push(`${f.file}:${l.line}`)
      } else if (uni.methods.has(l.name) && !lockMethods[l.name])
        orphans.push({ name: l.name, site: `${f.file}:${l.line}` })
    }
  }
  const allowUnresolved = new Set((allow.unresolved ?? []).map(u => `${u.file}#${u.fn}`))
  // An env entry is excused only for the one file that sets it for a non-runtime child process.
  const allowEnv = new Set((allow.env ?? []).map(e => `${e.file}#${e.name}`))
  const allowRest = new Set((allow.rest ?? []).map(e => `${e.file}#${e.route}`))
  const unresolved = [...tsRes.unresolved, ...jsUnresolved]
    .map(u => ({ site: `${u.file}:${u.line}`, fn: u.fn, allowlisted: allowUnresolved.has(`${u.file}#${u.fn}`) }))
    .sort((a, b) => (a.site < b.site ? -1 : 1))

  // other surfaces
  const uniq = xs => [...new Set(xs)].sort()
  const all = k => perFile.flatMap(f => f[k])
  const mainCh = uniq([...all('ipcMain'), ...tsRes.ipc.main])
  const pushCh = uniq([...all('ipcPush'), ...tsRes.ipc.push])
  const preload = perFile.filter(f => f.file === 'electron/preload.ts').flatMap(f => f.ipcRef)
  const preloads = extraPreloads(ts, uniq(all('preloads')))
  const refCh = uniq([...preload, ...preloads.flatMap(p => p.refs), ...tsRes.ipc.ref])
  const served = new Set([...mainCh, ...pushCh])
  const waived = new Set(waivers.map(w => w.name))
  // The lock lists every unpaired channel; waivers.json only excuses some of them (the gate subtracts it).
  const unpaired = uniq([...refCh.filter(c => !served.has(c)), ...mainCh.filter(c => !refCh.includes(c))])
  const stale = [...waived].filter(c => !unpaired.includes(c)).sort()
  const config = {}
  for (const s of tsRes.sites) {
    const mode = s.names.some(n => /^config\.(set|update|patch|save)/.test(n)) ? 'write' : 'read'
    for (const k of s.configKeys ?? []) config[k] = config[k] === 'write' ? 'write' : mode
  }
  const lock = {
    lockVersion: 1,
    generator: GENERATOR,
    app: {
      upstreamReference: (fs
        .readFileSync(path.join(HERE, '..', 'UPSTREAM_BASE'), 'utf8')
        .match(/^[0-9a-f]{7,40}$/m) ?? [''])[0]
    },
    verifiedAgainst: {},
    methods: lockMethods,
    serverRequests: serverRequestPolicy(),
    events: sortObj(events),
    errorCodes: uniq(all('codes')).sort((a, b) => a - b),
    rest: Object.fromEntries(
      uniq(perFile.flatMap(f => f.rest.filter(r => !allowRest.has(`${f.file}#${r}`)))).map(r => [r, {}])
    ),
    cli: { serve: uniq(all('serve')) },
    config: sortObj(config),
    env: uniq(perFile.flatMap(f => f.env.filter(k => !allowEnv.has(`${f.file}#${k}`)))),
    disk: Object.fromEntries(uniq(all('disk')).map(d => [d, 'path'])),
    ipc: { mainChannels: mainCh.length, preloadRefs: refCh.length, unpaired },
    engineDeps: ENGINE_DEPS
  }
  const spec = readJson(path.join(HERE, 'runtime.spec.json'), null)
  lock.verifiedAgainst = spec
    ? { rev: spec.rev, openrpcSha256: spec.openrpcSha256, specTier: spec.specTier, result: await computedResult(lock) }
    : { rev: '', openrpcSha256: '', specTier: '', result: 'unverified' }

  const hit = new Set(tsRes.excludedHit ?? [])
  const restSeen = new Set(perFile.flatMap(f => f.rest.map(r => `${f.file}#${r}`)))
  // An allow entry that matches nothing excuses nothing today and would silently excuse a future site: it fails.
  // An events entry is stale when no event position of that name is in that file, and wrong when the provider spec
  // knows the name as an event (it would excuse nothing and read as if it did): both fail the run.
  const staleAllow = [
    ...[...SINK_EXCLUDE].filter(k => !hit.has(k)),
    ...[...allowRest].filter(k => !restSeen.has(k)).map(k => `rest ${k}`),
    ...[...allowEvents].filter(k => !eventsHit.has(k)).map(k => `events ${k}`),
    ...[...allowEvents]
      .filter(k => uni.events.has(k.slice(k.indexOf('#') + 1)))
      .map(k => `events ${k} (a provider event)`)
  ].sort()
  const sitesOut = { methods: sortObj(methodSites), events: sortObj(eventSites) }
  const report = {
    generator: GENERATOR,
    cached,
    scannedJs: files.filter(f => JS_EXT.test(f)).map(rel),
    scannedFiles: files.length,
    counts: {
      methods: Object.keys(lockMethods).length,
      events: Object.keys(events).length,
      jsOnly: Object.values(lockMethods).filter(m => m.via).length
    },
    orphans,
    unresolved,
    staleAllow: staleAllow,
    ipc: {
      main: mainCh.length,
      push: pushCh.length,
      preload: refCh.length,
      extraPreloads: preloads.map(p => p.file),
      unwaived: unpaired.filter(c => !waived.has(c)),
      staleWaivers: stale,
      unresolved: tsRes.ipc.unresolved.map(u => `${u.file}:${u.line} ${u.kind}`)
    },
    ms: 0
  }
  const lockText = `${JSON.stringify(lock, null, 2)}\n`
  const prettier = requireApp('prettier')
  const genTarget = path.join(APP, 'electron', 'iclone-compat', 'lock.generated.ts')
  const pcfg = (await prettier.resolveConfig(genTarget)) ?? {}
  const gen = await prettier.format(
    `// Generated by ${GENERATOR} from iclone/contract/runtime.lock.json. Do not edit; rerun the extractor.\n` +
      `export const RUNTIME_LOCK = ${JSON.stringify(lock)} as const\n\nexport type RuntimeLock = typeof RUNTIME_LOCK\n`,
    { ...pcfg, parser: 'typescript', filepath: genTarget }
  )
  const dest = OUT
    ? {
        lock: path.join(OUT, 'runtime.lock.json'),
        sites: path.join(OUT, 'runtime.lock.sites.json'),
        gen: path.join(OUT, 'lock.generated.ts'),
        report: path.join(OUT, 'extract-report.json')
      }
    : {
        lock: path.join(HERE, 'runtime.lock.json'),
        sites: path.join(HERE, 'runtime.lock.sites.json'),
        gen: genTarget,
        report: path.join(CACHE, 'extract-report.json')
      }
  for (const p of Object.values(dest)) fs.mkdirSync(path.dirname(p), { recursive: true })
  report.ms = Date.now() - t0
  fs.writeFileSync(dest.lock, lockText)
  // Slashes are JSON-escaped so app paths such as src/app/home/... never read as a home directory to path linters.
  fs.writeFileSync(dest.sites, `${JSON.stringify(sitesOut, null, 2).replaceAll('/', '\\/')}\n`)
  fs.writeFileSync(dest.gen, gen)
  fs.writeFileSync(dest.report, `${JSON.stringify(report, null, 2)}\n`)
  const bad = unresolved.filter(u => !u.allowlisted).length
  process.stdout.write(
    `extract: ${report.counts.methods} methods (${report.counts.jsOnly} js-only), ${report.counts.events} events, ` +
      `${orphans.length} orphans, ${bad} unresolved, ${unpaired.length} unpaired ipc, ${report.ms} ms${cached ? ' (cached)' : ''}\n`
  )
  if (stale.length) process.stderr.write(`extract: waivers.json excuses paired ipc channels: ${stale.join(', ')}\n`)
  if (staleAllow.length) {
    process.stderr.write(`extract: extract-allow.json entries match nothing: ${staleAllow.join(', ')}\n`)
    process.exitCode = 1
  }
}

main().catch(e => {
  process.stderr.write(`extract: ${e.stack ?? e}\n`)
  process.exit(1)
})
