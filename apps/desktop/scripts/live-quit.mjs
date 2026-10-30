// V3-RT live harness, quit step: quitting the app is not enough. A runtime or backend process an earlier launch left
// behind (a backend the app did not reap, a pool member, a helper run from the bundle) keeps the runtime folder busy and
// answers the next launch's probes, so the next live run measures the wrong process. After the app quits, this stops
// every process whose EXECUTABLE lives inside one of the given roots (the app bundle, the app's own runtime folder), and
// only those: identity is the kernel's executable path, never a name or argv (a stage run by /bin/bash is the shell's,
// outside the roots; its runtime children are caught). Fail closed (ruling 58), on Linux and macOS alike: a process of
// this user whose executable cannot be read (macOS: in `ps` but not in lsof's text files), a process table that cannot
// be read, or a process that survives SIGKILL is reported and the step exits non-zero.
//
// `holding` (review r2 R2-M13, completed by review r3 R3-M3): a process whose executable is OUTSIDE every root is
// reported, the step exits non-zero, and it is NEVER signalled (it may be the user's own shell or editor), when the
// final scan finds either of two things inside a root:
//   - a path it holds: its working folder, an open file, a path-named socket (macOS: lsof; Linux: /proc cwd + fd);
//   - a path its environment names as the program it was launched as: `__PYVENV_LAUNCHER__` (set by the python.org
//     framework's launcher for a venv's `bin/python`), `VIRTUAL_ENV`, or `_` (the command a shell ran). This is the
//     R2-M13 case itself: a venv inside the runtime folder whose base interpreter is the framework's has the image
//     .../Python.app/Contents/MacOS/Python, and with its working folder elsewhere it holds nothing inside the root.
// What is still NOT seen (declared, not hidden): a process outside the roots that neither holds a path inside one nor
// names one in those variables. On Linux: a venv's python (its /proc exe is the base interpreter) started without a
// shell and with its working folder elsewhere. On macOS, the same case whenever the venv's base interpreter is NOT
// python.org's framework (a standalone CPython: uv's, python-build-standalone, Homebrew's): only the framework's
// launcher sets `__PYVENV_LAUNCHER__`, so a venv inside a root on a base interpreter OUTSIDE every root, started
// without a shell (no `_`) and with its working folder elsewhere, gives `holding []` and exit 0 while it runs
// (measured, review r4 R4-01). Also on macOS: a process whose environment `ps` will not show (Apple's platform
// binaries, such as /bin/sleep). Such a process's argv[0] does name the venv, but argv is never identity (HX003). The
// environment is a claim the process makes about itself, so it only ever adds to `holding` (a report), never to what
// is signalled: identity for a signal stays the kernel's executable path.
// Where the shipped runtime stands: the BACKEND is not that case. The packaged app installs its pinned
// python-build-standalone CPython INSIDE its runtime folder (`<userData>/hermes-runtime/<pin sha>/.iclone-deps/hermes/
// tools/python-*`, the private home of electron/main/env.ts RUNTIME_DEPS_HOME) and the app environment's venv beside
// it, so a backend's image is inside the `<userData>/hermes-runtime` root and it is found and stopped by its executable.
// The pm-runtime venv IS that case on some machines (review r5 A5-1): pm/runtime.py builds it on `Path(sys.executable)`,
// the host Python that bootstrapped PM, not the pinned CPython, so its `bin/python` points OUTSIDE every root (on the
// review's install: `.iclone-deps/hermes/installs/*/pm-runtime/generations/*/bin/python ->
// /Library/Frameworks/Python.framework/.../python3.14`). On a host whose Python is python.org's framework a PM worker
// is `holding` (reported, exit 1, the quit is RED, never silent); on a host whose Python is a standalone CPython
// (Homebrew's, uv's) a PM worker started without a shell and with its working folder elsewhere is the declared gap.
// Whether a PM worker is still alive when the quit runs was not measured. live-quit.launched.test.mjs measures the two
// layouts: a standalone base interpreter inside the root (found, stopped) and outside it (the declared gap).
// Correction (2026-10-27, review r4 R4-01, ruling 60): this header as written in 5bfcf6689b named only "Apple's
// platform binaries" as the macOS gap, and 5bfcf6689b and FIX_R3 R3-M3 said "the venv is identifiable" for macOS in
// general. That holds only for a venv whose base interpreter is the python.org framework.
//
// Roots that are not existing absolute directories, `/`, or the home folder or one of its parents are refused before
// anything is signalled, and so is any command line argument other than the two below (a typo must not silently clear
// nothing).
//
//   node scripts/live-quit.mjs --root <dir> [--root <dir> ...] [--grace-ms 3000]
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { isMain } from './utils.mjs'

export const DEFAULT_GRACE_MS = 3000

/** True when `file` is `root` or inside it (path containment, not a string prefix). */
export function isInside(file, root) {
  const rel = relative(root, file)

  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The path with every symbolic link resolved. A path that no longer exists (the executable of a process whose image
 * was unlinked while it runs, e.g. an old backend after an upgrade re-created the runtime folder) still resolves
 * through its longest EXISTING ancestor, so it is compared on the same footing as a root: on macOS the temp folder and
 * `/var` are symbolic links (`/var/folders/x` -> `/private/var/folders/x`) and lsof prints the resolved image path, so
 * resolving only one of the two sides would put a real leftover outside every root and the step would pass with it
 * still running.
 */
export const canonical = dir => {
  const full = resolve(dir)
  let head = full
  const tail = []

  for (;;) {
    try {
      return join(realpathSync(head), ...tail)
    } catch {
      const parent = dirname(head)

      if (parent === head) {
        return full
      }

      tail.unshift(basename(head))
      head = parent
    }
  }
}

/**
 * How two paths are compared for containment on `platform`: macOS volumes are case-insensitive by default (APFS,
 * HFS+), so a root given as `/Applications/ICLONE OS.app` exists and names the bundle lsof prints as
 * `/Applications/iClone OS.app`; realpath keeps the caller's casing, so comparing as-is would miss every helper inside
 * it. Linux file systems are case-sensitive: there a different casing is a different path.
 */
const caseFold = platform => (platform === 'darwin' ? path => path.toLowerCase() : path => path)

/**
 * `lsof -F pfn` output for `-d txt`: per process a `p<pid>` line, then its text files (`f` + `n` lines). The first
 * text file lsof lists for a process is its executable image (macOS lists `txt` in mapping order, the executable
 * first). Rows without one (lsof could not read it) come back with `exe: null`.
 */
export function parseLsofText(out) {
  const rows = []
  let row = null

  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      row = { pid: Number(line.slice(1)), exe: null }
      rows.push(row)
    } else if (line.startsWith('n') && row && row.exe === null) {
      row.exe = line.slice(1)
    }
  }

  return rows
}

/**
 * `lsof -F pn` output over every descriptor: per process (`p<pid>`) the absolute paths it holds (`n/…`): its working
 * folder, text files, open files and path-named sockets. Names lsof marks `(deleted)` keep their old path.
 */
export function parseLsofFiles(out) {
  const files = new Map()
  let pid = null

  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1))
      files.set(pid, [])
    } else if (line.startsWith('n/') && pid !== null) {
      files.get(pid).push(line.slice(1).replace(/ \(deleted\)$/, ''))
    }
  }

  return files
}

/** The environment variables whose value names the program a process was launched as (R3-M3). */
export const LAUNCH_VARS = ['__PYVENV_LAUNCHER__', 'VIRTUAL_ENV', '_']

/** The absolute paths `LAUNCH_VARS` name in a list of `NAME=value` entries (Linux: /proc/<pid>/environ). */
export function launchPaths(entries) {
  return entries.flatMap(entry => {
    const eq = entry.indexOf('=')
    const value = entry.slice(eq + 1)

    return eq > 0 && LAUNCH_VARS.includes(entry.slice(0, eq)) && isAbsolute(value) ? [value] : []
  })
}

/**
 * `ps -axwwE -o pid=,command=` output (macOS; `-E` adds the environment, while `-e` would only mean every process):
 * per line a pid, the command line, then the environment as `NAME=value` words. A value runs up to the next ` NAME=`
 * word, so a path with spaces (`Application Support`) stays whole. Words in argv that look like `VIRTUAL_ENV=/x` are
 * read too: that can only add a report, never a signal.
 */
export function parsePsEnvironment(out) {
  const paths = new Map()
  const names = LAUNCH_VARS.join('|')

  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line)

    if (match) {
      const found = [...match[2].matchAll(new RegExp(`(?:^| )(${names})=(.*?)(?= [A-Za-z_][A-Za-z0-9_]*=|$)`, 'g'))]

      paths.set(Number(match[1]), launchPaths(found.map(([, name, value]) => `${name}=${value}`)))
    }
  }

  return paths
}

/** Linux: the launch paths of a process's environment (R3-M3), as far as /proc shows them. */
function launchPathsLinux(pid) {
  try {
    return launchPaths(readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0'))
  } catch {
    return []
  }
}

/** Linux: the absolute paths a process holds (its working folder and every descriptor), as far as /proc shows them. */
function openFilesLinux(pid) {
  const links = ['cwd']

  try {
    links.push(...readdirSync(`/proc/${pid}/fd`).map(fd => `fd/${fd}`))
  } catch {
    // Gone, or not ours to read: nothing it holds is known.
  }

  return links.flatMap(link => {
    try {
      const target = readlinkSync(`/proc/${pid}/${link}`).replace(/ \(deleted\)$/, '')

      return isAbsolute(target) ? [target] : []
    } catch {
      return []
    }
  })
}

function listLinux(withFiles) {
  const uid = process.getuid()
  const rows = []

  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) {
      continue
    }

    let owner

    try {
      owner = statSync(`/proc/${name}`).uid

      // Only this user's processes, as on macOS (lsof -u): another user's process is never ours to stop.
      if (owner === uid) {
        const exe = readlinkSync(`/proc/${name}/exe`).replace(/ \(deleted\)$/, '')

        rows.push(
          withFiles
            ? { pid: Number(name), exe, files: openFilesLinux(name), launched: launchPathsLinux(name) }
            : { pid: Number(name), exe }
        )
      }
    } catch (error) {
      // Gone (ENOENT), a kernel thread or a zombie (no exe), or another user's process (EACCES): none can be a
      // process this user's launch left. One of OUR processes we cannot read is unknown, so it fails closed.
      if (owner === uid && error.code !== 'ENOENT') {
        rows.push({ pid: Number(name), exe: null })
      }
    }
  }

  return rows
}

/**
 * macOS: this user's pids from `ps -axo pid=,uid=,stat=`, each with its executable from lsof's text files. A pid of
 * this user that lsof did not list (it could not read it) and that is still alive comes back with `exe: null`
 * (unknown). A zombie (stat `Z…`) is dropped first: it keeps its uid and still answers kill(pid, 0), but nothing runs
 * and it has no text files, so lsof never lists it; it is not a leftover and cannot be stopped (only its parent can
 * reap it), so reporting it unknown would make the step RED forever. Linux drops zombies the same way (no exe link).
 */
export function mergeDarwin(psOut, lsofOut, uid, alive) {
  const exe = new Map(parseLsofText(lsofOut).map(row => [row.pid, row.exe]))

  return psOut
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)

      // Strict (ruling 58): a ps line that is not "<pid> <uid> <stat>" means the table was not understood.
      if (!match) {
        throw new Error(`ps printed a line that is not "<pid> <uid> <stat>": ${JSON.stringify(line.slice(0, 80))}`)
      }

      return match
    })
    .filter(match => Number(match[2]) === uid && !match[3].startsWith('Z'))
    .map(match => Number(match[1]))
    .filter(pid => exe.get(pid) || alive(pid))
    .map(pid => ({ pid, exe: exe.get(pid) ?? null }))
}

/**
 * macOS: whether `pid`, listed by `ps` but not by lsof, still RUNS. `kill(pid, 0)` alone is not that: a process that
 * exits between the `ps` and the lsof and is not yet reaped by its parent is a zombie, and a zombie answers kill(pid, 0).
 * Counted as unknown, it turned the step RED with "(executable unreadable)" on any busy machine (FIX_CRITICOS pass 2:
 * 16 of 30 runs under process churn, 0 of 30 without; the gate's full electron suite failed on it). A zombie runs nothing
 * and holds nothing, and a pid that is gone is gone: neither is unknown. A process that runs and cannot be read stays
 * unknown, and a `ps` that cannot answer keeps it unknown too (fail closed).
 */
export function stillRunning(pid) {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error.code !== 'EPERM') {
      return false
    }
  }

  const st = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })

  if (st.error) {
    return true
  }

  const stat = st.stdout.trim()

  // `ps -p` prints nothing (exit 1) for a pid that no longer exists.
  if (!stat) {
    return st.status === 0
  }

  return !stat.startsWith('Z')
}

function listDarwin(withFiles) {
  const run = (command, args) => {
    const out = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 28 })

    // lsof exits 1 when a selector matched nothing; the ps cross-check below catches whatever it left out.
    if (out.error || (out.status !== 0 && !out.stdout)) {
      throw new Error(
        `${command} could not list the processes: ${String(out.error ?? out.stderr)
          .trim()
          .slice(0, 200)}`
      )
    }

    return out.stdout
  }
  const uid = process.getuid()
  const ps = run('/bin/ps', ['-axo', 'pid=,uid=,stat='])
  const lsof = run('/usr/sbin/lsof', ['-n', '-P', '-w', '-a', '-u', String(uid), '-d', 'txt', '-F', 'pfn'])

  const rows = mergeDarwin(ps, lsof, uid, stillRunning)

  if (!withFiles) {
    return rows
  }

  const held = parseLsofFiles(run('/usr/sbin/lsof', ['-n', '-P', '-w', '-u', String(uid), '-F', 'pn']))
  const launched = parsePsEnvironment(run('/bin/ps', ['-axwwE', '-o', 'pid=,command=']))

  return rows.map(row => ({ ...row, files: held.get(row.pid) ?? [], launched: launched.get(row.pid) ?? [] }))
}

/**
 * This user's processes as `{ pid, exe }`: `exe` is the kernel's absolute executable path (Linux /proc/<pid>/exe,
 * macOS lsof's first text file), or null when it could not be read. With `files`, each row also carries `files`, the
 * absolute paths it holds (R2-M13; one extra lsof over every descriptor, so only the final scan asks for it), and
 * `launched`, the absolute paths its environment names as the program it was launched as (R3-M3; macOS one extra
 * `ps -E`). Throws when the table cannot be read.
 */
export function listProcesses({ platform = process.platform, files = false } = {}) {
  return platform === 'linux' ? listLinux(files) : listDarwin(files)
}

/**
 * The processes left inside `roots` (this process excluded), this user's processes whose executable is unknown, and
 * (rows that carry `files` / `launched`) the ones whose executable is outside every root but that hold a path inside
 * one or were launched as a program inside one (`holding`, R2-M13 / R3-M3). Containment follows `platform`'s file system: case-insensitive on macOS, case-sensitive
 * elsewhere (`caseFold`).
 */
export function leftovers(rows, roots, { self = process.pid, platform = process.platform } = {}) {
  const fold = caseFold(platform)
  const inside = roots.map(root => fold(canonical(root)))
  const contained = real => inside.some(root => isInside(fold(real), root))
  const within = file => contained(canonical(file))
  // A launch path is where the program was STARTED from: a venv's bin/python is a symbolic link to the base
  // interpreter, so resolving its last component would take it out of the root it was launched in (R3-M3).
  const launchedWithin = file => contained(join(canonical(dirname(file)), basename(file)))
  const mine = rows.filter(row => row.pid !== self)
  const inRoots = mine.filter(row => row.exe && within(row.exe))

  return {
    inside: inRoots,
    unknown: mine.filter(row => !row.exe),
    holding: mine.filter(
      row =>
        row.exe &&
        !inRoots.includes(row) &&
        ((row.files ?? []).some(within) || (row.launched ?? []).some(launchedWithin))
    )
  }
}

/** Where a temp folder may be for its allowance to count (TMPDIR=/ must not open /usr to the quit step). */
const TEMP_HOMES = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']

/**
 * The only places a root may be (an allowlist, so no system folder or broad home folder can slip through): a folder
 * inside an app's own data folder (`~/Library/Application Support/<app>/<…>` on macOS, `~/.config/<app>/<…>` on Linux:
 * the app runtime folder), an `.app` bundle directly in /Applications or ~/Applications (the installed app), or a
 * folder strictly inside the temp folder (the live harness's throwaway homes).
 */
export function assertRoots(roots, { home = homedir(), temp = tmpdir() } = {}) {
  if (!roots?.length) {
    throw new Error('no root to clear: pass the app bundle and the app runtime folder')
  }

  for (const root of roots) {
    let directory = false

    try {
      directory = isAbsolute(root) && statSync(root).isDirectory()
    } catch {
      directory = false
    }

    if (!directory) {
      throw new Error(`refused root ${JSON.stringify(root)}: not an existing absolute directory`)
    }

    const real = canonical(root)
    const depthBelow = dir => {
      const rel = relative(canonical(dir), real)

      return rel && isInside(real, canonical(dir)) ? rel.split(sep).length : 0
    }
    const appData = [join(home, 'Library', 'Application Support'), join(home, '.config')]
    const appsDirs = ['/Applications', join(home, 'Applications')].map(canonical)
    const allowed =
      appData.some(dir => depthBelow(dir) >= 2) ||
      (/\.app$/.test(real) && appsDirs.includes(dirname(real))) ||
      (depthBelow(temp) >= 1 && TEMP_HOMES.some(dir => isInside(canonical(temp), canonical(dir))))

    if (!allowed) {
      throw new Error(
        `refused root ${root}: not inside an app data folder, not an .app in /Applications, not inside the temp folder`
      )
    }
  }
}

/**
 * Stops every leftover: SIGTERM, up to `graceMs` for them to go, then SIGKILL to the ones the table STILL shows inside
 * the roots (a pid reused meanwhile is re-checked, never signalled blind). Returns what was found, what had to be
 * killed, what is still running and what could not be identified; the step passes only when the last two are empty.
 * `where` ({ home, temp }) is handed to `assertRoots` and `platform` to `leftovers`; both default to this machine.
 */
export async function stopLeftovers({
  roots,
  graceMs = DEFAULT_GRACE_MS,
  list = listProcesses,
  kill = process.kill.bind(process),
  sleep = ms => new Promise(done => setTimeout(done, ms)),
  self = process.pid,
  where = {},
  platform = process.platform
}) {
  assertRoots(roots, where)

  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error(`--grace-ms must be a non-negative number of milliseconds (got ${graceMs})`)
  }

  const scan = () => leftovers(list(), roots, { self, platform })
  const signal = (pids, name) => {
    for (const pid of pids) {
      try {
        kill(pid, name)
      } catch {
        // Already gone between the scan and the signal.
      }
    }
  }

  const step = Math.max(1, Math.min(100, graceMs))
  const termed = new Set()
  const killedSet = new Set()
  const seen = new Map()
  const all = []
  const record = rows => {
    for (const row of rows) {
      if (!seen.has(row.pid)) {
        seen.set(row.pid, row)
        all.push(row)
      }
    }
  }
  // Wait by the CLOCK as well as by the step: each iteration costs a sleep PLUS a scan (on macOS two processes over
  // every pid of this user), so counting only the step made a 5 s grace take about 10 s. The step accounting stays so
  // an injected instant sleep still terminates the loop in a test.
  const settle = async ms => {
    const deadline = Date.now() + ms
    for (let waited = 0; waited < ms && Date.now() < deadline; waited += step) {
      await sleep(step)
      if (!scan().inside.length) {
        return
      }
    }
  }

  // Converge instead of acting on one snapshot. A supervised backend replaces a SIGTERMed sibling, so a process that
  // appears AFTER the first scan was never signalled at all: it stayed inside a root, landed in `remaining`, and the
  // step went red for ever while the folder stayed busy — and, on macOS, while it still held the app's singleton lock,
  // which is what blocked the next launch in live run r1. Each round re-scans, SIGTERMs whatever is inside and not yet
  // termed, waits, then SIGKILLs only what the table STILL shows inside (so a reused pid is never signalled blind).
  const MAX_ROUNDS = 3
  let rounds = 0

  for (; rounds < MAX_ROUNDS; rounds++) {
    const inside = scan().inside

    if (!inside.length) {
      break
    }

    record(inside)

    const fresh = inside.filter(row => !termed.has(row.pid))

    if (fresh.length) {
      signal(
        fresh.map(row => row.pid),
        'SIGTERM'
      )
      for (const row of fresh) {
        termed.add(row.pid)
      }
    }

    await settle(graceMs)

    const stubborn = scan().inside.filter(row => termed.has(row.pid) && !killedSet.has(row.pid))

    if (stubborn.length) {
      signal(
        stubborn.map(row => row.pid),
        'SIGKILL'
      )
      for (const row of stubborn) {
        killedSet.add(row.pid)
      }
      await settle(Math.min(1000, Math.max(step, graceMs)))
    }
  }

  // The final scan also reads what each process holds (R2-M13) and what it was launched as (R3-M3): such a process
  // outside the roots is reported, not signalled.
  const after = leftovers(list({ platform, files: true }), roots, { self, platform })

  return {
    found: all,
    killed: [...killedSet],
    remaining: after.inside,
    unknown: after.unknown,
    holding: after.holding,
    rounds
  }
}

/** `--root <dir>` (repeatable) and `--grace-ms <n>` only; anything else is refused, nothing is guessed. */
export function parseArgs(argv) {
  const roots = []
  let graceMs = DEFAULT_GRACE_MS

  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1]

    if (argv[i] === '--root' && value !== undefined) {
      roots.push(value)
      i++
    } else if (argv[i] === '--grace-ms' && /^\d+$/.test(value ?? '')) {
      graceMs = Number(value)
      i++
    } else if (argv[i] === '--root' || argv[i] === '--grace-ms') {
      throw new Error(
        `${argv[i]} needs a value (${argv[i] === '--root' ? 'a directory' : 'a non-negative integer number of milliseconds'}, got ${JSON.stringify(value ?? '')})`
      )
    } else {
      throw new Error(
        `unknown argument ${JSON.stringify(argv[i])}: only --root <dir> and --grace-ms <n> are understood`
      )
    }
  }

  return { roots, graceMs }
}

if (isMain(import.meta.url)) {
  try {
    const result = await stopLeftovers(parseArgs(process.argv.slice(2)))
    const show = rows => rows.map(row => `${row.pid} ${row.exe ?? '(executable unreadable)'}`)

    console.log(
      JSON.stringify(
        {
          found: show(result.found),
          killed: result.killed,
          remaining: show(result.remaining),
          unknown: show(result.unknown),
          holding: show(result.holding)
        },
        null,
        2
      )
    )
    process.exit(result.remaining.length || result.unknown.length || result.holding.length ? 1 : 0)
  } catch (error) {
    console.error(`[live-quit] RED ${error.message}`)
    process.exit(1)
  }
}
