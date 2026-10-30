// Post-hoc watch of every update door (contract decision 11): read-only `fs.watch` on the receipts folder and on the
// runtime's `.git` (HEAD) and `.git/logs` (reflog). Every reflog transition gets exactly one verdict, receipt or not
// (09-16: the receipt said pre == post while the reflog fast-forwarded). Directories are watched, not files, because
// git and the updater replace files by rename.
import fs from 'node:fs'
import path from 'node:path'

import { staleBackendCard, type StaleCard } from './guard'
import { readReflog, runtimeGitDir } from './runtime-git'

export interface Transition {
  kind: 'post-update' | 'reflog'
  from: string
  to: string
  source: string
}

export interface WatchVerdict {
  kind: Transition['kind']
  from: string
  to: string
  level: string
  cards: unknown[]
  ms: number
}

interface WatchDeps {
  runtimeDir: string
  receiptsDir: string
  verdictFor: (t: Transition) => Promise<{ level: string; cards?: unknown[] }>
  healthCommit: () => Promise<string | null>
  onVerdict: (v: WatchVerdict) => void
  debounceMs?: number
  // fs.watch can drop events (FSEvents coalescing, a folder created after the watch): a cheap re-scan keeps the
  // 2 s verdict promise anyway.
  pollMs?: number
  watch?: typeof fs.watch
  now?: () => number
}

interface Receipt {
  outcome?: string
  pre_update?: { sha?: string }
  post_update?: { sha?: string }
  steps?: unknown[]
}

function receiptTransition(file: string, r: Receipt): Transition | null {
  const from = r.pre_update?.sha
  const to = r.post_update?.sha

  if (!from || !to || from === to) {
    return null
  }

  return { kind: 'post-update', from, to, source: path.basename(file) }
}

function listReceipts(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()
  } catch {
    return []
  }
}

export function createWatch(deps: WatchDeps): { close: () => void; poll: () => Promise<void> } {
  const watchFn = deps.watch ?? fs.watch
  const now = deps.now ?? (() => performance.now())
  const gitDir = runtimeGitDir(deps.runtimeDir)
  const seenReceipts = new Set(listReceipts(deps.receiptsDir))
  const emitted = new Set<string>()
  const entryKey = (e: { from: string; to: string; at: number }) => `${e.from}>${e.to}@${e.at}`
  let lastEntry = readReflog(deps.runtimeDir).at(-1) ?? null

  const watchers: fs.FSWatcher[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstEventAt: number | null = null
  let running = Promise.resolve()

  const emit = async (t: Transition, startedAt: number) => {
    // A receipt and the reflog line for the same move are one transition.
    if (emitted.has(`${t.from}>${t.to}`)) {
      return
    }

    emitted.add(`${t.from}>${t.to}`)
    const [v, health] = await Promise.all([deps.verdictFor(t), deps.healthCommit()])
    const stale: StaleCard | null = staleBackendCard(health, t.to)
    const cards = [...(stale ? [stale] : []), ...(v.cards ?? [])]
    const level = stale && v.level === 'GREEN' ? 'UNKNOWN' : v.level
    deps.onVerdict({ kind: t.kind, from: t.from, to: t.to, level, cards, ms: Math.round(now() - startedAt) })
  }

  const scan = async (startedAt: number) => {
    const transitions: Transition[] = []

    for (const file of listReceipts(deps.receiptsDir)) {
      if (seenReceipts.has(file)) {
        continue
      }

      seenReceipts.add(file)

      try {
        const t = receiptTransition(file, JSON.parse(fs.readFileSync(path.join(deps.receiptsDir, file), 'utf8')))

        if (t) {
          transitions.push(t)
        }
      } catch {
        // A receipt still being written is re-read on its next event.
        seenReceipts.delete(file)
      }
    }

    // Every reflog line after the last one seen is a door that moved; a rollback to an older sha counts too.
    const entries = readReflog(deps.runtimeDir)
    const last = lastEntry
    const lastIndex = last ? entries.findIndex(e => entryKey(e) === entryKey(last)) : -1
    const fresh = lastIndex >= 0 ? entries.slice(lastIndex + 1) : entries.filter(e => e.at >= (last?.at ?? 0))
    lastEntry = entries.at(-1) ?? last

    for (const e of fresh) {
      if (e.from !== e.to) {
        transitions.push({ kind: 'reflog', from: e.from, to: e.to, source: e.message })
      }
    }

    for (const t of transitions) {
      await emit(t, startedAt)
    }
  }

  const poll = () => {
    const startedAt = firstEventAt ?? now()
    firstEventAt = null
    running = running.then(() => scan(startedAt)).catch(() => undefined)

    return running
  }

  const onEvent = () => {
    firstEventAt ??= now()

    if (timer) {
      clearTimeout(timer)
    }

    timer = setTimeout(() => void poll(), deps.debounceMs ?? 120)
  }

  const interval = setInterval(() => void poll(), deps.pollMs ?? 1000)
  interval.unref?.()

  for (const dir of [deps.receiptsDir, gitDir, path.join(gitDir, 'logs')]) {
    try {
      watchers.push(watchFn(dir, { persistent: false }, onEvent))
    } catch {
      // A missing folder (no receipts yet) is not an error: the reflog still covers that door.
    }
  }

  return {
    poll,
    close: () => {
      clearInterval(interval)

      if (timer) {
        clearTimeout(timer)
      }

      watchers.forEach(w => w.close())
    }
  }
}
