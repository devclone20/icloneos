/**
 * V3-S (K139, r3 m-c) — STRUCTURAL: no app-launched Hermes bypasses the gate. Content-based, not name-based.
 *
 * The electron sources are compiled with the TypeScript checker (tsconfig.electron.json) and every process launch is
 * found by what the callee IS, whatever it is called locally:
 * - primitives: child_process `spawn/spawnSync/exec/execSync/execFile/execFileSync/fork` (and their `promisify` forms),
 *   cluster `fork`, node-pty `spawn`, electron `utilityProcess.fork` — through any import style or alias;
 * - wrappers: a function whose launch takes its COMMAND from one of its parameters (or a parameter's property, with at
 *   most a literal fallback) forwards that parameter, so every call of it is a launch too — to a fixpoint, across files;
 * - ports: a launcher handed to a slot typed in our sources (an injected `exec`, a `ProbeExec`) makes that slot a
 *   launcher, so calls through the injected function are launches too;
 * - escapes: a launcher used as a VALUE anywhere else (`.call`, `Reflect.apply`, stored, passed to a library) is a
 *   launch site itself.
 * Each launch that DECIDES its command (not a pass-through) must either be gated — after `prepareHermesSpawn(` in the
 * same function, with the prepared value's `seal(`, `argv(` and `stdio` in the launch — or be pinned in ALLOW by the
 * sha256 of its own normalized text (comments and formatting do not count; any other edit does) with the reason it is
 * not an agent the gate must hold. A new launch, an edited allowed launch and a stale ALLOW entry all fail this test.
 * The analyzer itself is checked on fixtures (aliases, namespaces, wrappers, ports, escapes, the scope of a gate).
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { sealBypasses } from './iclone-telemetry-seal.test-helpers'

const ELECTRON = import.meta.dirname
const DESKTOP = path.dirname(ELECTRON)

const PRIMITIVE_NAMES = new Set(['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync'])

type Verdict = 'gated' | 'open' | 'refused'

interface Site {
  file: string
  fn: string
  /** The normalized launch and the local declarations it is decided by: what ALLOW's reviewed snapshot holds. */
  full: string
  /** `<file> <function> <sha256 of the normalized launch, 12 hex>` */
  key: string
  line: number
  text: string
  verdict: Verdict
}

function declName(node: ts.Node | undefined): string {
  const name = (node as { name?: ts.Node } | undefined)?.name

  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : ''
}

function isPrimitive(decl: ts.Declaration): boolean {
  const file = decl.getSourceFile().fileName.replace(/\\/g, '/')

  if (/\/@types\/node\/(child_process|cluster)\.d\.ts$/.test(file)) {
    if (ts.isFunctionDeclaration(decl) && PRIMITIVE_NAMES.has(declName(decl))) {
      return true
    }

    // `execFile.__promisify__` and friends live in a namespace named after the function.
    for (let parent: ts.Node | undefined = decl.parent; parent; parent = parent.parent) {
      if (ts.isModuleDeclaration(parent) && PRIMITIVE_NAMES.has(declName(parent))) {
        return true
      }
    }

    return PRIMITIVE_NAMES.has(declName(decl)) && /cluster\.d\.ts$/.test(file)
  }

  if (/\/node-pty\//.test(file)) {
    return declName(decl) === 'spawn'
  }

  // r4 (m-c′): a worker thread runs any code it is given (eval: true included); vm compiles and runs a string.
  if (/\/@types\/node\/worker_threads\.d\.ts$/.test(file)) {
    return ts.isConstructorDeclaration(decl) && declName(decl.parent) === 'Worker'
  }

  if (/\/@types\/node\/vm\.d\.ts$/.test(file)) {
    return true
  }

  // utilityProcess.fork; r4 (m-c′): shell.openPath / openExternal start whatever the OS associates (a `.command` runs
  // in Terminal), so they are launches too.
  return /\/electron\.d\.ts$/.test(file) && ['fork', 'openExternal', 'openPath'].includes(declName(decl))
}

/** The modules whose namespace, used as a VALUE (not `.member`), reaches a launcher the analysis cannot follow. */
const LAUNCH_MODULES = new Set(
  ['child_process', 'cluster', 'node-pty', 'vm', 'worker_threads'].flatMap(name => [name, `node:${name}`])
)

/** `process` members that load native code or bindings directly. */
const PROCESS_LOADERS = new Set(['_linkedBinding', 'binding', 'dlopen'])

const isFunctionLike = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node)

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (isFunctionLike(parent)) {
      return parent
    }
  }

  return undefined
}

function functionName(fn: ts.FunctionLikeDeclaration | undefined): string {
  for (let node: ts.Node | undefined = fn; node; node = node.parent) {
    if (isFunctionLike(node) && declName(node)) {
      return declName(node)
    }

    if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && declName(node)) {
      return declName(node)
    }
  }

  return '<module>'
}

function unwrap(expr: ts.Expression): ts.Expression {
  let out = expr

  while (
    ts.isParenthesizedExpression(out) ||
    ts.isAsExpression(out) ||
    ts.isNonNullExpression(out) ||
    ts.isSatisfiesExpression(out) ||
    ts.isTypeAssertionExpression(out)
  ) {
    out = out.expression
  }

  return out
}

const PRINTER = ts.createPrinter({ removeComments: true })

function normalized(node: ts.Node): string {
  return PRINTER.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile()).replace(/\s+/g, ' ')
}

function inTypePosition(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isTypeNode(parent) || ts.isTypeQueryNode(parent)) {
      return true
    }

    if (ts.isStatement(parent) || ts.isExpression(parent)) {
      return false
    }
  }

  return false
}

/** The launches of every non-test source under `root` in `program`. */
export function analyzeLaunches(program: ts.Program, root: string): Site[] {
  const checker = program.getTypeChecker()

  const sources = program
    .getSourceFiles()
    .filter(sf => sf.fileName.startsWith(`${root}/`) && !/\.test\.|\.d\.ts$|\.e2e\./.test(sf.fileName))

  const launchers = new Map<ts.Node, number>()
  const decisions = new Set<ts.Node>()

  const commandIndex = (decl: ts.Declaration | undefined): number | undefined =>
    decl ? (isPrimitive(decl) ? 0 : launchers.get(decl)) : undefined

  const ours = (decl: ts.Node) => decl.getSourceFile().fileName.startsWith(`${root}/`)

  const callee = (call: ts.CallExpression | ts.NewExpression): ts.Declaration | undefined =>
    checker.getResolvedSignature(call)?.declaration ?? undefined

  const valueLauncher = (expr: ts.Node): ts.Declaration | undefined => {
    if (isFunctionLike(expr) && launchers.has(expr)) {
      return expr
    }

    try {
      return checker
        .getTypeAtLocation(expr)
        .getCallSignatures()
        .map(signature => signature.declaration)
        .find(
          (decl): decl is ts.SignatureDeclaration => Boolean(decl) && commandIndex(decl as ts.Declaration) !== undefined
        )
    } catch {
      return undefined
    }
  }

  /** The slot a value goes into (a typed property, parameter, variable or argument), `undefined` stripped. */
  const contextual = (expr: ts.Expression): ts.Type | undefined => {
    const type = checker.getContextualType(expr)

    return type ? checker.getNonNullableType(type) : undefined
  }

  /** The (function, parameter index) a command expression forwards, if it is a pure pass-through. */
  const forwarded = (command: ts.Expression | undefined): [ts.FunctionLikeDeclaration, number, boolean] | null => {
    if (!command) {
      return null
    }

    let expr = unwrap(ts.isSpreadElement(command) ? command.expression : command)

    if (
      ts.isBinaryExpression(expr) &&
      (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        expr.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      ts.isStringLiteralLike(unwrap(expr.right))
    ) {
      expr = unwrap(expr.left)
    }

    while (ts.isPropertyAccessExpression(expr)) {
      expr = unwrap(expr.expression)
    }

    if (!ts.isIdentifier(expr)) {
      return null
    }

    const symbol = checker.getSymbolAtLocation(expr)
    let decl: ts.Node | undefined = symbol?.valueDeclaration

    while (decl && (ts.isBindingElement(decl) || ts.isObjectBindingPattern(decl) || ts.isArrayBindingPattern(decl))) {
      decl = decl.parent
    }

    if (!decl || !ts.isParameter(decl) || !isFunctionLike(decl.parent)) {
      return null
    }

    const fn = decl.parent

    return [fn, fn.parameters.indexOf(decl), Boolean(decl.initializer)]
  }

  const walk = (visit: (node: ts.Node, sf: ts.SourceFile) => void) => {
    for (const sf of sources) {
      const go = (node: ts.Node) => {
        visit(node, sf)
        ts.forEachChild(node, go)
      }

      go(sf)
    }
  }

  // Fixpoint: wrappers (pass-through command), ports (launcher stored in a slot typed in our sources).
  for (let changed = true, rounds = 0; changed && rounds < 50; rounds += 1) {
    changed = false

    walk(node => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const index = commandIndex(callee(node))

        if (index === undefined) {
          return
        }

        const through = forwarded(node.arguments?.[index])

        if (through && !launchers.has(through[0])) {
          launchers.set(through[0], through[1])
          changed = true
        }

        return
      }

      if (
        (ts.isIdentifier(node) ||
          ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node)) &&
        !inTypePosition(node) &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)
      ) {
        const value = valueLauncher(node)
        const slot = value && ts.isExpression(node) ? contextual(node) : undefined

        for (const signature of slot?.getCallSignatures() ?? []) {
          const decl = signature.declaration

          if (decl && ours(decl) && !launchers.has(decl) && commandIndex(decl as ts.Declaration) === undefined) {
            launchers.set(decl, commandIndex(value) ?? 0)
            changed = true
          }
        }
      }
    })
  }

  const isLib = (decl: ts.Node | undefined, re: RegExp) =>
    Boolean(decl) && re.test(decl!.getSourceFile().fileName.replace(/\\/g, '/'))

  /** A call through Node's `require` signature (the global, `module.require`, a `createRequire` result). */
  const isRequire = (decl: ts.Declaration | undefined) =>
    Boolean(decl?.parent) &&
    ts.isInterfaceDeclaration(decl!.parent) &&
    declName(decl!.parent) === 'Require' &&
    isLib(decl, /\/@types\/node\//)

  const isDynamicLoad = (call: ts.CallExpression | ts.NewExpression, decl: ts.Declaration | undefined) => {
    const first = call.arguments?.[0]
    const literal = Boolean(first && ts.isStringLiteralLike(first))

    if (ts.isCallExpression(call) && call.expression.kind === ts.SyntaxKind.ImportKeyword) {
      return !literal
    }

    if (isRequire(decl)) {
      return !literal
    }

    return (
      isLib(decl, /\/typescript\/lib\/lib\.[^/]*\.d\.ts$/) &&
      (declName(decl) === 'eval' ||
        (Boolean(decl?.parent) &&
          ts.isInterfaceDeclaration(decl!.parent) &&
          declName(decl!.parent) === 'FunctionConstructor'))
    )
  }

  const launchModule = (expr: ts.Node): boolean => {
    let symbol: ts.Symbol | undefined

    try {
      symbol = checker.getTypeAtLocation(expr).getSymbol()
    } catch {
      return false
    }

    return Boolean(
      symbol &&
      symbol.flags & ts.SymbolFlags.ValueModule &&
      symbol.declarations?.some(decl => ts.isModuleDeclaration(decl) && LAUNCH_MODULES.has(decl.name.text))
    )
  }

  const isProcess = (expr: ts.Node): boolean => {
    try {
      return checker.getTypeAtLocation(expr).getSymbol()?.getName() === 'Process'
    } catch {
      return false
    }
  }

  /** Whether `node` hands a launching module, a `process` loader or `require` on where no call above tracks it. */
  const escapesAsNamespace = (node: ts.Expression): boolean => {
    let outer: ts.Node = node

    while (
      ts.isParenthesizedExpression(outer.parent) ||
      ts.isAwaitExpression(outer.parent) ||
      ts.isAsExpression(outer.parent) ||
      ts.isNonNullExpression(outer.parent) ||
      ts.isSatisfiesExpression(outer.parent)
    ) {
      outer = outer.parent
    }

    const parent = outer.parent

    // `process.binding` / `(process as any).binding` / `process['dlopen']` / `process[name]`.
    if (
      (ts.isPropertyAccessExpression(node) &&
        PROCESS_LOADERS.has(node.name.text) &&
        isProcess(unwrap(node.expression))) ||
      (ts.isElementAccessExpression(node) &&
        isProcess(unwrap(node.expression)) &&
        (!ts.isStringLiteralLike(node.argumentExpression) || PROCESS_LOADERS.has(node.argumentExpression.text)))
    ) {
      return true
    }

    // `require` (or a createRequire result) as a value, not called; `require.resolve` only resolves a path.
    if (
      (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
      !(ts.isCallExpression(parent) && parent.expression === outer) &&
      !(ts.isPropertyAccessExpression(parent) && parent.expression === outer && parent.name.text === 'resolve') &&
      (parent as { name?: ts.Node }).name !== outer &&
      !ts.isImportSpecifier(parent) &&
      !ts.isImportClause(parent) &&
      !ts.isNamespaceImport(parent) &&
      !ts.isExportSpecifier(parent) &&
      (() => {
        try {
          return checker
            .getTypeAtLocation(node)
            .getCallSignatures()
            .some(signature => isRequire(signature.declaration as ts.Declaration | undefined))
        } catch {
          return false
        }
      })()
    ) {
      return true
    }

    if (!(ts.isIdentifier(node) || ts.isCallExpression(node)) || !launchModule(node)) {
      return false
    }

    // Declarations are not uses; a static member is followed by the checker; an alias keeps the type.
    if (
      ts.isNamespaceImport(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isExportSpecifier(parent) ||
      (ts.isPropertyAccessExpression(parent) && parent.expression === outer) ||
      (parent as { name?: ts.Node }).name === outer
    ) {
      return false
    }

    if (ts.isVariableDeclaration(parent) && parent.initializer === outer && !parent.type) {
      // `const { [name]: run } = cp` computes the member: the analysis cannot follow it.
      return (
        ts.isObjectBindingPattern(parent.name) &&
        parent.name.elements.some(element => element.propertyName && ts.isComputedPropertyName(element.propertyName))
      )
    }

    return true
  }

  const sites: Site[] = []

  const gateDecl = (decl: ts.Declaration | undefined) =>
    Boolean(decl && ts.isFunctionDeclaration(decl) && declName(decl) === 'prepareHermesSpawn' && ours(decl))

  const verdictOf = (launch: ts.CallExpression | ts.NewExpression): Verdict => {
    const fn = enclosingFunction(launch)

    if (!fn?.body) {
      return 'open'
    }

    let verdict: Verdict = 'open'
    // The gate counts only in the launch's own function: not in a sibling, a caller or the module.
    const scope: ts.Node = fn.body
    const inScope = (node: ts.Node) => enclosingFunction(node) === fn

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.end <= launch.getStart() && inScope(node) && gateDecl(callee(node))) {
        let holder: ts.Node = node.parent

        while (ts.isAwaitExpression(holder) || ts.isParenthesizedExpression(holder)) {
          holder = holder.parent
        }

        if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) {
          const prepared = checker.getSymbolAtLocation(holder.name)
          const uses = new Set<string>()

          const scan = (inner: ts.Node) => {
            if (
              ts.isPropertyAccessExpression(inner) &&
              ts.isIdentifier(inner.expression) &&
              checker.getSymbolAtLocation(inner.expression) === prepared
            ) {
              const member = inner.name.text
              uses.add(ts.isCallExpression(inner.parent) && inner.parent.expression === inner ? `${member}(` : member)
            }

            ts.forEachChild(inner, scan)
          }

          launch.arguments?.forEach(scan)

          if (uses.has('seal(') && uses.has('argv(') && uses.has('stdio')) {
            verdict = 'gated'
          }
        } else {
          const options = node.arguments[0]

          const refused =
            options &&
            ts.isObjectLiteralExpression(options) &&
            options.properties.some(
              prop =>
                ts.isPropertyAssignment(prop) &&
                declName(prop) === 'role' &&
                ts.isStringLiteralLike(prop.initializer) &&
                prop.initializer.text === 'external-terminal'
            )

          if (refused && verdict === 'open') {
            verdict = 'refused'
          }
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(scope)

    return verdict
  }

  /**
   * The local declarations a command comes from (`const py = path.join(root, 'venv', …)`, a module constant, a loop
   * variable's source), to depth 3, so the pin also changes when the command is re-pointed without touching the call.
   */
  const provenance = (
    expr: ts.Node | undefined,
    depth = 0,
    seen = new Set<ts.Node>(),
    /** r4: a pass-through's own arguments — a member or key NAME (`{ timeout }`'s key, `x.cwd`) is not a value. */
    values = false
  ): string[] => {
    const out: string[] = []

    const symbolOf = (node: ts.Identifier): ts.Symbol | undefined => {
      if (!values) {
        return checker.getSymbolAtLocation(node)
      }

      const parent = node.parent

      if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
        return checker.getShorthandAssignmentValueSymbol(parent)
      }

      if (
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node)
      ) {
        return undefined
      }

      return checker.getSymbolAtLocation(node)
    }

    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        const decl = symbolOf(node)?.valueDeclaration

        if (decl && ours(decl) && !seen.has(decl) && !ts.isFunctionLike(decl) && !ts.isParameter(decl)) {
          seen.add(decl)

          let holder: ts.Node = decl

          while (holder.parent && !ts.isStatement(holder) && !ts.isSourceFile(holder.parent)) {
            holder = holder.parent
          }

          const statement = ts.isStatement(holder) && !ts.isBlock(holder) ? holder : decl

          // A loop variable's statement is the whole loop: pin only its head.
          const head =
            ts.isForOfStatement(statement) || ts.isForInStatement(statement) ? statement.expression : statement

          out.push(normalized(head))

          if (depth < 3) {
            const init = ts.isVariableDeclaration(decl) ? decl.initializer : ts.isBindingElement(decl) ? decl : head
            out.push(...provenance(init, depth + 1, seen, values))
          }
        }
      }

      ts.forEachChild(node, visit)
    }

    if (expr) {
      visit(expr)
    }

    return out
  }

  /** `also`: more expressions whose local declarations decide the launch (a pass-through's own args, r4 m-c′). */
  const record = (node: ts.Node, sf: ts.SourceFile, verdict: Verdict, command?: ts.Node, also: ts.Node[] = []) => {
    if (decisions.has(node)) {
      return
    }

    decisions.add(node)

    const file = path.relative(root, sf.fileName).replace(/\\/g, '/')
    const fn = functionName(enclosingFunction(node))
    const seen = new Set<ts.Node>()

    const text = [
      normalized(node),
      ...provenance(command, 0, seen),
      ...also.flatMap(expr => provenance(expr, 0, seen, true))
    ].join('\n')

    sites.push({
      file,
      fn,
      full: text,
      key: `${file} ${fn} ${createHash('sha256').update(text).digest('hex').slice(0, 12)}`,
      line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      text: normalized(node).slice(0, 160),
      verdict
    })
  }

  walk((node, sf) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const decl = callee(node)

      // r4 (m-c′): code loaded by a name computed at run time (`require('node:' + x)`, `import(x)`), `eval`, `Function`.
      if (isDynamicLoad(node, decl)) {
        record(node, sf, 'open', undefined, [...(node.arguments ?? [])])

        return
      }

      const index = commandIndex(decl)

      if (index === undefined) {
        return
      }

      const through = forwarded(node.arguments?.[index])

      // Every call of a pure pass-through's function is a launch site of its own (a parameter with a default value
      // decides when the caller omits it, so that launch is decided). r4 (m-c′): the pass-through itself is a site too —
      // its own arguments (`serve --help`) are decided here, so they are pinned with the local declarations they use.
      if (!through || through[2]) {
        record(node, sf, verdictOf(node), node.arguments?.[index])
      } else {
        record(
          node,
          sf,
          verdictOf(node),
          undefined,
          (node.arguments ?? []).filter((_arg, at) => at !== index)
        )
      }

      return
    }

    // r4 (m-c′): a launching module's namespace used as a value (`Reflect.get(cp, 'sp' + 'awn')`, `cp[name]`, passed
    // on), a `process` loader (`process.binding('spawn_sync')`), or `require` itself handed around.
    if (ts.isExpression(node) && !inTypePosition(node) && escapesAsNamespace(node)) {
      record(node, sf, 'open')

      return
    }

    // Escapes: a launcher used as a value where nothing above tracks it.
    if (
      (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      !inTypePosition(node) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
      // A declared name or a member name (`function spawn`, `{ spawn: … }`, `x.spawn`) is not a use of a value.
      (node.parent as { name?: ts.Node }).name !== node &&
      !(ts.isBindingElement(node.parent) && node.parent.propertyName === node) &&
      !ts.isImportSpecifier(node.parent) &&
      !ts.isExportSpecifier(node.parent) &&
      !ts.isImportClause(node.parent) &&
      !ts.isNamespaceImport(node.parent)
    ) {
      const value = valueLauncher(node)

      if (!value) {
        return
      }

      const parent = node.parent

      // An alias (`const run = spawn`, `{ spawn } = cp`) keeps the type, so calls through it are found as calls.
      if (ts.isVariableDeclaration(parent) && parent.initializer === node && !parent.type) {
        return
      }

      // A slot typed as a launcher (a port in our sources, or `typeof spawn` itself): calls through it are found as calls.
      const slot = ts.isExpression(node) ? contextual(node) : undefined

      if (
        slot
          ?.getCallSignatures()
          .some(signature => commandIndex(signature.declaration as ts.Declaration | undefined) !== undefined)
      ) {
        return
      }

      // Wrapped into another launcher (`promisify(execFile)`): calls of the result are found as calls.
      if (ts.isCallExpression(parent) && parent.expression !== node && valueLauncher(parent)) {
        return
      }

      record(node, sf, 'open')
    }
  })

  return sites.sort((a, b) => a.key.localeCompare(b.key) || a.line - b.line)
}

function electronProgram(): ts.Program {
  const config = ts.getParsedCommandLineOfConfigFile(path.join(DESKTOP, 'tsconfig.electron.json'), undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    }
  })

  if (!config) {
    throw new Error('tsconfig.electron.json could not be read')
  }

  return ts.createProgram({
    rootNames: config.fileNames,
    options: { ...config.options, composite: false, declaration: false, incremental: false, noEmit: true }
  })
}

/** A program of in-memory fixture files under `<electron>/__spawn_fixtures__/` (nothing is written to disk). */
function fixtureProgram(files: Record<string, string>): { program: ts.Program; root: string } {
  const root = path.join(ELECTRON, '__spawn_fixtures__')

  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    types: ['node']
  }

  const host = ts.createCompilerHost(options)
  const virtual = new Map(Object.entries(files).map(([name, text]) => [path.join(root, name), text]))
  const { fileExists, getSourceFile, readFile } = host
  const { directoryExists } = host
  host.directoryExists = dir => dir === root || Boolean(directoryExists?.call(host, dir))
  host.fileExists = file => virtual.has(file) || fileExists.call(host, file)
  host.readFile = file => virtual.get(file) ?? readFile.call(host, file)
  host.getSourceFile = (file, language, onError, fresh) =>
    virtual.has(file)
      ? ts.createSourceFile(file, virtual.get(file)!, language)
      : getSourceFile.call(host, file, language, onError, fresh)

  return { program: ts.createProgram([...virtual.keys()], options, host), root }
}

// ── ALLOW: every launch that decides its command and is not gated, pinned by content, with why it is not an agent ──

const WHY = {
  acp: 'the ACP / AgentCard / Claude Code CLIs the app drives (their own binaries, found by the app): not Hermes',
  compat:
    'iclone-compat adoption tooling: the repo’s own spec script under system python3 -B, on a checkout; not Hermes',
  confinement:
    'V3-G confinement machinery: sandbox-exec / container / log / ps / getconf probes and the confined shell the agent’s tool calls run in',
  doctor:
    'Doctor diagnostics and fix steps: system tools, `python --version`, `hermes doctor` read-only and `hermes config set …`; one-shots, no agent loop',
  gate: 'the gate’s own armed probe (`-s -P -c`, lock flags only, no key, os._exit): no agent loop',
  git: 'git / gh one-shots on a repository (status, log, diff, ls-remote, worktree, clone, archive, PR): not Hermes',
  harness:
    'test-only harnesses (only test code calls them): the confinement live world; V3-RT asking an interpreter its version before rebuilding the pinned artifact',
  install:
    'the first-run / repair installer stages (install.sh / install.ps1, --non-interactive: setup and gateway install are skipped)',
  probe:
    'one-shot interpreter / CLI probes that print and exit (`hermes --version`, an import check, `serve --help`, `py -3.x -c sys.executable`): no agent loop',
  pty: 'the in-app terminal: the user’s own shell, ssh or tmux in a pty (and the pty self-test `echo`), not an agent the app starts',
  shell: 'the user’s login shell, once, to read its PATH (`-ilc`), then exits',
  ssh: 'ssh to a remote host (a remote Hermes is out of V3-S scope)',
  system:
    'a fixed system tool (ps, lsof, pgrep, tasklist, codesign, xattr, tar, curl, reg, icacls, taskkill, wsl, powershell, fc-cache, cmd start <url>): not Hermes',
  uninstall:
    '`hermes uninstall --gui-summary` prints a summary and exits; the detached cleanup runs after the app quits',
  update:
    'runtime / app update hand-offs (`hermes update`, the updater script, the pre-update backup and venv blocker scan, `hermes config set updates.check false`): the backend is stopped or the app quits first',
  forward:
    'r4 (m-c′): a launch whose COMMAND comes from its caller — a wrapper (execProbeSync, runGh, execRunner, runFile, spawnUpdaterProcess, backendSupportsServe…) or an injected port (deps.run, env.exec, deps.probe, opts.run); every caller is pinned on its own, and what the launch decides itself (`serve --help`, `config set …`) is pinned here: probes, git/gh, the doctor, the ACP runner, the gate’s probe, the updater hand-off',
  open: 'r4 (m-c′): shell.openExternal / openPath of a web link, a log or plugin folder, a file the user clicked, the OAuth or policy page: the OS opens it with its own application, never a Hermes the app starts',
  dynamic:
    'r4 (m-c′): code loaded by a name computed at run time: the get-windows module staged inside the app bundle (window-below)'
} as const

const ALLOW: Record<keyof typeof WHY, string[]> = {
  acp: [
    'iclone-acp.ts startCli 080fd056859a',
    'iclone-acp.ts startCli 9f22aededc45',
    'iclone-acp.ts startWatchCli 4332ce4a6be2',
    'iclone-agentcard-status.ts createAgentcardRun b1b06ae5e851',
    'iclone-claude-code.ts createClaudeCodeStatus 0fc74a5d1280',
    'iclone-claude-code.ts createClaudeCodeStatus e027e55bf5d1',
    'iclone-claude-code.ts discoverClaudeBinary 2d6e9043b177',
    'iclone-ownership.ts initIcloneOwnership 7e8a942c7682'
  ],
  compat: ['iclone-compat/adoption.ts upstreamDay 328154dfe10a'],
  confinement: [
    'iclone-confinement/backend-seatbelt.ts spawn 848f4aad4a65',
    'iclone-confinement/index.ts xcrunCacheFile cbfdec72e4bb',
    'iclone-confinement/ipc.ts registerConfinement 2a82bb9a548a',
    'iclone-confinement/probe.ts probeContainer 46034aa8f4fe',
    'iclone-confinement/probe.ts probeSeatbelt b06b79a783da',
    'iclone-confinement/probe.ts probeSeatbelt b135d4665680',
    'iclone-confinement/refusals.ts startRefusalStream 6e7e982ff668',
    'iclone-confinement/refusals.ts startRefusalStream e98a8bed4717',
    'iclone-confinement/state.ts readPs 1d53a4f20b61'
  ],
  doctor: [
    'iclone-doctor-checks.ts accessibility 8ae669897f4c',
    'iclone-doctor-checks.ts codesignFacts 6d5803d89ed8',
    'iclone-doctor-checks.ts codesignFacts 921510d7117a',
    'iclone-doctor-checks.ts codesignFacts fe04fa320632',
    'iclone-doctor-checks.ts hermesDoctor f9cb6922485b',
    'iclone-doctor-checks.ts listenerPid 9726a2987217',
    'iclone-doctor-checks.ts networkQuality fc95009919a7',
    'iclone-doctor-checks.ts openHolders 8200b1d1607c',
    'iclone-doctor-checks.ts processInfo 25ec071c8b70',
    'iclone-doctor-checks.ts quickCheck 9c93efae458a',
    'iclone-doctor-checks.ts quickCheck ca10f65d86a0',
    'iclone-doctor-checks.ts timeOffset 00033bf0b550',
    'iclone-doctor-checks.ts venvPython 51b826bbdc7d',
    'iclone-doctor-fixes.ts applySteps ab51c9db8b48',
    'iclone-doctor-fixes.ts interpreterFor 33aed06f4f75',
    'iclone-doctor-fixes.ts venvRepair 51b826bbdc7d'
  ],
  gate: ['main/iclone-gate.ts ensureIcloneGate 742b35327c36'],
  git: [
    'bootstrap-runner.ts gitResult 12b6414b081d',
    'bootstrap-runner.ts run 2a8f9b211548',
    'desktop-plugin-install.ts gitExit 957b5c0fc9b1',
    'git-ipc.ts registerGitIpc 68d5ddb18569',
    'git-ipc.ts registerGitIpc 8657d907ec2b',
    'git-ipc.ts registerGitIpc b3c442e2a9b2',
    'git-ipc.ts registerGitIpc bb85ddc5d854',
    'git-ipc.ts registerGitIpc c860a04304da',
    'git-ipc.ts registerGitIpc cf3edcd17410',
    'git-worktree-ops.ts gitOut acfc7010b220',
    'iclone-compat/runtime-git.ts repoGit d2dc5ebecaa2',
    'iclone-compat/runtime-git.ts runtimeInstallTip 20763f9ff2bd',
    'iclone-ownership.ts archive b7fa7171076e',
    'iclone-ownership.ts runGh c92c85fdec69',
    'iclone-pane-remote/probe.ts branchOf 7b9b8b453317',
    'iclone-updates.ts git d14653fa0201',
    'lib/git.ts runGit 7f44c977b1e0',
    'main/agent-update.ts lsRemote 7d342b4ec8bc',
    'main/executables.ts runResolvedGit 9dd9043bc6d4'
  ],
  harness: [
    'iclone-confinement/live-harness.ts createLiveWorld 4e8065348828',
    'iclone-runtime-integrity.test-helpers.ts canBuildPinnedArtifact fb0094303dd8',
    'iclone-runtime-integrity.test-helpers.ts runtimeFixture efa4a6634f5a',
    'iclone-confinement/live-harness.ts runPlain 522fcb9408a0'
  ],
  install: ['bootstrap-runner.ts spawnBash 15c5a3f0c653', 'bootstrap-runner.ts spawnPowerShell fe408f5ca09a'],
  probe: [
    'main/executables.ts findSystemPython 1737b10074ff',
    'main/managed-ssh-update.ts spawnPoolBackend 6e63cde75e03',
    'main/start-hermes.ts connectionPromise 82a5b4c26962',
    'main/updates.ts isActiveRuntimeUsable 76496a28bbee',
    'main/updates.ts resolveHermesBackend d111ba4ee0d3',
    'main/updates.ts resolveHermesBackend b594a284f6c9',
    'windows-hermes-path.ts resolveVenvHermesCommand 4c8b69b9010a'
  ],
  pty: [
    'iclone-acp.ts selftestPty e59b2bd7e440',
    'iclone-pane-bus/ipc.ts initPaneBus 1e22bc64c61c',
    'iclone-pane-bus/ipc.ts initPaneBus 5a47108ee47b',
    'terminal-ipc.ts registerTerminalIpc 06fa48d7bd1b',
    'terminal-ipc.ts registerTerminalIpc 9fd62ffc6ffb',
    'terminal-ipc.ts registerTerminalIpc e56f2dcc77f2'
  ],
  shell: ['shell-path.ts captureLoginShellPath 2539b05024d7'],
  ssh: [
    'main/connections-ipc.ts registerConnectionsIpc 8aa3edff8ac7',
    'main/managed-ssh.ts effectiveSshConfigFingerprint 9393441b0e20',
    'ssh-connection.ts <module> a04afb368a49',
    'ssh-connection.ts runSsh a04afb368a49'
  ],
  system: [
    // V3-RT-B r2: one `/bin/ps` of the process table (no shell) — the install watchdog's CPU-time probe.
    'install-liveness.ts sampleTreeCpu 0477ad2ee9dc',
    'backend-claim.ts processStartMarker 4fb75fef0a94',
    'backend-claim.ts processStartMarker 9ccdec68d8e1',
    'bootstrap-runner.ts extractTarball 010d16cdb5bf',
    'iclone-diagnostics-file.ts collectMacNames f583a8788399',
    'iclone-diagnostics-file.ts macOnly c10985ea35a4',
    'gitlock.ts gitProcessRunning 4832af7ad34e',
    'iclone-acp.ts keychainPromptShowing 3427d9346951',
    'iclone-pane-remote/probe.ts portsByPane 138e11af29e9',
    'iclone-pane-remote/probe.ts portsByPane e00312dd06fd',
    'main/backend-ownership.ts backendCommandForPid 5d7a3086277f',
    'main/backend-ownership.ts forceKillProcessTree 730b8d217e10',
    'main/executables.ts findSystemPython ec1624828de8',
    'main/link-metadata.ts fetchHtmlTitleWithCurl a2d3ee32acc7',
    'main/shell-open.ts ensureWslWindowsFonts bd5331b11ff9',
    'main/shell-open.ts openExternalUrl fb845614ceed',
    'main/updates.ts repairMacUpdaterHelper 163a21f1706f',
    'main/updates.ts repairMacUpdaterHelper 171fb1ab950d',
    'main/updates.ts repairMacUpdaterHelper 8b231c46fd32',
    'terminal-ipc.ts readProcessCwd f932c4530ce4',
    'windows-sandbox-fallback.ts grantAllApplicationPackagesAcl 4a423d770d62',
    'windows-user-env.ts readWindowsUserEnvVar ede46b2de1e3',
    'wsl-clipboard-image.ts readWslWindowsClipboardImage f8f6c0277411',
    'wsl-path-bridge.ts resolveDefaultWslDistro 791d319fbd21'
  ],
  uninstall: [
    'main/updates-ipc.ts probeUninstallSummary d1e941024f50',
    'main/updates-ipc.ts runDesktopUninstall d711e200f684'
  ],
  update: [
    'main/agent-update.ts applyAgentUpdate 34b4eb53b70b',
    'main/agent-update.ts applyAgentUpdate c619d79d6cb6',
    'main/backend-pool.ts handOffWindowsBootstrapRecovery ab5fbb15f9a7',
    'main/update-apply.ts applyUpdates 3d263fca6807',
    'main/update-apply.ts applyUpdates ab5fbb15f9a7',
    'main/updates.ts applyUpdatesPosixHandoff d6cb4f290088',
    'venv-blocker-scan.ts scanVenvBlockers bf2f9693acc8',
    'venv-blocker-scan.ts stopSafeVenvBlockers 080e9420e569'
  ],
  forward: [
    'iclone-diagnostics-file.ts read f21bcae69f63',
    'iclone-doctor-main.ts read f20007f49164',
    'agent-update.ts ensureFullPreUpdateBackup eaa6ff34ed3c',
    'backend-claim.ts execText 98361ea0d7e6',
    'backend-probes.ts canImportHermesCli 14cae9cb73b8',
    'backend-probes.ts execProbeSync df4d0932f2f5',
    'backend-probes.ts verifyHermesCli 15c1a273e53e',
    'git-review-ops.ts fileDiffVsHead 26e20713074d',
    'git-review-ops.ts reviewCreatePr b25aa39d8436',
    'git-review-ops.ts reviewDiff 26e20713074d',
    'git-review-ops.ts reviewFetchPrComment d6fc002a5058',
    'git-review-ops.ts reviewPrList 41b90d6b16ce',
    'git-review-ops.ts reviewPrList 76ec327ec837',
    'git-review-ops.ts reviewShipInfo 2aeb72646482',
    'git-review-ops.ts reviewShipInfo 70a9c1cd49c8',
    'git-review-ops.ts runGh 0b9ddc0ea7ea',
    'iclone-claude-code.ts defaultExec 54a2db43ddf8',
    'iclone-confinement/index.ts createConfinement 61a4fb61e491',
    'iclone-confinement/members.ts createMemberProbe 59e66abea64b',
    'iclone-confinement/probe.ts runFile 755ad63d84db',
    'iclone-doctor-checks.ts execAbsolute 45b7f816b7d7',
    'iclone-doctor-checks.ts interpreterVersion a5abcdd7d2ec',
    'iclone-doctor-fixes.ts runStep 40ba0f99e98d',
    'iclone-hermes-plugins.ts ensureIcloneHermesPlugins eebc30c36c1c',
    'iclone-ownership.ts applyDeactivation 358a50fc6e98',
    'iclone-ownership.ts applyDeactivation e0259db21478',
    'iclone-ownership.ts currentAgentName 5f284c884659',
    'iclone-ownership.ts execRunner c5f2cc83ac68',
    'iclone-pane-bus/ipc.ts runTmux 5eb21e90cf4b',
    'iclone-pane-remote/probe.ts runFile 3a4016461683',
    'main/executables.ts backendSupportsServe 0d1c893b6526',
    'main/executables.ts getBackendArgsForRuntime bcacf7675e2c',
    'main/iclone-gate.ts probe 40c9200fcb97',
    'shell-path.ts runProbe b136afc56cc8',
    'update-runtime-align.ts ensureCuratedRuntimeConfig f7223e5d499f',
    'update-runtime-align.ts spawnCapped 05d3a399ed9a',
    'updater-process.ts spawnUpdaterProcess 079cebda2add'
  ],
  open: [
    'fs-ipc.ts registerFsIpc 4fc8f572e075',
    'iclone-consent.ts registerIcloneConsent 6a9bd93ca13d',
    'iclone-doctor-fixes.ts runStep 7bda12d82089',
    'iclone-doctor-main.ts initIcloneDoctor efc485bb3d06',
    // REL-6 notices (J6 m-r5-4): main picks the path AND re-checks the content before every open: a regular,
    // single-linked file of this user, re-hashed against the verified manifest, in a 0700 folder that is not a link.
    'iclone-acp-tools/ipc.ts registerAcpToolsIpc dd66b4850c0e',
    'iclone-acp.ts openFile f245ec560339',
    'iclone-doctor-main.ts openExternal b294026502a3',
    // V3-RT-B RTB-6: a fixed macOS Settings pane (Network / Storage) for an install fix, from a closed enum.
    'main/agent-runtime-status.ts openAgentRuntimeFix 207102cfebbd',
    // V3-ON: the Set up step opens the Privacy / Notifications pane its row names — URLs fixed in iclone-setup.ts.
    'iclone-setup.ts actOnSetupSystemItem 5a04eef0f056',
    'main.ts openExternal b294026502a3',
    'main.ts openFile d08ce94bb111',
    'main/connection-config-ipc.ts openExternal b294026502a3',
    'main/setup-ipc.ts openExternal b294026502a3',
    // X1c: a file: URL from content opens only a passive document/media file (file-open-policy.ts); else revealed.
    'main/shell-open.ts openExternalUrl fdea688b7613',
    'main/shell-open.ts openExternalUrl c41e3434fc1c',
    'main/shell-open.ts openPreviewInBrowser b197a64cfce8',
    'native-oauth-login.ts runNativeLogin 740a73f2b18c'
  ],
  dynamic: ['window-below.ts loadGetWindows ecb7e3d9787a']
}

/**
 * r4 (m-c′): the REVIEWED text of every pin, `hermes-spawn-paths.allow.txt` — one block per ALLOW key: `== <key>
 * [<reason>]`, the normalized launch, then each local declaration that decides it (once each, in order). The key's hash
 * is over the same text, so a re-pin changes the key AND the block, and the block's diff is what a reviewer reads.
 */
const SNAPSHOT_FILE = path.join(ELECTRON, 'hermes-spawn-paths.allow.txt')

const SNAPSHOT_HEADER = [
  '# Reviewed launch inventory of apps/desktop/electron (V3-S r4 m-c′), checked by hermes-spawn-paths.test.ts.',
  '# One block per ALLOW pin: "== <file> <function> <sha256-12> [<reason>]", the normalized launch, then each local',
  '# declaration it is decided by (once each). Never edit by hand without reviewing the launch it describes.',
  ''
].join('\n')

function snapshotBlock(key: string, reason: string, full: string): string {
  const lines = [...new Set(full.split('\n'))]

  return [`== ${key} [${reason}]`, ...lines, ''].join('\n')
}

function readSnapshot(): Map<string, string> {
  const blocks = new Map<string, string>()
  const text = fs.existsSync(SNAPSHOT_FILE) ? fs.readFileSync(SNAPSHOT_FILE, 'utf8') : ''

  for (const block of text.split(/\n(?=== )/).filter(part => part.startsWith('== '))) {
    const key = /^== (.+?) \[[^\]]+\]\n/.exec(block)?.[1]

    if (key) {
      blocks.set(key, block.endsWith('\n') ? block : `${block}\n`)
    }
  }

  return blocks
}

/** The launches that must be gated (seal + argv + stdio after prepareHermesSpawn) or refused by it. */
const GATED: Record<Exclude<Verdict, 'open'>, string[]> = {
  gated: ['main/managed-ssh-update.ts spawnPoolBackend', 'main/start-hermes.ts connectionPromise'],
  refused: ['main/window-ipc.ts registerWindowIpc']
}

function sourceFilesOnDisk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sourceFilesOnDisk(full)
    }

    return /\.(c|m)?(t|j)sx?$/.test(entry.name) && !/\.test\.|\.d\.ts$|\.e2e\./.test(entry.name) ? [full] : []
  })
}

describe('every app-launched Hermes goes through prepareHermesSpawn (content-based)', () => {
  const program = electronProgram()
  const sites = analyzeLaunches(program, ELECTRON)

  // Ruling 54.4 (V3-FX r5): every file holding a launch starts its children only through primitives the telemetry
  // seal covers (iclone-telemetry-seal.ts), so no spawn site bypasses the seal.
  it('every launch site is covered by the telemetry seal (ruling 54.4)', () => {
    const files = [...new Set(sites.map(site => site.file))]

    const bypasses = files.flatMap(file =>
      sealBypasses(path.join(ELECTRON, file)).map(problem => `${file}: ${problem}`)
    )

    expect(files.length).toBeGreaterThan(40)
    expect(bypasses).toEqual([])
  })

  it('the analysis sees every source file under electron/ (nothing launches from outside the compiled program)', () => {
    const compiled = new Set(program.getSourceFiles().map(sf => path.resolve(sf.fileName)))

    expect(sourceFilesOnDisk(ELECTRON).filter(file => !compiled.has(path.resolve(file)))).toEqual([])
  })

  it('each launch that decides its command is gated, refused by the gate, or pinned in ALLOW by its content', () => {
    const allowed = Object.values(ALLOW).flat()
    const open = sites.filter(site => site.verdict === 'open')

    const unexplained = open
      .filter(site => !allowed.includes(site.key))
      .map(site => `${site.key}  (line ${site.line})  ${site.text}`)

    expect(unexplained).toEqual([])
  })

  it('no ALLOW entry is stale or listed twice, and every reason is written down', () => {
    const keys = sites.filter(site => site.verdict === 'open').map(site => site.key)
    const allowed = Object.values(ALLOW).flat()

    expect(allowed.filter(key => !keys.includes(key))).toEqual([])
    expect(new Set(allowed).size).toBe(allowed.length)

    for (const reason of Object.values(WHY)) {
      expect(reason.length).toBeGreaterThan(20)
    }
  })

  it('r4 (m-c′): every pin has its reviewed text in hermes-spawn-paths.allow.txt, equal to what the launch is now', () => {
    const reasonOf = new Map(Object.entries(ALLOW).flatMap(([reason, keys]) => keys.map(key => [key, reason] as const)))

    const expected = new Map<string, string>()

    for (const site of sites) {
      const reason = reasonOf.get(site.key)

      if (site.verdict === 'open' && reason) {
        expected.set(site.key, snapshotBlock(site.key, reason, site.full))
      }
    }

    const snapshot = readSnapshot()
    const differ = [...expected].filter(([key, block]) => snapshot.get(key) !== block).map(([, block]) => block)

    // On failure: review each printed block (it is the launch as it is now), then put it in the file.
    expect(differ.join('\n')).toBe('')
    expect([...snapshot.keys()].filter(key => !expected.has(key))).toEqual([])
    expect(fs.readFileSync(SNAPSHOT_FILE, 'utf8').startsWith(SNAPSHOT_HEADER)).toBe(true)
  })

  it('the agent spawns are found and gated: primary and pool / forced-local; Open in terminal is refused', () => {
    const by = (verdict: Verdict) =>
      sites
        .filter(site => site.verdict === verdict)
        .map(site => `${site.file} ${site.fn}`)
        .sort()

    expect({ gated: by('gated'), refused: by('refused') }).toEqual(GATED)
  })
})

describe('the analyzer (fixtures)', () => {
  const GATE = `
export async function prepareHermesSpawn(_o: { role: string }) {
  return { argv: (a: string[]) => a, seal: (e: object) => e as Record<string, string>, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] as const }
}`

  const run = (files: Record<string, string>) =>
    (({ program, root }) => analyzeLaunches(program, root))(fixtureProgram({ 'gate.ts': GATE, ...files }))

  it('finds a spawn through a renamed import, a namespace, require, promisify, node-pty-like and .call', () => {
    const sites = run({
      'a.ts': `
import { spawn as launch, execFile } from 'node:child_process'
import * as cp from 'node:child_process'
import { promisify } from 'node:util'
const { fork } = require('node:child_process') as typeof import('node:child_process')
const run = promisify(execFile)
export function one(py: string) { void py; launch('/rt/venv/bin/python', ['-m', 'hermes_cli.main', 'serve']) }
export function two() { cp.spawnSync('python3', ['x']) }
export async function three() { await run('python3', ['x']) }
export function four() { fork('/m.js') }
export function five() { Reflect.apply(execFile, null, ['python3', []]) }
export function six() { execFile.call(null, 'python3', []) }
`
    })

    expect(sites.map(site => `${site.fn}:${site.verdict}`).sort()).toEqual([
      'five:open',
      'four:open',
      'one:open',
      'six:open',
      'three:open',
      'two:open'
    ])
  })

  it('a wrapper forwarding its command makes each of its calls a site, across files and to a fixpoint', () => {
    const sites = run({
      'w.ts': `
import { spawn } from 'node:child_process'
export function spawnUpdaterProcess(command: string, args: string[]) { return spawn(command, args) }
export function viaOptions(options: { bin?: string }) { return spawn(options.bin ?? 'git', []) }`,
      'x.ts': `
import { spawnUpdaterProcess, viaOptions } from './w'
function again(cmd: string) { return spawnUpdaterProcess(cmd, ['serve']) }
export function agent() { again('/rt/venv/bin/python') }
export function git() { viaOptions({}) }`
    })

    // r4 (m-c′): the pass-throughs are sites too (their own arguments are decided where they are).
    expect(sites.map(site => `${site.file} ${site.fn}`).sort()).toEqual([
      'w.ts spawnUpdaterProcess',
      'w.ts viaOptions',
      'x.ts again',
      'x.ts agent',
      'x.ts git'
    ])
  })

  it('an injected exec (a port typed in our sources) makes calls through it sites', () => {
    const sites = run({
      'p.ts': `
import { execFile } from 'node:child_process'
export interface Env { exec: (file: string, args: string[]) => void }
export const realEnv: Env = { exec: (file, args) => { execFile(file, args) } }
export function check(env: Env) { env.exec('/rt/venv/bin/python', ['-m', 'hermes_cli.main', 'serve']) }`
    })

    expect(sites.map(site => `${site.fn}:${site.verdict}`).sort()).toEqual(['check:open', 'exec:open'])
  })

  it('gated only after prepareHermesSpawn in the SAME function, using seal, argv and stdio', () => {
    const sites = run({
      'g.ts': `
import { spawn } from 'node:child_process'
import { prepareHermesSpawn } from './gate'
export async function good() {
  const gated = await prepareHermesSpawn({ role: 'primary' })
  spawn('/py', gated.argv(['serve']), { env: gated.seal({}), stdio: gated.stdio })
}
export async function noSeal() {
  const gated = await prepareHermesSpawn({ role: 'primary' })
  spawn('/py', gated.argv(['serve']), { env: {}, stdio: gated.stdio })
}
export async function before() {
  spawn('/py', ['serve'])
  await prepareHermesSpawn({ role: 'primary' })
}
async function elsewhere() { return prepareHermesSpawn({ role: 'primary' }) }
export async function sibling() { await elsewhere(); spawn('/py', ['serve']) }
const early = await prepareHermesSpawn({ role: 'primary' })
export function moduleLevel() {
  spawn('/py', early.argv(['serve']), { env: early.seal({}), stdio: early.stdio })
}
export async function refused() {
  await prepareHermesSpawn({ role: 'external-terminal' })
  spawn('/usr/bin/open', ['x'])
}`
    })

    const verdicts = Object.fromEntries(
      sites.filter(site => site.file === 'g.ts' && site.text.startsWith('spawn')).map(site => [site.fn, site.verdict])
    )

    expect(verdicts).toEqual({
      before: 'open',
      good: 'gated',
      moduleLevel: 'open',
      noSeal: 'open',
      refused: 'refused',
      sibling: 'open'
    })
  })

  it('r4 (m-c′): the critic’s seven blind spots are each a site (computed require/import, openPath, a namespace as a value, process.binding, a worker)', () => {
    const sites = run({
      's.ts': `
import * as cpns from 'node:child_process'
import { shell } from 'electron'
import { Worker } from 'node:worker_threads'
import vm from 'node:vm'
export function s1() { const m = require('node:' + 'child_process'); m.spawn('/rt/venv/bin/python', ['serve']) }
export async function s2(name: string) { const m = await import(name); m.spawn('x') }
export function s3(dir: string) { void shell.openPath(dir + '/run.command') }
export function s4() { (Reflect.get(cpns, 'sp' + 'awn') as typeof cpns.spawn)('/py', ['serve']) }
export function s4b(name: 'spawn') { cpns[name]('/py', ['serve']) }
export function s6() { (process as any).binding('spawn_sync') }
export function s7() { return new Worker('require("child_process").spawn("/py")', { eval: true }) }
export function s8() { vm.runInThisContext('1') }
export function s9() { return eval('require') }
export function s10() { const r = require; return r }
export function ok() { return require.resolve('node-pty/package.json') }
`
    })

    expect(
      [...new Set(sites.filter(site => site.file === 's.ts').map(site => `${site.fn}:${site.verdict}`))].sort()
    ).toEqual([
      's10:open',
      's1:open',
      's2:open',
      's3:open',
      's4:open',
      's4b:open',
      's6:open',
      's7:open',
      's8:open',
      's9:open'
    ])
  })

  it('r4 (m-c′): S5 — a pass-through is pinned by the arguments it decides (`serve --help` → `serve` is a new key)', () => {
    const key = (args: string) =>
      run({
        'p.ts': `
import { execFileSync } from 'node:child_process'
export function probeSync(command: string, args: string[]) { return execFileSync(command, args) }
export function supportsServe(backend: { command: string }) { const prefix = ['-m', 'hermes_cli.main']; return probeSync(backend.command, [...prefix, ${args}]) }
`
      }).find(site => site.fn === 'supportsServe')!.key

    expect(key(`'serve', '--help'`)).not.toBe(key(`'serve'`))
    expect(key(`'serve', '--help'`)).toBe(key(`'serve',  '--help' /* why */`))
  })

  it('the key changes with the launch’s content and its command’s local source, not with comments or formatting', () => {
    const key = (body: string) =>
      run({ 'k.ts': `import { spawn } from 'node:child_process'\nexport function k() {\n${body}\n}` })[0]!.key

    const base = key(`const bin = 'git'\nspawn(bin, ['status'])`)

    expect(key(`const bin = 'git' // the scm\nspawn( bin,\n  [ 'status' ] /* why */ )`)).toBe(base)
    expect(key(`const bin = 'git'\nspawn(bin, ['status', 'serve'])`)).not.toBe(base)
    expect(key(`const bin = '/rt/venv/bin/python'\nspawn(bin, ['status'])`)).not.toBe(base)
  })
})
