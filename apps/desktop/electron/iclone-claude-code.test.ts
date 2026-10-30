import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  asEndpoint,
  asLastFallback,
  asTarget,
  asWindow,
  claudeBinaryCandidates,
  createClaudeCodeStatus,
  discoverClaudeBinary,
  parseAuthStatus,
  readFallbackState,
  syncClaudeCodePlugin,
  writeFallbackTarget
} from './iclone-claude-code'
import { writeJsonAtomicSync } from './lib/fs-json'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'icc-'))

describe('claude binary discovery', () => {
  it('probes the S1 order: env override first, login shell last', async () => {
    const list = claudeBinaryCandidates({ ICLONE_CLAUDE_BIN: '/x/claude' }, '/h', ['v22'])
    expect(list.slice(0, 5)).toEqual([
      '/x/claude',
      '/h/.local/bin/claude',
      '/h/.claude/local/claude',
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude'
    ])
    expect(list).toContain('/h/.nvm/versions/node/v22/bin/claude')

    const shell: string[][] = []

    const found = await discoverClaudeBinary({
      env: {},
      exec: async (file, args) => (shell.push([file, ...args]), '/opt/shell/claude\n'),
      home: '/h',
      isExec: file => file === '/opt/shell/claude'
    })

    expect(found).toBe('/opt/shell/claude')
    expect(shell).toEqual([['/bin/zsh', '-lic', 'command -v claude']])
  })
})

describe('auth status parsing', () => {
  it('reads the three shapes and drops identity fields', () => {
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"e"}')).toEqual({
      authMethod: 'claude.ai',
      loggedIn: true,
      subscriptionType: 'max'
    })
    expect(parseAuthStatus('{"loggedIn":false,"authMethod":"none"}').loggedIn).toBe(false)
    expect(parseAuthStatus('{"type":"result","is_error":true,"result":"Not logged in"}').authMethod).toBe('none')
    expect(parseAuthStatus('nope').loggedIn).toBe(false)
  })
})

describe('plugin sync + status IPC shape', () => {
  it('copies atomically with a marker, keeps runtime files, skips an unchanged tree', () => {
    const src = tmp()
    const home = tmp()
    fs.writeFileSync(path.join(src, '__init__.py'), 'x = 1\n')
    fs.mkdirSync(path.join(src, 'tests'))
    fs.writeFileSync(path.join(src, 'tests', 'test_a.py'), '')
    expect(syncClaudeCodePlugin({ hermesHome: home, sourceDir: src })).toEqual({ written: true })
    const target = path.join(home, 'plugins/model-providers/claude-code')
    fs.writeFileSync(path.join(target, 'status.json'), '{"window":{"status":"allowed"}}')
    expect(syncClaudeCodePlugin({ hermesHome: home, sourceDir: src })).toEqual({ written: false })
    fs.writeFileSync(path.join(src, '__init__.py'), 'x = 2\n')
    expect(syncClaudeCodePlugin({ hermesHome: home, sourceDir: src })).toEqual({ written: true })
    expect(fs.readFileSync(path.join(target, '__init__.py'), 'utf8')).toBe('x = 2\n')
    expect(fs.existsSync(path.join(target, 'status.json'))).toBe(true)
    expect(fs.readdirSync(path.dirname(target))).toEqual(['claude-code'])
    expect(fs.existsSync(path.join(target, 'tests'))).toBe(false)
  })

  it('a damaged marker or a missing __init__.py re-syncs instead of sticking', () => {
    const src = tmp()
    fs.writeFileSync(path.join(src, '__init__.py'), 'x = 1\n')

    for (const body of ['{"vers', 'null', '[]', '"x"', '', '\u0000\u0000', '{"version":{}}']) {
      const home = tmp()
      expect(syncClaudeCodePlugin({ hermesHome: home, sourceDir: src })).toEqual({ written: true })
      const target = path.join(home, 'plugins/model-providers/claude-code')
      fs.writeFileSync(path.join(target, 'fallback.json'), '{"provider":"nous","model":"m"}')
      fs.writeFileSync(path.join(target, '.iclone-plugin.json'), body)
      fs.rmSync(path.join(target, '__init__.py'))
      expect(syncClaudeCodePlugin({ hermesHome: home, sourceDir: src })).toEqual({ written: true })
      expect(fs.readFileSync(path.join(target, '__init__.py'), 'utf8')).toBe('x = 1\n')
      expect(fs.readFileSync(path.join(target, 'fallback.json'), 'utf8')).toContain('nous')
      expect(syncClaudeCodePlugin({ hermesHome: home, sourceDir: src })).toEqual({ written: false })
    }

    const home = tmp()
    syncClaudeCodePlugin({ hermesHome: home, sourceDir: src })
    const target = path.join(home, 'plugins/model-providers/claude-code')
    fs.rmSync(path.join(target, '__init__.py'))
    // A matching marker alone is not proof of an installed plugin.
    expect(syncClaudeCodePlugin({ hermesHome: home, sourceDir: src })).toEqual({ written: true })
    expect(fs.existsSync(path.join(target, '__init__.py'))).toBe(true)
    // A leftover .old-<pid> directory from an interrupted sync does not block the next one.
    fs.mkdirSync(path.join(path.dirname(target), `claude-code.old-${process.pid}`, 'x'), { recursive: true })
    fs.writeFileSync(path.join(src, '__init__.py'), 'x = 2\n')
    expect(syncClaudeCodePlugin({ hermesHome: home, sourceDir: src })).toEqual({ written: true })
    expect(fs.readdirSync(path.dirname(target))).toEqual(['claude-code'])
  })

  it('sweeps every .old-* copy (any pid) and dead stage folders, on a no-op sync too', () => {
    const src = tmp()
    fs.writeFileSync(path.join(src, '__init__.py'), 'x = 1\n')
    const parent = path.join(tmp(), 'plugins/model-providers')
    const home = path.dirname(path.dirname(parent))

    const plant = () => {
      // A full plugin copy: Hermes would import it as a second provider.
      for (const name of ['claude-code.old-99999', `claude-code.old-${process.pid}`]) {
        fs.mkdirSync(path.join(parent, name), { recursive: true })
        fs.writeFileSync(path.join(parent, name, '__init__.py'), 'x = 0\n')
      }

      // Untagged (an older build), our own pid, a dead pid: all junk. A live other process keeps its stage.
      for (const name of ['dead', `${process.pid}-x`, '999999-x', `${process.ppid}-live`]) {
        fs.mkdirSync(path.join(parent, `.claude-code-stage-${name}`), { recursive: true })
      }
    }

    fs.mkdirSync(parent, { recursive: true })
    plant()
    expect(syncClaudeCodePlugin({ hermesHome: home, sourceDir: src })).toEqual({ written: true })
    expect(fs.readdirSync(parent).sort()).toEqual([`.claude-code-stage-${process.ppid}-live`, 'claude-code'])
    fs.rmSync(path.join(parent, `.claude-code-stage-${process.ppid}-live`), { recursive: true })
    plant()
    expect(syncClaudeCodePlugin({ hermesHome: home, sourceDir: src })).toEqual({ written: false })
    expect(fs.readdirSync(parent).sort()).toEqual([`.claude-code-stage-${process.ppid}-live`, 'claude-code'])
    fs.writeFileSync(path.join(parent, 'other-provider'), '')
    expect(syncClaudeCodePlugin({ hermesHome: home, sourceDir: src })).toEqual({ written: false })
    expect(fs.existsSync(path.join(parent, 'other-provider'))).toBe(true)
  })

  it('an interrupted sync never loses a runtime file: failed swap, crash mid swap, crash pre swap', () => {
    const src = tmp()
    fs.writeFileSync(path.join(src, '__init__.py'), 'x = 1\n')
    const fallback = '{"provider":"custom","model":"m","base_url":"http://127.0.0.1:9/v1"}'
    const dead = 2147480000

    const setup = () => {
      const home = tmp()
      const parent = path.join(home, 'plugins/model-providers')
      const target = path.join(parent, 'claude-code')
      syncClaudeCodePlugin({ hermesHome: home, sourceDir: src })
      fs.writeFileSync(path.join(target, 'fallback.json'), fallback)
      fs.mkdirSync(path.join(target, 'work'))
      fs.writeFileSync(path.join(target, 'work', 'w.txt'), 'w')

      return { home, parent, target }
    }

    const recover = ({ home, parent, target }: ReturnType<typeof setup>) => {
      expect(syncClaudeCodePlugin({ hermesHome: home, sourceDir: src }).error).toBeUndefined()
      expect(fs.readFileSync(path.join(target, 'fallback.json'), 'utf8')).toBe(fallback)
      expect(fs.readFileSync(path.join(target, 'work', 'w.txt'), 'utf8')).toBe('w')
      expect(fs.readFileSync(path.join(target, '__init__.py'), 'utf8')).toBe('x = 1\n')
      expect(fs.readdirSync(parent)).toEqual(['claude-code'])
    }

    // A: rename(target, old) throws in-process; the originals never left the target.
    const a = setup()
    fs.writeFileSync(path.join(a.target, '.iclone-plugin.json'), '{}')
    const realRename = fs.renameSync

    const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EBUSY: simulated'), { code: 'EBUSY' })
    })

    try {
      expect(syncClaudeCodePlugin({ hermesHome: a.home, sourceDir: src }).error).toContain('EBUSY')
    } finally {
      spy.mockRestore()
    }

    expect(fs.renameSync).toBe(realRename)
    expect(fs.readFileSync(path.join(a.target, 'fallback.json'), 'utf8')).toBe(fallback)
    expect(fs.readdirSync(a.parent)).toEqual(['claude-code'])
    recover(a)

    // A2: rename(stage, target) throws after the target moved aside; the target is put back.
    const a2 = setup()
    fs.writeFileSync(path.join(a2.target, '.iclone-plugin.json'), '{}')

    const spy2 = vi
      .spyOn(fs, 'renameSync')
      .mockImplementationOnce((from, to) => realRename(from, to))
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('EXDEV: simulated'), { code: 'EXDEV' })
      })

    try {
      expect(syncClaudeCodePlugin({ hermesHome: a2.home, sourceDir: src }).error).toContain('EXDEV')
    } finally {
      spy2.mockRestore()
    }

    expect(fs.readdirSync(a2.parent)).toEqual(['claude-code'])
    recover(a2)

    // B: a dead process crashed between the two renames: target missing, its stage holds the files.
    const b = setup()
    fs.cpSync(b.target, path.join(b.parent, `.claude-code-stage-${dead}-abc123`), { recursive: true })
    fs.renameSync(b.target, path.join(b.parent, `claude-code.old-${dead}`))

    for (const name of ['fallback.json', 'work']) {
      fs.rmSync(path.join(b.parent, `claude-code.old-${dead}`, name), { force: true, recursive: true })
    }

    recover(b)

    // B2: same crash but no .old-* copy is left at all: the files are carried into a fresh target.
    const b2 = setup()
    fs.renameSync(b2.target, path.join(b2.parent, `.claude-code-stage-${dead}-ghi789`))
    recover(b2)

    // C: a dead process moved the files into its stage, then crashed before touching the target.
    const c = setup()
    fs.cpSync(c.target, path.join(c.parent, `.claude-code-stage-${dead}-def456`), { recursive: true })
    fs.rmSync(path.join(c.target, 'fallback.json'))
    fs.rmSync(path.join(c.target, 'work'), { recursive: true })
    fs.writeFileSync(path.join(c.target, '.iclone-plugin.json'), '{}')
    recover(c)
  })

  it('reports installed/loggedIn/plan/window and caches auth for 60 s', async () => {
    const home = tmp()
    const dir = path.join(home, 'plugins/model-providers/claude-code')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '__init__.py'), '')
    fs.writeFileSync(
      path.join(dir, 'status.json'),
      JSON.stringify({
        window: {
          fiveHour: { resetsAt: 1, utilization: 0.63 },
          isUsingOverage: false,
          sevenDay: null,
          status: 'allowed'
        }
      })
    )
    const calls: string[] = []

    const status = createClaudeCodeStatus({
      env: { ICLONE_CLAUDE_BIN: '/bin/sh' },
      exec: async (_file, args) => {
        calls.push(args.join(' '))

        return args[0] === '--version'
          ? '2.1.302 (Claude Code)\n'
          : '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'
      },
      hermesHome: home,
      home
    })

    const first = await status()
    expect(first).toMatchObject({
      installed: true,
      loggedIn: true,
      path: '/bin/sh',
      pluginInstalled: true,
      subscriptionType: 'max',
      version: '2.1.302'
    })
    expect(first.window?.fiveHour?.utilization).toBe(0.63)
    await status()
    expect(calls.filter(c => c.startsWith('auth')).length).toBe(1)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'binary.json'), 'utf8')).path).toBe('/bin/sh')
  })

  it('fallback target never points back at the engine', () => {
    const home = tmp()
    writeFallbackTarget(home, { model: 'm', provider: 'claude-code-cli' })
    const file = path.join(home, 'plugins/model-providers/claude-code/fallback.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ model: 'm', provider: 'nous' })
  })

  it('writes binary.json and fallback.json atomically as 0600 with no temp file left', async () => {
    const home = tmp()
    const dir = path.join(home, 'plugins/model-providers/claude-code')
    writeFallbackTarget(home, { model: 'gpt-x', provider: 'openrouter' })
    fs.writeFileSync(path.join(dir, '__init__.py'), '')

    const status = createClaudeCodeStatus({
      env: { ICLONE_CLAUDE_BIN: '/bin/sh' },
      exec: async (_file, args) => (args[0] === '--version' ? '2.1.302\n' : '{"loggedIn":false}'),
      hermesHome: home,
      home
    })

    expect((await status()).fallbackTarget).toEqual({ model: 'gpt-x', provider: 'openrouter' })

    for (const name of ['binary.json', 'fallback.json']) {
      expect(fs.statSync(path.join(dir, name)).mode & 0o777).toBe(0o600)
    }

    expect(fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
    const file = path.join(dir, 'x.json')
    writeJsonAtomicSync(file, { a: 1 }, { space: 0, trailingNewline: false })
    writeJsonAtomicSync(file, { a: 2 }, { space: 0, trailingNewline: false })
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":2}')
  })

  it('only well-formed lastFallback / window / target shapes reach the renderer', async () => {
    expect(asLastFallback({ at: 5, reason: 'not_logged_in', text: 't' })).toEqual({
      at: 5,
      reason: 'not_logged_in',
      text: 't'
    })

    for (const bad of [null, 'x', { at: '5', reason: 'r', text: 't' }, { at: 5, reason: 7, text: 't' }]) {
      expect(asLastFallback(bad)).toBeNull()
    }

    expect(asWindow({ fiveHour: { resetsAt: null, utilization: 1 }, status: 'rejected' })).toEqual({
      fiveHour: { resetsAt: null, utilization: 1 },
      isUsingOverage: false,
      sevenDay: null,
      status: 'rejected'
    })

    for (const bad of [null, [], { status: 1 }, { fiveHour: { utilization: 'x' }, status: 'allowed' }]) {
      expect(asWindow(bad)).toBeNull()
    }

    expect(asTarget({ model: 'm', provider: 'claude-code-cli' })).toBeNull()
    expect(asTarget({ model: 3, provider: 'nous' })).toBeNull()
    expect(asTarget({ provider: 'nous' })).toEqual({ model: '', provider: 'nous' })

    const home = tmp()
    const dir = path.join(home, 'plugins/model-providers/claude-code')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'status.json'),
      JSON.stringify({ lastFallback: { at: 'soon', reason: {}, text: 1 }, window: { status: { x: 1 } } })
    )

    const status = createClaudeCodeStatus({
      env: {},
      exec: async () => '',
      hermesHome: home,
      home: '/nonexistent-home'
    })

    expect(await status()).toMatchObject({ fallbackTarget: null, lastFallback: null, window: null })
  })
})

describe('custom endpoints and the banner poll', () => {
  it('records a custom endpoint by URL only and hands it back validated', () => {
    const home = tmp()
    const dir = path.join(home, 'plugins/model-providers/claude-code')
    writeFallbackTarget(home, { baseUrl: 'http://127.0.0.1:9/v1', model: 'my-local-model', provider: 'custom' })
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'fallback.json'), 'utf8'))).toEqual({
      base_url: 'http://127.0.0.1:9/v1',
      model: 'my-local-model',
      provider: 'custom'
    })
    expect(readFallbackState(home).fallbackTarget).toEqual({
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'my-local-model',
      provider: 'custom'
    })
    writeFallbackTarget(home, { baseUrl: 'https://user:secret@host/v1', model: 'm', provider: 'custom' })
    expect(fs.readFileSync(path.join(dir, 'fallback.json'), 'utf8')).not.toContain('secret')
    writeFallbackTarget(home, { baseUrl: 'http://127.0.0.1:9/v1', model: 'hermes-4', provider: 'nous' })
    expect(readFallbackState(home).fallbackTarget).toEqual({ model: 'hermes-4', provider: 'nous' })
    expect(asEndpoint('file:///etc/passwd')).toBe('')
    expect(asEndpoint('javascript:alert(1)')).toBe('')
    expect(asEndpoint(`https://h/${'x'.repeat(400)}`)).toBe('')
    expect(asEndpoint(42)).toBe('')
    expect(asTarget({ base_url: 'ftp://h', model: 'm', provider: 'custom' })).toEqual({
      model: 'm',
      provider: 'custom'
    })
  })

  it('the banner state reads files only: an hour of polls starts claude 0 times', async () => {
    const home = tmp()
    const dir = path.join(home, 'plugins/model-providers/claude-code')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'status.json'),
      JSON.stringify({ lastFallback: { at: 5, reason: 'not_logged_in', text: 'Claude Code is not logged in' } })
    )
    let spawns = 0

    const status = createClaudeCodeStatus({
      env: { ICLONE_CLAUDE_BIN: '/bin/sh' },
      exec: async () => {
        spawns++

        return ''
      },
      hermesHome: home,
      home
    })

    for (let i = 0; i < 360; i++) {
      expect(readFallbackState(home).lastFallback?.reason).toBe('not_logged_in')
    }

    expect(spawns).toBe(0)
    expect((await status()).lastFallback).toEqual(readFallbackState(home).lastFallback)
  })
})
