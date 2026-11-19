// Faint-ink gate (v0.0.9 r3, lead order). --ic-text-3 is ink at 40 %: it measures under 3:1 on every plate in both
// skins (P0_NOTIFICATIONS.md: "--ic-text-3 always fails 4.5"). It is for incidental text only: meta, separators, hints,
// placeholders and disabled controls. An element the owner can press — a button, link, tab, menu item, chip, toggle,
// a toast or banner action — must never wear it, in any state but disabled. This gate scans the whole renderer tree:
//
//   CSS  any `color` / `-webkit-text-fill-color` declaration that reads the faint token (or an alias of it) on a
//        selector whose subject is an interactive element: a <button>/<a>/<summary>/<select>, an interactive role,
//        a class that sits on an interactive JSX element anywhere in src/ (found by parsing every .tsx), or a class
//        whose BEM element names a control (btn, button, link, tab, action, chip, item, toggle, …).
//   TSX  a Tailwind `text-(--faint)` / `text-[color:var(--faint)]` utility on an interactive JSX element.
//
// Exempt in both: the disabled state (`:disabled`, `[aria-disabled='true']`, `disabled:`), placeholders, and pseudo
// elements (`::before` separators are not labels). Aliases are found, not listed: any custom property whose value is
// exactly `var(--<faint>)` joins the set, transitively (today --e-faint and --ic-inft-name-ink).
//
// Self-contained (no import of the ratchet: it imports this module while its own top-level await is pending).
// Imported by ic-style-ratchet.mjs (so `node scripts/ic-style-ratchet.mjs` runs it) and by ic-faint-ink.test.mjs.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const DESK = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SRC = join(DESK, 'src')
export const FAINT_ROOT = 'ic-text-3'

const INTERACTIVE_TAGS = new Set(['button', 'a', 'summary', 'select'])
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'tab',
  'menuitem',
  'menuitemradio',
  'menuitemcheckbox',
  'option',
  'switch',
  'checkbox',
  'radio'
])
// A JSX component whose name ends in one of these renders a control (IcPageButton, DropdownMenuItem, TabsTrigger…).
const INTERACTIVE_COMPONENT = /(?:Button|Link|MenuItem|Trigger|Tab|Toggle|Chip|Action)$/
// The BEM element (after `__`, before `--`) or the last dash word of a block naming a control.
// `chip` and `item` are left to the JSX cross-reference: a static attribute chip or a list item is not a control.
const CONTROL_WORD = /^(?:btn|button|iconbtn|link|tab|action|toggle|trigger|reset|clear|refresh|retry|close|cta|crumb|star|seg|addrow|disclosure-btn)$/

// v0.0.9 r4 (design r3 N7): informative text roles. A page subtitle, a dim line ("Wallet 0x…"), a hint under a field
// and a status line carry information the owner reads; they hold AA too (--ic-text-2-aa). Still exempt: decorative
// separators and pseudo elements, placeholders and disabled states (EXEMPT_STATE), and incidental meta.
const INFO_WORD = /^(?:subtitle|dim|hint|status)$/

const walk = (dir, ext) =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name)

    if (e.isDirectory()) {
      return e.name === 'node_modules' ? [] : walk(p, ext)
    }

    return ext.some(x => e.name.endsWith(x)) && !/\.test\.[jt]sx?$/.test(e.name) ? [p] : []
  })

const rel = file => relative(DESK, file).split(sep).join('/')

/** Rules as { selector, prop, value, line }, nesting flattened (at-rules keep their parent's selector). */
export function rules(css) {
  const s = css.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  const out = []
  const stack = []
  let buf = ''
  let line = 1
  let paren = 0

  const take = () => {
    const seg = buf.trim()
    const colon = seg.indexOf(':')
    const selector = [...stack].reverse().find(x => !x.startsWith('@')) ?? ''

    if (colon > 0 && stack.length) {
      out.push({ selector, prop: seg.slice(0, colon).trim().toLowerCase(), value: seg.slice(colon + 1).trim(), line })
    }
  }

  for (const c of s) {
    if (c === '\n') {
      line++
    }

    if (c === '(') {
      paren++
    } else if (c === ')') {
      paren = Math.max(0, paren - 1)
    }

    if (c === '{' && paren === 0) {
      stack.push(buf.trim().replace(/\s+/g, ' '))
      buf = ''
    } else if (c === '}' && paren === 0) {
      take()
      stack.pop()
      buf = ''
    } else if (c === ';' && paren === 0) {
      take()
      buf = ''
    } else {
      buf += c
    }
  }

  return out
}

/** The faint token and every custom property that is exactly an alias of it, transitively. */
export function faintSet(cssTexts) {
  const set = new Set([FAINT_ROOT])
  const aliases = []

  for (const css of cssTexts) {
    for (const { prop, value } of rules(css)) {
      const m = /^var\(--([\w-]+)\)$/.exec(value)

      if (prop.startsWith('--') && m) {
        aliases.push([prop.slice(2), m[1]])
      }
    }
  }

  for (let grew = true; grew; ) {
    grew = false

    for (const [name, target] of aliases) {
      if (set.has(target) && !set.has(name)) {
        set.add(name)
        grew = true
      }
    }
  }

  return set
}

const readsFaint = (value, faint) => [...value.matchAll(/var\(--([\w-]+)/g)].some(m => faint.has(m[1]))

const EXEMPT_STATE = /:disabled|\[aria-disabled=['"]?true['"]?\]|\[data-disabled\]|::?placeholder|::?before|::?after|::?marker/

/** The subject (last compound) of one selector, without pseudo-classes. */
function subject(sel) {
  const parts = sel.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean)

  return parts.at(-1) ?? ''
}

function controlClass(cls) {
  const element = cls.includes('__') ? cls.split('__').at(-1) : cls
  const base = element.split('--')[0]

  return CONTROL_WORD.test(base) || CONTROL_WORD.test(base.split('-').at(-1) ?? '')
}

/** Why a CSS subject is interactive, or null. */
export function interactiveSubject(sel, interactiveClasses) {
  if (EXEMPT_STATE.test(sel)) {
    return null
  }

  const subj = subject(sel)
  const tag = /^([a-z][a-z0-9]*)/.exec(subj)?.[1]

  if (tag && INTERACTIVE_TAGS.has(tag)) {
    return `<${tag}>`
  }

  const role = /\[role=['"]?([\w-]+)/.exec(subj)?.[1]

  if (role && INTERACTIVE_ROLES.has(role)) {
    return `role=${role}`
  }

  // A compound like `.wallet-table__head.e-row` is judged by its BEM element class when it has one: the shared block
  // class (`.e-row`) also sits on clickable rows elsewhere, but this header row is not one of them.
  const classes = [...subj.matchAll(/\.([\w-]+)/g)].map(m => m[1])
  const elements = classes.filter(c => c.includes('__'))

  for (const c of elements.length ? elements : classes) {
    const m = [null, c]

    if (interactiveClasses.has(m[1])) {
      return `.${m[1]} sits on an interactive element (${interactiveClasses.get(m[1])})`
    }

    if (controlClass(m[1])) {
      return `.${m[1]} names a control`
    }
  }

  return null
}

/** Why a CSS subject is informative text (design r3 N7), or null. */
export function informativeSubject(sel) {
  if (EXEMPT_STATE.test(sel)) {
    return null
  }

  for (const [, c] of subject(sel).matchAll(/\.([\w-]+)/g)) {
    const element = (c.includes('__') ? c.split('__').at(-1) : c).split('--')[0]
    const word = INFO_WORD.test(element) ? element : element.split('-').at(-1)

    if (INFO_WORD.test(word ?? '')) {
      return `.${c} is informative text (${word})`
    }
  }

  return null
}

function jsxName(node) {
  return node.tagName.getText()
}

function attr(node, name) {
  return node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText() === name)
}

function interactiveJsx(node) {
  const name = jsxName(node)
  const role = attr(node, 'role')
  const roleValue = role?.initializer && ts.isStringLiteral(role.initializer) ? role.initializer.text : null

  if (INTERACTIVE_TAGS.has(name)) {
    return `<${name}>`
  }

  if (roleValue && INTERACTIVE_ROLES.has(roleValue)) {
    return `role=${roleValue}`
  }

  if (/^[A-Z]/.test(name) && INTERACTIVE_COMPONENT.test(name.split('.').at(-1))) {
    return `<${name}>`
  }

  if (attr(node, 'onClick') && !attr(node, 'aria-hidden')) {
    return `<${name} onClick>`
  }

  return null
}

/** Every string piece in a className expression (literals, template parts, cn() arguments, ternaries). */
function classStrings(expr) {
  const out = []

  const visit = n => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      out.push(n.text)
    } else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text, ...n.templateSpans.map(s => s.literal.text))
    }

    ts.forEachChild(n, visit)
  }

  visit(expr)

  return out
}

function faintUtility(token, faint) {
  // Tailwind: [variants:]text-(--x) or text-[color:var(--x)]; a disabled/placeholder variant is exempt.
  const m = /^((?:[\w-[\]=&'".:/]+:)*)text-(?:\(--([\w-]+)\)|\[color:var\(--([\w-]+)\)\])$/.exec(token)

  if (!m || !faint.has(m[2] ?? m[3])) {
    return false
  }

  return !/(?:^|:)(?:disabled|placeholder|group-disabled|peer-disabled|aria-disabled|data-\[disabled\])/.test(m[1])
}

/** Scan the TSX tree: the classes on interactive elements, and the faint utilities placed on them. */
export function scanTsx(files, faint) {
  const interactiveClasses = new Map()
  const violations = []

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

    const visit = node => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const why = interactiveJsx(node)
        const cls = attr(node, 'className')

        if (why && cls?.initializer) {
          const expr = ts.isJsxExpression(cls.initializer) ? cls.initializer.expression : cls.initializer

          for (const piece of expr ? classStrings(expr) : []) {
            for (const token of piece.split(/\s+/).filter(Boolean)) {
              if (/^[a-z][\w-]*$/.test(token) && (token.includes('__') || /^[a-z]+-[a-z]/.test(token))) {
                if (!interactiveClasses.has(token)) {
                  interactiveClasses.set(token, `${rel(file)} ${why}`)
                }
              }

              if (faintUtility(token, faint)) {
                const { line } = sf.getLineAndCharacterOfPosition(node.getStart())
                violations.push(`${rel(file)}:${line + 1} ${why} wears ${token}`)
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sf)
  }

  return { interactiveClasses, violations }
}

// Utility-looking tokens that are Tailwind, not our BEM classes; never a CSS subject of ours.
const isOurClass = c => c.includes('__') || /^(?:ic|e|em|mk|bk|hl|icp|icsk|icpg|icui|icn|iw|ifiles|imsg|iecon|irpick|icc|icag|ibg|cron|icont)[-_]/.test(c)

/** The whole gate over a renderer tree: { violations: string[], faint: Set }. */
export function checkFaintInk(srcDir = SRC) {
  const cssFiles = walk(srcDir, ['.css'])
  const cssTexts = cssFiles.map(f => readFileSync(f, 'utf8'))
  const faint = faintSet(cssTexts)
  const tsx = scanTsx(walk(srcDir, ['.tsx']), faint)
  const classes = new Map([...tsx.interactiveClasses].filter(([c]) => isOurClass(c)))
  const violations = [...tsx.violations]

  cssFiles.forEach((file, i) => {
    for (const r of rules(cssTexts[i])) {
      if ((r.prop === 'color' || r.prop === '-webkit-text-fill-color') && readsFaint(r.value, faint)) {
        for (const sel of r.selector.split(',')) {
          const why = interactiveSubject(sel, classes) ?? informativeSubject(sel)

          if (why) {
            violations.push(`${rel(file)}:${r.line} ${sel.trim()} { ${r.prop}: ${r.value} } — ${why}`)
          }
        }
      }
    }
  })

  return { violations, faint }
}
