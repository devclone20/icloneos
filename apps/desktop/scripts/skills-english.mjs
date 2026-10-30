// Ruling 69 (English only) for the skills the app ships: `iclone/skills` is copied verbatim into the bundle as
// Resources/hermes-skill (package.json extraResources, filter `!**/.*`), shown on the Skills page and put in the agent's
// prompt. Review r2 (R2-M6): about thirty of those files were in Portuguese (pt-PT, and pt-BR without accents). This
// finds every line that still reads as Portuguese. Usage: node skills-english.mjs [dir]; exit 1 when any line does,
// when a file is binary (bytecode, NUL bytes), or when the tree has no file at all; on success it prints the counts.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { DEFAULT_BUNDLE } from './port-owner-skills.mjs'
import { isMain } from './utils.mjs'

/** URLs, e-mail addresses, host names and reverse-DNS ids: `com`, `pt` or `br` in them is not a Portuguese word. */
const NOT_PROSE = /https?:\/\/\S+|\b[\w.+-]+@[\w.-]+|\b(?:[\w-]+\.)+(?:com|br|pt|org|io|dev|ai|net)\b|\bcom\.[\w.]+/g

/** Letters English text does not use (Portuguese accents). */
const PT_LETTERS = /[ãõçáéíóúâêôàÃÕÇÁÉÍÓÚÂÊÔÀ]/

/**
 * Lower-case Portuguese function words and the words these skills used most, whole words only. Calibrated on the tree
 * before R2-M6 (about 1,500 lines found, pt-BR without accents included) and after it (0), with no English false positive.
 */
const PT_WORDS =
  /\b(não|nao|são|também|tambem|então|você|voce|está|quando|isto|isso|aqui|peça|fazer|sempre|nunca|ainda|depois|porque|já|uma|para|com|dos|das|pelo|pela|seja|deve|cada|onde|ficheiro|ficheiros|utilizador|português|portugues|arquivo|codigo|código|segurança|seguranca|tudo|nada|mais|muito|agora|antes|sem|pelos|pelas|nas|nos|numa|aos|nome|pronto|testes|segundo|abre|faz|curto|dono|agente|usar|à|às|é)\b/u

/**
 * Short Portuguese words that are not English words but are too short to trust alone (a flag `-o`, a `de` in a name):
 * two DIFFERENT ones on one line mark it. Review r3 (R3-m2): a pt line with no accent and none of the words above
 * ("Corre o teste de novo e mostra o resultado ao lead.") used to pass. English words (`a`, `do`, `no`, `as`, `se`,
 * `os`, `e`) are left out on purpose: two of them on one line are ordinary English or code.
 */
const PT_PAIR_WORDS =
  /\b(o|de|que|em|ao|da|na|um|por|mas|ele|ela|lhe|novo|nova|mostra|mostrar|corre|correr|resultado|teste|ver|fica|ficar|tem|ter|foi|vai|isso|esta|este|estes|estas|essa|esse|pode|podes|quer|queres|depois|outra|outro)\b/gu

/** The marker a line carries, or null when it reads as English. */
export function portugueseMarker(line) {
  const prose = line.replace(NOT_PROSE, ' ')
  const match = PT_LETTERS.exec(prose) ?? PT_WORDS.exec(prose)

  if (match) {
    return match[0]
  }

  const pair = [...new Set([...prose.matchAll(PT_PAIR_WORDS)].map(found => found[0]))]

  return pair.length >= 2 ? pair.slice(0, 2).join(' ') : null
}

function shippedFiles(root, rel = '') {
  return readdirSync(path.join(root, rel), { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.'))
    .flatMap(entry => {
      const child = rel ? `${rel}/${entry.name}` : entry.name

      return entry.isDirectory() ? shippedFiles(root, child) : entry.isFile() ? [child] : []
    })
}

/**
 * Compiled files, refused by name (review r4 B1-9 / R4-14): Python bytecode a test run or an import left beside a
 * skill's script (`__pycache__/x.cpython-314.pyc`) is build residue, never skill content, and would ship as it is.
 */
const BYTECODE = /(?:^|\/)__pycache__\/|\.py[co]$/

/** Why a shipped file is not text this scan can read (`bytecode`, `NUL bytes`), or null for a text file. */
function binaryReason(file, bytes) {
  return BYTECODE.test(file) ? 'bytecode' : bytes.includes(0) ? 'NUL bytes' : null
}

/**
 * The whole scan of a shipped tree: how many files and lines were read, every line that reads as Portuguese
 * (`{ file, line, marker }`) and every binary file (`{ file, reason }`, never read as lines).
 */
export function scanBundle(root = DEFAULT_BUNDLE) {
  const report = { files: 0, lines: 0, hits: [], binary: [] }

  for (const file of shippedFiles(root)) {
    const bytes = readFileSync(path.join(root, file))
    const reason = binaryReason(file, bytes)

    report.files += 1

    if (reason) {
      report.binary.push({ file, reason })
      continue
    }

    const lines = bytes.toString('utf8').split('\n')

    if (lines.at(-1) === '') {
      lines.pop()
    }

    report.lines += lines.length
    lines.forEach((text, index) => {
      const marker = portugueseMarker(text)

      if (marker !== null) {
        report.hits.push({ file, line: index + 1, marker })
      }
    })
  }

  return report
}

/** Every line of the shipped tree that reads as Portuguese: `{ file, line, marker }`. */
export function portugueseLines(root = DEFAULT_BUNDLE) {
  return scanBundle(root).hits
}

// The step is never green on silence (review r4 B1-9): success prints what was scanned, and a tree with no file in it
// (a wrong path, an empty bundle) is refused, since 0 Portuguese lines in 0 files proves nothing.
if (isMain(import.meta.url)) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_BUNDLE
  const { files, lines, hits, binary } = scanBundle(root)

  for (const { file, reason } of binary) {
    console.error(`[skills-english] RED ${file} binary file in skill bundle (${reason})`)
  }

  for (const hit of hits) {
    console.error(`[skills-english] RED ${hit.file}:${hit.line} reads as Portuguese ("${hit.marker}")`)
  }

  if (files === 0) {
    console.error(`[skills-english] RED ${root}: 0 files to scan, an empty skill bundle proves nothing`)
  }

  const ok = files > 0 && hits.length === 0 && binary.length === 0

  ;(ok ? console.log : console.error)(
    `[skills-english] ${ok ? 'OK' : 'RED'} ${files} files, ${lines} lines scanned, ${hits.length} Portuguese, ${binary.length} binary`
  )
  process.exit(ok ? 0 : 1)
}
