/**
 * The facts on a pane's sidebar line: git branch of its directory and the TCP
 * ports its process tree listens on. execFile only — no shell string is ever
 * built. One `ps` and one `lsof` per probe round, whatever the pane count, and
 * the caller only asks for panes on screen (lsof costs 100-300 ms on macOS).
 */
import { execFile } from 'node:child_process'

const GIT_TIMEOUT_MS = 1_500
const LSOF_TIMEOUT_MS = 3_000
// Below the 5 s probe interval: each round re-reads, a burst within one round does not.
const BRANCH_CACHE_MS = 4_000

export type RunFile = (file: string, args: readonly string[], timeoutMs: number) => Promise<string>

export interface ProbeInput {
  paneId: string
  pid: null | number
  cwd: null | string
}

interface PaneFacts {
  paneId: string
  branch: null | string
  ports: number[]
}

const runFile: RunFile = (file, args, timeoutMs) =>
  new Promise(resolve => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? '' : String(stdout))
    )
  })

/** ppid → children, from `ps -A -o pid=,ppid=`. */
function childrenOf(psOut: string): Map<number, number[]> {
  const tree = new Map<number, number[]>()

  for (const line of psOut.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)

    if (Number.isInteger(pid) && Number.isInteger(ppid)) {
      tree.set(ppid, [...(tree.get(ppid) ?? []), pid])
    }
  }

  return tree
}

function descendants(root: number, tree: Map<number, number[]>): Set<number> {
  const seen = new Set<number>([root])
  const queue = [root]

  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const child of tree.get(next) ?? []) {
      if (!seen.has(child)) {
        seen.add(child)
        queue.push(child)
      }
    }
  }

  return seen
}

/** pid → listening ports, from `lsof -nP -iTCP -sTCP:LISTEN -Fpn`. */
export function parseListeners(lsofOut: string): Map<number, Set<number>> {
  const ports = new Map<number, Set<number>>()
  let pid = 0

  for (const line of lsofOut.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1))
    } else if (line.startsWith('n') && pid) {
      const port = Number(line.slice(line.lastIndexOf(':') + 1))

      if (Number.isInteger(port) && port > 0) {
        ports.set(pid, (ports.get(pid) ?? new Set()).add(port))
      }
    }
  }

  return ports
}

export function createPaneProbe(run: RunFile = runFile, now: () => number = Date.now) {
  const branchCache = new Map<string, { at: number; branch: null | string }>()

  async function branchOf(cwd: string): Promise<null | string> {
    const cached = branchCache.get(cwd)

    if (cached && now() - cached.at < BRANCH_CACHE_MS) {
      return cached.branch
    }

    const out = (await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], GIT_TIMEOUT_MS)).trim()
    const branch = out && !out.includes('\n') ? out : null

    branchCache.set(cwd, { at: now(), branch })

    return branch
  }

  async function portsByPane(inputs: readonly ProbeInput[]): Promise<Map<string, number[]>> {
    const rooted = inputs.filter((input): input is ProbeInput & { pid: number } => typeof input.pid === 'number')

    if (!rooted.length) {
      return new Map()
    }

    const [psOut, lsofOut] = await Promise.all([
      run('ps', ['-A', '-o', 'pid=,ppid='], LSOF_TIMEOUT_MS),
      run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], LSOF_TIMEOUT_MS)
    ])

    const tree = childrenOf(psOut)
    const listeners = parseListeners(lsofOut)

    return new Map(
      rooted.map(input => {
        const ports = new Set<number>()

        for (const pid of descendants(input.pid, tree)) {
          listeners.get(pid)?.forEach(port => ports.add(port))
        }

        return [input.paneId, [...ports].sort((a, b) => a - b)]
      })
    )
  }

  return async function probe(inputs: readonly ProbeInput[]): Promise<PaneFacts[]> {
    const ports = await portsByPane(inputs)

    return Promise.all(
      inputs.map(async input => ({
        paneId: input.paneId,
        branch: input.cwd ? await branchOf(input.cwd) : null,
        ports: ports.get(input.paneId) ?? []
      }))
    )
  }
}
