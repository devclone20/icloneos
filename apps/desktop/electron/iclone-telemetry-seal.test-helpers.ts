/**
 * Ruling 54.4 audit, shared by iclone-telemetry-seal.test.ts and hermes-spawn-paths.test.ts: in a source file, every
 * way to start a child process is one the telemetry seal covers.
 *   - `node:child_process` imports name only sealed primitives (or types); a default/namespace import is the module
 *     object the seal patches;
 *   - node-pty spawns pass `sealTelemetryEnv(...)` as their env (node-pty is native: the seal cannot patch it);
 *   - no other process-launching package is imported.
 */
import fs from 'node:fs'

import ts from 'typescript'

import { SEALED_CHILD_PROCESS } from './iclone-telemetry-seal'

const OTHER_LAUNCHERS = ['execa', 'cross-spawn', 'tinyexec', 'zx', 'shelljs', 'node:cluster', 'cluster', 'nano-spawn']

const TYPE_ONLY =
  /^(ChildProcess|ChildProcessByStdio|ChildProcessWithoutNullStreams|SpawnOptions|ExecFileSyncOptionsWithStringEncoding|ExecFileOptions|ExecOptions|SpawnSyncOptions|SpawnSyncReturns|ExecSyncOptions|StdioOptions|IOType)$/

export function sealBypasses(file: string, text: string = fs.readFileSync(file, 'utf8')): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const problems: string[] = []
  const ptyNames = new Set<string>()

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = node.moduleSpecifier.text
      const bindings = node.importClause?.namedBindings

      if (OTHER_LAUNCHERS.includes(from)) {
        problems.push(`imports ${from}`)
      }

      if ((from === 'node:child_process' || from === 'child_process') && bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const name = (element.propertyName ?? element.name).text

          if (!element.isTypeOnly && !node.importClause?.isTypeOnly && !TYPE_ONLY.test(name)) {
            if (!(SEALED_CHILD_PROCESS as readonly string[]).includes(name)) {
              problems.push(`child_process.${name} is not sealed`)
            }
          }
        }
      }

      if (from === 'node-pty' || from === '@lydell/node-pty') {
        if (node.importClause?.name) {
          ptyNames.add(node.importClause.name.text)
        }

        if (bindings && ts.isNamespaceImport(bindings)) {
          ptyNames.add(bindings.name.text)
        }
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'spawn' &&
      /pty/i.test(node.expression.expression.getText())
    ) {
      const options = node.arguments[2]

      if (!options || !/env:\s*sealTelemetryEnv\(/.test(options.getText())) {
        problems.push(
          `a pty spawn without sealTelemetryEnv (line ${source.getLineAndCharacterOfPosition(node.getStart()).line + 1})`
        )
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(source)
  void ptyNames

  return problems
}
