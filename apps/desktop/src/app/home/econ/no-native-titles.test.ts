import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * U3-p2-05: hints in the econ windows come from the app's hint layer (`Tip`),
 * never from a native `title` tooltip. The population is every component file
 * under econ/, found on disk — not a list typed here. `window.tsx` is the one
 * file left out: it belongs to front UF2B2 (its two titles are a patch in the
 * UF2B1 r1 handoff), and `<time title>` is the one native hint kept on purpose.
 */
const root = path.dirname(fileURLToPath(import.meta.url))
const OUT_OF_FRONT = new Set(['window.tsx'])

function componentFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      componentFiles(full, out)
    } else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') && !OUT_OF_FRONT.has(entry.name)) {
      out.push(full)
    }
  }

  return out
}

/** `file:line <tag title>` for every `title=` on an intrinsic element other than `<time>`. */
function nativeTitles(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )

  const hits: string[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'title') {
      const element = node.parent.parent

      if (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) {
        const tag = element.tagName.getText(source)

        if (/^[a-z]/.test(tag) && tag !== 'time') {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))

          hits.push(`${path.relative(root, file)}:${line + 1} <${tag} title>`)
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(source)

  return hits
}

describe('econ windows have no native tooltips (U3-p2-05)', () => {
  it('no `title=` on an intrinsic element except <time>, in every econ component file', () => {
    const files = componentFiles(root)

    expect(files.length).toBeGreaterThan(20)
    expect(files.flatMap(nativeTitles)).toEqual([])
  })
})
