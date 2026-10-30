/**
 * The pane bus wire format. One envelope per message; the broker stamps `id`
 * (unless the sender supplied one for a retry), `seq`, `from` and `ts` —
 * a pane never writes its own identity.
 */

export const BUS_BODY_CAP_BYTES = 8 * 1024

/** Pane names are what agents address; the same rule as spawn spec names. */
const PANE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

export type EnvelopeKind = 'ask' | 'event' | 'msg' | 'reply'

export interface Envelope {
  v: 1
  id: string
  /** Monotonic per (from, to) pair: the reader can prove order. */
  seq: number
  from: string
  to: string
  group?: string
  kind: EnvelopeKind
  corr?: string
  ts: number
  /** Seconds the message stays readable; an expired message is dropped and counted. */
  ttl: number
  body: string
}

type BodyCheck = { ok: true } | { ok: false; error: string }

export function checkBody(body: string): BodyCheck {
  const bytes = Buffer.byteLength(body, 'utf8')

  if (bytes > BUS_BODY_CAP_BYTES) {
    return { ok: false, error: `the message is ${bytes} bytes; the cap is ${BUS_BODY_CAP_BYTES} (nothing was sent)` }
  }

  return { ok: true }
}

export function isPaneName(value: string): boolean {
  return PANE_NAME_RE.test(value)
}

export function isMessageId(value: string): boolean {
  return MESSAGE_ID_RE.test(value)
}

export function envelopeBytes(envelope: Envelope): number {
  return Buffer.byteLength(envelope.body, 'utf8') + 256
}
