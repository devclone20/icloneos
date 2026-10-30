/**
 * V3-FX FX-2 (privacy): no keychain dialog at startup. Every use of Electron's `safeStorage` in the main process is
 * listed here with the guard that keeps it from touching the macOS keychain while the owner's Keychain setting
 * (`secretStoragePolicy().on`, default OFF) is off. Live finding (V3-ON): main.ts handed `safeStorage` to the ACP tools
 * and permission sealers unguarded, and both call `isEncryptionAvailable()` on the spot — at launch.
 *
 * The scan is structural (TypeScript AST): every `safeStorage` identifier outside its import, in every non-test file
 * under electron/, must sit either under the policy guard (the true branch of a `secretStoragePolicy().on` condition,
 * or after an early `if (!secretStoragePolicy().on) return`) or at one of the named sites below, each with its reason.
 * A new unguarded site turns this red.
 */
import fs from 'node:fs'
import path from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = path.join(__dirname)
const POLICY = /secretStoragePolicy\(\)\.on\b/

/** Sites guarded by something other than the policy itself: file → enclosing function or call → reason. */
const NAMED_GUARDS: { file: string; within: string; reason: string }[] = [
  {
    file: 'main.ts',
    within: 'keychain.sealer',
    reason: 'V3-FX M1: the live keychain switch builds a sealer only while the setting is on (iclone-live-sealing.ts)'
  },
  {
    file: 'main.ts',
    within: 'enableBasicPasswordStoreEncryption',
    reason: 'Linux `--password-store=basic` only (hardening.ts returns before any call on macOS; hardening tests)'
  },
  {
    file: 'iclone-doctor-main.ts',
    within: 'gatedKeychainProbe',
    reason: 'the doctor probe runs only when encryptionOn() is true (gatedKeychainProbe)'
  },
  {
    file: 'main/secret-storage.ts',
    within: 'applySecretStorageEncryption',
    reason: "the owner's own Settings toggle turning the Keychain on (or off): a user action, never at launch"
  },
  {
    file: 'main/secrets.ts',
    within: 'decryptDesktopSecret',
    reason: "a legacy safeStorage blob, before the one-shot migration only (classifyStoredSecret 'drop' after it)"
  }
]

interface Site {
  file: string
  line: number
  guard: string
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sourceFiles(full)
    }

    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [full] : []
  })
}

/**
 * The local names Electron's `safeStorage` is bound to in this file: `safeStorage`, an alias (`safeStorage as kc`), or
 * a namespace import (`import * as electron` → `electron.safeStorage`, reported as `<ns>.safeStorage`). m1: an alias
 * must not hide a keychain site from this scan.
 */
function safeStorageBindings(source: ts.SourceFile): { names: Set<string>; namespaces: Set<string> } {
  const names = new Set<string>()
  const namespaces = new Set<string>()

  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'electron'
    ) {
      continue
    }

    const bindings = statement.importClause?.namedBindings

    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === 'safeStorage') {
          names.add(element.name.text)
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text)
    }

    if (statement.importClause?.name) {
      namespaces.add(statement.importClause.name.text)
    }
  }

  return { names, namespaces }
}

function nameOf(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
    return node.name.getText()
  }

  if (ts.isCallExpression(node)) {
    return node.expression.getText()
  }

  return null
}

/** An early `if (!secretStoragePolicy().on) { …return }` before `node` in an enclosing block. */
function earlyPolicyReturn(block: ts.Block, node: ts.Node): boolean {
  return block.statements.some(
    statement =>
      statement.end <= node.pos &&
      ts.isIfStatement(statement) &&
      /^!\s*secretStoragePolicy\(\)\.on$/.test(statement.expression.getText().trim()) &&
      /\breturn\b/.test(statement.thenStatement.getText())
  )
}

function guardOf(file: string, node: ts.Node): string | null {
  for (let at: ts.Node = node; at.parent; at = at.parent) {
    const parent = at.parent

    if (ts.isConditionalExpression(parent) && at === parent.whenTrue && POLICY.test(parent.condition.getText())) {
      return 'policy'
    }

    if (ts.isIfStatement(parent) && at === parent.thenStatement && POLICY.test(parent.expression.getText())) {
      return 'policy'
    }

    if (ts.isBlock(parent) && earlyPolicyReturn(parent, at)) {
      return 'policy'
    }

    const name = nameOf(parent)
    const named = NAMED_GUARDS.find(guard => guard.file === file && guard.within === name)

    if (named) {
      return `named:${named.within}`
    }
  }

  return null
}

function scan(): Site[] {
  const sites: Site[] = []

  for (const full of sourceFiles(ROOT)) {
    const text = fs.readFileSync(full, 'utf8')

    if (!/\bsafeStorage\b|from 'electron'/.test(text)) {
      continue
    }

    const source = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const { names, namespaces } = safeStorageBindings(source)

    if (names.size === 0 && namespaces.size === 0) {
      continue
    }

    const file = path.relative(ROOT, full).split(path.sep).join('/')

    const visit = (node: ts.Node) => {
      const aliasUse =
        ts.isIdentifier(node) &&
        names.has(node.text) &&
        !ts.isImportSpecifier(node.parent) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
        !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)

      const namespaceUse =
        ts.isPropertyAccessExpression(node) &&
        node.name.text === 'safeStorage' &&
        ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text)

      if (aliasUse || namespaceUse) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart())

        sites.push({ file, line: line + 1, guard: guardOf(file, node) ?? 'NONE' })
      }

      ts.forEachChild(node, visit)
    }

    visit(source)
  }

  return sites
}

describe('FX-2 m1: the scan sees an aliased or namespaced safeStorage too', () => {
  it('an alias and a namespace import are both found, and unguarded is reported', () => {
    const fixture = path.join(ROOT, '__fx2_alias_fixture__.ts')

    fs.writeFileSync(
      fixture,
      [
        "import * as electron from 'electron'",
        "import { safeStorage as kc } from 'electron'",
        'export const a = kc.isEncryptionAvailable()',
        'export const b = electron.safeStorage.isEncryptionAvailable()'
      ].join('\n')
    )

    try {
      const found = scan().filter(site => site.file === '__fx2_alias_fixture__.ts')

      expect(found).toEqual([
        { file: '__fx2_alias_fixture__.ts', line: 3, guard: 'NONE' },
        { file: '__fx2_alias_fixture__.ts', line: 4, guard: 'NONE' }
      ])
    } finally {
      fs.rmSync(fixture, { force: true })
    }
  })
})

describe('FX-2: every safeStorage site is behind the Keychain policy (no keychain dialog at startup)', () => {
  const sites = scan()

  it('finds the main-process sites (the scan is alive)', () => {
    expect(new Set(sites.map(site => site.file))).toEqual(
      new Set(['main.ts', 'iclone-doctor-main.ts', 'main/secret-storage.ts', 'main/secrets.ts'])
    )
    expect(sites.filter(site => site.file === 'main.ts').length).toBeGreaterThanOrEqual(6)
  })

  it('no site is unguarded', () => {
    expect(sites.filter(site => site.guard === 'NONE')).toEqual([])
  })

  it('the ACP tools and permission sealers are built only under the policy (main.ts, the V3-ON finding)', () => {
    const main = fs.readFileSync(path.join(ROOT, 'main.ts'), 'utf8')

    for (const sealer of ['acpToolsSealer(safeStorage)', 'permissionKeySealer(safeStorage)']) {
      const lines = main.split('\n').filter(line => line.includes(sealer))

      expect(lines.length).toBeGreaterThan(0)

      for (const line of lines) {
        // Either the policy itself, or the live switch that builds only while the policy is on (M1).
        expect(line).toMatch(/secretStoragePolicy\(\)\.on\b|keychain\.sealer\(/)
      }
    }
  })

  it('every named guard is still used (a stale exemption is removed, never kept)', () => {
    for (const guard of NAMED_GUARDS) {
      expect(sites.some(site => site.file === guard.file && site.guard === `named:${guard.within}`)).toBe(true)
    }
  })
})
