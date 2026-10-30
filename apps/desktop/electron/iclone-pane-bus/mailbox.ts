/**
 * One pane's inbox. Senders may deliver at least once (a retry carries the
 * same id); the mailbox remembers recent ids so the reader gets each message
 * exactly once. A full mailbox refuses — the sender is told, nothing is
 * dropped silently.
 */
import { type Envelope, envelopeBytes } from './envelope'

export const MAILBOX_MAX_MESSAGES = 1_000
const MAILBOX_MAX_BYTES = 8 * 1024 * 1024

// Larger than the mailbox itself, so a retry of anything still queued or just
// read is recognised.
const SEEN_IDS_KEPT = 4 * MAILBOX_MAX_MESSAGES

type PushResult = 'duplicate' | 'full' | 'queued'

export class Mailbox {
  private readonly queue: Envelope[] = []
  private bytes = 0
  private readonly seen = new Set<string>()
  private readonly seenOrder: string[] = []
  private readonly waiters = new Set<() => void>()

  get size(): number {
    return this.queue.length
  }

  /** Whether `envelope` would be queued now (a retry of a seen id always is: it is a duplicate, not a cost). */
  accepts(envelope: Envelope): boolean {
    return (
      this.seen.has(envelope.id) ||
      (this.queue.length < MAILBOX_MAX_MESSAGES && this.bytes + envelopeBytes(envelope) <= MAILBOX_MAX_BYTES)
    )
  }

  push(envelope: Envelope): PushResult {
    if (this.seen.has(envelope.id)) {
      return 'duplicate'
    }

    if (!this.accepts(envelope)) {
      return 'full'
    }

    const cost = envelopeBytes(envelope)

    this.remember(envelope.id)
    this.queue.push(envelope)
    this.bytes += cost

    for (const wake of [...this.waiters]) {
      wake()
    }

    return 'queued'
  }

  /** Remove and return up to `max` messages, dropping expired ones into `onExpired`. */
  take(max: number, now: number, onExpired: (envelope: Envelope) => void): Envelope[] {
    const out: Envelope[] = []

    for (let next = this.queue.shift(); next !== undefined; next = out.length < max ? this.queue.shift() : undefined) {
      this.bytes -= envelopeBytes(next)

      if (next.ttl > 0 && now - next.ts > next.ttl * 1000) {
        onExpired(next)

        continue
      }

      out.push(next)
    }

    return out
  }

  /** Resolves when a message arrives, after `ms`, or when `cancel` fires — whichever is first. */
  waitForMail(ms: number, cancel?: AbortSignal): Promise<void> {
    if (this.queue.length > 0 || ms <= 0 || cancel?.aborted) {
      return Promise.resolve()
    }

    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer)
        cancel?.removeEventListener('abort', done)
        this.waiters.delete(done)
        resolve()
      }

      const timer = setTimeout(done, ms)

      this.waiters.add(done)
      cancel?.addEventListener('abort', done, { once: true })
    })
  }

  /** The pane died: wake every reader and hand back whatever was never read. */
  drain(): Envelope[] {
    const left = this.queue.splice(0)

    this.bytes = 0

    for (const wake of [...this.waiters]) {
      wake()
    }

    return left
  }

  private remember(id: string): void {
    this.seen.add(id)
    this.seenOrder.push(id)

    const forgotten = this.seenOrder.length > SEEN_IDS_KEPT ? this.seenOrder.shift() : undefined

    if (forgotten !== undefined) {
      this.seen.delete(forgotten)
    }
  }
}
