/**
 * iCLONE OS — the one way the main process runs git: never interactive (no
 * terminal or askpass prompt can hang a background call), hidden console on
 * Windows, bounded output and an optional hard timeout. The result is always
 * resolved with the exit status; only a binary that cannot be spawned rejects.
 * Callers keep their own contract (throw on non-zero, stream lines…) on top.
 */
import { spawn } from 'node:child_process'

export const NONINTERACTIVE_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_ASKPASS: 'echo',
  GIT_TERMINAL_PROMPT: '0',
  SSH_ASKPASS: 'echo'
}

/** Characters kept per stream before the child is killed (matches execFile's former 8 MiB maxBuffer). */
export const DEFAULT_GIT_MAX_BUFFER = 8 * 1024 * 1024

type GitStream = 'stderr' | 'stdout'

export interface RunGitOptions {
  /** The git executable (default 'git' from PATH). */
  bin?: string | undefined
  cwd?: string | undefined
  /** Merged over process.env; the non-interactive overrides always win. */
  env?: NodeJS.ProcessEnv | undefined
  /** Kill the child (SIGKILL) after this many ms; the result says `timedOut`. */
  timeoutMs?: number | undefined
  /** Per-stream character cap; beyond it the child is killed and the result says `overflowed`. */
  maxBuffer?: number | undefined
  /** Every decoded chunk as it arrives (progress UIs). */
  onOutput?: ((stream: GitStream, text: string) => void) | undefined
  /** For tests: the platform whose argv rules apply. */
  platform?: NodeJS.Platform | undefined
}

export interface RunGitResult {
  /** Exit code, or null when the child died by a signal. */
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  overflowed: boolean
}

/** Git's argv: on Windows, appends are made non-atomic (antivirus/indexer locks break the atomic path). */
export function gitArgv(args: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['-c', 'windows.appendAtomically=false', ...args] : [...args]
}

export function gitEnv(env: NodeJS.ProcessEnv | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...env, ...NONINTERACTIVE_GIT_ENV }
}

export function runGit(args: readonly string[], options: RunGitOptions = {}): Promise<RunGitResult> {
  const maxBuffer = options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER

  return new Promise((resolve, reject) => {
    const child = spawn(options.bin ?? 'git', gitArgv(args, options.platform), {
      cwd: options.cwd,
      env: gitEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    const output: Record<GitStream, string> = { stderr: '', stdout: '' }
    let timedOut = false
    let overflowed = false
    let settled = false

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
          }, options.timeoutMs)

    const collect = (stream: GitStream) => (text: string) => {
      options.onOutput?.(stream, text)

      if (overflowed) {
        return
      }

      const room = maxBuffer - output[stream].length

      if (text.length > room) {
        output[stream] += text.slice(0, Math.max(0, room))
        overflowed = true
        child.kill('SIGKILL')

        return
      }

      output[stream] += text
    }

    child.stdout.setEncoding('utf8').on('data', collect('stdout'))
    child.stderr.setEncoding('utf8').on('data', collect('stderr'))

    child.once('error', error => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    })

    child.once('close', (code, signal) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ code, overflowed, signal, stderr: output.stderr, stdout: output.stdout, timedOut })
      }
    })
  })
}
