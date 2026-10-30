// Ruling 69 / review r2 (R2-M6): the skills the app ships (Resources/hermes-skill) are in English.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, test } from 'vitest'

import { portugueseLines, portugueseMarker } from './skills-english.mjs'

const CLI = fileURLToPath(new URL('./skills-english.mjs', import.meta.url))
const temps = []

afterAll(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** A throwaway skill tree with `files` (relative path -> text or bytes). */
const bundle = files => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-english-'))

  temps.push(root)

  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), body)
  }

  return root
}

const cli = root => spawnSync(process.execPath, [CLI, root], { encoding: 'utf8' })

describe('skills-english: the shipped skill tree reads as English (R2-M6)', () => {
  test('the committed tree that ships as Resources/hermes-skill has no line in Portuguese', () => {
    assert.deepEqual(
      portugueseLines().map(hit => `${hit.file}:${hit.line} (${hit.marker})`),
      []
    )
  })

  test('the scan has teeth: pt-PT, pt-BR without accents and a Portuguese trigger phrase are each caught', () => {
    for (const line of [
      'description: Editar vídeo no DaVinci Resolve a partir do Claude Code',
      'Use quando o dono pedir uma revisao de seguranca',
      "Use when the owner says 'fala com a minha voz'",
      '    gh auth status || { echo "peça ao dono para autenticar o gh"; exit 1; }',
      // Review r3 (R3-m2, mutant S1): no accent and none of the single marker words; two short pt words mark it.
      'Corre o teste de novo e mostra o resultado ao lead.'
    ]) {
      assert.notEqual(portugueseMarker(line), null, line)
    }
  })

  // Review r4 (B1-9): the step was green on silence. Each case runs the CLI itself, as the gate row does.
  test('CLI: a clean tree prints what it scanned (files, lines, 0 Portuguese) and exits 0', () => {
    const root = bundle({ 'a/SKILL.md': 'One line.\nTwo lines.\n', 'b/run.sh': 'echo ok\n' })
    const run = cli(root)

    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /^\[skills-english\] OK 2 files, 3 lines scanned, 0 Portuguese, 0 binary$/m)
  })

  test('CLI: a tree with no file is refused (an empty bundle proves nothing)', () => {
    const run = cli(bundle({}))

    assert.equal(run.status, 1)
    assert.match(run.stderr, /0 files to scan, an empty skill bundle proves nothing/)
  })

  test('CLI: bytecode and NUL-byte files are refused by name as binary, never read as Portuguese', () => {
    const root = bundle({
      'x/SKILL.md': 'English only.\n',
      // A real .pyc's header is bytes, and its marshalled strings can hold anything (here, Portuguese words).
      'x/scripts/__pycache__/tool.cpython-314.pyc': Buffer.concat([
        Buffer.from([0x2b, 0x0e, 0x0d, 0x0a, 0, 0, 0, 0]),
        Buffer.from('não para com\n')
      ]),
      'x/assets/blob.bin': Buffer.from([0x41, 0x00, 0x42, 0x0a])
    })
    const run = cli(root)

    assert.equal(run.status, 1)
    assert.match(
      run.stderr,
      /RED x\/scripts\/__pycache__\/tool\.cpython-314\.pyc binary file in skill bundle \(bytecode\)/
    )
    assert.match(run.stderr, /RED x\/assets\/blob\.bin binary file in skill bundle \(NUL bytes\)/)
    assert.doesNotMatch(run.stderr, /reads as Portuguese/)
  })

  test('English with a URL, an e-mail, a host or a reverse-DNS id is not mistaken for Portuguese', () => {
    for (const line of [
      'See https://github.com/github/spec-kit for the original.',
      'Co-Authored-By: Claude <noreply@anthropic.com>',
      'The driver bundle id is com.trycua.driver; the mirror is example.com.br.',
      '[0:a]atrim=D-11:D,asetpts=PTS-STARTPTS[ao]; { kind: "num", def: 40 }',
      // Short English words a Portuguese line also has (a, do, no, as, os, e, se) never count as a pair.
      'Do a final pass: run `ps -o pid` as the setup does, e.g. with `import os, sys`, and see if no file is left.'
    ]) {
      assert.equal(portugueseMarker(line), null, line)
    }
  })
})
