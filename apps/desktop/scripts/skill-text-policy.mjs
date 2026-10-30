// V3-R2 r4 (lead method change, 2026-10-22) — what the text of a shipped skill may say about places and names.
//
// Three rounds widened a denylist and the next critic found the next spelling or depth. This module stops enumerating:
// both rules below are DENY-BY-DEFAULT, and the text is FOLDED before either reads it (every escape, every width, every
// split and every path-join spelling becomes one plain form first).
//
//   R4-1 PATH-SHAPED STRINGS. Any string that looks like a filesystem path with two or more segments (`a/b`, `~/x`,
//        `/x/y`, `$VAR/x`, `<placeholder>/x`, `join("a", "b")`, `ROOT / "a"`, backslash forms, URL-encoded, full-width
//        slashes, zero-width or soft-hyphen splits) is refused unless EVERY segment is generic: a placeholder (the
//        port's own, an env name the skill's manifest documents, a variable the same file assigns), a name of the
//        shipped tree or of the product's tracked source, a part of a declared `requires.paths` root, a trivial
//        segment (a number, a version, two characters, an extension, a glob), one plain word or an identifier of plain
//        words (`lark_batches`, `site-packages`), the product's name, the port's alias, or an entry of the small
//        committed GENERIC_SEGMENTS list. Refused: a numbered name (`take_7`, `20_NOTES`), a title with spaces, a
//        CamelCase or brand-like word, an undocumented numbered variable, and right under a home layout folder
//        (`~/Movies/<x>`) anything but a pattern (`<name>-agent`). Only what is inside a declared root below a dot folder
//        (`~/.tool/model/…`) is that requirement's own interface and passes whole.
//   R4-2 PRIVATE NAMES. The names of the scanning machine's layout are read AT SCAN TIME (never written in the repo):
//        every folder, and every document or media file, to depth NAME_DEPTH under the home folders NAME_HOME_FOLDERS
//        and under every ancestor of this tree's checkouts below the home (the project folder, the control plane, the
//        checkout itself). A name is private when it is a title typed with spaces, numbered, CamelCase / brand-like, or
//        an identifier carrying a one-letter code (`PLAN_Q`); one common word or an identifier of real words is not.
//        Names the product itself ships (tracked in its checkout, or a file of the shipped tree), the committed
//        PUBLIC_NAMES and GENERIC_SEGMENTS, and what a manifest declares (a requirement's path, a kept name) are not
//        private. Any occurrence of a private name, in a path or as a label, in any case, width, diacritic, joiner or
//        split, is refused (a name written as an identifier counts in an identifier spelling only).
//
// The port (port-owner-skills.mjs) rewrites what it can (an owner path becomes a placeholder, a known label becomes
// a generic series name) and refuses what it cannot; the release scan (artifact-hygiene.mjs) refuses both on the
// pack's `hermes-skill` tree. Neither prints a name: hits carry a file, a line and a rule id.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadPrivateMarkers } from './private-markers.mjs'

// ---------------------------------------------------------------------------------------------------------------------
// Folding (shared with artifact-hygiene.mjs, which re-exports these two).

// The encodings a path or a phrase takes inside bundles, source maps, JSON and URLs: \uXXXX, \u{X..}, \xXX, octal \NNN,
// \n \r \t, %XX and HTML character references (numeric and named). A marker behind one ("\\nNAME", "%2FUsers%2FNAME")
// is tokenised after decoding.
const ESCAPE_RE =
  /\\u([0-9a-fA-F]{4})|\\u\{([0-9a-fA-F]{1,6})\}|\\x([0-9a-fA-F]{2})|\\([0-7]{3})|\\([nrt])|%([0-9a-fA-F]{2})|&#x([0-9a-fA-F]{2,4});|&#(\d{2,5});|&([A-Za-z]{2,8});/g
const ESCAPED_CHARS = { n: '\n', r: '\r', t: '\t' }
// The named references that stand for a separator or punctuation a path, a key or a phrase is written with.
const NAMED_ENTITIES = {
  amp: '&',
  apos: "'",
  bsol: '\\',
  colon: ':',
  comma: ',',
  commat: '@',
  dash: '-',
  dollar: '$',
  equals: '=',
  grave: '`',
  gt: '>',
  hyphen: '-',
  lowbar: '_',
  lt: '<',
  nbsp: ' ',
  NewLine: '\n',
  num: '#',
  percnt: '%',
  period: '.',
  plus: '+',
  quot: '"',
  semi: ';',
  sol: '/',
  Tab: '\t',
  tilde: '~',
  verbar: '|',
  vert: '|'
}
const MAX_DECODE_PASSES = 3

/** `text` with \\uXXXX, \\u{..}, \\xXX, \\NNN, \\n \\r \\t, %XX, &#..; and &name; decoded (up to 3 layers, as in %252F). */
export function decodeEscapes(text) {
  let out = text

  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    ESCAPE_RE.lastIndex = 0

    if (!ESCAPE_RE.test(out)) {
      break
    }

    out = out.replace(ESCAPE_RE, (match, u, cp, x, oct, c, pct, hexRef, decRef, name) => {
      if (c) {
        return ESCAPED_CHARS[c]
      }

      if (name) {
        return NAMED_ENTITIES[name] ?? match
      }

      if (cp) {
        const code = parseInt(cp, 16)

        return code <= 0x10ffff ? String.fromCodePoint(code) : match
      }

      if (oct) {
        return String.fromCharCode(parseInt(oct, 8))
      }

      return String.fromCharCode(parseInt(u ?? x ?? pct ?? hexRef ?? decRef, decRef ? 10 : 16))
    })
  }

  return out
}

// Zero-width characters and soft hyphens, as code points and as the latin1 view of their UTF-8 bytes.
const ZERO_WIDTH_RE =
  /\u00c2\u00ad|\u00e2\u0080[\u008b-\u008d]|\u00e2\u0081\u00a0|\u00ef\u00bb\u00bf|[\u00ad\u200b-\u200d\u2060\ufeff]/g
// One string literal joined to the next with `+` ("RES" + "UME", 'a' +\n 'b').
const CONCAT_RE = /["'`][ \t\r\n]{0,24}\+[ \t\r\n]{0,24}["'`]/g

/** `text` as a reader sees it: zero-width characters and soft hyphens dropped, concatenated string literals joined. */
export function foldSplits(text) {
  return text.replace(ZERO_WIDTH_RE, '').replace(CONCAT_RE, '')
}

// Slash and backslash look-alikes NFKC leaves alone (NFKC already maps the full-width ／ and ＼).
const SLASH_LIKE_RE = /[\u2044\u2215\u29f8\u2571]/g
const BACKSLASH_LIKE_RE = /[\u29f5\u29f9\u2572\ufe68]/g
// A path-join call: its literal arguments are segments, any other argument is a placeholder (`{arg}`).
const JOIN_CALL_RE = /\b(?:join|joinpath|resolve|Path|PurePath|PosixPath)\(([^()\n]{1,400})\)/g
const ARG_RE = /\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`\n]*)`|([^,]+?))\s*(?:,|$)/gy
// pathlib: `ROOT / "a" / "b"` and `"a" / "b"`.
const PATHLIB_RE = /(?:\b([A-Za-z_][A-Za-z0-9_.]*)|(["']))\s*\/\s*(["'])/g

/** One path-join call as the path it builds: `join(ROOT, "a", 'b')` → `"{arg}/a/b"`. */
function joinedCall(args) {
  const parts = []

  ARG_RE.lastIndex = 0

  for (let m = ARG_RE.exec(args); m && m[0]; m = ARG_RE.exec(args)) {
    const literal = m[1] ?? m[2] ?? m[3]

    parts.push(literal ?? '{arg}')

    if (ARG_RE.lastIndex >= args.length) {
      break
    }
  }

  return `"${parts.join('/')}"`
}

/**
 * The one plain form both rules read: escapes decoded (three layers), NFKC (full width → ASCII), slash look-alikes,
 * zero-width characters and soft hyphens dropped, concatenated literals joined, and every path-join spelling
 * (`join(…)`, `os.path.join(…)`, `Path(…)`, pathlib `/`) written as one slash path. Case and diacritics are kept here
 * (R4-1 is case-sensitive); R4-2 folds those too.
 */
export function foldText(text) {
  let out = foldSplits(decodeEscapes(text).normalize('NFKC'))
    .replace(SLASH_LIKE_RE, '/')
    .replace(BACKSLASH_LIKE_RE, '\\')

  out = out.replace(JOIN_CALL_RE, (_m, args) => joinedCall(args))

  // `ROOT / "a"` → `"{ROOT}/a`, `"a" / "b"` → `"a/b"`; repeated until no join is left.
  for (let pass = 0; pass < 8; pass += 1) {
    const next = out.replace(PATHLIB_RE, (_m, name, closing, opening) =>
      name ? `${opening}{${name}}/` : `${closing === opening ? '' : closing}/`
    )

    if (next === out) {
      break
    }

    out = next
  }

  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// R4-1 — path-shaped strings, deny by default.

/**
 * The committed GENERIC list: segments that are not one plain word and are still nobody's private name — the parts of
 * an operating system, a toolchain, a file format or a protocol that shipped skills name. Exact spellings (case
 * included). A name of the owner's never belongs here: the port rewrites those.
 */
export const GENERIC_SEGMENTS = Object.freeze([
  // Operating systems, shells and their folders.
  '.bashrc',
  '.config',
  '.local',
  '.ssh',
  '.zshrc',
  'authorized_keys',
  'LaunchAgents',
  'LaunchDaemons',
  'Mobile Documents',
  'Application Support',
  'com~apple~CloudDocs',
  'site-packages',
  'dist-packages',
  'sbin',
  'systemd',
  'sshd_config',
  'known_hosts',
  // Runtimes and toolchains.
  'node_modules',
  'python3',
  'python3.11',
  'python3.12',
  'pip3',
  'venv312',
  'x86_64',
  'arm64',
  'aarch64',
  // Formats, codecs, algorithms.
  'base64',
  'utf-8',
  'mp4',
  'MP4',
  'h264',
  'H264',
  'h265',
  'avc1',
  'vp8',
  'vp9',
  'VP8',
  'VP9',
  'WebM',
  'WebGL',
  'WebAuthn',
  'OAuth',
  'sha256',
  'SHA256',
  'SHA256SUMS',
  'argon2',
  'bcrypt',
  'RS256',
  'ES256',
  'HS256',
  // Version-control and CI names.
  '.git',
  '.github',
  '.gitignore',
  'pre-commit',
  'post-update',
  'filter-repo',
  // Computing words the machine's (old) dictionary lacks, and tools that are not anyone's private name.
  'screenshots',
  'download',
  'downloads',
  'repo',
  'repos',
  'vocab',
  'ckpts',
  'cmux',
  'fotos',
  'Irys',
  'mini',
  'defs',
  // Templates' round counters (`critic_rN.json`), Electron's per-app data folder, other products and organisations.
  'rN',
  'userData',
  'OpenAI',
  'NousResearch',
  'fail2ban',
  '00-hardening.conf',
  // The product's public GitHub organisation (its releases and its iNFT template are published there), its brand words
  // and the spellings a speech recogniser hears for them (the voice skill's pronunciation table lists those).
  'devclone20',
  'iNFT',
  'INFT',
  'iCLONE',
  'iClone',
  'iCloneOS',
  'iColone',
  'iKolone',
  // Training checkpoints (`ck2000`) and web or bot APIs a skill names in a code span (`setWebhook/getWebhookInfo`).
  'ck500',
  'ck1000',
  'ck2000',
  'fontBoundingBoxAscent',
  'fontBoundingBoxDescent',
  'setWebhook',
  'getWebhookInfo'
])

/** The port's own placeholders (written by port-owner-skills.mjs) and the standard environment names. */
export const PORT_PLACEHOLDERS = Object.freeze(['{skill_dir}', '{skills_root}', '{agent_home}', '<user>', '<email>'])
export const STANDARD_ENV = Object.freeze([
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'PWD',
  'OLDPWD',
  'USER',
  'SHELL',
  'PATH',
  'PROJECT_DIR',
  'SKILL_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HERMES_HOME'
])
/** The words of the port's generic alias for an owner's name it could not place (layoutAlias in the port). */
export const ALIAS_WORDS = Object.freeze(['sample', 'project'])
/** The home folders that are a machine LAYOUT root, never a requirement: what is inside them is the owner's. */
export const HOME_LAYOUT_FOLDERS = Object.freeze([
  'Desktop',
  'Documents',
  'Developer',
  'Downloads',
  'Movies',
  'Music',
  'Pictures',
  'Public'
])

const CODE_EXT = new Set(['.sh', '.zsh', '.bash', '.command', '.py', '.lua', '.js', '.mjs', '.cjs', '.ts'])

/** Is this shipped file all code (every string in it can be a path)? */
export function isCodeFile(rel) {
  return CODE_EXT.has(extname(rel).toLowerCase())
}

// A plain word: letters only (any script), in one case or Capitalised.
const PLAIN_RE = /^\p{L}+$/u
const VAR_RE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:[:?=+#%/-][^}]*)?\}?|([A-Za-z_][A-Za-z0-9_]*))$/
const WIN_VAR_RE = /^%([A-Za-z_][A-Za-z0-9_]*)%$/
// Placeholders written inside a segment: `<k>`, `{name}`, `{{NAME}}`, `${k}`, `$k`, `%k%`.
const INNER_PLACEHOLDER_RE =
  /<[^<>/]{1,40}>|\{\{?[^{}/]{1,40}\}?\}|\$\{[^{}/]{1,60}\}?|\$[A-Za-z_][A-Za-z0-9_]*|\$\$|\$$|%[A-Za-z_][A-Za-z0-9_]*%/g
export const EXT_RE = /(?:\.[A-Za-z][A-Za-z0-9]{0,7}){1,2}$/
// A date or a timestamp inside a name (`backup-2026-08-30-171039`) is a pattern, not an ordinal.
const DATE_RE = /(?<!\d)(?:\d{4}-\d{2}-\d{2}(?:[-_T]\d{4,6})?|\d{8}(?:[-_T]\d{4,6})?)(?!\d)/g

function isPlainWord(word) {
  if (!PLAIN_RE.test(word)) {
    return false
  }

  const rest = word.slice(1)

  return word === word.toLowerCase() || word === word.toUpperCase() || rest === rest.toLowerCase()
}

/** A segment that says nothing of anyone: punctuation, a number or a version, a range, an extension, a glob. */
function isTrivial(segment) {
  const literal = segment.replace(/[^\p{L}\p{N}]+/gu, '')

  return (
    literal.length <= 2 ||
    /^v?\d+(?:[._\-–]\d+)*[a-z]?$/i.test(segment) ||
    /^[\d.,:×x–\-+]+$/.test(segment) ||
    /^\*?\.[A-Za-z0-9]{1,8}$/.test(segment)
  )
}

/** The port's alias, alone or with plain words (`Sample Project`, `sample_project_work`, `SAMPLE-PROJECT.md`). */
function isAliasForm(segment) {
  const words = segment
    .replace(EXT_RE, '')
    .replace(/^\d+\s*[-_.]\s*/, '')
    .split(/[\s_.-]+/)
    .filter(Boolean)

  return (
    ALIAS_WORDS.every((word, i) => words[i]?.toLowerCase() === word) &&
    words.slice(ALIAS_WORDS.length).every(isPlainWord)
  )
}

/**
 * Is the literal part of a segment an identifier of plain words (`find_fixes`, `site-packages`, `PLAN_NOTES`,
 * `cues_<k>`), never a label? Refused: a space between words, a short number beside a word (`take_7`, `20_NOTES` —
 * an ordinal or a numbered folder), a word glued to digits (`take_lark1`, `verdicts9`) other than a version (`v2`), a
 * CamelCase or mixed-case word (`QuartzHarbor`, `zeD`).
 */
function identifierRefusal(segment) {
  const templated = segment.replace(INNER_PLACEHOLDER_RE, '\ue000')
  const literal = templated
    .replace(EXT_RE, '')
    .replace(DATE_RE, '\ue000')
    .replace(/[*?[\]{}]/g, '')
    .replace(/\.\./g, '\ue000')

  if (/\s/.test(literal)) {
    return 'path.label'
  }

  const pieces = literal.split(/[\ue000_.+=:@,~\u00b7-]+/).filter(Boolean)
  const words = pieces.filter(piece => /\p{L}/u.test(piece))

  for (const piece of pieces) {
    if (/^\d+$/.test(piece)) {
      if (piece.length <= 3 && words.length) {
        return 'path.numbered'
      }
    } else if (/\p{N}/u.test(piece)) {
      // A short code (`a1`, `b2`, `3d`, `v12`) is a pattern; a word glued to a number (`verdicts9`, `take12`) is a name.
      if (piece.length > 3 && !/^v\d+$/i.test(piece) && !GENERIC_SEGMENTS.includes(piece)) {
        return 'path.numbered'
      }
    } else if (!isPlainWord(piece) && !GENERIC_SEGMENTS.includes(piece)) {
      return 'path.brand'
    }
  }

  return null
}

/**
 * Why one path segment is refused, or null when it is generic. `ctx`: { self: names of the shipped tree, product:
 * names the product tracks, declared: parts of declared roots, env: documented env names, assigned: names the file
 * assigns }. `strict`: the segment right after a home layout folder (`~/Desktop/<x>`), where only a placeholder, a
 * trivial segment, the alias or a GENERIC_SEGMENTS entry passes: whatever stands there is the owner's own folder.
 */
export function segmentRefusal(segment, ctx = {}, { strict = false } = {}) {
  if (!segment || segment === '~' || isTrivial(segment)) {
    return null
  }

  if (
    /^<[^<>]+>$/.test(segment) ||
    /^\{\{?[A-Za-z_][A-Za-z0-9_. -]*\}?\}$/.test(segment) ||
    PORT_PLACEHOLDERS.includes(segment)
  ) {
    return null
  }

  // A template expression (`${A.front}`, `${2#$ROOT}`) is a placeholder; a variable's NAME is read like a segment:
  // documented, standard or assigned here, or an identifier of plain words (a numbered or brand name is refused).
  if (/^\$\{[^}]*[^A-Za-z0-9_}:?=+#%/-][^}]*\}?$/.test(segment) || /^\$\{\d/.test(segment)) {
    return null
  }

  const variable = VAR_RE.exec(segment) ?? WIN_VAR_RE.exec(segment)

  if (variable) {
    const name = variable[1] ?? variable[2]

    return STANDARD_ENV.includes(name) || ctx.env?.has(name) || ctx.assigned?.has(name) || !identifierRefusal(name)
      ? null
      : 'path.variable'
  }

  const stem = segment.replace(EXT_RE, '')
  const known = name => GENERIC_SEGMENTS.includes(name) || isAliasForm(name) || isProductName(name)

  if (known(segment) || known(stem)) {
    return null
  }

  // Right after a home layout folder only a pattern (`<name>-agent`) passes: a real name there is the owner's folder.
  if (strict) {
    return new RegExp(INNER_PLACEHOLDER_RE.source).test(segment) && !identifierRefusal(segment) ? null : 'path.layout'
  }

  const named = name => ctx.self?.has(name) || ctx.product?.has(name) || ctx.declared?.has(name)

  if (named(segment) || named(stem) || /^@[a-z0-9][a-z0-9._-]*$/.test(segment)) {
    return null
  }

  // K140 r5: a word-shaped segment is generic only when it is not a coined name of this machine (`appvid`).
  if (ctx.coined?.size) {
    const word = nameWords(stem).join('')

    if (ctx.coined.has(word)) {
      return 'path.coined'
    }
  }

  return identifierRefusal(segment)
}

// A path token: runs of path characters, a shell-escaped space kept inside (`video\ clip`).
const TOKEN_RE = /(?:[^\s"'`()[\]|;,&<>]|<[^<>\s/]{1,40}>|<[^<>\n/]{1,60}>(?=\/)|\\ )+/g
const ROOT_RE =
  /^(?:~(?=[\\/])|\.{1,2}(?=\/)|\/(?=[^\s/])|\$\{?[A-Za-z_][A-Za-z0-9_]*(?:[:?=+-][^}\s]*)?\}?(?=[\\/])|%[A-Za-z_][A-Za-z0-9_]*%(?=\\)|<[^<>\n]{1,60}>(?=\/)|\{[A-Za-z_][A-Za-z0-9_]*\}(?=\/)|[A-Za-z]:(?=[\\/])|file:\/\/)/
const URL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//
// A bare domain opening a token (`github.com/x/y`): a web address, not a filesystem path.
const DOMAIN_RE = /^(?:[A-Za-z0-9-]+\.)+(?:com|org|net|io|ai|dev|app|sh|co|xyz|gg|me|so|to|tv|cloud|run|site)(?:\/|$)/i
// What only a regex, an expression or markup has (`\d`, `^`, `|`, `(?`, `=>`, `//` comments): never a path.
const NOT_A_PATH_RE = /\\(?![ \\])|[\^|]|\(\?|=>|\*\*\/|\/\/(?!$)|^\/.*\/[dgimsuy]{1,6}$/
// What joins a string to the home folder just before it: Lua `os.getenv('HOME') .. '`, shell `$HOME"`.
const HOME_JOIN_RE = /(?:os\.getenv\((['"])HOME\1\)\s*\.\.\s*|\$\{?HOME\}?)["']$/
// `KEY=value`, `--flag=value`, systemd's `-` and `append:` prefixes: the value is the path.
const ASSIGN_PREFIX_RE =
  /^(?:(?:--?[A-Za-z][\w-]*|[A-Za-z_][\w.-]*)=|-(?=[/~$])|(?:append|file|truncate):(?=\/(?!\/)|[~$]))+/

/** The quoted strings, backtick spans and fenced blocks of a Markdown text, as [start, end) ranges. */
function codeRanges(text) {
  const ranges = []

  for (const m of text.matchAll(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$|`[^`\n]+`/gm)) {
    ranges.push([m.index, m.index + m[0].length])
  }

  return ranges
}

/**
 * A code text with its comments blanked (same length: `/* … *\/`, and `//`, `#` or `--` to the end of a line after a
 * space or at its start): a comment is prose, its apostrophes open no string.
 */
function withoutComments(text, rel) {
  const ext = extname(rel).toLowerCase()
  const blank = m => m.replace(/[^\n]/g, ' ')
  let out = text.replace(/\/\*[\s\S]*?\*\//g, blank)

  const line = ['.js', '.mjs', '.cjs', '.ts'].includes(ext)
    ? /(?:^|[ \t])\/\/[^\n]*/gm
    : ext === '.lua'
      ? /(?:^|[ \t])--[^\n]*/gm
      : /(?:^|[ \t])#(?![!{])[^\n]*/gm

  out = out.replace(line, blank)

  return out
}

/** The string literals of a text (any quote), as [start, end) ranges. */
function quotedRanges(text) {
  return [...text.matchAll(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g)].map(m => [m.index, m.index + m[0].length])
}

const ASSIGN_RE =
  /(?:^|[\s;(&|])(?:export\s+|local\s+|readonly\s+|const\s+|let\s+|var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:?=(?!=)\s*["']?([^\s"';]*)/gm

/** The names a text assigns (shell `X=`, `export X=`, JS `const X =`, Python `X =`): a `$X/…` path there is its own. */
export function assignedNames(text) {
  const names = new Set()

  for (const m of text.matchAll(ASSIGN_RE)) {
    names.add(m[1])
  }

  for (const m of text.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g)) {
    names.add(m[1])
  }

  return names
}

/** The one value each name the text assigns takes (a name assigned two different values is left out). */
export function assignedValues(text) {
  const values = new Map()
  const conflicts = new Set()

  for (const m of text.matchAll(ASSIGN_RE)) {
    if (values.has(m[1]) && values.get(m[1]) !== m[2]) {
      conflicts.add(m[1])
    }

    values.set(m[1], m[2])
  }

  for (const name of conflicts) {
    values.delete(name)
  }

  return values
}

/** The 1-based line of `index` in `text` (line starts are computed once per text object). */
function lineOf(text, index) {
  let starts = lineStartCache.get(text)

  if (!starts) {
    starts = [0]

    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
      starts.push(i + 1)
    }

    lineStartCache.clear()
    lineStartCache.set(text, starts)
  }

  let lo = 0
  let hi = starts.length - 1

  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1

    if (starts[mid] <= index) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }

  return lo + 1
}

const lineStartCache = new Map()

/** `a/b/c` → its segments; a Windows or escaped form uses `\` (`C:\\Users\\x`, `$ROOT\\x`). */
export function segmentsOf(token) {
  return token
    .replace(/\\ /g, ' ')
    .replace(/\\\\/g, '\\')
    .split(/[\\/]+/)
}

const TRAILING_RE = /[.,;:!?)\]}*'"`>]+$/
const LEADING_RE = /^[([*'"`]+(?=[^)\]]*$)|^[*'"`]+/

const PAIRS = { ')': '(', ']': '[', '}': '{', '>': '<' }

/** A segment without the punctuation prose wraps it in; a closing bracket the segment opened itself stays. */
export function cleanSegment(segment, last) {
  let out = segment.replace(LEADING_RE, '')

  if (!last && !/[.,;:!?)\]}*'"`>]$/.test(out)) {
    return out
  }

  for (let end = out.length; end > 0; end -= 1) {
    const ch = out[end - 1]

    if (!TRAILING_RE.test(ch)) {
      return out.slice(0, end)
    }

    const open = PAIRS[ch]

    if (open && out.slice(0, end - 1).split(open).length > out.slice(0, end - 1).split(ch).length) {
      return out.slice(0, end)
    }
  }

  return out.replace(TRAILING_RE, '')
}

/**
 * Is this path inside a declared root below a dot folder (`~/.tool/model/…`, the manifest's `requires.paths`), written
 * directly or through a variable the file assigns from it (`M=~/.tool` … `$M/model/x`)? That root is the requirement's
 * interface: what is inside it (a model file, a venv) is what the host must provide, not the owner's layout.
 */
function insideInterfaceRoot(segments, ctx) {
  let parts = segments
  const variable = VAR_RE.exec(parts[0] ?? '')
  const value = variable && ctx.values?.get(variable[1] ?? variable[2])

  if (value) {
    parts = [...segmentsOf(value), ...parts.slice(1)]
  }

  if (parts[0] !== '~' || !parts[1]?.startsWith('.')) {
    return false
  }

  return (ctx.roots ?? []).some(root => {
    const rootParts = root.split('/')

    return parts.length > rootParts.length && rootParts.every((part, i) => parts[i] === part)
  })
}

/** Does the path open with a declared root up to and including segment `at` (`~/Movies/<declared>`)? */
function declaredThrough(segments, at, ctx) {
  const head = segments.slice(0, at + 1).join('/')

  return (ctx.roots ?? []).some(root => root === head || root.startsWith(`${head}/`))
}

/** The index of the home layout folder a path opens with (`~/Desktop/…`, `$HOME/Movies/…`, `/Users/x/Desktop/…`). */
export function layoutFolderAt(segments) {
  const home =
    segments[0] === '~' || /^\$\{?HOME\b/.test(segments[0] ?? '') || /^%USERPROFILE%$/i.test(segments[0] ?? '')
      ? 1
      : (segments[0] === '' || /^[A-Za-z]:$/.test(segments[0] ?? '')) && segments[1] === 'Users' && segments[2]
        ? 3
        : -1

  return home !== -1 && HOME_LAYOUT_FOLDERS.includes(segments[home]) ? home : -1
}

/**
 * The path-shaped strings of `text` (already folded with foldText) with their verdicts: `[{ index, length, line,
 * rooted, rule, segment, refused, segments }]` (`rule` and `segment` = the first refused segment, or null and -1).
 * A rooted path counts anywhere; a relative one where a path is meant: a string literal (in a code file, outside its
 * comments), a Markdown code span or block, a trailing `/` or a file name. The release scan reports only `line` and
 * `rule`; the port rewrites from `segments` and `refused`.
 */
export function pathFindings(text, rel, ctx = {}) {
  const ranges = isCodeFile(rel)
    ? quotedRanges(withoutComments(text, rel))
    : [...codeRanges(text), ...quotedRanges(text)]
  const inCode = index => ranges.some(([a, b]) => index >= a && index < b)
  const local = {
    ...ctx,
    assigned: new Set([...(ctx.assigned ?? []), ...assignedNames(text)]),
    values: assignedValues(text)
  }
  const findings = []

  // Quoted or backticked strings that open with a root are read whole: a folder name with spaces is one segment.
  const spans = [...text.matchAll(/(["'`])([^"'`\n]{3,300})\1/g)]
    .map(m => ({ index: m.index + 1, value: m[2] }))
    .filter(({ value }) => ROOT_RE.test(value) && !URL_RE.test(value) && /[\\/]/.test(value))
    .filter(
      ({ value }) => !/\s-{1,2}[A-Za-z]|\s[|&<>;=]|\$\(|\s\S+\s|\s[~/$]|[:,;.]\s/.test(value.replace(/<[^<>]*>/g, '<>'))
    )
  const insideSpan = index => spans.some(span => index >= span.index && index < span.index + span.value.length)
  const tokens = [...text.matchAll(TOKEN_RE)]
    .map(m => ({ index: m.index, value: m[0] }))
    .filter(({ index }) => !insideSpan(index))

  for (const candidate of [...spans, ...tokens]) {
    const prefix = ASSIGN_PREFIX_RE.exec(candidate.value)?.[0] ?? ''
    const lead = /^[*_]{1,2}(?=\S)/.exec(candidate.value.slice(prefix.length))?.[0] ?? ''
    const index = candidate.index + prefix.length + lead.length
    const token = candidate.value.slice(prefix.length + lead.length).replace(/[*_]{1,2}$/, '')
    const rooted = ROOT_RE.test(token)

    if (!/[\\/]/.test(token) || (URL_RE.test(token) && !token.startsWith('file://')) || DOMAIN_RE.test(token)) {
      continue
    }

    if (
      NOT_A_PATH_RE.test((token.startsWith('file://') ? token.slice(7) : token).replace(/\\ /g, ' ')) &&
      !/^(?:[A-Za-z]:|~|\$\{?\w+\}?|%\w+%)\\(?![dDsSwWbB](?![A-Za-z]))[^\\]*(?:\\(?![dDsSwWbB](?![A-Za-z]))[^\\]*)*$/.test(
        token
      )
    ) {
      continue
    }

    const parts = segmentsOf(token.startsWith('file://') ? token.slice(7) : token).filter(
      (part, i) => part !== '' || i === 0
    )

    // A string the code joins to the home folder (`os.getenv('HOME') .. '/x'`, `$HOME"/x"`) is a path under `~`.
    if (parts[0] === '' && HOME_JOIN_RE.test(text.slice(Math.max(0, candidate.index - 40), candidate.index))) {
      parts[0] = '~'
    }

    // Two segments at least (`~/x`, `$X/x`, `/x/y`; `/tmp` or a `/command` alone is not a path); a relative one only
    // where a path is meant: code, a code span, a trailing slash or a file name.
    if (parts.filter(Boolean).length < 2) {
      continue
    }

    if (!rooted && !inCode(candidate.index) && !/\/$/.test(token) && !EXT_RE.test(token)) {
      continue
    }

    const layout = layoutFolderAt(parts)
    const strictAt = i => layout !== -1 && i === layout + 1 && !declaredThrough(parts, i, local)
    const interior = insideInterfaceRoot(parts, local)
    const verdicts = parts.map((part, i) =>
      interior ? null : segmentRefusal(cleanSegment(part, i === parts.length - 1), local, { strict: strictAt(i) })
    )
    const refused = verdicts.flatMap((verdict, i) => (verdict ? [i] : []))

    findings.push({
      index,
      length: token.length,
      line: lineOf(text, index),
      rooted,
      rule: refused.length ? verdicts[refused[0]] : null,
      segment: refused.length ? refused[0] : -1,
      refused,
      segments: parts
    })
  }

  return findings
}

/** The refused path-shaped strings of `text` (folded): `[{ line, rule, segment, index, length }]`. */
export function pathRefusals(text, rel, ctx = {}) {
  return pathFindings(text, rel, ctx).filter(finding => finding.rule !== null)
}

// ---------------------------------------------------------------------------------------------------------------------
// R4-2 — the scanning machine's private names.

export const NAME_DEPTH = 4
export const NAME_HOME_FOLDERS = Object.freeze(['Desktop', 'Movies', 'Developer', 'Documents'])
const NAME_MIN_CHARS = 5
// The files whose names are labels: documents and media. A tool's code, data and models are its interface.
const LABEL_EXT = new Set(
  (
    'md markdown txt rtf pdf doc docx pages key numbers xls xlsx csv tsv html htm ' +
    'png jpg jpeg gif webp heic tif tiff svg psd mov mp4 m4v webm mkv avi wav mp3 m4a aac aiff aif flac ' +
    'srt vtt ass fcpxml drp blend glb gltf fbx usdz obj zip dmg'
  )
    .split(' ')
    .map(ext => `.${ext}`)
)
const SKIP_DIRS = new Set(['node_modules', '.git'])
const BUNDLE_RE = /\.(?:app|bundle|framework|plugin|noindex|appex)$/i
const ORDINAL_RE = /^\d+\s*[-_.]\s*(?=\S)/
// The product's own name, alone or followed by generic words of four letters or more.
const PRODUCT_WORDS = Object.freeze([['iclone', 'os'], ['icloneos'], ['iclone']])

/**
 * Names that are nobody's private layout although a folder of this machine carries them: other people's products and
 * the product's own public names. Folded like any name (case, joiner and width do not matter here).
 */
export const PUBLIC_NAMES = Object.freeze([
  // Other people's products, datasets, chains and file conventions.
  'DaVinci Resolve',
  'Final Cut Pro',
  'Local Storage',
  'Session Storage',
  'Application Support',
  'Mobile Documents',
  'READ ME',
  'LEIA-ME',
  'Start here',
  'Virtuals Protocol',
  'Robinhood Chain',
  'Emilia_ZH_EN_pinyin',
  'troubleshooting-acp-agentes-virtual',
  // Generic technical terms that are also folder names somewhere (K140 r5: identifiers count as names now).
  'top-level',
  'data base',
  'entry points',
  'black hole',
  'ufw status',
  'iFRAME',
  // Generic working names: review rounds, a grid, a Python venv.
  'critic r1',
  'critic r2',
  'grid 3',
  'venv312',
  // The product's public names: its brand, its runtime folders, its public iNFT template and that template's documents.
  'CLONE FRAME',
  'clone frame hub',
  'iCLONE OS',
  'ECONOMY_OS',
  'acp-cli',
  'virtuals-cli',
  'hermes-runtime',
  'home-iclone',
  'state-snapshots',
  'iNFT_i01',
  'inft-i01',
  'neural soul',
  'NEURAL_SOUL_ARCHITECTURE',
  'INFT_CONCEPT'
])

/** The words of a name, folded: NFKC, diacritics dropped, lower case; split at every non-letter-or-digit, at a
 * letter/digit change and at a CamelCase change (`QuartzHarbor` → quartz harbor; `fooBAR` → foo bar; `zeD` stays). */
export function nameWords(name) {
  const folded = name
    .normalize('NFKC')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
  const words = []

  for (const run of folded.match(/[\p{L}\p{N}]+/gu) ?? []) {
    for (const piece of run.match(/\p{N}+|\p{L}+/gu) ?? []) {
      if (/^\p{N}+$/u.test(piece)) {
        words.push(piece)
        continue
      }

      for (const part of piece.split(/(?<=\p{Ll})(?=\p{Lu}\p{Ll})|(?<=\p{Ll})(?=\p{Lu}{2,})/u)) {
        if (part) {
          words.push(part.toLowerCase())
        }
      }
    }
  }

  return words
}

const nameKeyCache = new Map()

/** A name's folded words joined by one space (memoised: a machine has tens of thousands of names). */
const nameKey = name => {
  if (!nameKeyCache.has(name)) {
    nameKeyCache.set(name, nameWords(name).join(' '))
  }

  return nameKeyCache.get(name)
}

/**
 * One common word (letters only, in one case or Capitalised: `MacMini` is brand-like, not common), a Finder copy, a
 * version or a number, or the product's own name (+ generic words): not private.
 */
export function isGenericName(name) {
  const single = /^(\p{L}+)(?: \d{1,2})?$/u.exec(name)

  return (single && isPlainWord(single[1])) || /^v?\d+(?:[._-]\d+)*$/i.test(name) || isProductName(name)
}

/** The product's own name, alone or followed by generic words of four letters or more (`iclone-os-release`). */
export function isProductName(name) {
  const words = nameWords(name)

  return PRODUCT_WORDS.some(
    product =>
      product.every((word, i) => words[i] === word) &&
      words.slice(product.length).every(word => /^[a-z]{4,}$/.test(word))
  )
}

/**
 * A private name's shape: two or more words however they are joined (`Lab Notes`, `lab_notes`, `lab-notes`), a
 * numbered name (`ready_9`, `001 - X`), or a CamelCase or brand-like word (`QuartzHarbor`, `clipT`). One common word is
 * not. Never short (five letters and digits at least), never generic.
 */
export function isPrivateNameShape(name) {
  if (name.length < 3 || isGenericName(name)) {
    return false
  }

  const words = nameWords(name)

  if (words.join('').length < NAME_MIN_CHARS) {
    return false
  }

  const long = words.filter(word => word.length >= 2)
  const numbered = words.some(word => /^\d+$/.test(word)) && words.some(word => !/^\d+$/.test(word))
  const camel = /\p{Ll}\p{Lu}/u.test(name)

  if (numbered || camel) {
    return true
  }

  // K140 r5 (ruling 48): any name of two or more words, however it is joined (space, `_`, `-`, `.`, CamelCase).
  return words.length >= 2 && long.length >= 1
}

/** A name written as an identifier of plain words: no space, no digit, no CamelCase (`the-crew`, `START_HERE`). */
export function isIdentifierName(name) {
  return !/[\s\p{N}]/u.test(name) && !/\p{Ll}\p{Lu}/u.test(name)
}

let dictionary = null

/**
 * The words of this machine's dictionary (`/usr/share/dict/words`, read once; none on a machine without it): only
 * used to decide how a private name may be spelled, never written anywhere.
 */
export function dictionaryWords(file = '/usr/share/dict/words') {
  if (dictionary === null) {
    try {
      dictionary = new Set(readFileSync(file, 'utf8').toLowerCase().split('\n').filter(Boolean))
    } catch {
      dictionary = new Set()
    }
  }

  return dictionary
}

/**
 * Common words the machine's dictionary may predate (macOS ships a 1934 word list): ordinary modern vocabulary, never
 * anyone's name. Used with the dictionary to tell a coined word from a common one.
 */
export const MODERN_WORDS = Object.freeze(
  (
    'app api audio backend blog browser checkout codebase config dashboard dataset debug dev download email emoji ' +
    'frontend hashtag inbox internet laptop login logout metadata online password playlist plugin podcast repo ' +
    'runtime screenshot selfie setup smartphone software startup timestamp toolkit upload username webcam ' +
    'website wifi workflow'
  ).split(' ')
)

/** Is `word` (folded) a dictionary word, as written or in a plain inflection (`notes`, `traced`, `running`)? */
export function isDictionaryWord(word, words = dictionaryWords()) {
  return [
    word,
    word.replace(/s$/, ''),
    word.replace(/es$/, ''),
    word.replace(/ed$/, ''),
    word.replace(/ing$/, '')
  ].some(form => form.length >= 2 && (words.has(form) || MODERN_WORDS.includes(form)))
}

/**
 * How a private name may be found in a text (K140 r5):
 *  - `any`: it has a coined word, a number or a CamelCase word: every spelling counts.
 *  - `named`: all its words are dictionary words or single letters (`Harbor Survey`, `kiln-harbor`, `take_b`): it
 *    counts as an identifier (`_ . -` or glued) or written as a name (each word capitalised or upper case), never as
 *    lower-case words in prose (`the bot`, `how it works` there are just English).
 */
export function nameSpelling(name, words = dictionaryWords()) {
  const parts = nameWords(name)
  const coined = part => part.length >= 3 && !isDictionaryWord(part, words)

  return /\p{Ll}\p{Lu}/u.test(name) || parts.some(part => /\d/.test(part) || coined(part)) ? 'any' : 'named'
}

/** `a.b.md` → `a.b`, `x.tar.gz` → `x`: a file's name without its extensions (two at most). */
function stemOf(file) {
  return file.replace(/(?<=[^.])(?:\.[A-Za-z][A-Za-z0-9]{0,7}){1,2}$/, '')
}

function gitLines(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore']
  })

  return result.status === 0 ? result.stdout.split('\n').filter(Boolean) : []
}

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * The checkouts behind the tree this script runs from: its main checkout (a worktree's common git dir) and every remote
 * that is a local folder (a release clone). None without git (CI from a tarball). Read once per process.
 */
const checkoutsOf = new Map()

export function productCheckouts(repoRoot = resolve(SCRIPTS_DIR, '..', '..', '..')) {
  if (checkoutsOf.has(repoRoot)) {
    return [...checkoutsOf.get(repoRoot)]
  }

  const found = new Set()
  const common = gitLines(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])[0]

  if (common) {
    found.add(basename(common) === '.git' ? dirname(common) : common)
  }

  for (const line of gitLines(repoRoot, ['config', '--get-regexp', '^remote\\..*\\.url$'])) {
    const url = line
      .slice(line.indexOf(' ') + 1)
      .trim()
      .replace(/^file:\/\//, '')

    if (url.startsWith('/') && existsSync(url)) {
      found.add(url.replace(/\/\.git\/?$/, '').replace(/\/+$/, ''))
    }
  }

  checkoutsOf.set(repoRoot, [...found])

  return [...found]
}

const productWalks = new Map()

/**
 * The names the product itself owns: every path component its checkouts track, and every one of the outputs its own
 * ignore rules declare (`git ls-files --others --ignored --directory`: build folders and two levels inside them), read
 * once per process.
 */
export function productNames(checkouts = productCheckouts()) {
  const key = JSON.stringify(checkouts)

  if (productWalks.has(key)) {
    return new Set(productWalks.get(key))
  }

  const names = new Set()

  for (const checkout of checkouts) {
    for (const line of gitLines(checkout, ['ls-files'])) {
      for (const part of line.split('/')) {
        names.add(part)
      }
    }

    // The ignored outputs, collapsed to their folders (fast), and two levels of what the product built inside each.
    for (const line of gitLines(checkout, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'])) {
      for (const part of line.split('/')) {
        if (part) {
          names.add(part)
        }
      }

      if (line.endsWith('/')) {
        walkNames(join(checkout, line), 2, name => names.add(name))
      }
    }
  }

  productWalks.set(key, [...names])

  return names
}

/** The folders a name is read under: the home folders, every ancestor of each checkout below the home, the checkouts. */
export function nameRoots({ home = homedir(), checkouts = productCheckouts() } = {}) {
  const roots = new Set(NAME_HOME_FOLDERS.map(folder => join(home, folder)))

  for (const checkout of checkouts) {
    roots.add(checkout)

    for (let dir = dirname(checkout); dir.startsWith(`${home}${sep}`); dir = dirname(dir)) {
      roots.add(dir)
    }
  }

  return [...roots].sort()
}

function walkNames(root, depth, visit) {
  const step = (dir, level) => {
    let entries

    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) {
        continue
      }

      const folder = entry.isDirectory()

      visit(entry.name, folder)

      if (folder && level < depth) {
        step(join(dir, entry.name), level + 1)
      }
    }
  }

  step(root, 1)
}

/**
 * R4-2 — the scanning machine's private names, read now (never stored): every folder and every document or media file
 * to `depth` under nameRoots, plus the home's own name; private-shaped (isPrivateNameShape; a numbered folder's name
 * after its ordinal too, when it has two words); minus the product's tracked names, the shipped tree's own names
 * (`self`), PUBLIC_NAMES and GENERIC_SEGMENTS. Returns a Map of folded keys (`nameKey`) to the spelling that counts (`any`, or `identifier` for a
 * name written as an identifier of plain words): the names themselves are never kept.
 */
export function machinePrivateNames({
  home = homedir(),
  checkouts = productCheckouts(),
  depth = NAME_DEPTH,
  roots = nameRoots({ home, checkouts }),
  product = productNames(checkouts),
  self = []
} = {}) {
  const publicKeys = new Set(
    [...product, ...self, ...PUBLIC_NAMES, ...GENERIC_SEGMENTS]
      .flatMap(name => [nameKey(name), nameKey(stemOf(name))])
      .filter(Boolean)
  )
  const keys = new Map()
  const add = name => {
    const keep = (form, spelling) => {
      const key = nameKey(form)

      const rank = { named: 1, any: 2 }

      if (key && !publicKeys.has(key) && (!keys.has(key) || rank[spelling] > rank[keys.get(key)])) {
        keys.set(key, spelling)
      }
    }

    if (!isPrivateNameShape(name)) {
      return
    }

    keep(name, nameSpelling(name))

    // The name after an ordinal (`12_SERIES_NAME` → `SERIES_NAME`) is the same folder's name, in its own spelling.
    const core = name.replace(ORDINAL_RE, '')

    if (core !== name && nameWords(core).filter(word => word.length >= 2).length >= 2) {
      keep(core, nameSpelling(core))
    }
  }

  add(basename(home))

  for (const name of layoutNamesUnder(roots, depth)) {
    add(name)
  }

  return keys
}

/**
 * K140 r5 — the machine's COINED single-word names (`appvid`): a folder or document named by one word of four
 * letters or more that is not a dictionary word (and not public, the product's or the shipped tree's own). Read now,
 * never stored; only path segments are checked against them (in prose a non-English word is just a word).
 */
export function machineCoinedNames({
  home = homedir(),
  checkouts = productCheckouts(),
  depth = NAME_DEPTH,
  roots = nameRoots({ home, checkouts }),
  product = productNames(checkouts),
  self = [],
  words = dictionaryWords()
} = {}) {
  const publicKeys = new Set(
    [...product, ...self, ...PUBLIC_NAMES, ...GENERIC_SEGMENTS, ...STANDARD_ENV]
      .flatMap(name => [nameKey(name), nameKey(stemOf(name))])
      .filter(Boolean)
  )
  const coined = new Set()

  for (const name of layoutNamesUnder(roots, depth)) {
    const parts = nameWords(name.replace(ORDINAL_RE, ''))

    if (
      parts.length === 1 &&
      /^\p{L}{4,}$/u.test(parts[0]) &&
      !isDictionaryWord(parts[0], words) &&
      !publicKeys.has(parts[0]) &&
      !isProductName(parts[0])
    ) {
      coined.add(parts[0])
    }
  }

  return coined
}

const layoutWalks = new Map()

/**
 * Every folder name and every document or media file stem to `depth` under `roots` (one walk per process and set of
 * roots: a release scan, a port and a test run read the machine once).
 */
function layoutNamesUnder(roots, depth) {
  const key = JSON.stringify([roots, depth])

  if (!layoutWalks.has(key)) {
    const names = new Set()

    for (const root of roots) {
      walkNames(root, depth, (name, folder) => {
        if (folder) {
          // A bundle folder (`<name>.app`) is named by its stem: the product's own pack is the product's name.
          names.add(BUNDLE_RE.test(name) ? name.replace(BUNDLE_RE, '') : name)
        } else if (LABEL_EXT.has(extname(name).toLowerCase())) {
          names.add(stemOf(name))
        }
      })
    }

    layoutWalks.set(key, [...names])
  }

  return layoutWalks.get(key)
}

// The joiners a name's words may be written with in a text: a space, `_ . & + - / \`, `%20` (up to four of them).
const JOINER_RE = /^(?:[ \t_.&+\-/\\]|%20){1,4}$/
// The joiners of an identifier (`the-crew`, `to_archive`, `START.HERE`): no space, no path separator.
const IDENTIFIER_JOINER_RE = /^[_.-]{1,2}$/

/** The words of a text with where they are and whether each one continues the previous one (glued or joined). */
export function textWords(text) {
  const words = []
  let previousEnd = -1

  for (const run of text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    // A hash, a key or any long run of letters and digits is one opaque word: its pieces are never names.
    if (run[0].length > 40 || /^(?=.*\d)(?=.*[a-f])[0-9a-f]{12,}$/i.test(run[0])) {
      words.push({ word: '\u0000', start: run.index, end: run.index + run[0].length, joined: false, tight: false })
      previousEnd = run.index + run[0].length
      continue
    }

    const gap = previousEnd === -1 ? null : text.slice(previousEnd, run.index)
    const joined = gap !== null && JOINER_RE.test(gap)
    const tight = gap !== null && IDENTIFIER_JOINER_RE.test(gap)
    let first = true
    let offset = run.index

    for (const piece of run[0].match(/\p{N}+|[\p{L}\p{M}]+/gu) ?? []) {
      const parts = /^\p{N}+$/u.test(piece)
        ? [piece]
        : piece.split(/(?<=\p{Ll})(?=\p{Lu}\p{Ll})|(?<=\p{Ll})(?=\p{Lu}{2,})/u)

      for (const part of parts) {
        if (!part) {
          continue
        }

        const folded = part
          .normalize('NFKD')
          .replace(/\p{M}+/gu, '')
          .toLowerCase()

        if (folded) {
          words.push({
            word: folded,
            start: offset,
            end: offset + part.length,
            joined: first ? joined : true,
            tight: first ? tight : true,
            cased: /^[\p{Lu}\p{N}]/u.test(part)
          })
        }

        offset += part.length
        first = false
      }
    }

    previousEnd = run.index + run[0].length
  }

  return words
}

const nameIndexes = new WeakMap()

/** The names of `keys` by their first word, longest first (built once per keys object). */
function nameIndex(keys) {
  if (nameIndexes.has(keys)) {
    return nameIndexes.get(keys)
  }

  const byFirst = new Map()
  const entries = keys instanceof Map ? [...keys] : [...keys].map(key => [key, 'any'])

  for (const [key, spelling] of entries) {
    const words = key.split(' ')

    if (!byFirst.has(words[0])) {
      byFirst.set(words[0], [])
    }

    byFirst.get(words[0]).push(Object.assign(words, { spelling }))
  }

  for (const list of byFirst.values()) {
    list.sort((a, b) => b.length - a.length)
  }

  // Every name of two words or more, glued (`quartzharbor`): found as one whole run of letters and digits.
  const glued = new Map(entries.filter(([key]) => key.includes(' ')).map(([key]) => [key.replaceAll(' ', ''), key]))

  nameIndexes.set(keys, { byFirst, glued })

  return nameIndexes.get(keys)
}

/**
 * Where the private names `keys` (machinePrivateNames' Map, or a Set: any spelling) stand in `text` (one view, as
 * written): `[{ start, end }]`, longest first at each place. A name matches word by word, each next word glued to the
 * previous one or joined by a JOINER_RE gap (an `identifier` name: glued or joined by `_ . -` only).
 */
export function privateNameSpans(text, keys) {
  if (!keys?.size) {
    return []
  }

  const { byFirst, glued } = nameIndex(keys)
  const words = textWords(text)
  const spans = []
  const fits = (name, i) => {
    if (i + name.length > words.length || !name.every((word, k) => words[i + k].word === word)) {
      return false
    }

    const gaps = name.slice(1).map((_word, k) => words[i + k + 1])

    if (!gaps.every(word => word.joined)) {
      return false
    }

    // A name of dictionary words joined by spaces counts only when written as a name (`Harbor Survey`).
    return name.spelling !== 'named' || gaps.every(word => word.tight) || name.every((_word, k) => words[i + k].cased)
  }

  for (let i = 0; i < words.length; i += 1) {
    for (const name of byFirst.get(words[i].word) ?? []) {
      if (fits(name, i)) {
        spans.push({ start: words[i].start, end: words[i + name.length - 1].end })
        i += name.length - 1
        break
      }
    }
  }

  // A name glued into one whole run (`quartzharbor`, `QUARTZHARBOR`), never a piece of a longer run.
  if (glued.size) {
    for (const run of text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
      if (run[0].length > 40) {
        continue
      }

      const folded = run[0]
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()

      if (glued.has(folded) && !spans.some(span => span.start < run.index + run[0].length && span.end > run.index)) {
        spans.push({ start: run.index, end: run.index + run[0].length })
      }
    }

    spans.sort((a, b) => a.start - b.start)
  }

  return spans
}

/** Every view R4-2 reads a text in: as written, and folded (foldText: escapes, width, splits, joins). */
export function nameViews(text) {
  const folded = foldText(text)

  return folded === text ? [text] : [text, folded]
}

/** How many private-name occurrences `text` holds in any view (the most any one view shows). */
export function privateNameCount(text, keys) {
  return Math.max(0, ...nameViews(text).map(view => privateNameSpans(view, keys).length))
}

// ---------------------------------------------------------------------------------------------------------------------
// The shipped skill tree.

function listFiles(root, rel = '') {
  const out = []

  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      out.push(child, ...listFiles(root, child))
    } else if (entry.isFile()) {
      out.push(child)
    }
  }

  return out.sort()
}

/** Every file and folder name of a skill tree (the tree's own names: they ship as names). */
export function treeNames(root) {
  const names = new Set()

  for (const rel of listFiles(root)) {
    for (const part of rel.split('/')) {
      names.add(part)
    }
  }

  return names
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** What a skill's manifest declares: its named places (env names), its roots and their parts, its waivers. */
export function declaredOf(manifest) {
  const paths = (manifest?.requires?.paths ?? []).flat().filter(p => typeof p === 'string')
  const places = new Set()
  const roots = []
  const parts = new Set()

  for (const p of paths) {
    const variable = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(p)

    if (variable) {
      places.add(variable[1])
    } else {
      roots.push(p)
    }

    for (const part of p.split('/')) {
      if (part && !part.startsWith('$')) {
        parts.add(part)
      }
    }
  }

  const waivers = (manifest?.waivers ?? []).map(w => w?.kept).filter(Boolean)

  return { places, roots, parts, waivers }
}

/**
 * Both rules over one shipped text: `[{ line, rule }]`. `rule` is `path.segment` / `path.variable` (R4-1) or
 * `name.private` (R4-2). `ctx`: { self, keys, manifest }.
 */
export function skillTextRefusals(
  text,
  rel,
  { self = new Set(), product = new Set(), coined = new Set(), keys = new Set(), manifest = null, owner = null } = {}
) {
  const declared = declaredOf(manifest)
  const folded = foldText(text)
  const pathCtx = {
    self,
    product,
    coined,
    declared: declared.parts,
    env: declared.places,
    roots: declared.roots
  }
  const hits = pathRefusals(folded, rel, pathCtx).map(({ line, rule }) => ({ line, rule }))
  // A name the owner kept (a waiver) or the manifest declares as a requirement (a part of `requires.paths`) is public.
  const nameKeys = withoutDeclared(keys, [...declared.waivers, ...declared.parts])
  const interior = interiorRanges(folded, pathCtx)

  for (const view of nameViews(text)) {
    for (const span of privateNameSpans(view, nameKeys)) {
      if (view === folded && interior.some(([a, b]) => span.start >= a && span.end <= b)) {
        continue
      }

      if (view !== folded && interiorRanges(view, pathCtx).some(([a, b]) => span.start >= a && span.end <= b)) {
        continue
      }

      hits.push({ line: lineOf(view, span.start), rule: 'name.private' })
    }
  }

  // r5e (ruling 48, X1): the owner's own series and delivery-folder names (known only from the private side) and the
  // shape of a delivery record. Names a manifest declares stay public.
  for (const view of nameViews(text)) {
    for (const span of ownerNameSpans(view, owner)) {
      hits.push({ line: lineOf(view, span.start), rule: `name.${span.kind}` })
    }

    for (const re of DELIVERY_RECORD_RES) {
      for (const match of view.matchAll(new RegExp(re.source, 'gi'))) {
        hits.push({ line: lineOf(view, match.index), rule: 'record.delivery' })
      }
    }
  }

  return dedupe(hits)
}

/** The release id of a skill-text rule. */
export function skillRuleId(rule) {
  return SKILL_RULE_IDS[rule] ?? 'skill.path'
}

const SKILL_RULE_IDS = Object.freeze({
  'name.private': 'skill.private-name',
  'name.series': 'skill.owner-series',
  'name.delivery': 'skill.owner-delivery',
  'name.identity': 'skill.owner-identity',
  'record.delivery': 'skill.delivery-record'
})

/**
 * r5e (ruling 48, X1) — the shape of a delivery record (how many files went out, how long, how big): owner data, never
 * method. Shapes only: no count, date or name of the owner's is written here.
 */
export const DELIVERY_RECORD_RES = Object.freeze([
  /\b\d+\s+of\s+\d+\s+identical\b/,
  /\b(?:and|with)\s+its\s+\d+\s+(?:videos?|vídeos?|episodes?|takes?|files?)\b/,
  /\b\d+\s+(?:videos?|vídeos?|episodes?|takes?),\s*\d+\s+min(?:utes)?\s+of\s+(?:film|video|footage)\b/,
  // r5f: a report line's figures (`12 of 12 · … · 33 min · 6.39 GB`) and `N videos (M min, …)`.
  /\b\d+\s+of\s+\d+\s*·/,
  /\b\d+\s*min\s*·\s*\d+(?:[.,]\d+)?\s*GB\b/,
  /\b\d+\s+(?:videos?|vídeos?|episodes?|takes?)\s*\(\s*\d+\s*min\b/
])

const sha256Of = value => createHash('sha256').update(value).digest('hex')
const MAX_NAME_WORDS = 6

/**
 * The text a name is matched in, and where each of its characters came from: format characters (zero-width joiners,
 * soft hyphens …) dropped, a non-breaking hyphen read as `-`, a non-breaking space as a space.
 */
function nameMatchText(text) {
  let clean = ''
  const at = []

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]

    if (/\p{Cf}/u.test(ch)) {
      continue
    }

    clean += /[\u2010\u2011]/.test(ch) ? '-' : /[\u00a0\u202f]/.test(ch) ? ' ' : ch
    at.push(i)
  }

  at.push(text.length)

  return { clean, at }
}

/** The keys a run of words may be written as: as it is, singular at its end, without an inner `and`. */
function runKeys(words) {
  const keys = new Set([words.join(' ')])
  const last = words.at(-1)

  if (last.length > 3 && /s$/.test(last)) {
    keys.add([...words.slice(0, -1), last.slice(0, -1)].join(' '))

    if (/es$/.test(last)) {
      keys.add([...words.slice(0, -1), last.slice(0, -2)].join(' '))
    }
  }

  if (words.length > 2) {
    const inner = words.filter((word, i) => !(word === 'and' && i > 0 && i < words.length - 1))

    if (inner.length !== words.length) {
      keys.add(inner.join(' '))
    }
  }

  return keys
}

/**
 * r5e/r5f — the owner's series names, delivery-folder words and identity names, read from the private side when the
 * scan runs: `owner` is `{ series, delivery, identity }`, sets of sha256 digests (private-markers.mjs nameRows: a name's
 * words spaced and glued, a series' leading runs of two words or more too). Nothing here names one. A name matches
 * word by word (any joiner, any case, `and` between its words, a plural at its end, format characters ignored), glued
 * (`larkharbor`: the private file holds the glued spelling of every name and short form, so the word pass reads
 * it, plural too); a delivery folder as `<word>_<n>` or `<word>-<n>[-<m>]`. Returns
 * `[{ start, end, kind: 'series' | 'delivery' | 'identity', words }]`, longest first at each place.
 */
export function ownerNameSpans(text, owner) {
  const spans = []
  const sets = ['series', 'identity'].filter(kind => owner?.[kind]?.size)

  if (!sets.length && !owner?.delivery?.size) {
    return spans
  }

  const { clean, at } = nameMatchText(text)
  const kindOf = key => {
    const digest = sha256Of(key)

    return sets.find(kind => owner[kind].has(digest))
  }

  if (sets.length) {
    const words = textWords(clean)

    for (let i = 0; i < words.length; i += 1) {
      for (let n = Math.min(MAX_NAME_WORDS, words.length - i); n >= 1; n -= 1) {
        const run = words.slice(i, i + n)

        if (run.some(word => word.word === '\u0000') || !run.slice(1).every(word => word.joined)) {
          continue
        }

        const kind = [...runKeys(run.map(word => word.word))].map(kindOf).find(Boolean)

        if (kind) {
          spans.push({ start: at[run[0].start], end: at[run[n - 1].end], kind, words: n })
          i += n - 1
          break
        }
      }
    }
  }

  if (owner?.delivery?.size) {
    for (const match of clean.matchAll(/(?<![\p{L}\p{N}])(\p{L}+)[_-]\d+(?:[-_]\d+)*(?![\p{L}\p{N}])/gu)) {
      if (owner.delivery.has(sha256Of(match[1].toLowerCase()))) {
        spans.push({ start: at[match.index], end: at[match.index + match[0].length], kind: 'delivery', words: 1 })
      }
    }
  }

  return spans.sort((x, y) => x.start - y.start || y.end - x.end)
}

/** The owner's series and delivery names of this scan, from the private markers (none without the private file). */
export function ownerNamesOf(loaded = loadPrivateMarkers()) {
  const names = loaded?.names ?? []

  const of = kind => new Set(names.filter(row => row.kind === kind).map(row => row.sha256))

  return { series: of('series'), delivery: of('delivery'), identity: of('identity') }
}

/** The paths of `text` that are inside a declared interface root (`~/.tool/…`, see insideInterfaceRoot): [start, end). */
export function interiorRanges(text, ctx) {
  const local = { ...ctx, values: assignedValues(text) }

  return [...text.matchAll(TOKEN_RE)]
    .filter(m => insideInterfaceRoot(segmentsOf(m[0]), local))
    .map(m => [m.index, m.index + m[0].length])
}

const toMap = keys => (keys instanceof Map ? keys : new Map([...keys].map(key => [key, 'any'])))
const declaredKeySets = new WeakMap()

/**
 * `keys` without the names a manifest declares (its waivers, the parts of its requires.paths): the same Map object for
 * the same keys and declarations (its name index is built once).
 */
function withoutDeclared(keys, declared) {
  const waived = [...new Set(declared.map(nameKey))].sort()

  if (!waived.length) {
    return keys
  }

  if (!declaredKeySets.has(keys)) {
    declaredKeySets.set(keys, new Map())
  }

  const cache = declaredKeySets.get(keys)
  const id = waived.join('\n')

  if (!cache.has(id)) {
    const drop = new Set(waived)

    cache.set(id, new Map([...toMap(keys)].filter(([key]) => !drop.has(key))))
  }

  return cache.get(id)
}

/** A shipped file's text: UTF-8, or UTF-16 (a BOM, or every other byte NUL) decoded; null for any other binary. */
export function textOf(bytes) {
  if (!bytes.includes(0)) {
    return bytes.toString('utf8')
  }

  const le = bytes[0] === 0xff && bytes[1] === 0xfe
  const be = bytes[0] === 0xfe && bytes[1] === 0xff

  if (le || be || bytes.length % 2 === 0) {
    const body = le || be ? bytes.subarray(2) : bytes
    const odd = [...body.subarray(0, 4096)].filter((byte, i) => i % 2 === 1 && byte === 0).length
    const even = [...body.subarray(0, 4096)].filter((byte, i) => i % 2 === 0 && byte === 0).length
    const half = Math.min(body.length, 4096) / 2
    const littleEndian = le || (!be && odd >= half * 0.9)
    const bigEndian = be || (!le && even >= half * 0.9)

    if (littleEndian || bigEndian) {
      const copy = Buffer.from(body)

      if (bigEndian) {
        copy.swap16()
      }

      const text = copy.toString('utf16le')

      return text.includes('\u0000') ? null : text
    }
  }

  return null
}

function dedupe(hits) {
  const seen = new Set()

  return hits.filter(hit => {
    const key = `${hit.line}:${hit.rule}`

    if (seen.has(key)) {
      return false
    }

    seen.add(key)

    return true
  })
}

/**
 * The release scan of a whole shipped skill tree (`Resources/hermes-skill`, or `iclone/skills` in the repo): every text
 * file and every file name, each read against its own skill's manifest. Returns `[{ file, id }]` with ids
 * `skill.path` (R4-1) and `skill.private-name` (R4-2); `{ line }` is kept for the caller's report, never a value.
 */
export function scanSkillTree(
  root,
  { keys = undefined, coined = undefined, checkouts = undefined, owner = undefined } = {}
) {
  const ownerNames = owner === undefined ? ownerNamesOf() : owner
  const self = treeNames(root)
  const owners = checkouts ?? productCheckouts()
  const product = productNames(owners)
  const names = keys ?? machinePrivateNames({ self: [...self], checkouts: owners, product })
  const coinedNames = coined ?? machineCoinedNames({ self: [...self], checkouts: owners, product })
  const hits = []

  const files = listFiles(root)
  const manifests = files.filter(rel => /^[^/]+\/manifest\.json$/.test(rel)).map(rel => readJson(join(root, rel)))
  // A file of the tree's own (the catalog, the notices) repeats every skill's text: it reads against all manifests.
  const everything = {
    requires: { paths: manifests.flatMap(m => m?.requires?.paths ?? []) },
    waivers: manifests.flatMap(m => m?.waivers ?? [])
  }

  for (const rel of files) {
    const full = join(root, rel)
    const skill = rel.split('/')[0]
    const manifest = rel.includes('/') ? readJson(join(root, skill, 'manifest.json')) : everything
    const ctx = { self, product, coined: coinedNames, keys: names, manifest, owner: ownerNames }

    for (const hit of skillTextRefusals(rel.split('/').join('\n'), 'name.txt', ctx)) {
      hits.push({ file: rel, line: 0, id: skillRuleId(hit.rule) })
    }

    let bytes

    try {
      bytes = readFileSync(full)
    } catch {
      continue
    }

    // K140 r5: a file with NUL bytes is read as UTF-16 when it is UTF-16 text; any other binary is refused (a shipped
    // skill is text: an opaque file would carry what no rule can read).
    const text = textOf(bytes)

    if (text === null) {
      hits.push({ file: rel, line: 0, id: 'skill.binary' })
      continue
    }

    for (const hit of skillTextRefusals(text, rel, ctx)) {
      hits.push({ file: rel, line: hit.line, id: skillRuleId(hit.rule) })
    }
  }

  return hits
}

/** A path relative to `root`, for a report (never absolute). */
export function relativeTo(root, file) {
  return relative(root, file) || basename(file)
}
