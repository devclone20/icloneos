import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, test } from 'vitest'

import { planSpawn, readSpawnSpec, SPAWN_MAX_PANES } from './spec'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'v3d-spec-'))
  mkdirSync(path.join(dir, 'work'))
})

afterEach(() => rmSync(dir, { force: true, recursive: true }))

const spec = (panes: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ panes, ...extra })

test('eight panes with role, cwd, env and group come back resolved', () => {
  const panes = Array.from({ length: 8 }, (_, i) => ({
    name: `w${i}`,
    role: 'builder',
    cwd: 'work',
    cmd: 'echo hi',
    env: { PANE_STEP: String(i) },
    group: 'crew'
  }))

  const result = planSpawn(spec(panes), dir)

  expect(result.ok).toBe(true)

  if (result.ok) {
    expect(result.plan.panes).toHaveLength(8)
    expect(result.plan.panes[3]).toEqual({
      name: 'w3',
      role: 'builder',
      cwd: path.join(dir, 'work'),
      cmd: 'echo hi',
      env: { PANE_STEP: '3' },
      group: 'crew'
    })
  }
})

test.each([
  ['17 panes', spec(Array.from({ length: SPAWN_MAX_PANES + 1 }, (_, i) => ({ name: `p${i}` }))), 'at most 16'],
  ['a ../ cwd', spec([{ name: 'a', cwd: '../' }]), 'without ".."'],
  ['a nested ../ cwd', spec([{ name: 'a', cwd: 'work/../../etc' }]), 'without ".."'],
  ['a newline in a name', spec([{ name: 'a\nb' }]), 'name must match'],
  ['a 40-character name', spec([{ name: 'a'.repeat(40) }]), 'name must match'],
  ['a missing cwd', spec([{ name: 'a', cwd: 'nowhere' }]), 'is not a directory'],
  ['an ICLONE_ env key', spec([{ name: 'a', env: { ICLONE_PANE_TOKEN: 'x' } }]), 'not allowed'],
  ['an unknown pane field', spec([{ name: 'a', sudo: true }]), 'unknown field "sudo"'],
  ['an unknown spec field', spec([{ name: 'a' }], { hooks: [] }), 'unknown field "hooks"'],
  ['a duplicate name', spec([{ name: 'a' }, { name: 'a' }]), 'used twice'],
  ['not JSON', 'panes: [a]', 'not JSON']
])('rejects %s', (_label, text, message) => {
  const result = planSpawn(text, dir)

  expect(result.ok).toBe(false)

  if (!result.ok) {
    expect(result.errors.join('\n')).toContain(message)
  }
})

test('a spec file must be absolute, regular and small', () => {
  const file = path.join(dir, 'spec.json')

  writeFileSync(file, spec([{ name: 'solo', cwd: 'work' }]))

  expect(readSpawnSpec(file).ok).toBe(true)
  expect(readSpawnSpec('spec.json').ok).toBe(false)
  expect(readSpawnSpec(dir).ok).toBe(false)
})

const RUNS_CODE = [
  'ZDOTDIR',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'PS4',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'PYTHONSTARTUP',
  'PERL5OPT',
  'RUBYOPT',
  'GIT_SSH_COMMAND',
  'JAVA_TOOL_OPTIONS',
  'PATH',
  'LESSOPEN',
  'npm_config_script_shell'
]

test.each(RUNS_CODE)('env %s can run code around the reviewed cmd: refused, with the reason', key => {
  const result = planSpawn(spec([{ name: 'a', env: { [key]: '/tmp/x' } }]), dir)

  expect(result.ok).toBe(false)

  if (!result.ok) {
    expect(result.errors.join('\n')).toContain(`env key "${key}" can run code; put it in cmd`)
  }
})

test('env is an allow-list: inert names, LC_*, PANE_*; anything else is refused with the way out', () => {
  const allowed = planSpawn(
    spec([{ name: 'a', env: { PORT: '3000', NODE_ENV: 'test', LC_ALL: 'C', PANE_TASK: 'lint' } }]),
    dir
  )

  expect(allowed.ok).toBe(true)

  const unknown = planSpawn(spec([{ name: 'a', env: { STEP: '3' } }]), dir)

  expect(unknown.ok).toBe(false)

  if (!unknown.ok) {
    expect(unknown.errors.join('\n')).toContain('use PANE_STEP (the program then reads $PANE_STEP, not $STEP)')
  }
})
