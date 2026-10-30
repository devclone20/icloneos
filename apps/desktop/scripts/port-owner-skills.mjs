#!/usr/bin/env node
// V3-B — port the owner's Claude Code skills into the app bundle (`iclone/skills/<name>/`), at BUILD/PORT time only.
//
// The owner decided (the v0.0.3 plan §4 #1, 2026-10-20) that his skills live NATIVELY in the app: copied, owned and shipped
// by it, never read from `~/.claude/skills` at runtime. The cost of a copy is drift, so every port carries a
// `manifest.json` with the source tree's sha256 and a per-skill port version, and `--check` reports the drift (exit 1).
//
//   node scripts/port-owner-skills.mjs [--from <library>] [--to <bundle>] [--only <name>]... [--identity <token>]...
//   node scripts/port-owner-skills.mjs --check [...]        drift + residue + attribution report, writes nothing
//   node scripts/port-owner-skills.mjs --list               the scope set, as JSON
//
// What a port does to each file (text only; binaries are refused — none of the 15 has one; dot files are never ported):
//   1. REFUSES the whole run when a file carries a secret-looking value (keys, tokens, private keys, JWTs) or a private
//      workflow marker (`~/.ssh`, `servers.json`, `PRIVADO`, `private until`, Gmail/inbox). Exit 1. The remedy for a
//      private reference file is `exclude` in PORT_SET: it is then left out of the bundle and named in the manifest.
//   2. Rewrites `/Users/<anyone>/…` → `~/…` in prose; in CODE (fenced blocks, inline commands, .py/.sh/.lua files) the
//      form the language resolves: `os.path.expanduser('~/…')` (Python), `os.getenv('HOME') .. '/…'` (Lua),
//      `"$HOME/…"` (shell). `~/.claude/skills/<self>/` → `{skill_dir}/`; `~/.claude/skills/<other>/` →
//      `{skills_root}/<other>/`; any other `~/.claude/…` → `{agent_home}/…`; the machine user name → `<user>`;
//      e-mails (except the one public no-reply address) → `<email>`; 0x40-hex addresses → `0x<address>`; the owner's
//      identity tokens (`--identity`, `PORT_IDENTITY`, the git user name) → `the owner`.
//   3. SKILL.md gets the bundle's frontmatter (name = folder, "Use when …" cue, the upstream version when the source has
//      one, `ported` = the port version, author, licence, tags, related_skills) and a short port note under the title.
//   4. A THIRD-PARTY source (a symlink in the library, a folder whose FILES are symlinks into a package, a licence
//      file in its folder or an ancestor, or a foreign author in its frontmatter) keeps its true author and licence:
//      the licence text is copied verbatim to `LICENSE` beside SKILL.md, the manifest carries `author`, `license`,
//      `upstream` (with the upstream copyright line verbatim), and `iclone/skills/THIRD-PARTY-NOTICES.md` lists every
//      such skill. A third-party source without a licence, or whose licence cannot be read, is refused.
//   5. Measured voice-profile numbers of a real person (`f0 N Hz`, `N palavras/s`, a pause in seconds, a spread in
//      semitones) become `<n>`; a machine-layout path (`~/Desktop/…`, `~/Developer/…`) that is not a declared
//      `requires.paths` root (or an ancestor of one) becomes `<your project folder>/…` in prose and an env form that
//      keeps the line valid in code (`$PROJECT_DIR/…`, `os.environ.get('PROJECT_DIR')`, `os.getenv('PROJECT_DIR')`).
//   6. The home-relative roots a tool script reaches for (assignments, `cd`, `sys.path`, `expanduser`, `$VAR/…`
//      expanded through the script's own assignments, `||` fallbacks included) must all be declared in
//      `requires.paths`; an undeclared one refuses the port, so the manifest never understates what a host needs.
//   7. `manifest.json` records source sha256 + ported_at, `requires` (os, bins, mcp, paths), `touches` (V3-F action
//      classes: the hand-written ones plus the classes the SKILL.md text implies — spend/pay/buy credits ⇒ `$`,
//      publish/post/send/git push ⇒ `N`), the owner's recorded waivers (a product name kept by his decision) and
//      `scrubbed: true` with the scrub counts (counts only, never the values).
// The scope set, cues, requirements, touches, exclusions and waivers live in PORT_SET below: the only hand-written part.
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { cueOf, parseFrontmatter, PROMPT_CUT } from '../../../iclone/skills/tools/build-catalog.mjs'
import {
  decodeEscapes,
  foldSplits,
  layoutNameRegex,
  machineLayoutChildren,
  machineLayoutNames,
  scanBuffer
} from './artifact-hygiene.mjs'
import {
  cleanSegment,
  declaredOf,
  interiorRanges,
  nameWords as nameWordsOf,
  EXT_RE,
  layoutFolderAt,
  machinePrivateNames,
  pathFindings,
  privateNameSpans,
  machineCoinedNames,
  productNames,
  isCodeFile,
  ownerNameSpans,
  ownerNamesOf,
  skillRuleId,
  skillTextRefusals,
  treeNames
} from './skill-text-policy.mjs'

const DESK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_BUNDLE = path.resolve(DESK, '..', '..', 'iclone', 'skills')
export const MANIFEST_FILE = 'manifest.json'
export const LICENSE_FILE = 'LICENSE'
export const NOTICES_FILE = 'THIRD-PARTY-NOTICES.md'
export const MANIFEST_SCHEMA = 1
export const ACTION_CLASSES = ['R', 'Wp', 'Wo', 'X', 'N', '$', 'M', 'S', 'I', 'D']
export const OWNER_AUTHOR = 'the owner (ported from his Claude Code skills library)'
const OWNER_WORD = 'the owner'

/** The one public address allowed to stay (a git trailer in a tool script). */
const EMAIL_ALLOW = new Set(['noreply@anthropic.com'])

/** The port note's line for each class of `redact` rule (only the classes that matched are written). */
const HIS_VALUE_NOTE = "a value labelled as the owner's own prosody is written `<n>` or left out"
const POINTER_NOTE = 'pointers to a file that is not ported are left out'
const CONTROL_PLANE_NOTE =
  'the control plane is `CONTROL/` and its local half `CONTROL/local.nosync/` (neutral folder names, in prose and code alike)'

/**
 * K140 r2 — a folder of the owner's machine that a skill really needs (an engine, a pipeline, a subtitles folder) ships
 * as a NAMED PLACE: an environment variable the host sets (`$RIDERVOICE_DIR/engine`), never the owner's folder layout.
 * K140 r5 (ruling 48): the repo holds no trace of where those folders are — no path, no digest. The porting machine
 * says it at port time: `PORT_PLACE_<ENV>` (absolute or `~/` paths, `:`-separated alternatives), kept in the owner's
 * private control plane. A place the porter did not set has no path; its folder then stays in the text and the
 * release policy refuses the port.
 */
export function place(env, what) {
  return Object.freeze({ env, what })
}

/** One named place built from the paths it stands for (alternatives; a space may be written `\ ` in the source). */
export function buildPlace(env, what, paths) {
  const alternatives = [...paths]
    .sort((a, b) => b.length - a.length)
    .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '(?: |\\\\ )'))

  return Object.freeze({
    env,
    what,
    // The scrub keeps these whole (inside-only roots: a folder above one is still the owner's machine); rewritePlaces
    // then names them.
    roots: Object.freeze(paths.map(p => `~/${p}`)),
    match: alternatives.length ? new RegExp(`(?:${alternatives.join('|')})`) : null
  })
}

/**
 * The places of a skill with their paths, from the porting machine (`values`, normally process.env): each place's
 * `PORT_PLACE_<ENV>` value, its alternatives split on `:`, written home-relative. A place already built is kept.
 */
export function resolvePlaces(places = [], values = process.env, home = homedir()) {
  return places.map(p => {
    if (p.roots) {
      return p
    }

    const paths = String(values[`PORT_PLACE_${p.env}`] ?? '')
      .split(':')
      .map(value => value.trim())
      .filter(Boolean)
      .map(value =>
        value.startsWith('~/') ? value.slice(2) : value.startsWith(`${home}/`) ? value.slice(home.length + 1) : null
      )
      .filter(Boolean)

    return buildPlace(p.env, p.what, paths)
  })
}

const PLACE_NOTE = "folders of the owner's machine are environment variables the host sets"

/**
 * K140 r3 — the names of the owner's folder layout (his projects, delivery folders and checkouts, read from the porting
 * machine: machineLayoutNames, never written in the repo) become one neutral name wherever they stand, in any spelling:
 * prose, code, a `join(...)` argument, a file name. The alias keeps the case, the joiner and a leading ordinal of what
 * it replaces (`001 - X Y` → `001 - SAMPLE PROJECT`, `x-y` → `sample-project`, `XyZw` → `SampleProject`).
 */
export const LAYOUT_ALIAS = Object.freeze(['sample', 'project'])
const LAYOUT_NOTE = `the owner's own folder and project names are written \`${LAYOUT_ALIAS.join(' ')}\` (in the case and joiner they had)`
const REFERENCE_NOTE = "the reference implementations are the owner's own projects and are not listed"

/** The alias of one layout-name match, in its case, joiner and ordinal. */
export function layoutAlias(match) {
  const ordinal = /^\d+\s*[-_.]\s*/.exec(match)?.[0] ?? ''
  const body = match.slice(ordinal.length)
  const joiner = /\s/.test(body)
    ? ' '
    : body.includes('-')
      ? '-'
      : body.includes('_')
        ? '_'
        : body.includes('.')
          ? '.'
          : ''
  const letters = body.replace(/[^\p{L}]/gu, '')
  const cased = LAYOUT_ALIAS.map(word =>
    letters === letters.toUpperCase()
      ? word.toUpperCase()
      : letters === letters.toLowerCase()
        ? word
        : word[0].toUpperCase() + word.slice(1)
  )

  return ordinal + cased.join(joiner)
}

/**
 * `text` with the owner's Desktop folders (`desktop`: their names on the porting machine, generic ones included) folded
 * into the project placeholder where they open a path: `<your project folder>/<folder>/x` and a relative `<folder>/x`
 * become `<your project folder>/x`. `onHit` is called once per fold.
 */
export function foldDesktopRoots(text, desktop, onHit = () => {}) {
  const names = [...desktop].sort((a, b) => b.length - a.length).map(escapeRe)

  if (!names.length) {
    return text
  }

  const re = new RegExp(`(?:${escapeRe(PROJECT_PLACEHOLDER)}/|(?<=^|[\\s\`'"(]))(?:${names.join('|')})/`, 'gm')

  return text.replace(re, () => {
    onHit()

    return `${PROJECT_PLACEHOLDER}/`
  })
}

/** `text` with every layout-name match of `re` replaced by its alias; `onHit` is called once per match. */
export function aliasLayoutNames(text, re, onHit = () => {}) {
  return re
    ? text.replace(new RegExp(re.source, re.flags), match => {
        onHit()

        return layoutAlias(match)
      })
    : text
}

const OWNER_PATH_NOTE = `a path into the owner's own folders is written \`${'<your project folder>'}/…\` (in shell code, \`\${PROJECT_DIR:?}\`)`
/** The raw [start, end) of each segment of a path token, aligned with skill-text-policy's segmentsOf. */
function rawSegments(token) {
  const ranges = []
  const separator = j => token[j] === '/' || (token[j] === '\\' && token[j + 1] !== ' ')
  let start = 0

  for (let i = 0; i <= token.length;) {
    if (i === token.length || separator(i)) {
      ranges.push({ start, end: i })

      while (i < token.length && separator(i)) {
        i += 1
      }

      start = i

      if (i === token.length) {
        break
      }

      continue
    }

    i += token[i] === '\\' && token[i + 1] === ' ' ? 2 : 1
  }

  return ranges.filter((range, k) => range.end > range.start || k === 0)
}

const OWNER_ROOTS = new Set(['<your project folder>', '$PROJECT_DIR', '${PROJECT_DIR}', '${PROJECT_DIR:?}'])

/**
 * K140 r4 (R4-1) — a path the skill-text policy refuses (a segment that is not generic: a numbered folder, a title, a
 * brand-like name, the owner's folder right under a home folder) is rewritten when it means the owner's own folder:
 * relative, under a home layout folder, or already under the project placeholder. The refused folders become the
 * placeholder (`<your project folder>/…`; in shell code `${PROJECT_DIR:?}/…`), a refused file name `<name>.<ext>`. Any
 * other refused path (under a system folder, a named place, an unknown variable) refuses the port: PORT_SET must say
 * what it is. Returns the text; `onHit` once per path.
 */
export function rewriteOwnerPaths(text, rel, ctx = {}, onHit = () => {}) {
  const shell = CODE_FILE[path.extname(rel).toLowerCase()] === 'shell'
  const placeholder = shell ? '${PROJECT_DIR:?}' : '<your project folder>'
  let out = text

  for (let pass = 0; pass < 4; pass += 1) {
    const refused = pathFindings(out, rel, ctx).filter(finding => finding.rule)

    if (!refused.length) {
      return out
    }

    for (const finding of refused.sort((a, b) => b.index - a.index)) {
      const { segments } = finding
      const owner = !finding.rooted || OWNER_ROOTS.has(segments[0]) || layoutFolderAt(segments) !== -1

      if (!owner || (CODE_FILE[path.extname(rel).toLowerCase()] && !shell) || /\.(?:m?js|cjs|lua|py)$/i.test(rel)) {
        throw new Error(
          `${rel}:${finding.line}: a path the release would refuse (${finding.rule}, segment ${finding.segment}) that is not the owner's folder — say what it is in PORT_SET`
        )
      }

      let token = out.slice(finding.index, finding.index + finding.length)
      const ranges = rawSegments(token)

      if (ranges.length !== segments.length) {
        throw new Error(`${rel}:${finding.line}: a path the port cannot split — say what it is in PORT_SET`)
      }

      const last = segments.length - 1
      const isFile = i => i === last && EXT_RE.test(cleanSegment(segments[i], true))
      const folders = finding.refused.filter(i => !isFile(i))

      if (finding.refused.some(isFile)) {
        const raw = token.slice(ranges[last].start, ranges[last].end)
        const cleaned = cleanSegment(raw, true)
        const lead = raw.indexOf(cleaned)
        const ext = EXT_RE.exec(cleaned)[0]

        token =
          token.slice(0, ranges[last].start) +
          raw.slice(0, lead) +
          `<name>${ext}` +
          raw.slice(lead + cleaned.length) +
          token.slice(ranges[last].end)
      }

      if (folders.length) {
        token = placeholder + token.slice(ranges[Math.max(...folders)].end)
      }

      onHit()
      out = out.slice(0, finding.index) + token + out.slice(finding.index + finding.length)
    }
  }

  throw new Error(`${rel}: a path the port could not settle in four passes`)
}

const nameKey = name => nameWordsOf(name).join(' ')

/** `aliasPrivateNames` outside the given [start, end) ranges (the inside of a declared interface root). */
function aliasOutside(text, keys, ranges, onHit) {
  let out = text

  for (const span of privateNameSpans(text, keys).reverse()) {
    if (ranges.some(([a, b]) => span.start >= a && span.end <= b)) {
      continue
    }

    onHit()
    out = out.slice(0, span.start) + layoutAlias(text.slice(span.start, span.end)) + out.slice(span.end)
  }

  return out
}

/**
 * K140 r5 — every coined single-word name of the machine (`ctx.coined`, machineCoinedNames) written as the layout alias
 * where the release policy refuses it: a segment of a path it reads (pathFindings, rule `path.coined`), or a literal
 * argument of a path-join call (the policy reads those folded). Anywhere else a non-English word is just a word.
 */
export function aliasCoinedNames(text, rel, ctx = {}, onHit = () => {}) {
  const { coined } = ctx

  if (!coined?.size) {
    return text
  }

  const isCoined = word => coined.has(nameWordsOf(word).join(''))
  let out = text

  for (const finding of pathFindings(text, rel, ctx).sort((a, b) => b.index - a.index)) {
    const token = out.slice(finding.index, finding.index + finding.length)
    const ranges = rawSegments(token)

    if (ranges.length !== finding.segments.length) {
      continue
    }

    let rebuilt = token

    for (let i = ranges.length - 1; i >= 0; i -= 1) {
      const raw = token.slice(ranges[i].start, ranges[i].end)
      const cleaned = cleanSegment(raw, i === ranges.length - 1)
      const word = cleaned.replace(EXT_RE, '')

      if (/^\p{L}{4,}$/u.test(word) && isCoined(word)) {
        const at = ranges[i].start + raw.indexOf(word)

        onHit()
        rebuilt = rebuilt.slice(0, at) + layoutAlias(word) + rebuilt.slice(at + word.length)
      }
    }

    out = out.slice(0, finding.index) + rebuilt + out.slice(finding.index + finding.length)
  }

  // A literal argument of a path-join call (`join(ROOT, "x", "out")`, `Path("x")`).
  return out.replace(/\b(?:join|joinpath|resolve|Path|PurePath|PosixPath)\([^()\n]{1,400}\)/g, call =>
    call.replace(/(?<=["'`])\p{L}{4,}(?=["'`])/gu, word => {
      if (!isCoined(word)) {
        return word
      }

      onHit()

      return layoutAlias(word)
    })
  )
}

/** The neutral words a series of the owner's is written as: a name of one word, a name of more. */
export const SERIES_ALIAS = Object.freeze({ one: ['showcase'], more: ['example', 'series'] })

function castLike(words, original) {
  // The joiner the name was written with (`lark-like` keeps `-`, `lark_like` keeps `_`); glued CamelCase stays glued.
  const found = original.match(/[^\p{L}\p{N}]+/u)?.[0]
  // Only an identifier joiner is kept; a space, a slash or an ampersand reads as a space.
  const separator = found ? (/^[-_.]$/.test(found) ? found : ' ') : /\p{Ll}\p{Lu}/u.test(original) ? '' : ' '
  const letters = original.replace(/[^\p{L}]/gu, '')
  const capital = word => word[0].toUpperCase() + word.slice(1)

  if (letters && letters === letters.toUpperCase()) {
    return words.join(separator || '_').toUpperCase()
  }

  if (separator === '') {
    return words.map((word, i) => (i === 0 && /^\p{Ll}/u.test(original) ? word : capital(word))).join('')
  }

  if (/^\p{Lu}/u.test(original)) {
    return words.map(capital).join(separator)
  }

  return words.join(separator)
}

/**
 * r5e (ruling 48, X1) — the owner's series names become a neutral example name in the case they had; a delivery folder
 * goes from a ` / ` list (with its separator), or becomes `a delivery folder` in prose. `owner` comes from the private
 * markers (ownerNamesOf); nothing here names one.
 */
export function neutraliseOwnerSeries(text, owner, onHit = () => {}, rel = 'SKILL.md') {
  let out = text
  let dropped = false
  const ext = path.extname(rel).toLowerCase()
  const shell = ['.sh', '.bash', '.zsh'].includes(ext)
  const code = isCodeFile(rel)

  for (const span of ownerNameSpans(text, owner).reverse()) {
    // An identity name is the scrub's (it becomes "the owner" there); one left over is refused by the gate, never
    // rewritten here.
    if (span.kind === 'identity') {
      continue
    }

    const original = out.slice(span.start, span.end)
    const before = out.slice(0, span.start)
    const after = out.slice(span.end)

    onHit()

    if (span.kind === 'series') {
      // r5f m1: no "example series series" when the text already says series after the name.
      const tail = /^[\s_.-]+series\b/i.test(after)
      const words = tail ? ['example'] : span.words > 1 ? SERIES_ALIAS.more : SERIES_ALIAS.one

      out = before + castLike(words, original) + after
      continue
    }

    if (/ \/ $/.test(before)) {
      out = before.slice(0, -3) + after
      dropped = true
    } else if (/^ \/ /.test(after)) {
      out = before + after.slice(3)
      dropped = true
    } else if (shell) {
      // r5f m2: in shell code a placeholder variable keeps the command valid.
      out = `${before}"\${DELIVERY_DIR}"${after}`
    } else if (code) {
      out = `${before}delivery-folder${after}`
    } else {
      out = `${before}a delivery folder${after}`
    }
  }

  // r5f m6: two identical neighbours left in a ` / ` list once the item between them went become one.
  if (dropped) {
    let previous

    do {
      previous = out
      out = out.replace(/(?<=^|[\s"(])([^\s/"()]+) \/ \1(?= \/ | |"|\)|$)/gm, '$1')
    } while (out !== previous)
  }

  return out
}

/**
 * r5e/r5f (ruling 48, X1) — a delivery record (how many files went out, how long, how big) is dropped from the clause
 * that carries it, and a report-line example keeps its shape with placeholders. Shapes only (skill-text-policy
 * DELIVERY_RECORD_RES): no value is written here.
 */
export function dropDeliveryRecords(text, onHit = () => {}) {
  const swap = replacement => () => {
    onHit()

    return replacement
  }

  return text
    .replace(/(?:\s*[—–-]\s*|(?<=\()\s*)\d+\s+of\s+\d+\s+identical\b[^),\n]*(?:,\s*)?/g, swap(''))
    .replace(/\s+(?:and|with)\s+its\s+\d+\s+(?:videos?|vídeos?|episodes?|takes?|files?)\b/gi, swap(''))
    .replace(/,\s*\d{4}-\d{2}-\d{2}:\s*\d+\s+(?:videos?|vídeos?|episodes?|takes?)\b[^)]*(?=\))/g, swap(''))
    .replace(/\b\d+\s+of\s+\d+(?=\s*·)/g, swap('N of N'))
    .replace(/\b\d+\s*min\s*·\s*\d+(?:[.,]\d+)?\s*GB\b/g, swap('<minutes> · <size>'))
}

/** Every private name of the machine (`keys`, machinePrivateNames) left in `text` written as the layout alias. */
export function aliasPrivateNames(text, keys, onHit = () => {}) {
  let out = text

  for (const span of privateNameSpans(text, keys).reverse()) {
    onHit()
    out = out.slice(0, span.start) + layoutAlias(text.slice(span.start, span.end)) + out.slice(span.end)
  }

  return out
}

/**
 * The scope set (the v0.0.3 plan §V3-B, contract §0: 15). Per skill: the one-line cue the catalog shows (must start with
 * "Use when " and fit the prompt cut), tags, related bundle skills, what the host must have (`requires`), the V3-F
 * action classes its steps reach for (`touches`; the text-derived ones are added at port time) and the files that must
 * not ship (`exclude`: path → reason). `os: []` = any.
 */
export const PORT_SET = Object.freeze({
  parrallello: {
    cue: 'Use when running big work as parallel fronts.',
    tags: ['owner-library', 'orchestration', 'parallel', 'critic', 'gates'],
    related: ['fable-orchestrator', 'spec-driven'],
    requires: { os: ['macos', 'linux'], bins: ['git', 'python3', 'node', 'bash'], mcp: [], paths: [] },
    // N: tools/checkpoint.sh pushes the checkpoint commit (git push).
    touches: ['X', 'Wp', 'N'],
    // K140 r5: the method (the skill, its install, the lead protocol, the plan template, the templates and the run
    // tools). Left out: the owner's worked example, his lessons and measurements, the scenarios drawn from his projects
    // and the GPU-window tools written for one of them.
    ship: [
      'SKILL.md',
      'install.sh',
      'references/lead-protocol.md',
      'references/plan-template.md',
      'templates/RULES.md',
      'templates/workflows/block.js',
      'templates/workflows/prep.js',
      'templates/workflows/setup.js',
      'tools/bgjob.py',
      'tools/checkpoint.sh',
      'tools/codemap.py',
      'tools/cost_mark.py',
      'tools/keepawake.sh',
      'tools/progress.py',
      'tools/q.sh',
      'tools/sheet.py',
      'tools/verdict_digest.py'
    ],
    // K140: the source names its local run folder after the owner's own lab layout, which the release hygiene scan
    // (lab.run-nosync) rejects. The shipped copy uses one neutral name in every file, prose and code alike, so the
    // tools, templates and install.sh still agree with each other (`*.nosync/` in .gitignore still covers it).
    redact: [
      {
        file: '*',
        pattern: /\brun\.nosync\b/g,
        replace: 'local.nosync',
        reason: "the owner's lab folder name for the local run data",
        note: CONTROL_PLANE_NOTE
      },
      // K140 r2: the control-plane folder itself carries the owner's own name for it. One neutral name everywhere
      // (install.sh, the tools, the templates and the prose agree), applied after the rule above.
      {
        file: '*',
        pattern: /(?<![A-Za-z0-9_])RESUME(?![A-Za-z0-9_])/g,
        replace: 'CONTROL',
        reason: "the owner's name for his control-plane folder",
        note: CONTROL_PLANE_NOTE
      }
    ]
  },
  'fable-orchestrator': {
    cue: 'Use when orchestrating CLONE FRAME HUB work.',
    tags: ['owner-library', 'orchestration', 'CLONE FRAME', 'multi-model'],
    related: ['parrallello'],
    requires: { os: [], bins: ['git', 'node'], mcp: [], paths: [] },
    touches: ['X', 'Wp', 'N'],
    // The private engineering diary of CLONE FRAME HUB (servers, mail, the owner's machine map) never ships.
    ship: ['SKILL.md']
  },
  'camera-and-action': {
    cue: 'Use when a web page must record itself to video.',
    tags: ['owner-library', 'video', 'recorder', 'canvas', 'WebGL', 'ffmpeg'],
    related: ['videoediting'],
    requires: { os: ['macos', 'linux'], bins: ['node', 'ffmpeg', 'ffprobe'], mcp: [], paths: [] },
    touches: ['X', 'Wp'],
    ship: [
      'SKILL.md',
      'references/architectures.md',
      'references/batch-and-files.md',
      'references/critic-brief.md',
      'references/gates.md',
      'references/recorder-core.md',
      'references/settings-ui.md',
      'references/traps.md',
      'templates/gates-harness.mjs',
      'templates/mini-recorder.js',
      'templates/record-series.mjs',
      'templates/recorder-core.js',
      'tools/conform-cfr.sh',
      'tools/probe-video.sh'
    ],
    // K140 r2: the rounds log sat in the owner's control-plane folder; the shipped copy names the file only.
    redact: [
      {
        file: 'SKILL.md',
        pattern: /RESUME\/CAMERA_RONDAS\.md/g,
        replace: 'CAMERA_RONDAS.md',
        reason: "the owner's control-plane folder in the rounds-log path",
        note: "the rounds log is named without the folder it sat in on the owner's machine"
      },
      // K140 r3: the reference-implementation table was a map of the owner's Desktop (his projects, their folders and
      // files). The section stays, the map goes.
      {
        file: 'SKILL.md',
        pattern: /^\| \| files \(under the owner's Desktop[^\n]*\n\|---\|---\|\n(?:\|[^\n]*\n)+/gm,
        replace:
          "The reference implementations are the owner's own projects and do not ship with this copy: §2–§8 carry what they teach, and `templates/` holds the tested pieces.\n",
        reason: "the reference-implementation table (a map of the owner's Desktop)",
        note: REFERENCE_NOTE
      },
      // The batch template's defaults were the owner's own folders: the pages come from --from or $PROJECT_DIR, the
      // videos go to --out or a dated folder there.
      {
        file: 'templates/record-series.mjs',
        pattern: /^const FROM = opt\.from \|\| \[[^\n]*\]\.find\(existsSync\);$/gm,
        replace: 'const FROM = opt.from || [process.env.PROJECT_DIR ?? process.cwd()].find(existsSync);',
        reason: "the batch template's default pages folder (the owner's own)",
        note: 'the batch template reads its pages from `--from` or `PROJECT_DIR`'
      },
      {
        file: 'templates/record-series.mjs',
        pattern: /^(const OUT = opt\.out \|\| join\(process\.env\.PROJECT_DIR \?\? process\.cwd\(\), )"[^"\n]*" \+/gm,
        replace: '$1"videos " +',
        reason: "the batch template's default output folder name (the owner's own)",
        note: 'the batch template reads its pages from `--from` or `PROJECT_DIR`'
      }
    ]
  },
  videoediting: {
    cue: "Use when editing or re-voicing the owner's videos.",
    tags: ['owner-library', 'video', 'ffmpeg', 'subtitles', 'voice'],
    related: ['ridervoice', 'camera-and-action'],
    requires: {
      os: ['macos'],
      bins: ['ffmpeg', 'ffprobe', 'python3'],
      mcp: [],
      paths: ['$F5TTS_VENV', '$VIDEOEDITING_PIPELINE_DIR']
    },
    touches: ['X', 'Wo'],
    // K140 r5: the method. Left out: the owner's delivery changelog and his session lessons.
    ship: [
      'SKILL.md',
      'references/agents.md',
      'references/audio-mix.md',
      'references/delivery-gates.md',
      'references/picture-pipeline.md',
      'references/subtitles-and-boxes.md',
      'references/traps.md',
      'references/vignettes.md',
      'references/voice-correction.md',
      'tools/detect_vignettes.py',
      'tools/probe_delivery.sh',
      'tools/verify_delivery.py'
    ],
    // K140 r4: the two brand-vignette assets were named by their pixel size and frame rate in the owner's pipeline;
    // the shipped copy names the pattern.
    redact: [
      {
        file: 'references/vignettes.md',
        pattern: /\bvignette_\d+x\d+_\d+\.mov\b/g,
        replace: 'vignette_<width>x<height>_<fps>.mov',
        reason: "the pipeline's vignette asset names",
        note: 'the brand-vignette assets are written `vignette_<width>x<height>_<fps>.mov`'
      }
    ],
    places: [
      place('F5TTS_VENV', 'the python environment the voice engine runs in'),
      place('VIDEOEDITING_PIPELINE_DIR', 'the reference video pipeline: its voice engine and its assets')
    ]
  },
  ridervoice: {
    cue: "Use when speaking text in the owner's own voice.",
    tags: ['owner-library', 'voice', 'TTS', 'F5-TTS'],
    related: ['videoediting'],
    requires: {
      os: ['macos'],
      bins: ['ffmpeg', 'python3'],
      mcp: [],
      // Every root the tool scripts can reach for (homeRootsOf, `$VAR/…` expanded, `||` fallbacks included). A list
      // inside the list is one need met by ANY of its places: the engine and its pre-move place, the subtitles folder
      // revoice.sh composes from $DESK and its iCloud-Desktop fallback. Then the raw-video pipeline SKILL.md §5
      // runs, the model, the venv and the work folder.
      paths: [
        '$RIDERVOICE_HOME',
        '$F5TTS_VENV',
        '$RIDERVOICE_DIR',
        '$RIDERVOICE_SUBTITLES_DIR',
        '$RIDERVOICE_PIPELINE_DIR',
        '~/Movies'
      ]
    },
    touches: ['X', 'Wo'],
    // K140 r2: the engine, the subtitles of the re-voiced series and the raw-video pipeline live in the owner's folder
    // layout; the shipped copy names them by variable. `placeLines` first fold what composes a place in several steps
    // (the pre-move fallback, the iCloud-Desktop fallback, the comment and changelog lines that narrate the move).
    places: [
      place('RIDERVOICE_HOME', 'the voice model, its references and the measured profile'),
      place('F5TTS_VENV', 'the python environment the voice engine runs in'),
      place('RIDERVOICE_DIR', 'the Rider Voice folder: engine, docs and samples'),
      place('RIDERVOICE_SUBTITLES_DIR', 'the subtitles of the videos to re-voice'),
      place('RIDERVOICE_PIPELINE_DIR', 'the raw-video pipeline')
    ],
    placeLines: [
      {
        file: ['tools/say.sh', 'tools/check.sh', 'tools/revoice.sh'],
        pattern: /; \[ -d "\$E" \] \|\| E="[^"\n]*"/g,
        replace: '',
        reason: 'the pre-move fallback of the engine folder (one named place now)'
      },
      {
        file: ['tools/say.sh', 'tools/check.sh', 'tools/revoice.sh'],
        pattern: /[ \t]*# engine moved into [^\n]*/g,
        replace: '',
        reason: "a comment that narrates the owner's folder move"
      }
    ],
    // K140 r5: the method (the skill, the engine's pipeline steps, the speak and check tools). Left out: the owner's
    // training record and voice profile, his changelog and lessons, his pronunciation notes, the re-voice record of his
    // own series and the batch over it.
    ship: ['SKILL.md', 'references/pipeline.md', 'tools/check.sh', 'tools/say.sh'],
    // Text that survives the identity and voice scrubs but still says something of the owner's (read AFTER the scrub,
    // so a rule never holds the name or a value itself): how his name sounds (F2b), a value labelled as his own prosody
    // (m5), a pointer into the record that does not ship (m6). `note` is the port note's line for the class. A rule that
    // matches nothing refuses the port: the source moved under it.
    redact: [
      {
        file: 'SKILL.md',
        pattern: /\(a pausa dele entre\s+frases, <n> s\)/g,
        replace: '(pausa entre frases)',
        reason: "the pause flag labelled as the owner's own pause",
        note: HIS_VALUE_NOTE
      },
      {
        file: 'SKILL.md',
        pattern: /Números de referência do treino aprovado em `references\/training-record\.md`\.\s*/g,
        replace: '',
        reason: 'a pointer to the training record that is not ported',
        note: POINTER_NOTE
      },
      {
        file: 'SKILL.md',
        pattern: /^- `references\/training-record\.md` — [^\n]*\n/gm,
        replace: '',
        reason: 'the reference-list entry of the training record that is not ported',
        note: POINTER_NOTE
      },
      {
        file: 'references/pipeline.md',
        pattern: /\(ver `training-record\.md`;\s*/g,
        replace: '(',
        reason: 'a pointer to the training record that is not ported',
        note: POINTER_NOTE
      }
    ],
    // The product name is the owner's public persona (he publishes it himself): kept by his decision, recorded here,
    // in the port note and in THIRD-PARTY-NOTICES.md.
    waivers: [{ kept: 'Rider Voice', reason: "the owner's product name and public persona, kept by his decision" }]
  },
  'higgsfield-blender': {
    cue: 'Use when making a Blender video with Higgsfield.',
    tags: ['owner-library', 'Blender', '3D', 'Higgsfield', 'video'],
    related: ['davinci-resolve'],
    requires: {
      os: ['macos'],
      bins: ['python3'],
      mcp: ['higgsfield'],
      paths: ['/Applications/Blender.app', '$VIDEO_ENGINE_DIR']
    },
    // $: the fnf_* tools spend the owner's Higgsfield credits (SKILL.md says so).
    touches: ['X', 'Wo', 'N', '$'],
    ship: ['SKILL.md'],
    places: [place('VIDEO_ENGINE_DIR', 'the video engine folder')],
    // K140 r4: the engine's double-click launcher carries a title for a name (spaces, a product in brackets): the
    // policy refuses that segment inside a named place, so the shipped copy writes the launcher generically.
    redact: [
      {
        file: 'SKILL.md',
        pattern: /\$VIDEO_ENGINE_DIR\/[^`\n/]*\.command/g,
        replace: '$VIDEO_ENGINE_DIR/<launcher>.command',
        reason: "the engine launcher's file name",
        note: 'the video engine is launched with its own `<launcher>.command`'
      }
    ]
  },
  inft: {
    cue: 'Use when explaining or building an iNFT agent.',
    tags: ['owner-library', 'iNFT', 'agent', 'NFT', 'monorepo'],
    related: ['iclone-os', 'economyos'],
    requires: { os: [], bins: ['git', 'node'], mcp: [], paths: [] },
    touches: ['X', 'Wp', 'N'],
    ship: ['SKILL.md']
  },
  'davinci-resolve': {
    cue: 'Use when editing video in DaVinci Resolve.',
    tags: ['owner-library', 'video', 'DaVinci Resolve', 'MCP'],
    related: ['videoediting'],
    requires: {
      os: ['macos'],
      bins: [],
      mcp: ['davinci-resolve'],
      // K140 r4: the bridge the MCP server installs into the app's sandbox (`~/Movies` is all it may read) and the
      // bridge's state folder beside it; the skill tells the console to load the first.
      paths: ['/Applications/DaVinci Resolve.app', '~/Movies', '~/Movies/ResolveBridge', '~/Movies/.resolve-bridge']
    },
    touches: ['X', 'Wo', 'S'],
    ship: ['SKILL.md']
  },
  'spec-driven': {
    cue: 'Use when writing specs before code.',
    tags: ['owner-library', 'spec', 'planning', 'constitution'],
    related: ['hm-engineer', 'hm-qa'],
    requires: { os: [], bins: ['git'], mcp: [], paths: [] },
    touches: ['Wp'],
    // K140 r5: the method and its templates. Left out: the owner's session memory (his projects, their stacks and
    // their security notes) and a spec of one of his packages.
    ship: [
      'SKILL.md',
      'templates/agents-context.md',
      'templates/constitution.md',
      'templates/spec.md',
      'templates/tasks.md'
    ]
  },
  'hm-deploy': {
    cue: 'Use when validating a deploy or a local environment.',
    tags: ['owner-library', 'highermind', 'deploy', 'docker', 'security'],
    related: ['hm-security', 'hm-qa'],
    requires: { os: [], bins: ['docker'], mcp: [], paths: [] },
    touches: ['X'],
    ship: ['SKILL.md']
  },
  'hm-designer': {
    cue: 'Use when reviewing an interface against the bar.',
    tags: ['owner-library', 'highermind', 'design', 'review'],
    related: ['hm-engineer'],
    requires: { os: [], bins: [], mcp: [], paths: [] },
    touches: [],
    ship: ['SKILL.md']
  },
  'hm-engineer': {
    cue: 'Use when auditing code quality in every layer.',
    tags: ['owner-library', 'highermind', 'review', 'security', 'performance'],
    related: ['hm-security', 'hm-qa'],
    requires: { os: [], bins: [], mcp: [], paths: [] },
    touches: ['X'],
    ship: ['SKILL.md']
  },
  'hm-init': {
    cue: 'Use when starting a project with the right stack.',
    tags: ['owner-library', 'highermind', 'scaffold', 'stack'],
    related: ['hm-engineer', 'hm-deploy'],
    requires: { os: [], bins: ['git', 'node'], mcp: [], paths: [] },
    touches: ['X', 'Wp', 'I'],
    ship: ['SKILL.md']
  },
  'hm-qa': {
    cue: 'Use when testing everything and finding the gaps.',
    tags: ['owner-library', 'highermind', 'QA', 'testing'],
    related: ['hm-engineer', 'hm-security'],
    requires: { os: [], bins: [], mcp: [], paths: [] },
    touches: ['X'],
    ship: ['SKILL.md'],
    // REL-2 R2-1: the report template's Secrets status line reads as a credential assignment to secret scanners
    // (gitleaks generic-api-key). The port writes the label in the template's Portuguese, Segredos, so the release scan
    // needs no allowlist for it.
    redact: [
      {
        file: 'SKILL.md',
        // Written with the s inside the group so this source line is no scanner hit either.
        pattern: /^Secret(s: limpo\/EXPOSED \(detalhes\))$/gm,
        replace: 'Segredo$1',
        reason: 'a report-template label that secret scanners read as a credential',
        optional: true,
        note: 'the report label `Secrets:` is written `Segredos:`, so secret scanners do not read it as a credential'
      }
    ]
  },
  'hm-security': {
    cue: 'Use when auditing security before shipping.',
    tags: ['owner-library', 'highermind', 'security', 'OWASP', 'secrets'],
    related: ['hm-deploy', 'hm-qa'],
    requires: { os: [], bins: ['git'], mcp: [], paths: [] },
    touches: ['X'],
    ship: ['SKILL.md']
  }
})

export const PORT_NAMES = Object.freeze(Object.keys(PORT_SET))

/** Secret-looking VALUES (a key body is required: the pattern names in a security checklist never match). */
export const SECRET_PATTERNS = Object.freeze([
  /\bsk-(?:ant-|live_|test_|proj-)?[A-Za-z0-9_-]{20,}/,
  /\bghp_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
  /\b0x[0-9a-fA-F]{64}\b/,
  /\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9_\-/+.]{24,}["']?/i
])

/**
 * Private-workflow markers (lead ruling F2): a file naming the owner's SSH keys, server inventory, mailbox or a
 * "private until …" note is a diary, not a skill. The port refuses it; `exclude` is the remedy.
 */
export const PRIVATE_PATTERNS = Object.freeze([
  /~\/\.ssh\b/,
  /\bservers\.json\b/,
  /\bPRIVADO\b/,
  /\bprivate until\b/i,
  /\bGmail\b/,
  /\binbox\b/i
])

/**
 * The V3-F classes a SKILL.md text implies (lead ruling F3). `$` needs a spending verb with a money object in the same
 * sentence (or credits next to a spending verb): "one slot of credit" and "a rule paid with pain" are not purchases.
 * `N` is publishing: publish, git push, posting to somewhere, sending a message/mail/webhook.
 */
export const TOUCH_RULES = Object.freeze({
  $: [
    /\b(?:spend(?:s|ing)?|spent|pay(?:s|ing)?|paid|buy(?:s|ing)?|bought|purchas(?:e|es|ed|ing)|gast(?:a|ar|am|o|ou)|pag(?:a|ar|am|o|ou)|compr(?:a|ar|am|o|ou))\b[^.;\n]{0,60}\b(?:credits?|cr[eé]ditos?|money|dinheiro|balance|saldo|usd|eur|€|\$)/i,
    /\b(?:credits?|cr[eé]ditos?)\b[^.;\n]{0,40}\b(?:spent|spend(?:s|ing)?|bought|buy(?:s|ing)?|paid|pay(?:s|ing)?|gast(?:o|os|ar|a)|compr(?:ado|ados|ar|a)|pag(?:o|os|ar|a))\b/i
  ],
  N: [
    /\bpublish(?:es|ed|ing)?\b/i,
    /\bpublic(?:a|ar|am|ou|ado|ada)\b/i,
    /\bgit push\b/i,
    /\bpost(?:s|ed|ing)?\s+(?:\S+\s+){0,3}(?:to|on)\s+(?:x|twitter|slack|discord|telegram|github|reddit|the\s+\w+|a\s+\w+)\b/i,
    /\b(?:send(?:s|ing)?|sent|envia(?:r|m|do|da)?)\s+(?:\S+\s+){0,3}(?:e-?mails?|messages?|mensagens?|webhooks?|notifications?|notificaç(?:ão|ões)|tweets?|dms?)\b/i
  ]
})

/**
 * Measured voice-profile numbers of a real person (lead ruling F2b): a fundamental in Hz, a speaking rate (words per
 * second, a range too), a pitch spread in semitones, a pause length in seconds next to a word that says it is speech.
 * The number becomes `<n>`; a signed value (a delta or a tolerance), a ratio (`0,85–1,25×`) and a pause of a page or
 * a video ("Pause 1.5 s") stay. Applied to prose files only: a tool script's thresholds are code, and the gate in the
 * control plane scans every file for the same shape.
 */
const NUM = String.raw`\d+(?:[.,]\d+)*`
const NUM_RANGE = String.raw`${NUM}(?:\s*(?:[–-]|…|\.\.\.?)\s*${NUM})?`
const SPEECH_CONTEXT = /\b(?:dele|his|voz|voice|frases?|sentences?|median[a]?|speech|fala)\b/i
const UNSIGNED_ST = new RegExp(String.raw`(?<![+±−\d.,-]\s*)(?<![\d.,])${NUM}(\s*st)\b`, 'g')

export const VOICE_PROFILE_RULES = Object.freeze([
  [new RegExp(String.raw`\b(f0\b[^\d\n]{0,12}?)${NUM}(\s*Hz)\b`, 'gi'), '$1<n>$2'],
  [
    new RegExp(
      String.raw`(?<![\d.,])${NUM_RANGE}(\s*(?:palavras|words|p)\s*\/\s*s\b|\s+(?:words|palavras)\s+(?:per|por)\s+(?:second|segundo)\b)`,
      'gi'
    ),
    '<n>$1'
  ],
  [new RegExp(String.raw`\b(spread\b[^\d\n]{0,12}?)${NUM}(\s*st)\b`, 'gi'), '$1<n>$2'],
  // On a line that names the spread, every unsigned semitone value is the profile ("nas frases dá <value> st").
  [/^.*\bspread\b.*$/gim, line => line.replace(UNSIGNED_ST, '<n>$1')],
  [new RegExp(String.raw`\((dele|his)\s+${NUM}\)`, 'g'), '($1 <n>)'],
  [
    new RegExp(
      String.raw`\b(paus(?:a|as|e|es))\b([^\d()|\n]{0,25}?(?:\n[^\d()|\n]{0,25}?)?)${NUM_RANGE}(\s*s)\b`,
      'gi'
    ),
    (match, word, gap, unit, offset, whole) => {
      const start = whole.lastIndexOf('\n', offset) + 1
      const end = whole.indexOf('\n', offset + match.length)

      return SPEECH_CONTEXT.test(whole.slice(start, end === -1 ? undefined : end)) ? `${word}${gap}<n>${unit}` : match
    }
  ]
])

/** Rewrite the voice-profile numbers of one prose text; `count` = how many values became `<n>`. */
export function scrubVoiceProfile(text) {
  let count = 0
  let out = text

  for (const [pattern, replacement] of VOICE_PROFILE_RULES) {
    out = out.replace(pattern, (...args) => {
      const next = typeof replacement === 'function' ? replacement(...args) : null
      const replaced = next ?? args[0].replace(new RegExp(pattern.source, pattern.flags.replace('g', '')), replacement)

      count += (replaced.match(/<n>/g) ?? []).length - (args[0].match(/<n>/g) ?? []).length

      return replaced
    })
  }

  return { text: out, count }
}

/** The user folders a machine layout lives in: a path under them that no `requires.paths` root declares is private. */
export const MACHINE_FOLDERS = Object.freeze(['Desktop', 'Developer'])
export const PROJECT_PLACEHOLDER = '<your project folder>'
export const PROJECT_ENV = 'PROJECT_DIR'

const MACHINE = MACHINE_FOLDERS.join('|')

/** Every `~/…` place a `requires.paths` names (a list inside it = alternatives, each one declared). */
export function declaredPaths(paths = []) {
  return paths.flat().filter(p => typeof p === 'string' && p.startsWith('~/'))
}

/**
 * Is the home-relative path that STARTS `rest` (`/Desktop/…`, then whatever text follows it) a declared root, inside
 * one, or a folder above one (where the text stops at the root's segment boundary)? `\ ` (a shell-escaped space)
 * reads as a space.
 */
export function coveredByRoots(rest, roots) {
  const text = rest.replace(/\\ /g, ' ')

  return roots.some(entry => {
    // `{ inside: '~/…' }` (a skill's named place, K140 r2) covers itself and what is inside it, never a folder above it.
    const insideOnly = typeof entry === 'object' && entry !== null
    const r = (insideOnly ? entry.inside : entry).slice(1)

    if (text.startsWith(r)) {
      const next = text.slice(r.length)

      return next === '' || /^(?:[^A-Za-z0-9_.-]|\.(?![A-Za-z0-9]))/.test(next)
    }

    if (insideOnly) {
      return false
    }

    let k = 0

    while (k < r.length && k < text.length && r[k] === text[k]) {
      k++
    }

    const stops = k === text.length || /[^A-Za-z0-9_./-]/.test(text[k])

    return stops && (r[k] === '/' || (k > 0 && r[k - 1] === '/'))
  })
}

/**
 * A machine-layout path (`~/Desktop/…`, `~/Developer/…`, in any form a language writes it) that no declared root
 * covers is the owner's machine, not the skill's need (lead ruling m3): prose gets `<your project folder>/…`, code a
 * form that stays valid and fails loudly when the folder is not given — `${PROJECT_DIR:?}` in shell,
 * `os.environ['PROJECT_DIR']` in Python, `os.getenv('PROJECT_DIR')` in Lua, `process.env.PROJECT_DIR ?? process.cwd()`
 * in JavaScript. `onMachine` counts each one.
 */
export function rewriteMachinePaths(text, lang, roots = [], onMachine = () => {}) {
  const keep = rest => coveredByRoots(rest, roots)
  let out = text

  // JavaScript: join(homedir(), "Desktop", "a", "b") — the following string arguments are the rest of the path.
  out = out.replace(
    new RegExp(
      String.raw`\b(?:os\.)?homedir\(\)\s*,\s*(['"])(${MACHINE})\1((?:\s*,\s*(['"])(?:(?!\4)[^\n])*\4)*)`,
      'g'
    ),
    (match, _q, folder, args) => {
      const rest = `/${folder}${[...args.matchAll(/(['"])((?:(?!\1)[^\n])*)\1/g)].map(m => `/${m[2]}`).join('')}`

      if (keep(`${rest}"`)) {
        return match
      }

      onMachine()

      return `process.env.${PROJECT_ENV} ?? process.cwd()${args}`
    }
  )

  // Python: os.path.join(os.path.expanduser("~"), "Desktop", "a") — the home joined to the folder as arguments (I1).
  out = out.replace(
    new RegExp(
      String.raw`os\.path\.expanduser\((['"])~\1\)\s*,\s*(['"])(${MACHINE})\2((?:\s*,\s*(['"])(?:(?!\5)[^\n])*\5)*)`,
      'g'
    ),
    (match, _q, quote, folder, args) => {
      const rest = `/${folder}${[...args.matchAll(/(['"])((?:(?!\1)[^\n])*)\1/g)].map(m => `/${m[2]}`).join('')}`

      if (keep(`${rest}${quote}`)) {
        return match
      }

      onMachine()

      return `os.environ['${PROJECT_ENV}']${args}`
    }
  )

  // Python: os.path.expanduser('~/Desktop/…') (the form the home-path pass gives every Python literal).
  out = out.replace(
    new RegExp(String.raw`os\.path\.expanduser\((['"])~\/(${MACHINE})((?:(?!\1)[^\n])*)\1\)`, 'g'),
    (match, quote, folder, rest) => {
      if (keep(`/${folder}${rest}${quote}`)) {
        return match
      }

      onMachine()

      const tail = rest.replace(/^\/+/, '')

      return tail
        ? `os.path.join(os.environ['${PROJECT_ENV}'], ${quote}${tail}${quote})`
        : `os.environ['${PROJECT_ENV}']`
    }
  )

  // Lua: os.getenv('HOME') .. '/Desktop/…'
  out = out.replace(
    new RegExp(String.raw`os\.getenv\((['"])HOME\1\)\s*\.\.\s*(['"])\/(${MACHINE})((?:(?!\2)[^\n])*)\2`, 'g'),
    (match, _q, quote, folder, rest) => {
      if (keep(`/${folder}${rest}${quote}`)) {
        return match
      }

      onMachine()

      return rest ? `os.getenv('${PROJECT_ENV}') .. ${quote}${rest}${quote}` : `os.getenv('${PROJECT_ENV}')`
    }
  )

  // Every other form: ~/Desktop, $HOME/Desktop, ${HOME}/Desktop, ${HOME:?}/Desktop, ${HOME:-…}/Desktop and
  // $(echo ~)/Desktop (I1) — by the language of the span.
  return out.replace(
    new RegExp(
      String.raw`(?<![A-Za-z0-9_\/])(?:~|\$HOME|\$\{HOME(?::?[?=+-][^}\n]*)?\}|\$\(echo ~\))\/(${MACHINE})(?![A-Za-z0-9_-])`,
      'g'
    ),
    (match, folder, offset, whole) => {
      if (keep(`/${folder}${whole.slice(offset + match.length)}`)) {
        return match
      }

      onMachine()

      return lang === 'shell' ? `\${${PROJECT_ENV}:?}` : PROJECT_PLACEHOLDER
    }
  )
}

/**
 * K140 r2 — every way the source writes one of the skill's named places (`~/…`, `$HOME/…`, `${HOME}/…`, `/Users/<x>/…`,
 * `os.path.expanduser('~/…')`) becomes its variable: `os.environ['NAME']` in Python, `${NAME:?}` in the code of a shell
 * script (it stops with a clear message when the host has not set it), `$NAME` everywhere else (prose, comments,
 * Markdown code). Runs after the scrub, which kept the places whole as declared roots and gave every Python literal its
 * `os.path.expanduser('~/…')` form.
 * `onPlace(env)` counts each one.
 */
export function rewritePlaces(text, rel, places = [], onPlace = () => {}) {
  let out = text
  const shell = CODE_FILE[path.extname(rel).toLowerCase()] === 'shell'

  for (const { env, match } of places.filter(p => p.match)) {
    out = out.replace(
      new RegExp(String.raw`os\.path\.expanduser\((['"])(?:~|\$HOME)\/${match.source}((?:(?!\1)[^\n])*)\1\)`, 'g'),
      (_m, quote, rest) => {
        onPlace(env)
        const tail = rest.replace(/^\/+/, '')

        return tail ? `os.path.join(os.environ['${env}'], ${quote}${tail}${quote})` : `os.environ['${env}']`
      }
    )

    out = out.replace(
      new RegExp(
        String.raw`(?<![A-Za-z0-9_\/])(?:~|\$HOME|\$\{HOME\}|\/Users\/[^\/\s"'\x60]+)\/${match.source}(?![A-Za-z0-9_.-])`,
        'g'
      ),
      (_m, offset, whole) => {
        onPlace(env)

        if (!shell) {
          return `$${env}`
        }

        const lineStart = whole.lastIndexOf('\n', offset - 1) + 1
        const lineEnd = whole.indexOf('\n', offset)
        const line = whole.slice(lineStart, lineEnd === -1 ? whole.length : lineEnd)
        const inComment = codeOfLine(line, '#').length <= offset - lineStart

        return inComment ? `$${env}` : `\${${env}:?}`
      }
    )
  }

  return out
}

const COMMENT_MARK = { '.lua': '--', '.js': '//', '.mjs': '//', '.cjs': '//' }

/** The code of one line: a comment (outside quotes, at the start or after a space) is prose and is cut. */
function codeOfLine(line, mark) {
  let quote = null

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]

    if (quote) {
      if (ch === '\\' && quote === '"') {
        i++
      } else if (ch === quote) {
        quote = null
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (line.startsWith(mark, i) && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i)
    }
  }

  return line
}

/**
 * The home-relative places a tool script reaches for (lead rulings F6/m2): every `~/…`, `$HOME/…`, `${HOME}/…`,
 * `expanduser('~/…')`, `os.getenv('HOME') .. '/…'` and `homedir(), '…'` it names in code, and every `$VAR/…` /
 * `${VAR}/…` expanded through the script's own assignments — all of them, so an `||` fallback is a second place the
 * script may use. A variable the script does not set ends the path there; a name with an extension is a file and
 * its folder is the place. Returns `~/…` folders, sorted, unique.
 */
export function homeRootsOf(text, rel = 'tool.sh') {
  const mark = COMMENT_MARK[path.extname(rel).toLowerCase()] ?? '#'
  const vars = new Map([['HOME', new Set(['~'])]])
  const places = new Set()
  const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g

  const expand = value => {
    let results = ['']
    let last = 0

    for (const m of value.matchAll(VAR)) {
      const literal = value.slice(last, m.index)
      const known = vars.get(m[1] ?? m[2])

      if (!known) {
        return results.map(r => `${r}${literal}`)
      }

      results = results.flatMap(r => [...known].map(k => `${r}${literal}${k}`))
      last = m.index + m[0].length
    }

    return results.map(r => `${r}${value.slice(last)}`)
  }

  const place = raw => {
    let p = raw
      .replace(/\\ /g, ' ')
      .replace(/[*?[].*$/, '')
      .replace(/\/+$/, '')

    if (!p.startsWith('~/')) {
      return
    }

    if (/^[^.].*\.[A-Za-z0-9]{1,8}$/.test(path.basename(p)) && !p.endsWith('.app')) {
      p = path.dirname(p)
    }

    if (p !== '~') {
      places.add(p)
    }
  }

  for (const raw of text.split('\n')) {
    const line = codeOfLine(raw, mark)
      // Lua and JavaScript spell the home folder their own way: read them as $HOME.
      .replace(
        /os\.getenv\((['"])HOME\1\)\s*\.\.\s*(['"])((?:(?!\2)[^\n])*)\2/g,
        (_m, _q, _q2, rest) => `"$HOME${rest}"`
      )
      .replace(/\b(?:os\.)?homedir\(\)((?:\s*,\s*(['"])(?:(?!\2)[^\n])*\2)*)/g, (_m, args) => {
        const segments = [...args.matchAll(/(['"])((?:(?!\1)[^\n])*)\1/g)].map(m => m[2])

        return `"$HOME${segments.map(s => `/${s}`).join('')}"`
      })

    // Assignments first (NAME=value; export/local too): every value a name takes is remembered (fallbacks add).
    for (const m of line.matchAll(
      /(?:^|[\s;&|(])(?:export\s+|local\s+)?([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|(?:[^\s;&|)\\]|\\.)*)/g
    )) {
      const value = m[2].startsWith("'") ? m[2].slice(1, -1) : m[2].replace(/^"|"$/g, '')
      const homes = (m[2].startsWith("'") ? [value] : expand(value)).filter(v => v === '~' || v.startsWith('~/'))

      if (homes.length) {
        vars.set(m[1], new Set([...(vars.get(m[1]) ?? []), ...homes]))
      }
    }

    // Then every quoted string and every bare word that names a home place, expanded; a '…' literal inside a
    // "…" string (python -c "…expanduser('~/x')…") is a place too.
    for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|((?:[^\s"';&|()<>\\]|\\.)+)/g)) {
      const single = m[2] !== undefined
      const value = m[1] ?? m[2] ?? m[3]
      const word = value.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, '')

      for (const candidate of single ? [word] : expand(word)) {
        place(candidate)
      }

      for (const inner of m[1] === undefined ? [] : m[1].matchAll(/'([^']*)'/g)) {
        place(inner[1])
      }
    }
  }

  return [...places].sort()
}

/** The `~/…` places a script reaches for that no declared root covers (a root, inside one, or a folder above one). */
export function undeclaredRoots(places, declared) {
  return places.filter(p => !declared.some(root => p === root || p.startsWith(`${root}/`) || root.startsWith(`${p}/`)))
}

/** How many machine-layout paths a text still holds (the residue a ported folder must not carry). */
export function countMachinePaths(text, roots = []) {
  let count = 0

  rewriteMachinePaths(text, 'shell', roots, () => count++)

  return count
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const ADDRESS = /\b0x[0-9a-fA-F]{40}\b/g
const HOME_PATH = /\/Users\/([A-Za-z0-9._-]+)/g
const TEXT_FILE = /\.(md|txt|sh|zsh|bash|py|lua|mjs|js|cjs|json|yaml|yml|toml|html|css|ts|svg|csv)$/i
const CODE_FILE = {
  '.py': 'python',
  '.lua': 'lua',
  '.sh': 'shell',
  '.zsh': 'shell',
  '.bash': 'shell',
  '.command': 'shell'
}
const TOOL_FILE = /\.(?:sh|zsh|bash|py|lua|mjs|js|cjs|command)$/i
/** LICENSE, LICENCE.md, LICENSE-MIT, LICENSE.rst, license.txt, COPYING, COPYING.LESSER, COPYRIGHT… (never LICENSES/). */
export const LICENSE_NAMES = /^(?:LICEN[CS]E|COPYING|COPYRIGHT)(?:[-_.][A-Za-z0-9][A-Za-z0-9.-]*)?$/i

const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordRe = (token, flags = 'g') => new RegExp(`(?<![A-Za-z0-9_])${escapeRe(token)}(?![A-Za-z0-9_])`, flags)

/** Files of one skill folder, following symlinks, deterministic order, without node_modules and the manifest. */
export function listSkillFiles(root, rel = '', { dot = false, skip = new Set() } = {}) {
  const out = []

  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if ((!dot && entry.name.startsWith('.')) || entry.name === 'node_modules' || entry.name === MANIFEST_FILE) {
      continue
    }

    const relPath = rel ? path.join(rel, entry.name) : entry.name

    if (skip.has(relPath)) {
      continue
    }

    const full = path.join(root, relPath)
    const stat = statSync(full)

    if (stat.isDirectory()) {
      out.push(...listSkillFiles(root, relPath, { dot, skip }))
    } else if (stat.isFile()) {
      out.push(relPath)
    }
  }

  return out
}

/** One hash over the whole source tree: every relative path and its bytes, in order. */
export function treeSha256(root) {
  const hash = createHash('sha256')

  for (const rel of listSkillFiles(root)) {
    hash.update(`${rel}\0`)
    hash.update(readFileSync(path.join(root, rel)))
    hash.update('\0')
  }

  return hash.digest('hex')
}

export function findSecret(text) {
  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.exec(text)

    if (match) {
      return { pattern: pattern.source, at: match.index }
    }
  }

  return null
}

export function findPrivateMarker(text) {
  for (const pattern of PRIVATE_PATTERNS) {
    const match = pattern.exec(text)

    if (match) {
      return { pattern: pattern.source, at: match.index }
    }
  }

  return null
}

/** The V3-F classes the text implies, with how many sentences implied each (`{ $: 2, N: 1 }`). */
export function derivedTouches(text) {
  const out = {}

  for (const [cls, rules] of Object.entries(TOUCH_RULES)) {
    const count = rules.reduce((n, rule) => n + (text.match(new RegExp(rule.source, `${rule.flags}g`)) ?? []).length, 0)

    if (count) {
      out[cls] = count
    }
  }

  return out
}

/**
 * The owner's identity tokens the scrub turns into "the owner": `PORT_IDENTITY` (comma-separated) and `--identity`,
 * explicit on purpose — a token guessed from the git user name once rewrote the public GitHub org inside repo URLs.
 * Longest first, never printed; the gate in the control plane holds the owner's list.
 */
export function identityTokens({ env = process.env, extra = [] } = {}) {
  const tokens = new Set()

  for (const token of [...String(env.PORT_IDENTITY ?? '').split(','), ...extra]) {
    if (token.trim()) {
      tokens.add(token.trim())
    }
  }

  return [...tokens].sort((a, b) => b.length - a.length || a.localeCompare(b))
}

// ---------------------------------------------------------------------------------------------------------------------
// Home paths in code vs prose (lead ruling F5).

const FENCE = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)/
const FENCE_LANG = {
  python: 'python',
  py: 'python',
  lua: 'lua',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  console: 'shell'
}

/** The language of a code span, from its own words; `inline` = a path or a word shown in code font, not a command. */
export function inferLanguage(code) {
  if (/\b(?:sys\.path|os\.path|import\s+[A-Za-z_]|from\s+\w+\s+import\b|python3?\s|\.py\b)/.test(code)) {
    return 'python'
  }

  if (/\b(?:dofile|loadfile|require)\s*\(|\.lua\b/.test(code)) {
    return 'lua'
  }

  if (
    /^\s*(?:\$\s|bash|sh|zsh|cd|cp|mv|rm|ls|cat|find|ffmpeg|ffprobe|node|npm|npx|python3?|export|source|open|git|mkdir|chmod|curl|brew|docker|make|blender|osascript|say)\b/i.test(
      code
    ) ||
    /^\s*[A-Za-z_][A-Za-z0-9_]*=\S/.test(code) ||
    /\$HOME\b|&&|\s\|\s/.test(code)
  ) {
    return 'shell'
  }

  return 'inline'
}

/** The literal a language resolves to the home folder: the whole quoted string is replaced. */
function literalForm(lang, quote, rest) {
  switch (lang) {
    case 'python':
      return `os.path.expanduser(${quote}~${rest}${quote})`
    case 'lua':
      return `os.getenv('HOME') .. ${quote}${rest}${quote}`
    case 'shell':
      return `"$HOME${rest}"`
    default:
      return `${quote}~${rest}${quote}`
  }
}

/** `/Users/<name>/…` (and, in Python/Lua, a `'~/…'` literal) in one span of text, by language. */
function rewriteHome(text, lang, { onUser, onCode, roots = [], onMachine = () => {} }) {
  let out = text

  // A `'~/…'` literal Python and Lua never expand (the owner's own shorthand, or a previous port's `~`): the
  // language form, unless it already sits inside one (`expanduser('~/…')` is resolved — and is what a re-scan sees).
  if (lang === 'python' || lang === 'lua') {
    out = out.replace(/(?<!expanduser\()(['"])~(\/(?:(?!\1)[^\n])*)\1/g, (_m, quote, rest) => {
      onCode()

      return literalForm(lang, quote, rest)
    })
  }

  out = out.replace(/(['"])\/Users\/([A-Za-z0-9._-]+)((?:(?!\1)[^\n])*)\1/g, (_m, quote, user, rest) => {
    onUser(user)

    if (lang && lang !== 'inline') {
      onCode()
    }

    return literalForm(lang, quote, rest)
  })

  out = out.replace(HOME_PATH, (_m, user) => {
    onUser(user)

    if (lang === 'shell') {
      onCode()

      return '$HOME'
    }

    return '~'
  })

  return rewriteMachinePaths(out, lang, roots, onMachine)
}

/**
 * Home paths over a whole file: fenced blocks and inline backtick spans are code (their language inferred from the
 * fence tag or the span's own words); a .py/.sh/.lua file is code throughout; everything else is prose (`~`).
 */
export function rewriteHomePaths(
  text,
  { fileLang = null, onUser = () => {}, onCode = () => {}, roots = [], onMachine = () => {} } = {}
) {
  const ctx = { onUser, onCode, roots, onMachine }

  if (fileLang) {
    return rewriteHome(text, fileLang, ctx)
  }

  const lines = text.split('\n')
  let fence = null

  return lines
    .map(line => {
      const open = FENCE.exec(line)

      if (open) {
        if (fence && open[1][0] === fence.marker[0] && open[1].length >= fence.marker.length) {
          fence = null
        } else if (!fence) {
          // A tagged fence names its language (json/yaml/text read as prose-in-code-font); an untagged one is
          // read line by line — a command line resolves `$HOME`, a tree listing keeps `~`.
          fence = { marker: open[1], lang: FENCE_LANG[open[2].toLowerCase()] ?? (open[2] ? 'inline' : null) }
        }

        return line
      }

      if (fence) {
        return rewriteHome(line, fence.lang ?? inferLanguage(line), ctx)
      }

      // Inline spans: `code` is a command or a path; the rest of the line is prose.
      return line
        .split(/(`+[^`]*`+)/)
        .map(part =>
          /^`+[^`]*`+$/.test(part)
            ? rewriteHome(part, inferLanguage(part.replace(/`/g, '')), ctx)
            : rewriteHome(part, null, ctx)
        )
        .join('')
    })
    .join('\n')
}

/**
 * `import { homedir, x } from 'node:os'` loses `homedir` when nothing else in the module calls it (the whole import
 * goes when it was the only name). A module that still calls `homedir()` keeps it.
 */
export function dropUnusedHomedirImport(text) {
  const IMPORT = /^import\s*\{([^}\n]*)\}\s*from\s*(['"])(?:node:)?os\2;?[ \t]*\n?/m
  const found = IMPORT.exec(text)

  if (!found) {
    return text
  }

  const names = found[1]
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)

  if (!names.includes('homedir')) {
    return text
  }

  const rest = text.slice(0, found.index) + text.slice(found.index + found[0].length)

  if (/\bhomedir\b/.test(rest)) {
    return text
  }

  const kept = names.filter(name => name !== 'homedir')
  const line = kept.length ? found[0].replace(found[1], ` ${kept.join(', ')} `) : ''

  return text.slice(0, found.index) + line + text.slice(found.index + found[0].length)
}

/**
 * The scrub of one text file. `self` is the skill being ported; `set` the names that end up as siblings; `rel` the
 * file's relative path (its extension says whether the whole file is code); `identity` the owner's tokens. Returns
 * the rewritten text and the counts (never the values).
 */
export function scrubText(text, { self, set = PORT_NAMES, user = '', rel = 'SKILL.md', identity = [], roots = [] }) {
  const counts = {
    homePaths: 0,
    codePaths: 0,
    claudeRefs: 0,
    emails: 0,
    addresses: 0,
    users: 0,
    identity: 0,
    machinePaths: 0,
    voiceProfile: 0
  }
  const users = new Set(user ? [user] : [])
  const fileLang = CODE_FILE[path.extname(rel).toLowerCase()] ?? null

  let out = rewriteHomePaths(text, {
    fileLang,
    roots,
    onUser: name => {
      counts.homePaths++
      users.add(name)
    },
    onCode: () => {
      counts.codePaths++
    },
    onMachine: () => {
      counts.machinePaths++
    }
  })

  // The machine-path rewrite can leave `homedir` imported and unused in a JavaScript module (I2): drop the specifier.
  if (/\.(?:mjs|cjs|js)$/i.test(rel)) {
    out = dropUnusedHomedirImport(out)
  }

  // A measured voice profile is prose (a tool script's thresholds are code: the gate scans those for the same shape).
  if (!TOOL_FILE.test(rel)) {
    const voice = scrubVoiceProfile(out)

    out = voice.text
    counts.voiceProfile = voice.count
  }

  out = out
    .replace(/(?:~|\$HOME|\$\{HOME\})\/\.claude\/skills\/([A-Za-z0-9_-]+)\/?/g, (_m, name) => {
      counts.claudeRefs++

      // A sibling in the set keeps its name; a skill outside it keeps its name too (the reader sees what is missing).
      return name === self || !set ? '{skill_dir}/' : `{skills_root}/${name}/`
    })
    .replace(/(?:~|\$HOME|\$\{HOME\})\/\.claude\//g, () => {
      counts.claudeRefs++

      return '{agent_home}/'
    })
    .replace(EMAIL, match => {
      if (EMAIL_ALLOW.has(match.toLowerCase())) {
        return match
      }

      counts.emails++

      return '<email>'
    })
    .replace(ADDRESS, () => {
      counts.addresses++

      return '0x<address>'
    })

  for (const name of users) {
    if (!name) {
      continue
    }

    out = out.replace(wordRe(name), () => {
      counts.users++

      return '<user>'
    })
  }

  for (const token of identity) {
    out = out.replace(wordRe(token), () => {
      counts.identity++

      return OWNER_WORD
    })
  }

  return { text: out, counts }
}

// ---------------------------------------------------------------------------------------------------------------------
// Third-party sources (lead ruling F1).

const inside = (dir, root) => dir === root || dir.startsWith(`${root}${path.sep}`)

/**
 * The licence files of one folder, in the order a reader trusts them: LICENSE/LICENCE, their variants (LICENSE-MIT,
 * LICENSE.rst, license.txt…), COPYING*, COPYRIGHT*. A folder that cannot be listed throws (the caller refuses).
 */
function licenseFilesIn(dir) {
  const rank = file => (/^LICEN[CS]E$/i.test(file) ? 0 : /^LICEN[CS]E/i.test(file) ? 1 : /^COPYING/i.test(file) ? 2 : 3)

  return readdirSync(dir)
    .filter(file => LICENSE_NAMES.test(file))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/** The nearest licence at `start` or above it, below the library root: `{ dir, file }`, or null. */
function nearestLicense(start, root, name) {
  for (let dir = start; inside(dir, root) && dir !== root; dir = path.dirname(dir)) {
    let found

    try {
      found = licenseFilesIn(dir)
    } catch (error) {
      throw new Error(
        `${name}: ${path.relative(root, dir)} cannot be listed (${error.code ?? error.message}) — refusing: its provenance cannot be read`
      )
    }

    if (found.length) {
      return { dir, file: found[0] }
    }
  }

  return null
}

/**
 * Every symlink inside a skill folder — a file or a folder, dot files too — whose target lies OUTSIDE the folder (a
 * link between two of its own files is not provenance). A dangling link throws.
 */
function foreignLinksIn(real) {
  const out = []
  const walk = rel => {
    for (const entry of readdirSync(path.join(real, rel), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const relPath = rel ? path.join(rel, entry.name) : entry.name

      if (entry.isSymbolicLink()) {
        let target

        try {
          target = realpathSync(path.join(real, relPath))
        } catch {
          throw new Error(`${relPath} is a dangling symlink`)
        }

        if (!inside(target, real)) {
          out.push({ rel: relPath, target })
        }
      } else if (entry.isDirectory() && entry.name !== 'node_modules') {
        walk(relPath)
      }
    }
  }

  walk('')

  return out
}

/** The upstream copyright lines, verbatim (a template line such as `Copyright [yyyy] [name]` is not one). */
export function copyrightLinesOf(text) {
  return (text.match(/^[ \t]*Copyright[ \t]+(?:\(c\)|©|\d{4})[^\n]*$/gim) ?? [])
    .map(line => line.trim())
    .filter(line => !/\[yyyy\]|\[name of/i.test(line))
}

function licenseIdOf(text) {
  const head = text.slice(0, 400)

  if (/\bMIT License\b/i.test(head)) return 'MIT'
  if (/\bApache License\b/i.test(head)) return 'Apache-2.0'
  if (/\bBSD\b/.test(head)) return 'BSD'
  if (/\bGNU (?:GENERAL|LESSER|AFFERO)/i.test(head)) return 'GPL'
  if (/\bMozilla Public License\b/i.test(head)) return 'MPL-2.0'
  if (/\bISC License\b/i.test(head)) return 'ISC'
  if (/\bCC0\b|\bUnlicense\b/i.test(head)) return 'CC0'

  return 'see LICENSE'
}

function copyrightHolderOf(text) {
  const match = /^\s*Copyright\s+(?:\(c\)|©)?\s*\d{4}(?:\s*[-–,]\s*\d{4})?\s+(.+?)\s*$/im.exec(text)

  return match ? match[1].replace(/\s*<[^>]+>\s*$/, '').trim() : ''
}

function upstreamUrlOf(dir, name) {
  for (const file of ['README.md', 'README', 'readme.md', 'package.json']) {
    let text

    try {
      text = readFileSync(path.join(dir, file), 'utf8')
    } catch {
      continue
    }

    const urls = text.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g) ?? []
    const own = urls.find(url => url.toLowerCase().includes(name.toLowerCase()))

    if (own) {
      return own.replace(/\.git$/, '')
    }
  }

  return null
}

/**
 * Is `<from>/<name>` someone else's work? A symlink in the library, a folder whose FILES (or sub-folders) are symlinks
 * out of it (attack A4), a licence beside the real folder or in an ancestor below the library root, or a foreign
 * `author` in the frontmatter says yes. Returns null for the owner's own skill; otherwise `{ author, license,
 * licenseText, licenseFile, copyright, upstream }`. Refuses — never stamps the owner — when the third-party source
 * carries no licence, when its licence cannot be read, when a link leaves the library, and when its parts come
 * from more than one licence (one LICENSE file cannot attribute them).
 */
export function thirdPartyOf(from, name, fm = {}) {
  const link = path.join(from, name)
  const symlink = isSymlinkDir(link)
  const real = realpathSync(link)
  const root = realpathSync(from)
  const foreignAuthor = typeof fm.author === 'string' && fm.author.trim() && !fm.author.startsWith(OWNER_WORD)
  let links

  try {
    links = foreignLinksIn(real)
  } catch (error) {
    throw new Error(`${name}: ${error.message} — refusing: its provenance cannot be read`)
  }

  const own = inside(real, root) ? nearestLicense(real, root, name) : null
  const linked = links.map(entry => ({
    ...entry,
    license: inside(entry.target, root)
      ? nearestLicense(statSync(entry.target).isDirectory() ? entry.target : path.dirname(entry.target), root, name)
      : null
  }))

  if (!symlink && !own && !foreignAuthor && !links.length) {
    return null
  }

  const unlicensed = linked.find(entry => !entry.license)

  if (unlicensed) {
    throw new Error(
      `${name}: ${unlicensed.rel} links to a third-party source without a licence text (or outside the library) — it cannot ship`
    )
  }

  if (!own && !linked.length) {
    throw new Error(`${name}: a third-party source (symlink or foreign author) without a licence text cannot ship`)
  }

  const licences = new Set(
    [own, ...linked.map(entry => entry.license)].filter(Boolean).map(l => path.join(l.dir, l.file))
  )

  if (licences.size > 1) {
    throw new Error(
      `${name}: its files come from ${licences.size} different licences — one LICENSE cannot attribute them`
    )
  }

  const chosen = own ?? linked[0].license
  let licenseText

  try {
    licenseText = readFileSync(path.join(chosen.dir, chosen.file), 'utf8')
  } catch (error) {
    throw new Error(
      `${name}: the licence ${chosen.file} cannot be read (${error.code ?? error.message}) — refusing: a third-party source is never stamped as the owner's`
    )
  }

  if (!licenseText.trim()) {
    throw new Error(
      `${name}: the licence ${chosen.file} is empty — refusing: a third-party source is never stamped as the owner's`
    )
  }

  // The folder holding the licence is the work: a package (highermind-code-skills) or the skill itself.
  const upstreamName = path.basename(chosen.dir)
  const url = upstreamUrlOf(chosen.dir, upstreamName)

  return {
    author: foreignAuthor ? fm.author.trim() : copyrightHolderOf(licenseText) || upstreamName,
    license: licenseIdOf(licenseText),
    licenseText,
    licenseFile: chosen.file,
    copyright: copyrightLinesOf(licenseText),
    upstream: { name: upstreamName, ...(url ? { url } : {}), license_file: LICENSE_FILE }
  }
}

// ---------------------------------------------------------------------------------------------------------------------

const yamlQuote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const yamlList = items => `[${items.map(item => (/^[A-Za-z0-9_-]+$/.test(item) ? item : yamlQuote(item))).join(', ')}]`
const yamlScalar = value =>
  /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(value) && !/^\d+\.\d+$/.test(value) ? value : yamlQuote(value)

/** The owner's frontmatter (Claude Code shape) or none (the hm-* files start at the title). */
function readOwnerHead(text) {
  const clean = text.replace(/^\uFEFF/, '')

  if (!/^---\r?\n/.test(clean)) {
    return { fm: {}, body: clean }
  }

  const fm = parseFrontmatter(clean)
  const end = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(clean)[0].length

  return { fm, body: clean.slice(end) }
}

/** The version the source declares: top-level `version`, else `metadata.version`; null when it declares none. */
export function upstreamVersionOf(fm) {
  const value = fm.version ?? fm.metadata?.version

  return value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim()
}

/** One plain line: the original description folded, quotes kept, fitted under the catalog's 1024-char rule. */
function oneLine(value, max) {
  const folded = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()

  return folded.length <= max ? folded : `${folded.slice(0, max - 1).trimEnd()}…`
}

export function renderSkillMd({
  name,
  version,
  upstreamVersion = null,
  body,
  original,
  spec,
  requires,
  thirdParty = null,
  excluded = [],
  waivers = [],
  scrub = {},
  redactionNotes = []
}) {
  const description = oneLine(`${spec.cue} ${original.description ?? ''}`, 1000)
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${yamlQuote(description)}`,
    `version: ${yamlScalar(upstreamVersion ?? version)}`,
    `ported: ${version}`,
    `author: ${yamlScalar(thirdParty ? thirdParty.author : OWNER_AUTHOR)}`,
    `license: ${yamlScalar(thirdParty ? thirdParty.license : 'MIT')}`,
    'metadata:',
    '  hermes:',
    `    tags: ${yamlList(spec.tags)}`,
    `    related_skills: ${yamlList(spec.related)}`,
    '---',
    ''
  ]

  const needs = [
    ...requires.bins.map(bin => `\`${bin}\` on PATH`),
    ...requires.mcp.map(server => `MCP server \`${server}\``),
    ...requires.paths.map(p => (Array.isArray(p) ? p.map(alt => `\`${alt}\``).join(' or ') : `\`${p}\``))
  ]

  const origin = thirdParty
    ? `Third-party work by ${thirdParty.author} (${thirdParty.upstream.name}${thirdParty.upstream.url ? `, ${thirdParty.upstream.url}` : ''}), ${thirdParty.license}: the licence text is in \`${LICENSE_FILE}\` beside this file.`
    : ''
  const left = excluded.length
    ? ` Not ported (the owner's own records — notes, logs, examples, project data — never ship): ${excluded.map(file => (file.startsWith('#') ? file : `\`${file}\``)).join(', ')}.`
    : ''
  const privacy = [
    scrub.voiceProfile ? 'measured voice-profile numbers of a real person are written `<n>`' : '',
    scrub.machinePaths
      ? `a folder of the owner's machine is written \`${PROJECT_PLACEHOLDER}\` (in code, the \`${PROJECT_ENV}\` environment variable)`
      : '',
    scrub.places && spec.places?.length
      ? `${PLACE_NOTE}: ${spec.places.map(p => `\`${p.env}\` (${p.what})`).join(', ')}`
      : '',
    scrub.ownerPaths ? OWNER_PATH_NOTE : '',
    scrub.layoutNames || scrub.privateNames ? LAYOUT_NOTE : '',
    ...redactionNotes
  ].filter(Boolean)
  const kept = waivers.length
    ? `Kept by the owner's decision: ${waivers.map(w => `"${w.kept}" (${w.reason})`).join(', ')}.`
    : ''

  const note = [
    `> Ported from the owner's skills library (port ${version}${upstreamVersion ? `, upstream version ${upstreamVersion}` : ''}; the source hash and`,
    `> what it needs are in \`manifest.json\` next to this file). Paths written \`{skill_dir}/…\` are this skill's own`,
    `> folder, \`{skills_root}/<name>/…\` a sibling icloneOS skill, \`{agent_home}/…\` the agent's home.` +
      (requires.os.length ? ` Runs on ${requires.os.join(', ')} only.` : '') +
      (needs.length ? ` Needs ${needs.join(', ')}.` : '') +
      left,
    ...(privacy.length ? [`> In this copy ${privacy.join('; ')}.`] : []),
    ...(kept ? [`> ${kept}`] : []),
    ...(origin ? [`> ${origin}`] : []),
    '',
    ''
  ]

  return `${lines.join('\n')}${note.join('\n')}${body.trimStart()}`
}

function bumpPatch(version) {
  const parts = String(version).split('.').map(Number)

  if (parts.length !== 3 || parts.some(n => !Number.isInteger(n) || n < 0)) {
    return '1.0.0'
  }

  parts[2] += 1

  return parts.join('.')
}

export function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'))
  } catch {
    return null
  }
}

function isSymlinkDir(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * K140 r2 (m2) — the owner's control-plane TOKENS, refused by the port in any spelling. The release scan matches one
 * spelling of a lab path (`RESUME/run.nosync`); a skill could write the same place as `os.path.join(ROOT, "RESUME",
 * "run.nosync")`, `ROOT / "RESUME" / "run.nosync"` or `$ROOT\\RESUME`, and pass it. These match each token on its own,
 * whatever joins it to the next: the control-plane folder name (case-sensitive, a whole word) and the lab run-data
 * folder. Both are the release's own control-plane names, not the owner's private names: those are never written here,
 * they are read from the machine at scan time (machinePrivateNames). Only the port reads them: the app's own code uses
 * RESUME as an ordinary word.
 */
export const PORT_PRIVATE_TOKENS = Object.freeze([
  Object.freeze({ id: 'port.control-plane', re: /(?<![A-Za-z0-9_])RESUME(?![A-Za-z0-9_])/ }),
  Object.freeze({ id: 'port.run-nosync', re: /(?<![A-Za-z0-9_-])run\.nosync(?![A-Za-z0-9_])/i })
])

/**
 * The PORT_PRIVATE_TOKENS ids `text` carries (each once, table order), in any spelling: as written, with its escapes
 * decoded (`run%2Enosync`, `\\u0052ESUME`) and with zero-width characters and string concatenations folded away.
 * (K140 r3: the 3D project's own folder name is a layout name of the porting machine, refused through the release
 * markers' `owner.layout` with every other one; this token is its former name, refused in any case.)
 */
export function privateTokenIds(text) {
  const decoded = decodeEscapes(text)
  const views = [...new Set([text, decoded, foldSplits(text), foldSplits(decoded)])]

  return PORT_PRIVATE_TOKENS.filter(token => views.some(view => token.re.test(view))).map(token => token.id)
}

/**
 * K140: the port refuses what the release would refuse. Every file it would write AND the manifest go through the
 * release's own artifact-hygiene markers (the owner's folder layout included, K140 r2), the port's own control-plane
 * tokens (PORT_PRIVATE_TOKENS, any spelling) and (K140 r4, `policy` = { self, product, keys, manifest }) the release's
 * skill-text policy, so a lab path, an owner token, a refused path or a private name fails here, not at the signed
 * build. `markers` is the release marker table (tests pass a fixture). Returns `['<rel> (<id>)', …]`.
 */
export function portHygiene(outputs, manifest, markers = undefined, policy = null) {
  return [...outputs, { rel: MANIFEST_FILE, text: JSON.stringify(manifest, null, 2) }].flatMap(out => {
    // K140 r3: a file's NAME ships too (`examples/<project>.md`): it is scanned like its contents.
    const ids = [
      ...scanBuffer(Buffer.from(out.text, 'utf8'), new Map(), markers),
      ...privateTokenIds(out.text),
      ...scanBuffer(Buffer.from(out.rel, 'utf8'), new Map(), markers),
      ...privateTokenIds(out.rel),
      // K140 r4: the release's skill-text policy (R4-1 paths, R4-2 the machine's private names), text and name.
      ...(policy ? policyIds(out.text, out.rel, policy) : [])
    ]

    return [...new Set(ids)].map(id => `${out.rel} (${id})`)
  })
}

/** The skill-text policy's ids for one shipped file: its text and its name (`skill.path`, `skill.private-name`). */
function policyIds(text, rel, policy) {
  const ctx = {
    self: policy.self,
    product: policy.product,
    coined: policy.coined,
    keys: policy.keys,
    owner: policy.owner ?? null,
    manifest: policy.manifest
  }
  const hits = [
    ...skillTextRefusals(text, rel === MANIFEST_FILE ? 'manifest.json' : rel, ctx),
    ...skillTextRefusals(rel.split('/').join('\n'), 'name.txt', ctx)
  ]

  return hits.map(hit => skillRuleId(hit.rule))
}

/**
 * Port one skill. Returns `{ name, version, bumped, sourceSha256, counts, outputs, manifest }`; throws on a secret or
 * a private marker (the caller aborts the run before any file of any skill is written: the scan happens first).
 */
export function portSkill(
  name,
  {
    from,
    to,
    now = () => new Date(),
    user = '',
    identity = [],
    markers = undefined,
    layoutNames = machineLayoutNames(),
    desktopFolders = machineLayoutChildren().Desktop,
    // K140 r4: the machine's private names (machinePrivateNames: read now, never stored), the product's own names and
    // the label table. `privateNames: null` leaves the R4-2 alias out (a unit test of another rule).
    privateNames = undefined,
    product = undefined,
    // K140 r5: the machine's coined single-word names (machineCoinedNames), refused and aliased in paths.
    coinedNames = undefined,
    // r5e (X1): the owner's series and delivery names, from the private markers ({ series, delivery } digest sets);
    // `null` leaves them out (a unit test of another rule).
    ownerNames = undefined,
    // The values of the places (PORT_PLACE_<ENV>): the porting machine's, a test's own.
    placeValues = process.env,
    // A test may port a fixture against its own copy of the skill's rules (synthetic places).
    spec = PORT_SET[name]
  }
) {
  if (!spec) {
    throw new Error(`${name}: not in the port set`)
  }

  const sourceDir = path.join(from, name)

  if (!existsSync(path.join(sourceDir, 'SKILL.md'))) {
    throw new Error(`${name}: no SKILL.md under ${sourceDir}`)
  }

  const targetDir = path.join(to, name)

  if (isSymlinkDir(targetDir)) {
    throw new Error(`${name}: the bundle folder is a symlink — a port is a copy, never a link`)
  }

  // K140 r5 (ruling 48): a ported skill ships its METHOD, never the owner's own records. A file ships only when the
  // skill's `ship` list names it (default deny: a new file in the source is left out until it is listed).
  if (!Array.isArray(spec.ship) || !spec.ship.length) {
    throw new Error(`${name}: PORT_SET lists no shippable file (ship) — nothing ships by default`)
  }

  // A listed file the source does not have is simply not shipped; a source file the list does not name is left out.
  const sourceFiles = listSkillFiles(sourceDir)

  const files = sourceFiles.filter(rel => spec.ship.includes(rel))
  const left = sourceFiles.filter(rel => !spec.ship.includes(rel))
  const sourceSha256 = treeSha256(sourceDir)
  const previous = readManifest(targetDir)
  const unchanged = previous?.source?.sha256 === sourceSha256 && typeof previous?.version === 'string'
  const version = unchanged ? previous.version : previous?.version ? bumpPatch(previous.version) : '1.0.0'
  // The day, never the minute: a millisecond stamp would tell a reader of the public repository the hour the
  // author works at. `skill-manifest.ts` asks only that Date.parse accepts it, and it accepts a plain date.
  const portedAt =
    unchanged && previous.source?.ported_at ? previous.source.ported_at : now().toISOString().slice(0, 10)
  // The counters a port added after the first manifests stand before the original tail (identity … redacted), so a
  // sibling front's change to one of those lines merges without a conflict.
  const totals = {
    homePaths: 0,
    codePaths: 0,
    claudeRefs: 0,
    emails: 0,
    addresses: 0,
    users: 0,
    places: 0,
    layoutNames: 0,
    ownerPaths: 0,
    privateNames: 0,
    identity: 0,
    machinePaths: 0,
    voiceProfile: 0,
    redacted: 0
  }
  const layoutRe = layoutNameRegex(layoutNames)
  const roots = declaredPaths(spec.requires.paths)
  const redactions = (spec.redact ?? []).map(rule => ({ ...rule, hits: 0 }))
  const placeLines = (spec.placeLines ?? []).map(rule => ({ ...rule, hits: 0 }))
  // K140 r5: the places come from the porting machine; the private names are read from the machine now.
  const places = resolvePlaces(spec.places ?? [], placeValues)
  const placeRoots = places.flatMap(p => p.roots.map(inside => ({ inside })))
  const self = new Set([
    ...(existsSync(to) ? treeNames(to) : []),
    name,
    ...files.flatMap(rel => rel.split('/')),
    MANIFEST_FILE,
    LICENSE_FILE
  ])
  const keys = privateNames === null ? new Map() : (privateNames ?? machinePrivateNames({ self: [...self] }))
  const declared = declaredOf({ requires: spec.requires, waivers: spec.waivers })
  const policyCtx = {
    self,
    owner: ownerNames === undefined ? ownerNamesOf() : ownerNames,
    coined: coinedNames ?? machineCoinedNames({ self: [...self] }),
    product: product ?? productNames(),
    declared: declared.parts,
    env: declared.places,
    roots: declared.roots
  }
  const exempt = new Set([...declared.waivers, ...declared.parts].map(word => nameKey(word)))
  const nameKeys = new Map([...keys].filter(([key]) => !exempt.has(key)))
  // A file left out is named by its path, or by its number in the source listing when the path itself carries a
  // private name or a path the policy refuses (the name never ships, not even in the list of what did not).
  const excluded = left.map(rel => {
    const refused =
      scanBuffer(Buffer.from(rel, 'utf8'), new Map(), markers).length > 0 ||
      privateTokenIds(rel).length > 0 ||
      privateNameSpans(rel, nameKeys).length > 0 ||
      skillTextRefusals(rel, 'name.txt', { self, product: policyCtx.product, keys: nameKeys, manifest: null }).length >
        0

    return refused ? `#${sourceFiles.indexOf(rel) + 1}` : rel
  })
  const outputs = []

  for (const rel of files) {
    const full = path.join(sourceDir, rel)
    const bytes = readFileSync(full)

    if (!TEXT_FILE.test(rel) && bytes.includes(0)) {
      throw new Error(`${name}/${rel}: binary files are not ported`)
    }

    const text = bytes.toString('utf8')
    const secret = findSecret(text)

    if (secret) {
      throw new Error(`${name}/${rel}: a secret-looking value (pattern ${secret.pattern}) — refusing the whole port`)
    }

    const marker = findPrivateMarker(text)

    if (marker) {
      throw new Error(
        `${name}/${rel}: a private workflow marker (pattern ${marker.pattern}) — refusing the whole port; exclude the file in PORT_SET`
      )
    }

    // K140 r2: the owner's folder layout becomes the skill's named places. Lines that compose a place in several steps
    // are folded on the source first (so each place is written once); the scrub keeps the places whole (declared
    // roots) and writes every code form the language resolves; rewritePlaces then names each one.
    let source = text

    for (const rule of placeLines.filter(r => r.file.includes(rel))) {
      source = source.replace(rule.pattern, (...args) => {
        rule.hits++

        return args[0].replace(new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', '')), rule.replace)
      })
    }

    const { text: scrubbed, counts } = scrubText(source, {
      self: name,
      user,
      rel,
      identity,
      roots: [...roots, ...placeRoots]
    })
    let shipped = rewritePlaces(scrubbed, rel, places, () => {
      totals.places++
    })

    for (const key of Object.keys(counts)) {
      totals[key] += counts[key]
    }

    // Read after the scrub, so the rule never holds the owner's name: a line that still says how it sounds goes.
    // `file: '*'` is a rule over every file of the skill (a name the whole tree must agree on).
    for (const rule of redactions.filter(r => r.file === rel || r.file === '*')) {
      shipped = shipped.replace(rule.pattern, (...args) => {
        rule.hits++

        return args[0].replace(new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', '')), rule.replace)
      })
    }

    // K140 r4: a path into the owner's folders becomes the placeholder; a private name of this machine left anywhere
    // (outside a declared interface root) gets the alias (K140 r5: read from the machine, never from the repo).
    shipped = aliasOutside(shipped, nameKeys, interiorRanges(shipped, policyCtx), () => totals.privateNames++)
    shipped = aliasCoinedNames(shipped, rel, policyCtx, () => totals.privateNames++)
    // r5e (ruling 48, X1): a series of the owner's becomes a neutral example name, a delivery folder and a delivery
    // record go: the method text stays.
    shipped = neutraliseOwnerSeries(shipped, policyCtx.owner, () => totals.privateNames++, rel)
    shipped = dropDeliveryRecords(shipped, () => totals.privateNames++)

    try {
      shipped = rewriteOwnerPaths(shipped, rel, policyCtx, () => totals.ownerPaths++)
    } catch (error) {
      throw new Error(`${name}/${error.message}`)
    }

    // K140 r3: what is left of the owner's folder layout (his project, delivery and checkout names) gets the alias.
    shipped = foldDesktopRoots(
      aliasLayoutNames(shipped, layoutRe, () => totals.layoutNames++),
      desktopFolders,
      () => {
        totals.layoutNames++
      }
    )

    // Every home place a tool script reaches for is declared, so a host without it says "needs …" before a run.
    if (TOOL_FILE.test(rel)) {
      const missing = undeclaredRoots(homeRootsOf(shipped, rel), roots)

      if (missing.length) {
        throw new Error(
          `${name}/${rel}: reaches for ${missing.join(', ')} — not in requires.paths; declare it (a list inside the list = alternatives)`
        )
      }
    }

    outputs.push({
      rel: aliasLayoutNames(
        aliasPrivateNames(rel, nameKeys, () => totals.privateNames++),
        layoutRe,
        () => {
          totals.layoutNames++
        }
      ),
      text: shipped,
      mode: statSync(full).mode & 0o777
    })
  }

  // A place line must match in every file it names that this source has: otherwise the source moved under it.
  for (const rule of placeLines) {
    if (!rule.hits && rule.file.some(rel => files.includes(rel))) {
      throw new Error(
        `${name}/${rule.file.join(', ')}: the place line "${rule.reason}" matched nothing — the source moved under it`
      )
    }
  }

  for (const rule of redactions) {
    // `optional`: a hygiene rewrite whose text may leave the source; with nothing to rewrite there is nothing to guard.
    if (!rule.hits && !rule.optional) {
      throw new Error(
        `${name}/${rule.file}: the redaction "${rule.reason}" matched nothing — the source moved under it`
      )
    }

    totals.redacted += rule.hits
  }

  const redactionNotes = [...new Set(redactions.filter(rule => rule.hits).map(rule => rule.note ?? ''))]

  const skillMd = outputs.find(file => file.rel === 'SKILL.md')
  const { fm, body } = readOwnerHead(skillMd.text)
  const thirdParty = thirdPartyOf(from, name, fm)
  const upstreamVersion = upstreamVersionOf(fm)

  skillMd.text = renderSkillMd({
    name,
    version,
    upstreamVersion,
    body,
    original: { description: typeof fm.description === 'string' ? fm.description : '' },
    spec,
    requires: spec.requires,
    thirdParty,
    excluded,
    waivers: spec.waivers ?? [],
    scrub: totals,
    redactionNotes
  })

  if (thirdParty) {
    outputs.push({ rel: LICENSE_FILE, text: thirdParty.licenseText, mode: 0o644 })
  }

  const cue = cueOf(spec.cue)

  if (!spec.cue.startsWith('Use when ') || cue.length > PROMPT_CUT) {
    throw new Error(`${name}: cue "${spec.cue}" breaks the catalog rule (Use when …, ≤ ${PROMPT_CUT} chars)`)
  }

  const fromText = derivedTouches(skillMd.text)
  const touches = ACTION_CLASSES.filter(cls => spec.touches.includes(cls) || cls in fromText)

  const manifest = {
    schema: MANIFEST_SCHEMA,
    name,
    version,
    author: thirdParty ? thirdParty.author : OWNER_AUTHOR,
    license: thirdParty ? thirdParty.license : 'MIT',
    ...(thirdParty ? { upstream: { ...thirdParty.upstream, copyright: thirdParty.copyright } } : {}),
    source: {
      library: 'claude-code-skills',
      path: name,
      version: upstreamVersion,
      sha256: sourceSha256,
      ported_at: portedAt
    },
    excluded,
    ...(spec.waivers?.length ? { waivers: spec.waivers } : {}),
    requires: spec.requires,
    touches,
    touches_from_text: fromText,
    scrubbed: true,
    scrub: totals
  }

  const hygiene = portHygiene(outputs, manifest, markers, {
    self: new Set([...self, ...outputs.flatMap(out => out.rel.split('/'))]),
    product: policyCtx.product,
    coined: policyCtx.coined,
    keys: nameKeys,
    owner: policyCtx.owner,
    manifest
  })

  if (hygiene.length) {
    throw new Error(
      `${name}: would fail the release hygiene scan — ${hygiene.join(', ')}; fix it in PORT_SET (redact/exclude)`
    )
  }

  return {
    name,
    version,
    bumped: !unchanged && Boolean(previous?.version),
    sourceSha256,
    counts: totals,
    outputs,
    manifest,
    thirdParty: thirdParty
      ? {
          author: thirdParty.author,
          license: thirdParty.license,
          upstream: thirdParty.upstream,
          copyright: thirdParty.copyright
        }
      : null
  }
}

function writePort(result, to) {
  const targetDir = path.join(to, result.name)

  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true })
  }

  for (const file of result.outputs) {
    const dest = path.join(targetDir, file.rel)

    mkdirSync(path.dirname(dest), { recursive: true })
    writeFileSync(dest, file.text, { mode: file.mode })
  }

  writeFileSync(path.join(targetDir, MANIFEST_FILE), `${JSON.stringify(result.manifest, null, 2)}\n`)
}

/**
 * The third-party notices of the whole bundle, from what is on disk: every ported skill whose manifest names an
 * upstream, and every skill shipped byte-for-byte with a VENDORED.json. Deterministic (sorted, no timestamps).
 */
export function renderThirdPartyNotices(to) {
  const rows = []
  const waived = []

  for (const name of readdirSync(to).sort()) {
    const dir = path.join(to, name)

    if (!statSync(dir).isDirectory()) {
      continue
    }

    const manifest = readManifest(dir)

    for (const waiver of manifest?.waivers ?? []) {
      waived.push(`"${waiver.kept}" (${name}: ${waiver.reason})`)
    }

    if (manifest?.upstream) {
      const upstream = `${manifest.upstream.name}${manifest.upstream.url ? ` (${manifest.upstream.url})` : ''}`
      const copyright = manifest.upstream.copyright ?? []

      rows.push([
        name,
        manifest.author,
        upstream,
        manifest.license,
        copyright.length ? copyright.join('<br>') : 'none in the licence text',
        `${name}/${manifest.upstream.license_file ?? LICENSE_FILE}`
      ])
      continue
    }

    try {
      const vendored = JSON.parse(readFileSync(path.join(dir, 'VENDORED.json'), 'utf8'))

      rows.push([
        name,
        String(vendored.author ?? ''),
        String(vendored.source ?? ''),
        String(vendored.licence ?? vendored.license ?? ''),
        vendored.copyright ? String(vendored.copyright) : 'none published',
        'declared in SKILL.md (no separate text from the publisher)'
      ])
    } catch {
      // not vendored
    }
  }

  const cell = value => String(value).replace(/\|/g, '\\|')

  return [
    '# Third-party notices — icloneOS skills bundle',
    '',
    'Skills in this folder written by someone other than the owner, with their true author and licence. Each ported',
    'third-party skill carries the upstream licence text verbatim beside its SKILL.md; a vendored skill is shipped',
    'byte-for-byte as published (its VENDORED.json names the source). The copyright column is the upstream line verbatim.',
    'Generated by apps/desktop/scripts/port-owner-skills.mjs.',
    '',
    ...(waived.length
      ? [
          `Owner's product names kept by his decision (not third-party work; recorded so the choice is explicit): ${waived.join(', ')}.`,
          ''
        ]
      : []),
    '| skill | author | upstream | licence | copyright | licence text |',
    '|---|---|---|---|---|---|',
    ...rows.map(row => `| ${row.map(cell).join(' | ')} |`),
    ''
  ].join('\n')
}

/** Drift of every ported skill against its source: `[{ name, state }]`, state = ok | drift | missing | unported. */
export function checkDrift(names, { from, to }) {
  return names.map(name => {
    const manifest = readManifest(path.join(to, name))

    if (!manifest) {
      return { name, state: 'unported' }
    }

    const sourceDir = path.join(from, name)

    if (!existsSync(path.join(sourceDir, 'SKILL.md'))) {
      return { name, state: 'missing', version: manifest.version }
    }

    const sha = treeSha256(sourceDir)

    return {
      name,
      state: sha === manifest.source?.sha256 ? 'ok' : 'drift',
      version: manifest.version,
      ported: String(manifest.source?.sha256 ?? '').slice(0, 12),
      source: sha.slice(0, 12)
    }
  })
}

/**
 * Attribution of every ported skill against its source (B6 attribution): a third-party source must be ported with
 * its LICENSE byte-identical, a true author (never the owner) and an upstream; an owner's skill must not claim one.
 */
export function checkAttribution(names, { from, to }) {
  return names.flatMap(name => {
    const dir = path.join(to, name)
    const manifest = readManifest(dir)

    if (!manifest || !existsSync(path.join(from, name, 'SKILL.md'))) {
      return []
    }

    let third

    try {
      third = thirdPartyOf(from, name, {})
    } catch (error) {
      return [{ name, problem: error.message }]
    }

    const problems = []

    if (third) {
      if (!manifest.upstream) problems.push('manifest names no upstream for a third-party source')
      if (!manifest.author || manifest.author.startsWith(OWNER_WORD)) problems.push('manifest author is the owner')
      if (manifest.license !== third.license)
        problems.push(`manifest licence "${manifest.license}" ≠ "${third.license}"`)
      if (JSON.stringify(manifest.upstream?.copyright ?? null) !== JSON.stringify(third.copyright))
        problems.push('manifest copyright differs from the upstream licence text')

      let shipped = null

      try {
        shipped = readFileSync(path.join(dir, LICENSE_FILE), 'utf8')
      } catch {
        problems.push(`${LICENSE_FILE} missing beside SKILL.md`)
      }

      if (shipped !== null && shipped !== third.licenseText)
        problems.push(`${LICENSE_FILE} differs from the upstream text`)

      const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'))?.[1] ?? ''
      const author = /^author:\s*(.+)$/m.exec(head)?.[1]?.trim().replace(/^"|"$/g, '')

      if (author !== manifest.author) problems.push('SKILL.md author differs from the manifest')
    } else if (manifest.upstream) {
      problems.push("manifest names an upstream for the owner's own skill")
    }

    return problems.map(problem => ({ name, problem }))
  })
}

/**
 * Re-scan a ported folder for anything the scrub must have removed (the B6 gate reads this through --check too). Dot
 * files are scanned here even though a port never writes them: a planted one must be caught.
 */
export function scrubResidue(dir, { identity = [], privateNames = undefined } = {}) {
  const hits = []
  const manifest = readManifest(dir)
  const roots = declaredPaths(manifest?.requires?.paths)
  // K140 r4: the release's skill-text policy, against the whole bundle's names (the folder's parent).
  const self = treeNames(path.dirname(dir))
  const declared = declaredOf(manifest)
  const exempt = new Set([...declared.waivers, ...declared.parts].map(word => nameKey(word)))
  const keys = new Map(
    [...(privateNames ?? machinePrivateNames({ self: [...self] }))].filter(([key]) => !exempt.has(key))
  )

  for (const rel of listSkillFiles(dir, '', { dot: true })) {
    const text = readFileSync(path.join(dir, rel), 'utf8')
    const residue = scrubText(text, { self: path.basename(dir), rel, identity, roots }).counts
    const secret = findSecret(text)
    const marker = findPrivateMarker(text)
    const claude = (text.match(/~\/\.claude\/skills/g) ?? []).length
    const hygiene = [
      ...new Set([
        ...scanBuffer(Buffer.from(text, 'utf8')),
        ...privateTokenIds(text),
        ...scanBuffer(Buffer.from(rel, 'utf8')),
        ...privateTokenIds(rel),
        ...policyIds(text, rel, { self, product: productNames(), keys, manifest })
      ])
    ]

    if (Object.values(residue).some(Boolean) || secret || marker || claude || hygiene.length) {
      hits.push({
        file: rel,
        ...residue,
        claudeSkillsRefs: claude,
        secret: Boolean(secret),
        privateMarker: Boolean(marker),
        hygiene
      })
    }
  }

  return hits
}

function parseArgs(argv) {
  const args = {
    from: path.join(homedir(), '.claude', 'skills'),
    to: DEFAULT_BUNDLE,
    only: [],
    identity: [],
    check: false,
    list: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '--from') args.from = path.resolve(argv[++i])
    else if (arg === '--to') args.to = path.resolve(argv[++i])
    else if (arg === '--only') args.only.push(argv[++i])
    else if (arg === '--identity') args.identity.push(argv[++i])
    else if (arg === '--check') args.check = true
    else if (arg === '--list') args.list = true
    else throw new Error(`unknown argument ${arg}`)
  }

  return args
}

function machineUser() {
  try {
    return userInfo().username
  } catch {
    return path.basename(homedir())
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const names = args.only.length ? args.only : [...PORT_NAMES]
  const user = machineUser()
  const identity = identityTokens({ extra: args.identity })

  if (args.list) {
    console.log(JSON.stringify({ names, set: PORT_SET }, null, 2))

    return 0
  }

  // r5f (X2): never a port or a check without the owner identity setting: without it the scrub cannot turn his name
  // into "the owner" and the residue check cannot see it. Fail closed.
  if (!identity.length) {
    console.error('[port] the owner identity is not set (PORT_IDENTITY or --identity): the port never runs without it')

    return 2
  }

  if (args.check) {
    const drift = checkDrift(names, args)
    const privateNames = machinePrivateNames({ self: [...(existsSync(args.to) ? treeNames(args.to) : [])] })
    const residue = names.flatMap(name =>
      existsSync(path.join(args.to, name))
        ? scrubResidue(path.join(args.to, name), { identity, privateNames }).map(hit => ({ name, ...hit }))
        : []
    )
    const attribution = checkAttribution(names, args)
    const noticesPath = path.join(args.to, NOTICES_FILE)
    const notices =
      existsSync(noticesPath) && readFileSync(noticesPath, 'utf8') === renderThirdPartyNotices(args.to) ? 'ok' : 'stale'
    const bad = drift.filter(row => row.state !== 'ok')

    console.log(JSON.stringify({ drift, residue, attribution, notices }, null, 2))

    return bad.length || residue.length || attribution.length || notices !== 'ok' ? 1 : 0
  }

  // Scan and transform everything first; only a fully clean set is written (a secret in one skill aborts the run).
  // K140 r4: the machine's private names and the product's names are read once, now, for every skill.
  const product = productNames()
  const privateNames = machinePrivateNames({
    self: [...(existsSync(args.to) ? treeNames(args.to) : []), ...PORT_NAMES]
  })
  const coinedNames = machineCoinedNames({ self: [...(existsSync(args.to) ? treeNames(args.to) : []), ...PORT_NAMES] })
  // r5e (X1): the owner's series and delivery names come from the private markers (ICLONE_PRIVATE_MARKERS).
  const ownerNames = ownerNamesOf()
  const results = names.map(name =>
    portSkill(name, { from: args.from, to: args.to, user, identity, privateNames, product, coinedNames, ownerNames })
  )

  for (const result of results) {
    writePort(result, args.to)
  }

  writeFileSync(path.join(args.to, NOTICES_FILE), renderThirdPartyNotices(args.to))

  console.log(
    JSON.stringify(
      results.map(r => ({
        name: r.name,
        version: r.version,
        bumped: r.bumped,
        files: r.outputs.length,
        excluded: r.manifest.excluded,
        thirdParty: r.thirdParty,
        touches: r.manifest.touches,
        touchesFromText: r.manifest.touches_from_text,
        scrub: r.counts
      })),
      null,
      2
    )
  )

  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main())
  } catch (error) {
    console.error(`port-owner-skills: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
