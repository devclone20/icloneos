/**
 * V3-G — renders a ProfileSpec as Seatbelt (SBPL) text. Generated from data, byte-stable for the same spec, hashed
 * by the caller; never hand-edited. Rule order is the safety argument: Seatbelt applies the LAST matching rule, so
 * the profile opens with `(deny default)`, allows what the class names, and ends with the denies no class may lift
 * (secrets, the keychain, the app's own state, the V3-F protected paths).
 *
 * The per-spawn facts are parameters (`sandbox-exec -D NAME=value`): an absent parameter makes its rule match
 * nothing, so a spawner that forgets one gets less, never more.
 */
import type { ProfileParam, ProfileSpec } from './profiles'
import {
  KEYCHAIN_SERVICES,
  NEVER_EXEC,
  PROJECT_GIT_FILES,
  PROJECT_GIT_FOLDERS,
  SILENT_DENY_MACH,
  SILENT_DENY_READS
} from './profiles'

// Any path we embed must be a plain absolute path: a quote, a backslash or a control character could end the SBPL
// string early and smuggle a rule in. Refusing is the whole defence, so it is strict.
const isSafePath = (value: string): boolean =>
  value.startsWith('/') &&
  ![...value].some(char => char === '"' || char === '\\' || char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)

export function str(value: string): string {
  if (!isSafePath(value)) {
    throw new Error(`confinement: refusing to embed an unsafe path in a profile: ${JSON.stringify(value)}`)
  }

  return `"${value}"`
}

export const subpaths = (items: readonly string[]) => items.map(item => `(subpath ${str(item)})`).join(' ')
export const literals = (items: readonly string[]) => items.map(item => `(literal ${str(item)})`).join(' ')
const param = (name: ProfileParam) => `(param "${name}")`
const paramSubpaths = (names: readonly ProfileParam[]) => names.map(name => `(subpath ${param(name)})`).join(' ')
/**
 * The kernel appends the message to every denial it logs. It names the class and, through the MEMBER parameter
 * (resolved when the profile is compiled for one spawn), the run's own token file: the log line itself says which run
 * refused what, after the process is gone, and which members folder (which app instance) the run belongs to
 * (refusals.ts). SBPL is a Scheme, so the message is built from the parameter rather than written as a literal.
 */
export const TAG_PREFIX = 'iclone-confined:'

/** The names a process under either profile may ask the kernel by (sysctlbyname), besides `hw.*` and `machdep.cpu.*`:
 *  measured over the real runtime's boot and its live tests (fx26a) and the user's own tools (fx35d, R32). Seatbelt
 *  mediates a numeric ask (a mib, how KERN_PROCARGS2 and kern.proc.pid are asked) through two operations OR'd: sysctl-read
 *  for an unnamed call, which a name filter never matches, or process-info-pidinfo on the target. PROCESS_INFO_LINES closes
 *  the second, the deny plus this list the first; only both together refuse it (runtime-env-block.live.test.ts).
 *  Never `kern.proc*` or anything that answers a process's arguments. */
export const SYSCTL_READS = [
  'kern.boottime',
  'kern.bootargs',
  'kern.hostname',
  'kern.iossupportversion',
  'kern.osproductversion',
  'kern.osrelease',
  'kern.ostype',
  'kern.osvariant_status',
  'kern.version',
  'security.mac.lockdown_mode_state'
]

/** What a user's own tools ask besides SYSCTL_READS, measured on macOS 27.2 (fx35d, R32): limits, load and the machine, and
 *  the sysctl tool's own name lookups. None answers anything about another process. bash and getconf ask kern.ngroups,
 *  xargs and clang kern.argmax, node kern.willshutdown and the interface list (net.routetable, getifaddrs). */
const COMMAND_SYSCTL_READS = {
  names: ['kern.aiomax', 'kern.argmax', 'kern.hv_vmm_present', 'kern.maxfilesperproc', 'kern.ngroups', 'kern.posix1version', 'kern.saved_ids', 'kern.willshutdown', 'vm.loadavg'],
  prefixes: ['kern.os', 'kern.sysv.', 'net.routetable.', 'sysctl.']
}

/** The allow that goes right after a tagged `(deny sysctl-read)`. */
export const sysctlAllowLine = (extra: { names: readonly string[]; prefixes: readonly string[] } = { names: [], prefixes: [] }) =>
  `(allow sysctl-read ${[...SYSCTL_READS, ...extra.names].map(name => `(sysctl-name "${name}")`).join(' ')} ${['hw.', 'machdep.cpu.', ...extra.prefixes].map(name => `(sysctl-name-prefix "${name}")`).join(' ')})`

/** A process may ask about itself and about nothing else, the runtime's own child and its parent included:
 *  `(target same-sandbox)` stays out, it would let the runtime's child read the runtime. `(deny default)` does not cover
 *  process-info*, so the deny is written; Python dies at start without the self line. */
export const processInfoLines = (denyTag: string) => [`(deny process-info* ${denyTag})`, '(allow process-info* (target self))']

/**
 * Chromium's debugger, in the browser the launcher's door runs outside the Seatbelt, reads any file it is told to, and the
 * daemon's stream shows the page and takes input. Chromium itself refuses these ports to any page (its restricted list, see
 * browser_door.py DEBUG_PORTS, the same list); that leaves a confined process, so they are refused here by number, on any address, to reach and to squat: measured,
 * `::ffff:0.0.0.0` passes `(deny ... (remote ip "localhost:*"))` and reaches a loopback listener; `*:<port>` stops it.
 * Written in the never section: last match wins, so a widening's localhost lines, which sit before it, do not undo it.
 * No `with message`: measured, the same deny tagged with the message of this profile's `(deny default)` is not enforced after
 * a widening's `(allow network-outbound (remote ip "localhost:*"))` when NET is off; untagged it is. The live test holds that.
 */
export const DEBUGGER_PORTS: readonly number[] = [1719, 1720, 1723, 4045, 5060, 5061, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]

export const debuggerDenials = (): string[] => [
  `(deny network-outbound ${DEBUGGER_PORTS.map(port => `(remote ip "*:${port}")`).join(' ')})`,
  `(deny network-bind ${DEBUGGER_PORTS.map(port => `(local ip "*:${port}")`).join(' ')})`
]

const tag = (spec: Pick<ProfileSpec, 'cls'>) =>
  `(with message (string-append "${TAG_PREFIX}${spec.cls}:" (param "MEMBER")))`

export const globalNames = (names: readonly string[]) => names.map(name => `(global-name "${name}")`).join(' ')

/**
 * The OS logging probes (profiles.ts SILENT_DENY_*): denied as before, unreported, untagged (a tag is a message, and
 * the point is that no line is written). Last in every profile, so no earlier rule reports them.
 */
export const SILENT_DENY_LINES = [
  `(deny mach-lookup (with no-report) ${globalNames(SILENT_DENY_MACH)})`,
  `(deny file-read* (with no-report) ${subpaths(SILENT_DENY_READS)})`
] as const

/** `*` within one path segment, anchored. Every other character is literal. */
export function globToSbplRegex(glob: string): string {
  if (!isSafePath(glob)) {
    throw new Error(`confinement: refusing an unsafe glob: ${JSON.stringify(glob)}`)
  }

  const body = glob
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]]/g, match => `\\${match}`))
    .join('[^/]*')

  return `(regex #"^${body}$")`
}

// The ancestors of a parameter path, computed inside the profile (SBPL is a Scheme): a shell resolves the current
// directory by reading the metadata of every parent, and only the metadata, so `ls ~` stays refused.
export const ANCESTORS_FN = `(define (iclone-ancestors p)
  (if (not (string? p)) '()
    (let loop ((s p) (acc '()))
      (if (or (string=? s "") (string=? s "/")) acc
        (let find ((i (- (string-length s) 1)))
          (if (char=? (string-ref s i) #\\/)
            (loop (substring s 0 i) (cons (literal s) acc))
            (find (- i 1))))))))`

const ancestorsOf = (names: readonly ProfileParam[]) =>
  names.map(
    name => `(allow file-read-metadata (apply require-any (cons (literal "/") (iclone-ancestors ${param(name)}))))`
  )

const projectGitPath = (rel: string) => `(string-append ${param('PROJECT_ROOT')} "/.git${rel}")`

/** fx10: only the exact word `unborn` lifts it; an absent parameter leaves the repository locked. */
const projectGitDenial = (spec: Pick<ProfileSpec, 'cls'>) => {
  const files = PROJECT_GIT_FILES.map(rel => `(literal ${projectGitPath(rel)})`).join(' ')
  const folders = PROJECT_GIT_FOLDERS.map(rel => `(subpath ${projectGitPath(rel)})`).join(' ')

  return `(if (and (string? ${param('PROJECT_ROOT')}) (not (equal? ${param('PROJECT_GIT')} "unborn"))) (deny file-write* ${files} ${folders} ${tag(spec)}))`
}

/**
 * fx13 (lens3-policy H2): the kernel holds a narrowed WRITE_PROJECT whatever the launcher ordered — a widening line
 * above this block cannot give the project back when the flag is not "1". A scratch run (PROJECT_ROOT is SCRATCH)
 * keeps its scratch; an unborn project's `.git` is a write under WRITE_PROJECT=1 and is not touched.
 */
const projectNarrowedDenial = (spec: Pick<ProfileSpec, 'cls'>) =>
  `(if (and (string? ${param('PROJECT_ROOT')}) (not (equal? ${param('WRITE_PROJECT')} "1")) (not (equal? ${param('PROJECT_ROOT')} ${param('SCRATCH')}))) (deny file-write* (subpath ${param('PROJECT_ROOT')}) ${tag(spec)}))`

export function renderSbpl(spec: ProfileSpec): string {
  const reads = [...spec.systemReads, ...spec.extraReads]

  const lines = [
    '(version 1)',
    `; iclone os confinement · class ${spec.cls} · generated by electron/iclone-confinement/sbpl.ts — never hand-edited`,
    `(deny default ${tag(spec)})`,
    ANCESTORS_FN,
    '(allow process-fork)',
    `(allow process-exec ${subpaths(reads)} ${paramSubpaths(spec.paramReads)})`,
    '(allow signal (target same-sandbox))',
    `(deny sysctl-read ${tag(spec)})`,
    sysctlAllowLine(COMMAND_SYSCTL_READS),
    ...processInfoLines(tag(spec)),
    '(allow system-info)',
    '(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))',
    `(allow mach-lookup ${globalNames(spec.mach)})`,
    `(allow file-read* ${subpaths(reads)} ${literals(spec.readLiterals)} (literal "/"))`,
    `(allow file-read-metadata ${literals(['/private', '/private/var', '/Users', '/Library', '/Applications', '/opt', '/var', '/etc', '/tmp'])})`,
    ...ancestorsOf(spec.paramReads),
    `(allow file-read* ${paramSubpaths(spec.paramReads)})`,
    `(allow file-write* ${paramSubpaths(spec.paramWrites)})`,
    spec.extraWrites.length > 0 ? `(allow file-write* ${subpaths(spec.extraWrites)})` : '',
    spec.projectWrites
      ? `(if (equal? ${param('WRITE_PROJECT')} "1") (allow file-write* (subpath ${param('PROJECT_ROOT')})))`
      : '',
    '(allow file-write-data file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))',
    // A NET grant is the internet: loopback (the browser's CDP port, dev servers, local model servers) stays shut, as
    // does every unix socket but DNS. Opening a local service would need its own grant; none exists.
    // `::ffff:0.0.0.0` passes the localhost deny and reaches every loopback listener, and a host here can only be * or
    // localhost, so TCP over IPv6 goes (measured; a name falls back to IPv4). Not `(remote ip6 "*:*")`: measured, as a deny
    // beside the localhost one it refuses IPv4 too. loopback.live.test.ts holds all of it.
    spec.network === 'grant'
      ? `(if (equal? ${param('NET')} "1") (begin (allow network-outbound (remote ip "*:*")) (deny network-outbound (remote ip "localhost:*")) (deny network-outbound (remote tcp6 "*:*")) (allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder"))) (allow mach-lookup ${globalNames(spec.netMach)})))`
      : '',
    // Membership (members.ts): main asks the kernel which processes this exact sandbox may read the run's token in,
    // so a child that double-forks, calls setsid and drops its marker is still found and killed.
    `(allow file-read-data (literal ${str(spec.memberMark)}) (literal ${param('MEMBER')}))`,
    '; never, whatever the class or the permission mode',
    `(deny file-read* file-write* ${subpaths(spec.denied)} ${spec.deniedGlobs.map(globToSbplRegex).join(' ')} ${tag(spec)})`,
    `(deny file-write* ${subpaths(spec.protectedWrites)} ${tag(spec)})`,
    spec.projectWrites ? projectGitDenial(spec) : '',
    spec.projectWrites ? projectNarrowedDenial(spec) : '',
    `(deny mach-lookup ${globalNames(KEYCHAIN_SERVICES)} ${tag(spec)})`,
    `(deny process-exec ${literals(NEVER_EXEC)} ${tag(spec)})`,
    // A hard link is a second name for an inode the path rules judged under its first name: from inside, none is made
    // (F7). git and the package managers fall back to a copy or a rename when link() is refused.
    `(deny file-link ${tag(spec)})`,
    ...debuggerDenials(),
    ...SILENT_DENY_LINES
  ]

  return `${lines.filter(Boolean).join('\n')}\n`
}

const GENERATED_NET_LINE =
  /^\(if \(equal\? \(param "NET"\) "1"\) \(begin \(allow network-outbound \(remote ip "\*:\*"\)\) \(deny network-outbound \(remote ip "localhost:\*"\)\) \(deny network-outbound \(remote tcp6 "\*:\*"\)\) \(allow network-outbound \(remote unix-socket \(path-literal "\/private\/var\/run\/mDNSResponder"\)\)\) \(allow mach-lookup(?: \(global-name "[\w.-]+"\))+\)\)\)$/

interface SbplAudit {
  widened: boolean
  problems: string[]
}

/**
 * The negative control's detector: a profile that allows by default, drops the default deny, or allows a whole
 * operation with no filter is widened. The pane and the gate read RED on it.
 */
export function auditSbpl(text: string): SbplAudit {
  const problems: string[] = []

  const code = text
    .split('\n')
    .map(line => line.replace(/;.*$/, '').trim())
    .filter(Boolean)
    .join('\n')

  if (!/^\(deny default(?: \(with message (?:"[^"]*"|\(string-append "[^"]*" \(param "MEMBER"\)\))\))?\)$/m.test(code)) {
    problems.push('no (deny default)')
  }

  if (/\(allow\s+default\b/.test(code)) {
    problems.push('(allow default)')
  }

  // The one place the network may open is the NET-parameter conditional the generator writes; anywhere else an
  // unfiltered allow is a widening.
  const unconditional = code
    .split('\n')
    .filter(line => !GENERATED_NET_LINE.test(line))
    .join('\n')

  if (
    /\(allow\s+(file-read\*|file-write\*|file\*|network\*|network-outbound|mach-lookup|process-exec)\s*\)/.test(
      unconditional
    )
  ) {
    problems.push('an operation allowed with no filter')
  }

  return { widened: problems.length > 0, problems }
}
