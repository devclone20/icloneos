/**
 * V3-RT (RT-4 live finding): the runtime's PM builds the dependency environment outside the tree; the app must launch
 * the committed one, or a fresh install loops on "no Hermes install found" forever.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { pmCommittedVenv } from './pm-venv'

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-venv-'))
  const root = path.join(home, 'hermes-agent')
  fs.mkdirSync(root)
  const key = createHash('sha256').update(fs.realpathSync(root), 'utf8').digest('hex').slice(0, 16)
  const env = path.join(home, 'installs', key, 'environments', 'gen1', 'venv')
  fs.mkdirSync(path.join(env, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(env, 'pyvenv.cfg'), 'version = 3.14.7\n')
  fs.writeFileSync(path.join(env, 'bin', 'python'), '')
  const facts = path.join(home, 'installs', key, 'facts.json')
  fs.writeFileSync(facts, JSON.stringify({ packages: { venv: { environment: env } }, schema: 1 }))

  return { env, facts, home, root }
}

describe('pmCommittedVenv', () => {
  it("answers PM's committed environment for the root (install key = sha256 of the resolved root, 16 hex)", () => {
    const f = fixture()

    expect(pmCommittedVenv(f.root, f.home)).toBe(f.env)
  })

  it('answers null when PM recorded nothing, a relative path, or an environment that is gone', () => {
    const f = fixture()

    expect(pmCommittedVenv(path.join(f.home, 'other'), f.home)).toBeNull()
    fs.writeFileSync(f.facts, JSON.stringify({ packages: { venv: { environment: 'venv' } } }))
    expect(pmCommittedVenv(f.root, f.home)).toBeNull()
    fs.writeFileSync(f.facts, JSON.stringify({ packages: { venv: { environment: f.env } } }))
    fs.rmSync(path.join(f.env, 'pyvenv.cfg'))
    expect(pmCommittedVenv(f.root, f.home)).toBeNull()
    fs.writeFileSync(f.facts, '{not json')
    expect(pmCommittedVenv(f.root, f.home)).toBeNull()
  })
})
