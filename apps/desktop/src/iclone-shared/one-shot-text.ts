/**
 * S1, the lead's ruling on the one-shot: the human reads all that runs outside the Seatbelt. What the sheet renders and
 * what main records come from this one reading of the text. A mark is a rendering only: every segment keeps the exact
 * characters it stands for, so the text the sheet says it showed is the text that runs, byte for byte.
 */

/**
 * Past this the command stays confined. The plugin's classify clips a target here, and a clipped target is never offered
 * (its text is no longer the command), so nothing longer ever reached the sheet whole.
 */
export const ONE_SHOT_MAX_TEXT = 4000

/**
 * No glyph of its own, or one that moves what is around it: controls, format characters (bidi overrides, zero-width,
 * tags), every space but the plain one, line and paragraph separators, default-ignorables (variation selectors, Hangul
 * fillers), surrogates, private use, unassigned, and the blank Braille cell. Newline and tab are read by their marks.
 */
const HIDDEN = /(?![ \n\t])[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}⠀]/u

const SEGMENT = new RegExp(`(${HIDDEN.source})|(\\n)|(\\t)|( {2,}|^ | $)`, 'gu')

export const hasHiddenCharacters = (text: string): boolean => HIDDEN.test(text)

/** Whether a person can read this text as it runs: the only text that may be offered outside the Seatbelt. */
export const oneShotReadable = (text: string): boolean =>
  text.length > 0 && text.length <= ONE_SHOT_MAX_TEXT && !hasHiddenCharacters(text)

export interface VisibleSegment {
  /** What the sheet renders. */
  shown: string
  /** The exact characters of the command this segment stands for. */
  raw: string
  /** Rendered by the app, not typed in the text: the sheet draws it in its own colour. */
  mark: boolean
}

const numbered = (character: string) =>
  `⟦U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟧`

/**
 * The text as segments. A hidden character always shows by its number. With `layout`, for a command: a newline shows ↵
 * and still breaks the line, a tab shows ⇥, a run of spaces and a space at either end show one · each.
 */
export function visibleSegments(text: string, { layout = false }: { layout?: boolean } = {}): VisibleSegment[] {
  const segments: VisibleSegment[] = []
  let from = 0

  const plain = (to: number) => {
    if (to > from) {
      const raw = text.slice(from, to)

      segments.push({ shown: raw, raw, mark: false })
    }
  }

  for (const match of text.matchAll(SEGMENT)) {
    const [raw, hidden, newline, tab] = match
    const at = match.index

    if (!hidden && !layout) {
      continue
    }

    plain(at)
    from = at + raw.length
    segments.push({
      raw,
      mark: true,
      shown: hidden ? numbered(raw) : newline ? '↵\n' : tab ? '⇥\t' : '·'.repeat(raw.length)
    })
  }

  plain(text.length)

  return segments
}

export const rawOf = (segments: readonly VisibleSegment[]): string => segments.map(segment => segment.raw).join('')

export const visibleText = (text: string, options?: { layout?: boolean }): string =>
  visibleSegments(text, options)
    .map(segment => segment.shown)
    .join('')
