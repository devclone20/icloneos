/**
 * Ruling 69 (owner): icloneOS ships in English only. Hermes picks its words from `HERMES_LANGUAGE` before
 * `display.language` (agent/i18n.py); every runtime the app spawns is told English (iclone-spawn-env.ts), but a ROUTED
 * profile reads `display.language` from its own config.yaml, and earlier builds saved e.g. `pt-PT` there.
 *
 * Review r2 (R2-M5): that rewrite used to live in the renderer, once at mount, through the config client — so it only
 * reached the profile active at that moment (every other saved profile stayed Portuguese in the runtime), and through a
 * remote gateway it would have rewritten a VPS's config. It is main's now: every LOCAL config Hermes runs a profile from
 * (`hermesProfileConfigs`) has a non-English `display.language` set to `en`, at launch, right before every Hermes spawn
 * and whenever a profile folder appears (the same passes as the payment-skill seed, iclone-x402/index.ts). Only that
 * one value changes; the file is edited in place under the seed's never-outside-the-home write rules
 * (`editConfigInside`). A remote gateway's config is never touched.
 */
import { editConfigInside, hermesProfileConfigs } from './iclone-x402/skill-defaults'

const DISPLAY_RE = /^display:[ \t]*(#.*)?$/
const DISPLAY_FLOW_RE = /^display:[ \t]*\{/
const TOP_KEY_RE = /^[^\s#]/
const LANGUAGE_RE = /^([ \t]+)language:([ \t]*)(.*)$/
const ENGLISH_RE = /^en(?:[-_]|$)/i

/** A YAML scalar as written (`pt-PT`, `"pt-PT"`, `'pt-PT'`, with an optional ` # comment`): its value and the comment. */
function scalarOf(raw: string): { value: string; comment: string } {
  const quoted = /^(["'])(.*?)\1([ \t]+#.*)?[ \t]*$/.exec(raw)

  if (quoted) {
    return { value: quoted[2], comment: quoted[3] ?? '' }
  }

  const hash = raw.search(/[ \t]#/)

  return hash === -1
    ? { value: raw.trim(), comment: '' }
    : { value: raw.slice(0, hash).trim(), comment: raw.slice(hash) }
}

/**
 * `text` with `display.language` set to `en` when it names another language (`from`: that language); the same text
 * (`from` null) when it is English, empty or absent; `{ skip }` for a shape this narrow edit does not understand (a flow
 * `display: {…}`), which is left as is. Understands what Hermes writes (PyYAML block style: `display:` at column 0,
 * `language:` one level in).
 */
export function withEnglishDisplayLanguage(text: string): { text: string; from: null | string } | { skip: string } {
  const lines = text.split('\n')
  const start = lines.findIndex(line => DISPLAY_RE.test(line))
  const same = { text, from: null }

  if (start === -1) {
    return lines.some(line => DISPLAY_FLOW_RE.test(line))
      ? { skip: 'config.yaml display block not understood (flow style)' }
      : same
  }

  let childIndent: null | string = null

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]

    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue
    }

    if (TOP_KEY_RE.test(line)) {
      break
    }

    const indent = line.slice(0, line.length - line.trimStart().length)

    childIndent ??= indent

    const match = indent === childIndent ? LANGUAGE_RE.exec(line) : null

    if (!match) {
      continue
    }

    const { value, comment } = scalarOf(match[3])

    if (value === '' || value === 'null' || value === '~' || ENGLISH_RE.test(value)) {
      return same
    }

    lines[index] = `${match[1]}language:${match[2] || ' '}en${comment}`

    return { text: lines.join('\n'), from: value }
  }

  return same
}

interface DisplayLanguagePass {
  configFile: string
  slug: string
  /** The language that was there when it was rewritten to `en`; null when nothing changed. */
  rewrote: null | string
  /** Why the file was left as it was (not understood, moved, could not be read or written); null otherwise. */
  skipped: null | string
}

/** One pass over every local profile's config (see the header). Never throws. */
export function englishDisplayLanguageEverywhere(hermesHome: string): DisplayLanguagePass[] {
  return hermesProfileConfigs(hermesHome).map(({ configFile, home, slug }) => {
    let rewrote: null | string = null

    const skipped = editConfigInside(configFile, home, text => {
      const edit = withEnglishDisplayLanguage(text)

      if ('skip' in edit) {
        return edit
      }

      rewrote = edit.from

      return edit.text
    })

    return { configFile, slug, rewrote: skipped === null ? rewrote : null, skipped }
  })
}
