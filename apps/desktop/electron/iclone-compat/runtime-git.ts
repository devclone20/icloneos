// The one git helper (contract decision 7). The runtime checkout is a `blob:none` promisor clone: any git process there
// can lazy-fetch objects or rewrite the index, so the runtime is read as FILES only (HEAD, refs, reflog, working tree).
// The one network read is `runtimeInstallTip`: an `ls-remote` of the checkout's origin URL, run outside the runtime.
// Other revisions come from the APP repo's full `upstream` objects through `repoGit`, which pins the read-only env and
// runs only read-only subcommands.
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  allowDestinationEnv,
  DESTINATION_PINNED_ENV,
  isDestinationKey,
  mainDestinationEnv
} from '../iclone-telemetry-seal'

const GIT_READ_ENV = { GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }

const READ_ONLY = new Set([
  'archive',
  'cat-file',
  'diff',
  'log',
  'ls-tree',
  'merge-base',
  'patch-id',
  'rev-list',
  'rev-parse',
  'show'
])

// args[0] is always the subcommand, so global options (-C, --git-dir) cannot appear. These are the subcommand flags that
// would write a file, run an external program or reach the network.
const FORBIDDEN_ARG = /^(-o|--output|--ext-diff|--textconv|--remote|--exec)(=|$)/
const SHA = /^[0-9a-f]{40}$/

// The only inherited variables a git process sees. Every GIT_* is dropped: GIT_DIR / GIT_WORK_TREE move the repo past the
// cwd check, GIT_CONFIG_PARAMETERS / GIT_EXTERNAL_DIFF run a program. System and global config are skipped for the same
// reason (diff.external, core.fsmonitor, textconv drivers); only the app repo's own config applies.
const ENV_ALLOW = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TMPDIR',
  'TMP',
  'TEMP'
]

const ENV_ALLOW_WIN32 = ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']
// Subcommands that render diffs: external diff and textconv drivers are switched off on the command line as well.
const DIFF_RENDERING = new Set(['diff', 'log', 'show'])

export function repoGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}

  for (const key of process.platform === 'win32' ? [...ENV_ALLOW, ...ENV_ALLOW_WIN32] : ENV_ALLOW) {
    if (env[key] !== undefined) {
      out[key] = env[key]
    }
  }

  return { ...out, ...GIT_READ_ENV, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull }
}

interface ReflogEntry {
  from: string
  to: string
  at: number
  message: string
}

export function runtimeHome(): string {
  return path.join(os.homedir(), '.hermes')
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)

  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function runtimeGitDir(runtimeDir: string): string {
  const dotGit = path.join(runtimeDir, '.git')
  const pointer = /^gitdir: (.+)$/m.exec(readText(dotGit) ?? '')?.[1]

  return pointer ? path.resolve(runtimeDir, pointer.trim()) : dotGit
}

// A linked worktree keeps HEAD in its own git dir but refs, packed-refs and config in the common dir.
function commonGitDir(gitDir: string): string {
  const pointer = readText(path.join(gitDir, 'commondir'))?.trim()

  return pointer ? path.resolve(gitDir, pointer) : gitDir
}

// A ref as a file read: loose ref -> packed-refs. Never a git process.
function readRef(gitDir: string, ref: string): string | null {
  for (const dir of new Set([gitDir, commonGitDir(gitDir)])) {
    const loose = readText(path.join(dir, ref))?.trim() ?? ''

    if (SHA.test(loose)) {
      return loose
    }
  }

  for (const line of (readText(path.join(commonGitDir(gitDir), 'packed-refs')) ?? '').split('\n')) {
    const [sha, name] = line.trim().split(' ')

    if (name === ref && SHA.test(sha ?? '')) {
      return sha
    }
  }

  return null
}

function headRef(gitDir: string): string | null {
  return /^ref: (refs\/\S+)$/.exec(readText(path.join(gitDir, 'HEAD'))?.trim() ?? '')?.[1] ?? null
}

// HEAD as a file read: symbolic ref -> loose ref -> packed-refs. Never a git process.
export function runtimeHead(runtimeDir: string): string | null {
  // V3-RT (M2, ruling 36): the app's own runtime has no .git; its head is the runtime sha its install stamp names.
  if (!fs.existsSync(path.join(runtimeDir, '.git'))) {
    try {
      const stamp = JSON.parse(readText(path.join(runtimeDir, 'ICLONE_MANAGED.json')) ?? '{}') as {
        runtimeSha?: unknown
      }

      return typeof stamp.runtimeSha === 'string' && SHA.test(stamp.runtimeSha) ? stamp.runtimeSha : null
    } catch {
      return null
    }
  }

  const gitDir = runtimeGitDir(runtimeDir)
  const head = readText(path.join(gitDir, 'HEAD'))?.trim() ?? ''

  if (SHA.test(head)) {
    return head
  }

  const ref = headRef(gitDir)

  return ref ? readRef(gitDir, ref) : null
}

// One key of one section in a git config file (first occurrence), surrounding quotes dropped. A file read.
function configValue(config: string, header: string, key: string): string | null {
  const lines = config.split('\n')
  const start = lines.findIndex(line => line.trim() === header)

  if (start < 0) {
    return null
  }

  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith('[')) {
      return null
    }

    const kv = /^\s*([\w-]+)\s*=\s*(.*?)\s*$/.exec(line)

    if (kv && kv[1].toLowerCase() === key) {
      return kv[2].replace(/^"(.*)"$/, '$1')
    }
  }

  return null
}

// `hermes update` fetches `origin` itself and installs the fresh tip of `main` (its fetch moves refs/remotes/origin/main
// there), or a release commit when a release channel is selected. The checkout's own @{u} is only its last fetch.
const UPDATE_REMOTE = 'origin'
const UPDATE_BRANCH = 'main'
const LS_REMOTE_TIMEOUT_MS = 8000
const PACKAGE_PAYLOADS = new Set(['bundled', 'light', 'runtime'])
// An absolute local path may contain spaces; a config value never spans lines.
const REMOTE_URL = /^(?:(?:https?|ssh|git|file):\/\/\S+|[\w.-]+@[\w.-]+:\S+|\/.+)$/

// A network read needs the proxy and CA settings; nothing else is inherited (repoGitEnv).
const NETWORK_ENV = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR'
]

// The checkout's `origin` URL as a file read. Only plain transports; `ext::`, option-like or relative URLs are refused.
function runtimeOriginUrl(runtimeDir: string): string | null {
  const config = readText(path.join(commonGitDir(runtimeGitDir(runtimeDir)), 'config')) ?? ''
  const url = configValue(config, `[remote "${UPDATE_REMOTE}"]`, 'url')

  return url && REMOTE_URL.test(url) ? url : null
}

// True when `hermes update` follows `main` for this install: a self-updating source checkout (install stamp) with no
// release channel recorded in the Hermes home's config.yaml. A record for any other channel, even another install's,
// answers false: a release commit is never the branch tip.
function followsMainChannel(runtimeDir: string, hermesHome: string): boolean {
  let stamp: Record<string, unknown> = {}

  try {
    stamp = JSON.parse(readText(path.join(runtimeDir, 'install-stamp.json')) ?? '{}') as Record<string, unknown>
  } catch {
    stamp = {}
  }

  if (PACKAGE_PAYLOADS.has(String(stamp.payload)) || (stamp.updateMechanism ?? 'self') !== 'self') {
    return false
  }

  const config = readText(path.join(hermesHome, 'config.yaml')) ?? ''
  const at = config.search(/^update\s*:/m)

  if (at < 0) {
    return true
  }

  // The `update:` block runs to the next top-level key.
  const rest = config.slice(at)
  const body = rest.indexOf('\n') + 1
  const end = body > 0 ? rest.slice(body).search(/^\S/m) : -1
  const block = body > 0 && end >= 0 ? rest.slice(0, body + end) : rest
  const channels = [...block.matchAll(/channel['"]?\s*:\s*['"]?([^\s'",}#]*)/g)].map(m => m[1])

  return channels.every(c => c === UPDATE_BRANCH)
}

function pickEnv(keys: string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(keys.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))
}

// Ruling 57.4: the seal took the proxy variables out of main's env; this network read is the one listed reason a child
// gets main's own values back (iclone-telemetry-seal.ts DESTINATION_REASONS).
function networkEnv(): NodeJS.ProcessEnv {
  const proxies = NETWORK_ENV.filter(key => isDestinationKey(key) || key in DESTINATION_PINNED_ENV)

  return { ...pickEnv(NETWORK_ENV.filter(key => !proxies.includes(key))), ...mainDestinationEnv(proxies) }
}

// APFS and NTFS are case-insensitive by default: there, two spellings of one directory compare equal.
const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32'

// The on-disk spelling (realpath(3): symlinks resolved, case as stored) of the deepest existing ancestor, plus the rest.
function canonicalPath(p: string): string {
  const abs = path.resolve(p)

  const real = (dir: string): string => {
    try {
      return fs.realpathSync.native(dir)
    } catch {
      const parent = path.dirname(dir)

      return parent === dir ? dir : path.join(real(parent), path.basename(dir))
    }
  }

  const canonical = real(abs)

  return FOLD_CASE ? canonical.toLowerCase() : canonical
}

// True when a local remote (an absolute path or a file:// URL) points inside a protected directory: `ls-remote` would
// run upload-pack IN it. Both the raw and the percent-decoded path are checked, canonicalised (symlinks, and case where the
// filesystem folds it); a file:// URL with a host or an undecodable path is refused outright.
function localRemoteIsProtected(url: string, protectedDirs: string[]): boolean {
  let candidates: string[]

  if (url.startsWith('/')) {
    candidates = [url]
  } else if (url.startsWith('file://')) {
    try {
      candidates = [url.slice('file://'.length), fileURLToPath(url)]
    } catch {
      return true
    }
  } else {
    return false
  }

  const fold = (p: string) => (FOLD_CASE ? p.toLowerCase() : p)
  const dirs = protectedDirs.flatMap(d => [fold(path.resolve(d)), canonicalPath(d)])

  return candidates.some(c => {
    const at = [fold(path.resolve(c)), canonicalPath(c)]

    return dirs.some(dir => at.some(p => isInside(p, dir)))
  })
}

interface InstallTipOptions {
  hermesHome?: string
  timeoutMs?: number
}

// The rev `hermes update` would install now: the remote tip of origin/main, read with one `ls-remote` that runs in the
// temp dir (never in the runtime, never fetching into it), with the read-only env, ext/fd transports off, no prompt and a
// timeout. null (UNKNOWN) when the remote is unreachable or refused, or when the install follows a release channel.
// Async on purpose: main resolves it at preview and again right before apply, never on a hot path.
export function runtimeInstallTip(runtimeDir: string, opts: InstallTipOptions = {}): Promise<string | null> {
  const root = path.resolve(runtimeDir)
  const url = runtimeOriginUrl(root)
  const hermesHome = opts.hermesHome ?? path.dirname(root)

  if (!url || !followsMainChannel(root, hermesHome)) {
    return Promise.resolve(null)
  }

  if (localRemoteIsProtected(url, [root, runtimeHome(), ...(opts.hermesHome ? [opts.hermesHome] : [])])) {
    return Promise.resolve(null)
  }

  const cwd = fs.realpathSync(os.tmpdir())
  const ref = `refs/heads/${UPDATE_BRANCH}`

  const env = allowDestinationEnv('runtime-git-network-read', {
    ...networkEnv(),
    ...repoGitEnv(),
    GIT_CEILING_DIRECTORIES: path.dirname(cwd),
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes'
  })

  const argv = ['-c', 'protocol.ext.allow=never', '-c', 'protocol.fd.allow=never', 'ls-remote', '--', url, ref]

  return new Promise(resolve => {
    execFile(
      'git',
      argv,
      {
        cwd,
        env,
        encoding: 'utf8',
        timeout: opts.timeoutMs ?? LS_REMOTE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 1 << 16
      },
      (error, stdout) => {
        const tip = error
          ? undefined
          : stdout
              .split('\n')
              .find(line => line.endsWith(`\t${ref}`))
              ?.split('\t')[0]

        resolve(tip && SHA.test(tip) ? tip : null)
      }
    )
  })
}

// A working-tree file of the runtime at HEAD. Paths that leave the checkout or reach into `.git` are refused.
export function readRuntimeFile(runtimeDir: string, rel: string): string | null {
  const root = path.resolve(runtimeDir)
  const file = path.resolve(root, rel)

  if (!isInside(file, root) || isInside(file, path.join(root, '.git'))) {
    throw new Error(`runtime-git: refused path outside the working tree: ${rel}`)
  }

  return readText(file)
}

export function parseReflog(text: string): ReflogEntry[] {
  const out: ReflogEntry[] = []

  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) .*? (\d+) [+-]\d{4}\t?(.*)$/.exec(line)

    if (m) {
      out.push({ from: m[1], to: m[2], at: Number(m[3]), message: m[4] })
    }
  }

  return out
}

// The newest reflog entries. Only the tail is read: the reflog grows forever and the watcher needs the last moves.
export function readReflog(runtimeDir: string, tailBytes = 65536): ReflogEntry[] {
  const file = path.join(runtimeGitDir(runtimeDir), 'logs', 'HEAD')
  let fd: number | null = null

  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, tailBytes)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    const text = buf.toString('utf8')

    return parseReflog(len < size ? text.slice(text.indexOf('\n') + 1) : text)
  } catch {
    return []
  } finally {
    if (fd !== null) {
      fs.closeSync(fd)
    }
  }
}

interface RepoGitOptions {
  input?: string
  maxBuffer?: number
  // Directories no git process may run in (default: the Hermes home, which holds the runtime checkout).
  forbidden?: string[]
}

// Read-only git on the APP repo. Throws on a write-capable subcommand, a flag that changes the repo or the output target,
// or a cwd inside the runtime home.
export function repoGit(repoDir: string, args: string[], opts: RepoGitOptions = {}): string {
  const sub = args[0] ?? ''

  if (!READ_ONLY.has(sub)) {
    throw new Error(`runtime-git: refused subcommand: ${sub || '(none)'}`)
  }

  const bad = args.find(a => FORBIDDEN_ARG.test(a))

  if (bad) {
    throw new Error(`runtime-git: refused argument: ${bad}`)
  }

  const cwd = fs.realpathSync(repoDir)

  for (const dir of opts.forbidden ?? [runtimeHome()]) {
    const real = fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir)

    if (isInside(cwd, real)) {
      throw new Error('runtime-git: refused to run git inside the runtime home')
    }
  }

  const argv = DIFF_RENDERING.has(sub) ? [sub, '--no-ext-diff', '--no-textconv', ...args.slice(1)] : args

  return execFileSync('git', argv, {
    cwd,
    encoding: 'utf8',
    env: repoGitEnv(),
    input: opts.input,
    maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe']
  })
}
