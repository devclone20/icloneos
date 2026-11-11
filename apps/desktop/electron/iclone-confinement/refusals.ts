/**
 * V3-G R2 — Seatbelt refusals. A denial is not an exit code: the kernel reports it to the unified log as
 * `Sandbox: <proc>(<pid>) deny(1) <operation> <target>`. Measured on macOS 27.0.1: `log stream --style ndjson
 * --predicate 'sender == "Sandbox"'` delivers each one within about a second, and repeats of the same denial are
 * folded into "N duplicate report" lines, so a count of refusals is a lower bound.
 *
 * Every deny rule main generates carries `(with message …)` naming the class and the run's own token file (sbpl.ts),
 * which the kernel appends to the log line: that tag, not a pid lookup, says the denial is ours, which run it belongs
 * to and which members folder (which app instance) that run was made in, so a `cat` that is already gone is still
 * counted under its run. The log carries every app's sandbox: a denial with no tag, with a token from another members
 * folder (another instance of the app, a test world), or of the exact shape of the membership probe's own question (a
 * read of a file directly in the members folder; the probe asks without a report, so this only guards a kernel that
 * would report anyway) is dropped as it is parsed, before any `ps` fold.
 *
 * Who may write what this module trusts. The rest is appended to main's own record,
 * `userData/confinement/refusal-record/<UTC day>.jsonl` (0600), and, when attributed, to that run's own file under
 * `refusal-record/runs/`, the one source a run's count is read from while it runs and after it ends. That folder is
 * reached by no hole of the runtime profile (runtime-profile.ts USERDATA_HOLES): the runtime under it can neither
 * forge, inflate, erase nor re-attribute a kernel refusal or a run's count. The runtime does write one refusal folder,
 * `userData/confinement/refusals` (REFUSALS_DIR): the plugin's rows for hard links found after a run. That folder is
 * read as the runtime's own report and nothing more: only rows of that one shape, rebuilt field by field, never with a
 * run, at most REPORTED_MAX of any list, from the tail of each file.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { RefusalDayView, RefusalView } from '../../src/iclone-shared/confinement'
import { redactSecrets } from '../../src/iclone-shared/redact'

import { isRunToken, parseRunToken } from './members'
import { realOrSelf } from './profiles'

const DENY_RE = /^Sandbox: (.+?)\((\d+)\) deny\(\d+\) (\S+)(?: (.*))?$/
/** `iclone-confined:<class>:<members folder>/<run token>`; an older profile wrote the class alone. */
const TAG_RE = /^iclone-confined:([a-z]+)(?::(\/.+))?$/
const FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/

/** Main's own refusal record: written only by main, inside no hole of the runtime profile. */
export const refusalRecordDir = (userDataDir: string) => path.join(userDataDir, 'confinement', 'refusal-record')
/** The folder the plugin writes its hard-link rows to (REFUSALS_DIR, a write hole of the runtime profile). */
export const reportedRefusalsDir = (userDataDir: string) => path.join(userDataDir, 'confinement', 'refusals')
/** At most this many rows of any list come from the runtime's own reports, so they never push the kernel's out. */
export const REPORTED_MAX = 25
/** At most this much of the end of each runtime-written file is read: the runtime decides how large it grows. */
const REPORTED_TAIL_BYTES = 256 * 1024
/** The one row shape the plugin writes there (core.py `check_hardlinks_after_run`). */
const REPORTED_OPERATIONS: ReadonlySet<string> = new Set(['hard-link-appeared', 'cannot-scan-after-run'])

interface SandboxDenial {
  /** The activity class from our profile's tag; null = another sandbox's denial. */
  cls: string | null
  /** The run token file the tag names (absolute), or null when the tag carries none. */
  member: string | null
  process: string
  pid: number
  operation: string
  target: string
}

export function parseSandboxMessage(message: string): SandboxDenial | null {
  const [first = '', ...rest] = message.trim().split('\n')
  const match = DENY_RE.exec(first.trim())

  if (!match) {
    return null
  }

  const tag = rest.map(line => TAG_RE.exec(line.trim())).find(Boolean) ?? null

  return {
    cls: tag?.[1] ?? null,
    member: tag?.[2] ?? null,
    process: match[1],
    pid: Number(match[2]),
    operation: match[3],
    target: (match[4] ?? '').trim()
  }
}

/**
 * The membership probe's own question, by its exact shape: a `file-read-data` of a file directly in the members folder
 * (its marks, its decoy, a token). The probe asks without a report; were a kernel to report it anyway, it would read as
 * a refusal of the process asked about. Anything else aimed at the members folder (a write, a new file, a listing of
 * the folder) is a command reaching for the run tokens, and is kept.
 */
/**
 * fx19: `git` finishing an object: it tries link(tmp_obj, final), the profile refuses every hard link (`deny file-link`),
 * and git falls back to rename(), which the profile allows; a commit made one such line each, read as "1 REFUSED". Only
 * this exact shape: a git process, the file-link operation, its own temp object. If the rename also fails, that is a
 * file-write line, which still shows; so does any other refusal in `.git`.
 */
export const isGitObjectFallback = (denial: Pick<SandboxDenial, 'operation' | 'process' | 'target'>) =>
  denial.operation === 'file-link' &&
  denial.process === 'git' &&
  /\/\.git\/(?:modules\/.+\/)?objects\/(?:[0-9a-f]{2}\/)?tmp_obj_[^/]+$/.test(denial.target)

/** The programs whose own look at a folder is how a `cd` works: `$PWD`, `pwd -P` and the prompt's stat. */
const SHELLS: ReadonlySet<string> = new Set(['bash', 'dash', 'sh', 'zsh'])

const isFolderNow = (target: string): boolean => {
  try {
    return fs.lstatSync(target).isDirectory()
  } catch {
    return false
  }
}

const isFileNow = (target: string): boolean => {
  try {
    return !fs.lstatSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * proof4 F6: a shell's look at a folder: its metadata, or its listing, which a `cd` or a wildcard does. A mark that
 * words the row and groups it, never one that hides it (fx24): the pane lists and counts every refusal, wherever it
 * pointed. A shell's stat of a file, its read of a file, every write and every other program are never marked.
 */
export const isShellFolderProbe = (
  denial: Pick<SandboxDenial, 'operation' | 'process' | 'target'>,
  isFolder: (target: string) => boolean = isFolderNow,
  isFile: (target: string) => boolean = isFileNow
) =>
  SHELLS.has(denial.process) &&
  ((denial.operation === 'file-read-metadata' && !isFile(denial.target)) ||
    (denial.operation === 'file-read-data' && isFolder(denial.target)))

export const isProbeQuestion = (denial: Pick<SandboxDenial, 'operation' | 'target'>, membersDirs: readonly string[]) =>
  denial.operation === 'file-read-data' && membersDirs.includes(path.dirname(denial.target))

/**
 * The run a tagged denial belongs to, by the token file its tag names: the token's name when that file lies directly
 * in THIS instance's members folder (either spelling of it); null for a tag with no token, a token of another members
 * folder, or a name that is not a run token.
 */
export function runOfTag(member: string | null, membersDirs: readonly string[]): string | null {
  if (!member) {
    return null
  }

  const name = path.basename(member)

  return membersDirs.includes(path.dirname(member)) && isRunToken(name) ? name : null
}

/** `2026-10-21 10:14:10.235910+0100` (log's own format) → ISO 8601; anything else → now. */
export function logTimestamp(text: string, now: () => Date = () => new Date()): string {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2})(\d{2})$/.exec(text.trim())

  if (!match) {
    return now().toISOString()
  }

  const date = new Date(`${match[1]}T${match[2]}${(match[3] ?? '').slice(0, 4)}${match[4]}:${match[5]}`)

  return Number.isNaN(date.getTime()) ? now().toISOString() : date.toISOString()
}

/** A run's own file stops growing here: its count is a number the pane shows, never an accumulator. */
export const RUN_REFUSALS_MAX = 10_000
/** A run's file is removed this long after its last refusal (the ledger has long rotated the run away). */
const RUN_FILE_KEEP_MS = 7 * 86_400_000

/** Newline count of a file, 0 when it does not exist. */
function lineCount(file: string): number {
  let fd: number | null = null

  try {
    fd = fs.openSync(file, 'r')

    const buffer = Buffer.alloc(64 * 1024)
    let count = 0
    let read = 0

    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      for (let index = 0; index < read; index += 1) {
        if (buffer[index] === 0x0a) {
          count += 1
        }
      }
    }

    return count
  } catch {
    return 0
  } finally {
    if (fd !== null) {
      fs.closeSync(fd)
    }
  }
}

/** The lines wholly inside the last `tailBytes` bytes of `file`. */
function fileLines(file: string, tailBytes: number): string[] {
  const fd = fs.openSync(file, 'r')

  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - tailBytes)
    const buffer = Buffer.alloc(size - start)

    fs.readSync(fd, buffer, 0, buffer.length, start)

    const lines = buffer.toString('utf8').split('\n')

    // A window that starts mid-line drops that first, partial line.
    return (start > 0 ? lines.slice(1) : lines).filter(Boolean)
  } finally {
    fs.closeSync(fd)
  }
}

/** The newest `limit` rows `parse` accepts from the day files of `dir` (each read from its last `tailBytes`). */
function newestRows(
  dir: string,
  limit: number,
  parse: (raw: unknown) => RefusalView | null,
  tailBytes: number
): RefusalView[] {
  const out: RefusalView[] = []
  let files: string[] = []

  try {
    files = fs
      .readdirSync(dir)
      .filter(name => FILE_RE.test(name))
      .sort()
  } catch {
    return out
  }

  for (let f = files.length - 1; f >= 0 && out.length < limit; f -= 1) {
    let lines: string[] = []

    try {
      lines = fileLines(path.join(dir, files[f]), tailBytes)
    } catch {
      continue
    }

    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      try {
        const row = parse(JSON.parse(lines[i]))

        if (row) {
          out.push(row)
        }
      } catch {
        // a torn last line is skipped
      }
    }
  }

  return out
}

const text = (value: unknown, max: number): string | null => (typeof value === 'string' ? value.slice(0, max) : null)

/**
 * A row of the runtime's own report folder, rebuilt from the one shape the plugin writes there (a hard link found
 * after a run): anything else in that folder, a kernel-looking row included, is not a row. It never names a run, so it
 * never reaches a run's count; its words are clipped.
 */
export function reportedRow(raw: unknown): RefusalView | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }

  const row = raw as Record<string, unknown>
  const ts = text(row.ts, 40)
  const target = text(row.target, 1_000)
  const root = text(row.root, 1_000)

  const sessionId =
    row.sessionId === null || row.sessionId === undefined
      ? null
      : typeof row.sessionId === 'string'
        ? row.sessionId.slice(0, 64)
        : undefined

  if (
    row.process !== 'hard-link' ||
    typeof row.operation !== 'string' ||
    !REPORTED_OPERATIONS.has(row.operation) ||
    !ts ||
    Number.isNaN(Date.parse(ts)) ||
    !Number.isSafeInteger(row.pid) ||
    target === null ||
    sessionId === undefined
  ) {
    return null
  }

  return {
    ts,
    pid: row.pid as number,
    process: 'hard-link',
    operation: row.operation,
    target: redactSecrets(target),
    sessionId,
    ...(root ? { root } : {}),
    run: null
  }
}

/** Main's own rows are its own writing: read back as written. */
const ownRow = (raw: unknown): RefusalView | null =>
  typeof raw === 'object' && raw !== null ? (raw as RefusalView) : null

/**
 * L4-02: a day's file is closed past this size and renamed to its next part, `<day>.<n>.jsonl` (n = 1, 2, …; the
 * higher, the newer), so no single file outgrows what can be read; every row stays on disk and in the day's count.
 */
export const DAY_FILE_MAX_BYTES = 50 * 1024 * 1024
/** The newest rows main keeps in memory for the pane (≥ the window index.ts explains); the state never reads a file. */
export const RECENT_KEPT = 1_000
/** At start, at most this much of the end of each of the newest files is read to fill RECENT_KEPT (a row is at most
 *  about 1.5 KB: its target is clipped to 1 000 characters). */
const OWN_TAIL_BYTES = 4 * 1024 * 1024
/** At start, the newest files are opened until they hold OWN_TAIL_BYTES between them (enough to fill RECENT_KEPT),
 *  and never more than this many. */
const OWN_TAIL_FILES_MAX = 128
const COUNT_CHUNK_BYTES = 1024 * 1024
const PART_RE = /^(\d{4}-\d{2}-\d{2})\.(\d+)\.jsonl$/

/** One file's rows: those it held when main first looked (counted off the main thread) and those main added since. */
interface FileRows {
  found: number | null
  added: number
}

/** A file opened at start: the open descriptor survives a rename, and `size` bounds the read to what was there then. */
interface Snapshot {
  fd: number
  size: number
}

const readAt = (fd: number, buffer: Buffer, length: number, position: number): Promise<number> =>
  new Promise((resolve, reject) => {
    fs.read(fd, buffer, 0, length, position, (error, bytes) => (error ? reject(error) : resolve(bytes)))
  })

const yieldToLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** Newlines in the first `size` bytes of an open file, read in chunks so the main thread never waits on the disk. */
async function countLines({ fd, size }: Snapshot): Promise<number> {
  const buffer = Buffer.alloc(Math.min(COUNT_CHUNK_BYTES, Math.max(1, size)))
  let count = 0

  for (let position = 0; position < size; ) {
    const bytes = await readAt(fd, buffer, Math.min(buffer.length, size - position), position)

    if (bytes <= 0) {
      break
    }

    for (let at = buffer.indexOf(0x0a, 0); at !== -1 && at < bytes; at = buffer.indexOf(0x0a, at + 1)) {
      count += 1
    }

    position += bytes
  }

  return count
}

/** The rows wholly inside the last `tailBytes` of the first `size` bytes of an open file, oldest first. */
async function tailRows({ fd, size }: Snapshot, tailBytes: number): Promise<{ rows: RefusalView[]; whole: boolean }> {
  const start = Math.max(0, size - tailBytes)
  const buffer = Buffer.alloc(size - start)
  let read = 0

  while (read < buffer.length) {
    const bytes = await readAt(fd, buffer, buffer.length - read, start + read)

    if (bytes <= 0) {
      break
    }

    read += bytes
  }

  const lines = buffer.subarray(0, read).toString('utf8').split('\n')
  const rows: RefusalView[] = []

  // A window that starts mid-line drops that first, partial line; a torn last line is skipped.
  for (const line of start > 0 ? lines.slice(1) : lines) {
    if (line) {
      try {
        const row = ownRow(JSON.parse(line))

        if (row) {
          rows.push(row)
        }
      } catch {
        // torn
      }
    }
  }

  return { rows, whole: start === 0 }
}

const utcDay = (date: Date) => date.toISOString().slice(0, 10)

interface RefusalLogOptions {
  /** Test seam: the size past which a day's file is closed into a part. */
  dayFileMaxBytes?: number
  now?: () => Date
}

/**
 * The refusal record main keeps in `dir` (refusalRecordDir: its own, outside every runtime hole), and, when
 * `reportedDir` is given, the runtime's own report folder read beside it (reportedRow, REPORTED_MAX).
 *
 * L4-02: the pane's list comes from memory (the newest RECENT_KEPT rows, fed by `append` and, once at start, by an
 * asynchronous read of the tails of the newest files); the day's count from counters kept by `append` over a count
 * made once, off the main thread, of what the files held at start. No call the pane makes reads a whole file.
 */
export function createRefusalLog(dir: string, reportedDir: string | null = null, options: RefusalLogOptions = {}) {
  const runsDir = path.join(dir, 'runs')
  const dayFileMax = options.dayFileMaxBytes ?? DAY_FILE_MAX_BYTES
  const now = options.now ?? (() => new Date())

  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 })

  // Rows per run file, read from the file the first time a run is asked about and kept current by this process's
  // own appends (it is the only writer): the cap costs one count per run, not one per refusal.
  const runRows = new Map<string, number>()
  const runFile = (run: string) => path.join(runsDir, `${run}.jsonl`)

  const rowsOf = (run: string): number => {
    const known = runRows.get(run)

    if (known !== undefined) {
      return known
    }

    const counted = lineCount(runFile(run))

    runRows.set(run, counted)

    return counted
  }

  // Oldest first; trimmed back to RECENT_KEPT once it holds twice that, so a push stays O(1) amortised.
  let recentRows: RefusalView[] = []

  const keep = (row: RefusalView) => {
    recentRows.push(row)

    if (recentRows.length >= RECENT_KEPT * 2) {
      recentRows = recentRows.slice(-RECENT_KEPT)
    }
  }

  // Bytes of each day file this process writes to: one stat the first time, then its own appends.
  const sizes = new Map<string, number>()

  const sizeOf = (file: string): number => {
    let size = sizes.get(file)

    if (size === undefined) {
      try {
        size = fs.statSync(file).size
      } catch {
        size = 0
      }

      sizes.set(file, size)
    }

    return size
  }

  const ownNames = (): string[] => {
    try {
      return fs.readdirSync(dir)
    } catch {
      return []
    }
  }

  /** Closed parts of `day`, oldest first. */
  const partsOf = (day: string, names = ownNames()): { name: string; n: number }[] =>
    names
      .map(name => PART_RE.exec(name))
      .filter((match): match is RegExpExecArray => match !== null && match[1] === day)
      .map(match => ({ name: match[0], n: Number(match[2]) }))
      .sort((a, b) => a.n - b.n)

  const open = (file: string): Snapshot | null => {
    try {
      const fd = fs.openSync(file, 'r')

      return { fd, size: fs.fstatSync(fd).size }
    } catch {
      return null
    }
  }

  const close = (snapshot: Snapshot) => {
    try {
      fs.closeSync(snapshot.fd)
    } catch {
      // closed
    }
  }

  // The day the count is kept for (UTC today when main last asked): its live file and its closed parts, in order.
  let today: { day: string; live: FileRows; parts: FileRows[] } = { day: '', live: { found: 0, added: 0 }, parts: [] }
  const pending: Promise<void>[] = []

  /** Starts counting `day`: each file is opened now (so a later append or rename cannot be counted twice or lost) and
   *  its rows are counted in the background. */
  const trackDay = (day: string) => {
    if (today.day === day) {
      return
    }

    const track = (name: string): { rows: FileRows; snapshot: Snapshot | null } => {
      const snapshot = open(path.join(dir, name))

      return { rows: { found: snapshot ? null : 0, added: 0 }, snapshot }
    }

    const parts = partsOf(day).map(part => track(part.name))
    const live = track(`${day}.jsonl`)

    today = { day, live: live.rows, parts: parts.map(entry => entry.rows) }
    pending.push(
      (async () => {
        for (const entry of [...parts, live]) {
          if (entry.snapshot) {
            try {
              entry.rows.found = await countLines(entry.snapshot)
            } catch {
              entry.rows.found = null
            } finally {
              close(entry.snapshot)
            }

            await yieldToLoop()
          }
        }
      })()
    )
  }

  /** Once at start: the newest rows on disk, read from the tails of the newest files, placed before any row appended
   *  since (those are newer). Each file is opened before the first append can land, and read only up to its size then. */
  const loadRecent = () => {
    const order = (name: string): string | null => {
      if (FILE_RE.test(name)) {
        return `${name.slice(0, 10)}~`
      }

      const part = PART_RE.exec(name)

      return part ? `${part[1]}.${part[2].padStart(9, '0')}` : null
    }

    const names = ownNames()
      .map(name => ({ name, key: order(name) }))
      .filter((entry): entry is { name: string; key: string } => entry.key !== null)
      .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))

    const newest: (Snapshot | null)[] = []
    let held = 0

    for (const entry of names) {
      if (held >= OWN_TAIL_BYTES || newest.length >= OWN_TAIL_FILES_MAX) {
        break
      }

      const snapshot = open(path.join(dir, entry.name))

      newest.push(snapshot)
      held += snapshot?.size ?? 0
    }

    pending.push(
      (async () => {
        const older: RefusalView[] = []

        try {
          for (const snapshot of newest) {
            if (!snapshot || older.length + recentRows.length >= RECENT_KEPT) {
              continue
            }

            const { rows, whole } = await tailRows(snapshot, OWN_TAIL_BYTES)

            older.unshift(...rows.slice(-(RECENT_KEPT - older.length - recentRows.length)))

            // A file read only in part leaves a gap before its tail: nothing older may follow it into the list.
            if (!whole) {
              break
            }

            await yieldToLoop()
          }
        } finally {
          for (const snapshot of newest) {
            if (snapshot) {
              close(snapshot)
            }
          }
        }

        recentRows = [...older, ...recentRows].slice(-RECENT_KEPT * 2 + 1)
      })()
    )
  }

  /** Closes `file` (a day's live file) into the day's next part. */
  const closeIntoPart = (file: string, day: string) => {
    const parts = partsOf(day)
    const next = (parts.at(-1)?.n ?? 0) + 1

    fs.renameSync(file, path.join(dir, `${day}.${next}.jsonl`))
    sizes.set(file, 0)

    if (today.day === day) {
      today.parts.push(today.live)
      today.live = { found: 0, added: 0 }
    }
  }

  loadRecent()
  trackDay(utcDay(now()))

  const ready = Promise.all(pending.slice()).then(() => undefined)

  return {
    /** Settles once the start-up reads (the newest rows, today's count) are done. */
    ready,
    append(refusal: RefusalView): void {
      this.appendAll([refusal])
    },
    /**
     * A batch of refusals, in order: one write per file it touches (a day file closes into a part between two rows,
     * never inside one), each row kept in memory for the pane and counted under its day.
     */
    appendAll(refusals: readonly RefusalView[]): void {
      let file: string | null = null
      let text = ''
      const runText = new Map<string, string>()

      const write = () => {
        if (file !== null && text) {
          fs.appendFileSync(file, text, { mode: 0o600 })
          sizes.set(file, sizeOf(file) + Buffer.byteLength(text))
        }

        text = ''
      }

      for (const refusal of refusals) {
        const day = refusal.ts.slice(0, 10)
        const dayFile = path.join(dir, `${day}.jsonl`)
        const target = redactSecrets(refusal.target).slice(0, 1_000)
        const row = { ...refusal, target }
        const line = `${JSON.stringify(row)}\n`

        if (dayFile !== file) {
          write()
          file = dayFile
        }

        const size = sizeOf(dayFile) + Buffer.byteLength(text)

        if (size > 0 && size + Buffer.byteLength(line) > dayFileMax) {
          write()
          closeIntoPart(dayFile, day)
        }

        text += line
        keep(row)

        if (today.day === day) {
          today.live.added += 1
        }

        // The run's own record: the same row, under the run token the kernel named. Running or ended, the count is
        // the lines of this file.
        if (isRunToken(refusal.run) && rowsOf(refusal.run) < RUN_REFUSALS_MAX) {
          runText.set(refusal.run, (runText.get(refusal.run) ?? '') + line)
          runRows.set(refusal.run, rowsOf(refusal.run) + 1)
        }
      }

      write()

      for (const [run, lines] of runText) {
        fs.appendFileSync(runFile(run), lines, { mode: 0o600 })
      }
    },
    /** Today's (UTC) own record: its exact count, and how much of it sits in closed parts the list does not reach. */
    day(): RefusalDayView {
      trackDay(utcDay(now()))

      const total = (rows: FileRows[]) =>
        rows.some(entry => entry.found === null)
          ? null
          : rows.reduce((sum, entry) => sum + (entry.found ?? 0) + entry.added, 0)

      return {
        day: today.day,
        rows: total([...today.parts, today.live]),
        olderRows: total(today.parts),
        parts: today.parts.length
      }
    },
    /** Kernel refusals attributed to `run`, from its own file (capped at RUN_REFUSALS_MAX). */
    runCount(run: string): number {
      return isRunToken(run) ? Math.min(rowsOf(run), RUN_REFUSALS_MAX) : 0
    },
    /** The counts of several runs at once, only for the runs that have any. */
    runCounts(runs: Iterable<string>): Map<string, number> {
      const out = new Map<string, number>()

      for (const run of runs) {
        const count = this.runCount(run)

        if (count > 0) {
          out.set(run, count)
        }
      }

      return out
    },
    /**
     * Removes run files untouched for RUN_FILE_KEEP_MS, except those of `keep`: the runs still alive and the runs the
     * ledger still shows, whose count must not drop to 0 because they went a week without a refusal.
     */
    sweepRuns(nowMs: number, keepRuns: Iterable<string>): number {
      const kept = new Set(keepRuns)
      let removed = 0
      let names: string[] = []

      try {
        names = fs.readdirSync(runsDir)
      } catch {
        return 0
      }

      for (const name of names) {
        const run = name.replace(/\.jsonl$/, '')
        const file = path.join(runsDir, name)

        if (kept.has(run)) {
          continue
        }

        try {
          if (nowMs - fs.statSync(file).mtimeMs > RUN_FILE_KEEP_MS) {
            fs.unlinkSync(file)
            runRows.delete(run)
            removed += 1
          }
        } catch {
          // gone already
        }
      }

      return removed
    },
    /**
     * The newest `limit` refusals, newest first: main's own (from memory, at most RECENT_KEPT), and at most
     * REPORTED_MAX of the runtime's reports (the runtime decides how many of those there are and what time they say,
     * so they get a share, never the list).
     */
    recent(limit = 100): RefusalView[] {
      const reported = reportedDir
        ? newestRows(reportedDir, Math.min(REPORTED_MAX, limit), reportedRow, REPORTED_TAIL_BYTES)
        : []

      const ownCount = Math.max(0, Math.min(limit - reported.length, RECENT_KEPT))
      const own = ownCount > 0 ? recentRows.slice(-ownCount).reverse() : []

      return [...own, ...reported].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    },
    dir
  }
}

/**
 * At most one call of `send` per `everyMs`, the last one trailing: a burst of refusal batches reaches the windows as
 * one change notice per interval, never one per row, and the newest change is always announced.
 */
export function createNoticeThrottle(send: () => void, everyMs = 250, clock: () => number = Date.now) {
  let last = Number.NEGATIVE_INFINITY
  let timer: NodeJS.Timeout | null = null

  const fire = () => {
    timer = null
    last = clock()
    send()
  }

  return {
    notify(): void {
      if (timer) {
        return
      }

      const wait = last + everyMs - clock()

      if (wait <= 0) {
        fire()
      } else {
        timer = setTimeout(fire, wait)
      }
    },
    stop(): void {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}

type RefusalLog = ReturnType<typeof createRefusalLog>

/** Where a confined pid belongs right now: its session, and the run the kernel holds it in (members.ts token). */
export interface ConfinedAt {
  sessionId: string | null
  run: string | null
}

interface StreamDeps {
  log: RefusalLog
  /** This instance's members folder (members.ts): a tag naming a token elsewhere is another instance's; a read of a
   *  file directly in it is the membership probe's question (isProbeQuestion). Both spellings are matched when the
   *  real path differs. */
  membersDir: string
  /** Session and run of each pid confined right now (a fresh `ps` fold per batch); a pid already gone keeps neither. */
  confined: () => Promise<Map<number, ConfinedAt>>
  onRefusal?: (refusal: RefusalView) => void
  /** Once per flushed batch, after every row of it is recorded (the change notice belongs here, not per row). */
  onBatch?: (refusals: readonly RefusalView[]) => void
  /** K97: the stream starts when a confined run starts, so the kernel may have refused something in the moment before
   *  it connected. That many seconds of the log are read once (`log show --last`), and a denial read twice counts
   *  once. 0 or absent: no look-back. */
  backfillSeconds?: number
  /** Test seams. */
  spawnLog?: () => ChildProcess
  spawnShow?: (seconds: number) => ChildProcess
}

const BATCH_MS = 100
const PREDICATE = 'sender == "Sandbox"'
/** A denial seen by both the look-back and the stream is folded while this many keys are remembered. */
const DEDUP_MAX = 2_000
const DEDUP_FOR_MS = 30_000

export function startRefusalStream(deps: StreamDeps): { stop: () => void } {
  const children: ChildProcess[] = []
  let pending: { ts: string; denial: SandboxDenial; run: string; look: boolean }[] = []
  let timer: NodeJS.Timeout | null = null
  let seen: Set<string> | null = null
  let forget: NodeJS.Timeout | null = null

  const membersDirs = [...new Set([deps.membersDir, realOrSelf(deps.membersDir)])]

  const flush = async () => {
    timer = null

    const batch = pending

    pending = []

    // Only this instance's denials reach the batch, so an empty one means nothing of ours: no `ps` fold.
    if (batch.length === 0) {
      return
    }

    const confined = await deps.confined().catch(() => new Map<number, ConfinedAt>())

    // The run comes from the kernel's line; the live fold only adds the session of a process still there, and the
    // token names the session of one that is gone.
    const refusals = batch.map(({ ts, denial, run, look }): RefusalView => {
      const at = confined.get(denial.pid)

      return {
        ts,
        pid: denial.pid,
        process: denial.process,
        operation: denial.operation,
        target: denial.target,
        sessionId: at?.sessionId ?? parseRunToken(run)?.sessionId ?? null,
        run,
        ...(look ? { shellLook: true } : {})
      }
    })

    // L4-02: one write per file for the whole batch, then one notice for it.
    deps.log.appendAll(refusals)

    for (const refusal of refusals) {
      deps.onRefusal?.(refusal)
    }

    deps.onBatch?.(refusals)
  }

  const take = (line: string) => {
    if (!line.startsWith('{')) {
      return
    }

    let event: { eventMessage?: unknown; timestamp?: unknown }

    try {
      event = JSON.parse(line) as typeof event
    } catch {
      return // not an event line
    }

    const denial = typeof event.eventMessage === 'string' ? parseSandboxMessage(event.eventMessage) : null

    // Another sandbox's denial is dropped here, before it can schedule a batch or a `ps` fold. So is a denial
    // of ours whose token lies in another members folder (another instance of this app on this Mac), and one of the
    // membership probe's own shape (isProbeQuestion).
    const run = denial?.cls ? runOfTag(denial.member, membersDirs) : null

    if (!denial || run === null || isProbeQuestion(denial, membersDirs) || isGitObjectFallback(denial)) {
      return
    }

    if (seen) {
      const key = `${String(event.timestamp ?? '')}\0${String(event.eventMessage)}`

      if (seen.has(key)) {
        return
      }

      if (seen.size < DEDUP_MAX) {
        seen.add(key)
      }
    }

    pending.push({ ts: logTimestamp(String(event.timestamp ?? '')), denial, run, look: isShellFolderProbe(denial) })

    if (!timer) {
      timer = setTimeout(() => void flush(), BATCH_MS)
    }
  }

  const read = (child: ChildProcess) => {
    let buffer = ''

    children.push(child)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk

      const lines = buffer.split('\n')

      buffer = lines.pop() ?? ''
      lines.forEach(take)
    })
    child.stdout?.on('end', () => {
      if (buffer) {
        take(buffer)
        buffer = ''
      }
    })
  }

  const backfill = Math.max(0, Math.floor(deps.backfillSeconds ?? 0))

  if (backfill > 0) {
    seen = new Set()
    forget = setTimeout(() => {
      seen = null
    }, DEDUP_FOR_MS)
    forget.unref?.()
  }

  read(
    deps.spawnLog?.() ??
      spawn('/usr/bin/log', ['stream', '--style', 'ndjson', '--predicate', PREDICATE], {
        stdio: ['ignore', 'pipe', 'ignore']
      })
  )

  if (backfill > 0) {
    read(
      deps.spawnShow?.(backfill) ??
        spawn('/usr/bin/log', ['show', '--style', 'ndjson', '--last', `${backfill}s`, '--predicate', PREDICATE], {
          stdio: ['ignore', 'pipe', 'ignore']
        })
    )
  }

  return {
    stop() {
      if (timer) {
        clearTimeout(timer)
      }

      if (forget) {
        clearTimeout(forget)
      }

      for (const child of children) {
        child.kill('SIGTERM')
      }
    }
  }
}
