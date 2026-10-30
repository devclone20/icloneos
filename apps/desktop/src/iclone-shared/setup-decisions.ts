/**
 * V3-ON r2 (minor 4) — the ONE validator of the Set up step's stored decisions, shared by main (electron/
 * iclone-consent.ts, which owns consent.json) and the window (src/components/setup/store.ts, which reads the record main
 * sends). Plain TS: no DOM or Node imports. A malformed entry is undecided (its section shows again) — never a reason
 * to discard the whole record.
 */

/** The Set up step's sections, in the order the screen shows them. */
export const SETUP_SECTIONS = ['packages', 'system', 'agent'] as const
export type SetupSection = (typeof SETUP_SECTIONS)[number]
export type SetupChoice = 'done' | 'skipped'
export type SetupDecisions = Partial<Record<SetupSection, { state: SetupChoice; at: string }>>

// ISO-8601 date-time as `toISOString()` writes it (offset or Z required); a bare date or free text is not a timestamp.
const ISO_DATE_TIME =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/

// Date.parse rolls an impossible day over (30 February → 2 March), so the day is checked against its month.
const realDay = (value: string) => {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)

  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export const isIsoDateTime = (value: unknown): value is string =>
  typeof value === 'string' && ISO_DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)) && realDay(value)

/** The stored decisions of a consent record (or anything shaped like one), well-formed entries only. */
export function setupDecisions(record: { setup?: unknown } | null | undefined): SetupDecisions {
  const raw = record?.setup

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }

  const out: SetupDecisions = {}

  for (const section of SETUP_SECTIONS) {
    const one = Object.hasOwn(raw, section) ? (raw as Record<string, unknown>)[section] : undefined
    const entry = (one ?? {}) as { state?: unknown; at?: unknown }

    if ((entry.state === 'done' || entry.state === 'skipped') && isIsoDateTime(entry.at)) {
      out[section] = { state: entry.state, at: entry.at }
    }
  }

  return out
}
