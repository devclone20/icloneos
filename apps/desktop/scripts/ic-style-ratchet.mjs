#!/usr/bin/env node
// Style-literal ratchet for our CSS (plan AD8): raw colour / radius / shadow / blur / z-index literals may only go
// down. Counts are per file over src/app/home/** and src/app/settings/**; the token files are the allow-list, since
// that is where literals live. Fails (exit 1) when any count rises above scripts/ic-style-ratchet.baseline.json.
//
//   node scripts/ic-style-ratchet.mjs            check
//   node scripts/ic-style-ratchet.mjs --update   lower the baseline to today's counts (never raises one; creates it once)
//
// The counting rules mirror the P5 gate counter (RESUME/run/gates/P5/p5_static.py) so the two never disagree.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESK = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_APP = join(DESK, 'src', 'app')
const BASELINE = join(DESK, 'scripts', 'ic-style-ratchet.baseline.json')
const SCOPES = ['home', 'settings']
const ALLOW = new Set(['home/ic-tokens.css', 'home/ic-bridge.css', 'home/ic-layers.css'])
const KINDS = ['color', 'radius', 'shadow', 'blur', 'z']

const HEX = /(?<![\w-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g
const COLOR_FN = /(?<![\w-])(?:rgba?|hsla?)\(/gi
const URL_FN = /url\((?:[^()]|\([^()]*\))*\)/gi
const VAR_NAME = /--[\w-]+/g
const NUMBER = /(?<![\w.#-])-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|vh|vw|vmin|vmax|ch|ex)?(?![\w.])/g
const BLUR_LITERAL = /(?<![\w-])blur\(\s*(?!var\()/gi
const RADIUS_PROP = /^(?:-webkit-)?border(?:-[a-z]+)*-radius$/
const SHADOW_KEYWORDS = new Set(['none', 'inherit', 'initial', 'unset'])

const count = (re, s) => (s.match(re) ?? []).length

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, m => '\n'.repeat(m.split('\n').length - 1))
}

/** Declarations as [prop, value]; nesting, strings and parentheses are respected. */
export function declarations(css) {
  const s = stripComments(css)
  const out = []
  let buf = ''
  let depth = 0
  let paren = 0
  let quote = null

  const flush = requireDepth => {
    const seg = buf.trim()
    const colon = seg.indexOf(':')

    if (colon > 0 && (!requireDepth || depth > 0)) {
      out.push([seg.slice(0, colon).trim().toLowerCase(), seg.slice(colon + 1).trim()])
    }
  }

  for (let i = 0; i < s.length; i++) {
    const c = s[i]

    if (quote) {
      buf += c

      if (c === '\\' && i + 1 < s.length) {
        buf += s[++i]
      } else if (c === quote) {
        quote = null
      }
    } else if (c === "'" || c === '"') {
      quote = c
      buf += c
    } else if (c === '(') {
      paren++
      buf += c
    } else if (c === ')') {
      paren = Math.max(0, paren - 1)
      buf += c
    } else if (c === '{' && paren === 0) {
      buf = ''
      depth++
    } else if (c === '}' && paren === 0) {
      flush(false)
      buf = ''
      depth = Math.max(0, depth - 1)
    } else if (c === ';' && paren === 0) {
      flush(true)
      buf = ''
    } else {
      buf += c
    }
  }

  return out
}

function hasLiteralNumber(value) {
  const v = value.replace(URL_FN, '').replace(VAR_NAME, '')

  return (v.match(NUMBER) ?? []).some(n => Number.parseFloat(n.replace(/[a-z%]+$/, '') || '0') !== 0)
}

/** Literal counts of one stylesheet. */
export function countLiterals(css) {
  const d = Object.fromEntries(KINDS.map(k => [k, 0]))

  for (const [prop, value] of declarations(css)) {
    const noUrl = value.replace(URL_FN, '')
    const colors = count(HEX, noUrl) + count(COLOR_FN, noUrl)
    d.color += colors
    d.blur += count(BLUR_LITERAL, noUrl)

    if (RADIUS_PROP.test(prop) && hasLiteralNumber(value)) {
      d.radius++
    }

    if ((prop === 'box-shadow' || prop === '-webkit-box-shadow') && !SHADOW_KEYWORDS.has(value.toLowerCase())) {
      if (hasLiteralNumber(value) || colors > 0) {
        d.shadow++
      }
    }

    if (prop === 'z-index' && /\d/.test(value.replace(VAR_NAME, ''))) {
      d.z++
    }
  }

  return d
}

function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name)

    return e.isDirectory() ? cssFiles(p) : e.name.endsWith('.css') ? [p] : []
  })
}

function measure() {
  const per = {}

  for (const scope of SCOPES) {
    for (const file of cssFiles(join(SRC_APP, scope))) {
      const rel = relative(SRC_APP, file).split(sep).join('/')

      if (!ALLOW.has(rel)) {
        per[rel] = countLiterals(readFileSync(file, 'utf8'))
      }
    }
  }

  return Object.fromEntries(Object.entries(per).sort(([a], [b]) => a.localeCompare(b)))
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf8')).files ?? {}
  } catch {
    return null
  }
}

function writeBaseline(files) {
  const totals = Object.fromEntries(KINDS.map(k => [k, Object.values(files).reduce((n, f) => n + f[k], 0)]))
  writeFileSync(BASELINE, `${JSON.stringify({ allow: [...ALLOW].sort(), totals, files }, null, 2)}\n`)
}

function main() {
  const now = measure()
  const base = readBaseline()
  const update = process.argv.includes('--update')

  if (base === null) {
    if (update) {
      writeBaseline(now)
      console.log('ic-style-ratchet: baseline created')

      return
    }

    console.error(`ic-style-ratchet: no baseline at ${relative(DESK, BASELINE)} (create it with --update)`)
    process.exit(1)
  }

  const rises = []

  for (const [file, counts] of Object.entries(now)) {
    for (const k of KINDS) {
      const was = base[file]?.[k] ?? 0

      if (counts[k] > was) {
        rises.push(`${file}: ${k} ${was} -> ${counts[k]} (+${counts[k] - was})`)
      }
    }
  }

  if (rises.length) {
    console.error(`ic-style-ratchet: ${rises.length} literal count(s) rose — use the --ic-* tokens instead:`)
    rises.forEach(r => console.error(`  ${r}`))
    process.exit(1)
  }

  if (update) {
    writeBaseline(now)
    console.log('ic-style-ratchet: baseline lowered to the current counts')

    return
  }

  const total = k => Object.values(now).reduce((n, f) => n + f[k], 0)
  console.log(`ic-style-ratchet: ok (${KINDS.map(k => `${k} ${total(k)}`).join(', ')})`)
}

main()
