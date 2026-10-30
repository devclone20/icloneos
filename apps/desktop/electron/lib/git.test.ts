import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_GIT_MAX_BUFFER, gitArgv, gitEnv, NONINTERACTIVE_GIT_ENV, runGit } from './git'

const NODE = process.execPath
let root = ''

// Node stands in for git where the test needs a scripted child (timeouts, floods, exit codes).
const node = (script: string, options: Parameters<typeof runGit>[1] = {}) =>
  runGit(['-e', script], { bin: NODE, platform: 'darwin', ...options })

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-git-'))
})

afterEach(() => {
  fs.rmSync(root, { force: true, recursive: true })
})

describe('gitArgv / gitEnv', () => {
  it('prefixes the Windows append flag on win32 only and never aliases the input', () => {
    const args = ['status', '--porcelain']

    expect(gitArgv(args, 'win32')).toEqual(['-c', 'windows.appendAtomically=false', 'status', '--porcelain'])
    expect(gitArgv(args, 'darwin')).toEqual(args)
    expect(gitArgv(args, 'linux')).not.toBe(args)
    expect(gitArgv(args)).toEqual(process.platform === 'win32' ? gitArgv(args, 'win32') : args)
  })

  it('merges caller env over the base and lets the non-interactive overrides win', () => {
    const env = gitEnv({ FOO: 'bar', GIT_TERMINAL_PROMPT: '1' }, { BASE: '1', GIT_ASKPASS: '/usr/bin/ui' })

    expect(env).toEqual({ BASE: '1', FOO: 'bar', ...NONINTERACTIVE_GIT_ENV })
    expect(gitEnv(undefined, {})).toEqual(NONINTERACTIVE_GIT_ENV)
    expect(gitEnv(undefined).PATH).toBe(process.env.PATH)
  })
})

describe('runGit with the real git', () => {
  it('resolves stdout and code 0', async () => {
    const result = await runGit(['--version'])

    expect(result).toMatchObject({ code: 0, overflowed: false, signal: null, timedOut: false })
    expect(result.stdout).toMatch(/^git version /)
  })

  it('resolves (never rejects) a non-zero exit with its stderr', async () => {
    const result = await runGit(['rev-parse', '--git-dir'], {
      cwd: root,
      env: { GIT_CEILING_DIRECTORIES: root, LANG: 'C', LC_ALL: 'C' }
    })

    expect(result.code).toBe(128)
    expect(result.stderr).toMatch(/not a git repository/i)
  })
})

describe('runGit process contract', () => {
  it('rejects only when the binary cannot be spawned', async () => {
    await expect(runGit(['--version'], { bin: path.join(root, 'no-such-git') })).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('passes the non-interactive env and cwd to the child', async () => {
    const result = await node(
      'process.stdout.write(JSON.stringify([process.env.GIT_TERMINAL_PROMPT, process.cwd()]))',
      {
        cwd: root
      }
    )

    expect(JSON.parse(result.stdout)).toEqual(['0', fs.realpathSync(root)])
  })

  it('streams every chunk to onOutput and keeps both streams', async () => {
    const seen: string[] = []

    const result = await node('process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3', {
      onOutput: (stream, text) => seen.push(`${stream}:${text}`)
    })

    expect(result).toMatchObject({ code: 3, stderr: 'err', stdout: 'out' })
    expect(seen.sort()).toEqual(['stderr:err', 'stdout:out'])
  })

  it('kills on timeout and reports it', async () => {
    const result = await node('setTimeout(() => {}, 30000)', { timeoutMs: 100 })

    expect(result).toMatchObject({ code: null, signal: 'SIGKILL', timedOut: true })
  })

  it('caps output at maxBuffer, kills the child and reports the overflow', async () => {
    const result = await node('process.stdout.write("x".repeat(200000)); setTimeout(() => {}, 30000)', {
      maxBuffer: 1000,
      timeoutMs: 20_000
    })

    expect(result.overflowed).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.stdout).toBe('x'.repeat(1000))
  })

  it('decodes UTF-8 split across chunks', async () => {
    const result = await node(
      'const b = Buffer.from("é🚀"); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 20)'
    )

    expect(result.stdout).toBe('é🚀')
  })

  it('has a sane default cap', () => {
    expect(DEFAULT_GIT_MAX_BUFFER).toBe(8 * 1024 * 1024)
  })
})
