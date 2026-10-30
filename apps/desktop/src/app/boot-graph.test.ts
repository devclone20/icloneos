/**
 * K99–K101: what the renderer's boot path may not reach. Walks the STATIC import graph from `src/main.tsx` (value
 * imports and re-exports; `import type` and dynamic `import()` are not followed, exactly as the bundler splits), and
 * names every lazy-only module that a static import pulled back. The bundle measurement in
 * `RESUME/run/gates/V3K2_fix2_gates.sh` (boot_bytes.py) is the byte-level half of this gate.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '..')

/** Lazy-only: each loads on its first use (a locale chosen, Settings or the palette opened, a pet chosen, a window). */
const LAZY_ONLY = [
  'i18n/catalog.ts',
  'i18n/ar.ts',
  'i18n/ja.ts',
  'i18n/zh.ts',
  'i18n/zh-hant.ts',
  'i18n/pt-PT.ts',
  'app/settings/index.tsx',
  'app/settings/panes.tsx',
  'app/settings/settings-window.tsx',
  'components/permissions/permissions-pane.tsx',
  'app/home/containers/containers-app.tsx',
  'components/pet/pet-catalog.ts',
  'components/pet/pet-sprite.tsx',
  'components/pet/pet-draw.ts',
  'components/pet/pet-codec.ts'
]

function resolve(from: string, spec: string): null | string {
  const base = spec.startsWith('@/')
    ? path.join(SRC, spec.slice(2))
    : spec === '@hermes/plugin-sdk'
      ? path.join(SRC, 'sdk/index.ts')
      : spec.startsWith('.')
        ? path.resolve(path.dirname(from), spec)
        : null

  if (!base || spec.startsWith('@/debug/')) {
    return null
  }

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx')
  ]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

function staticImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false)
  const out: string[] = []

  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause

      const typeOnly =
        clause?.isTypeOnly ||
        (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(e => e.isTypeOnly)
          : false)

      if (!typeOnly) {
        out.push(node.moduleSpecifier.text)
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly =
        node.isTypeOnly ||
        (node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.length > 0 && node.exportClause.elements.every(e => e.isTypeOnly)
          : false)

      if (!typeOnly) {
        out.push(node.moduleSpecifier.text)
      }
    }
  }

  return out
}

/** Every module statically reachable from the entry, with the importer that reached it first. */
function bootGraph(entry: string): Map<string, null | string> {
  const seen = new Map<string, null | string>([[entry, null]])
  const queue = [entry]

  for (let file = queue.shift(); file; file = queue.shift()) {
    for (const spec of staticImports(file)) {
      const target = resolve(file, spec)

      if (target && !seen.has(target)) {
        seen.set(target, file)
        queue.push(target)
      }
    }
  }

  return seen
}

const chain = (graph: Map<string, null | string>, file: string): string => {
  const steps: string[] = []

  for (let at: null | string | undefined = file; at; at = graph.get(at)) {
    steps.push(path.relative(SRC, at))
  }

  return steps.join(' <- ')
}

describe('the boot import graph (K99–K101)', () => {
  const graph = bootGraph(path.join(SRC, 'main.tsx'))

  it('the walker sees the boot path (control: modules that must be there are found)', () => {
    for (const file of [
      'app/home/home-view.tsx',
      'app/settings/settings-dock.tsx',
      'app/home/containers/containers-dock.tsx',
      'components/pet/pet-ids.ts',
      'i18n/en.ts',
      'i18n/locale-loader.ts'
    ]) {
      expect(graph.has(path.join(SRC, file)), file).toBe(true)
    }
  })

  it('no lazy-only module is reached by a static import from main.tsx', () => {
    const pulled = LAZY_ONLY.filter(file => graph.has(path.join(SRC, file))).map(file =>
      chain(graph, path.join(SRC, file))
    )

    expect(pulled).toEqual([])
  })
})
