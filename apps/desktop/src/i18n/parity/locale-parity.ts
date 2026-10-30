/**
 * The locale parity gate's comparator (front V3-T): walks an English word bank and a locale's own words for it, and
 * names every place the locale is not a complete, faithful copy of the English shape —
 *
 * - `missing`      a key English has and the locale does not (it would read through the English fallback);
 * - `extra`        a key the locale has and English no longer does (a stale word after a rename);
 * - `type`         a string where English has a function, an array of another length, …;
 * - `placeholder`  a sentence function with another number of parameters, or one that drops or adds an argument
 *                  in its output, or a `{name}` token that differs;
 * - `plural`       English picks a singular or plural form from a count and the locale prints one form for both;
 * - `empty`        an empty or blank string where English has words;
 * - `untranslated` the English words copied as they are, outside the allowlist of brand and product terms. The
 *                  comparison ignores surrounding white space and letter case, so "retry" or "Retry " still
 *                  count as the English "Retry" (critic m-G1).
 *
 * The `plural` rule is English-driven: a locale plural English lacks ("1 selecionado / 3 selecionados") is the
 * locale's own choice and is not checked (critic m-G2).
 *
 * Pure: it never imports a catalogue, so the gate, the top-up listing and the mutation proofs share it.
 */

/** @public — the parity reports name these kinds; the gate scripts read them (K106). */
export type ParityIssueKind = 'empty' | 'extra' | 'missing' | 'placeholder' | 'plural' | 'type' | 'untranslated'

export interface ParityIssue {
  bank: string
  detail?: string
  kind: ParityIssueKind
  path: string
}

export interface ParityOptions {
  /** The bank's name in every issue. */
  bank: string
  /** Words a locale may keep exactly as English has them: brand, product and protocol names, code, units. */
  allowedValues: ReadonlySet<string>
  /** `bank:path` entries a locale may keep in English as a whole (a value that is a term only in that place). */
  allowedPaths: ReadonlySet<string>
  /** `bank:path` groups whose keys are open (a `Record<string, …>` English fills from elsewhere): a locale may name
   *  more entries there than English does. */
  openGroups: ReadonlySet<string>
  /** The same bank in the other translated locales: a value every one of them keeps in English is a term, not an
   *  oversight. Undefined entries (a locale without the bank) never count as keeping it. */
  others: readonly unknown[]
}

type Fn = (...args: unknown[]) => unknown

const SENTINEL = (index: number) => `⟦${index}⟧`
const SENTINEL_RE = /⟦(\d+)⟧/g
const BRACE_TOKEN_RE = /\{\{?\s*([A-Za-z_][\w.]*)\s*\}?\}/g
// Two ASCII letters in a row: a string without them (a symbol, a number, a unit like "2×") cannot be "in English".
const WORDY_RE = /[A-Za-z]{2}/

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Text of whatever a sentence function returns (a string, or a number in a few counters). */
const asText = (value: unknown): null | string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null

function call(fn: Fn, args: unknown[]): { ok: false } | { ok: true; text: null | string } {
  try {
    return { ok: true, text: asText(fn(...args)) }
  } catch {
    return { ok: false }
  }
}

const sentinelsIn = (text: string) => [...new Set([...text.matchAll(SENTINEL_RE)].map(match => match[1]))].sort()
const braceTokensIn = (text: string) => [...new Set([...text.matchAll(BRACE_TOKEN_RE)].map(match => match[1]))].sort()
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** The same words as English, whatever the surrounding white space or letter case ("Retry", "retry", "Retry "). */
const sameWords = (value: string, english: string) =>
  value.trim().toLocaleLowerCase('en') === english.trim().toLocaleLowerCase('en')

/** A count probe: every argument 7, the probed one `count`, and the probed number masked so 1 and 3 compare. */
function countProbe(fn: Fn, arity: number, index: number, count: 1 | 3): null | string {
  const args = Array.from({ length: arity }, (_, i) => (i === index ? count : 7))
  const result = call(fn, args)

  if (!result.ok || result.text === null) {
    return null
  }

  // The probed count standing alone: not part of a longer number ("13", "1.5", "2,1"), but a sentence may end on it.
  return result.text.replace(new RegExp(`(?<![\\d.,])${count}(?![\\d]|[.,]\\d)`, 'g'), '#')
}

/** Whether the function picks its words from argument `index` as a count (its text differs for 1 and 3). */
function branchesOnCount(fn: Fn, arity: number, index: number): boolean | null {
  const one = countProbe(fn, arity, index, 1)
  const three = countProbe(fn, arity, index, 3)

  return one === null || three === null ? null : one !== three
}

export function compareBank(en: unknown, target: unknown, options: ParityOptions): ParityIssue[] {
  const issues: ParityIssue[] = []

  const push = (kind: ParityIssueKind, path: string, detail?: string) =>
    issues.push({ bank: options.bank, kind, path, ...(detail === undefined ? {} : { detail }) })

  const keptByEveryOther = (others: readonly unknown[], value: unknown): boolean =>
    others.length > 0 && others.every(other => other !== undefined && other === value)

  const keptByEveryOtherFn = (others: readonly unknown[], englishText: string, args: unknown[]): boolean =>
    others.length > 0 &&
    others.every(other => {
      if (typeof other !== 'function') {
        return false
      }

      const result = call(other as Fn, args)

      return result.ok && result.text === englishText
    })

  const allowed = (path: string, englishText: string, others: readonly unknown[], value: unknown) =>
    !WORDY_RE.test(englishText.replace(SENTINEL_RE, '').replace(BRACE_TOKEN_RE, '')) ||
    options.allowedValues.has(englishText.trim()) ||
    options.allowedPaths.has(`${options.bank}:${path}`) ||
    keptByEveryOther(others, value)

  const compareString = (path: string, english: string, value: unknown, others: readonly unknown[]) => {
    if (typeof value !== 'string') {
      push('type', path, `English is a string, the locale has ${typeof value}`)

      return
    }

    if (english.trim() !== '' && value.trim() === '') {
      push('empty', path)

      return
    }

    const englishTokens = braceTokensIn(english)
    const tokens = braceTokensIn(value)

    if (!sameList(englishTokens, tokens)) {
      push('placeholder', path, `English {${englishTokens.join(', ')}}, locale {${tokens.join(', ')}}`)
    }

    if (english.trim() !== '' && sameWords(value, english) && !allowed(path, english, others, value)) {
      push('untranslated', path, english.slice(0, 80))
    }
  }

  const compareFunction = (path: string, english: Fn, value: unknown, others: readonly unknown[]) => {
    if (typeof value !== 'function') {
      push('type', path, `English is a sentence function, the locale has ${typeof value}`)

      return
    }

    const fn = value as Fn
    const arity = english.length

    if (fn.length !== arity) {
      push('placeholder', path, `English takes ${arity} argument(s), the locale ${fn.length}`)

      return
    }

    const args = Array.from({ length: arity }, (_, i) => SENTINEL(i))
    const englishResult = call(english, args)

    if (englishResult.ok && englishResult.text !== null) {
      const result = call(fn, args)

      if (!result.ok || result.text === null) {
        push('type', path, 'English renders the probe, the locale throws or renders no text')

        return
      }

      if (englishResult.text.trim() !== '' && result.text.trim() === '') {
        push('empty', path)

        return
      }

      const englishArgs = sentinelsIn(englishResult.text)
      const localeArgs = sentinelsIn(result.text)

      if (!sameList(englishArgs, localeArgs)) {
        push(
          'placeholder',
          path,
          `English prints argument(s) [${englishArgs.join(', ')}], locale [${localeArgs.join(', ')}]`
        )
      }

      if (
        englishResult.text.trim() !== '' &&
        sameWords(result.text, englishResult.text) &&
        !allowed(path, englishResult.text, [], undefined) &&
        !keptByEveryOtherFn(others, englishResult.text, args)
      ) {
        push('untranslated', path, englishResult.text.slice(0, 80))
      }
    }

    for (let index = 0; index < arity; index += 1) {
      if (branchesOnCount(english, arity, index) === true && branchesOnCount(fn, arity, index) === false) {
        push('plural', path, `English has a singular and a plural for argument ${index}, the locale one form`)
      }
    }
  }

  const walk = (path: string, english: unknown, value: unknown, others: readonly unknown[]) => {
    const child = (key: string) => (path === '' ? key : `${path}.${key}`)

    const at = (key: number | string) =>
      others.map(other =>
        isPlainObject(other) || Array.isArray(other) ? (other as Record<string, unknown>)[key] : undefined
      )

    if (value === undefined) {
      push('missing', path)

      return
    }

    if (typeof english === 'string') {
      compareString(path, english, value, others)
    } else if (typeof english === 'function') {
      compareFunction(path, english as Fn, value, others)
    } else if (Array.isArray(english)) {
      if (!Array.isArray(value) || value.length !== english.length) {
        push(
          'type',
          path,
          `English is a list of ${english.length}, the locale ${Array.isArray(value) ? `a list of ${value.length}` : typeof value}`
        )

        return
      }

      english.forEach((item, index) => walk(child(String(index)), item, value[index], at(index)))
    } else if (isPlainObject(english)) {
      if (!isPlainObject(value)) {
        push('type', path, `English is a group of words, the locale has ${typeof value}`)

        return
      }

      for (const key of Object.keys(english)) {
        walk(child(key), english[key], value[key], at(key))
      }

      for (const key of Object.keys(value)) {
        if (!(key in english) && !options.openGroups.has(`${options.bank}:${path}`)) {
          push('extra', child(key))
        }
      }
    } else if (typeof english !== typeof value) {
      push('type', path, `English is ${typeof english}, the locale ${typeof value}`)
    }
  }

  walk('', en, target, options.others)

  return issues
}

/** Leaf count of an English bank (strings and sentence functions), for the report. */
export function countLeaves(value: unknown): number {
  if (typeof value === 'string' || typeof value === 'function') {
    return 1
  }

  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + countLeaves(item), 0)
  }

  return isPlainObject(value) ? Object.values(value).reduce<number>((sum, item) => sum + countLeaves(item), 0) : 0
}

export const formatIssue = (locale: string, issue: ParityIssue) =>
  `I18N-PARITY ${locale} ${issue.kind} ${issue.bank}:${issue.path || '(root)'}${issue.detail ? ` — ${issue.detail}` : ''}`
