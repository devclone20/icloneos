/** One `open_requests` entry from `session.resume` / `session.activate` / `session.events.since`. */
interface OpenRequestEntry {
  id: string
  method: string
  params: Record<string, unknown>
}

/** Keep the well-formed entries of an `open_requests` snapshot (runtimes before it omit the field). */
export function normalizeOpenRequests(entries: unknown): OpenRequestEntry[] {
  if (!Array.isArray(entries)) {
    return []
  }

  const out: OpenRequestEntry[] = []

  for (const entry of entries as unknown[]) {
    const e = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null

    if (!e || typeof e.method !== 'string' || (typeof e.id !== 'string' && typeof e.id !== 'number')) {
      continue
    }

    const params = e.params && typeof e.params === 'object' ? (e.params as Record<string, unknown>) : {}
    const item: OpenRequestEntry = { id: String(e.id), method: e.method, params }

    out.push(item)
  }

  return out
}

/**
 * Ids already settled here (answered, declined, cancelled, timed out). A reconnect snapshot taken
 * just before our answer landed still lists the request; re-raising it would ask the user twice.
 */
export class SettledIds {
  private readonly ids = new Set<string>()

  constructor(private readonly limit = 512) {}

  add(id: string): void {
    this.ids.delete(id)
    this.ids.add(id)

    if (this.ids.size > this.limit) {
      const oldest = this.ids.values().next().value

      if (oldest !== undefined) {
        this.ids.delete(oldest)
      }
    }
  }

  has(id: string): boolean {
    return this.ids.has(id)
  }

  clear(): void {
    this.ids.clear()
  }
}
