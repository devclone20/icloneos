// V3-RT: the runtime's shipped set and its inventory against the upstream pin (RT-1).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, test } from 'vitest'

import { gitRepo, runtimeRepo } from './runtime-artifact.test-helpers.mjs'
import {
  assertCleanShippedTree,
  buildRuntimeArtifact,
  compilePycs,
  dirtyShippedPaths,
  findRuntimePython,
  gzipDeterministic,
  gzipIdentity,
  gzipStored,
  ICLONE_RUNTIME_PATHS,
  inventory,
  isShippedPath,
  listTree,
  manifestOf,
  manifestText,
  parseManifest,
  readUpstreamPin,
  runtimeEqualsRepo,
  sha256,
  tarballName,
  tarOf,
  tryRuntimePython,
  venvExclusionProblems
} from './runtime-artifact.mjs'

describe('isShippedPath (RT-2 exclusions + RT-LIC)', () => {
  test.each([
    ['hermes_cli/plugins.py', true],
    ['plugins/iclone-permissions/policy.py', true],
    ['scripts/install.sh', true],
    ['pyproject.toml', true],
    ['skills/productivity/docx/SKILL.md', true],
    ['apps/desktop/package.json', false],
    ['iclone/RUNTIME_PIN.json', false],
    ['web/public/fonts/x.woff2', false],
    ['ui-tui/package.json', false],
    ['website/index.md', false],
    ['tests/tools/test_approval.py', false],
    ['tests-js/a.test.js', false],
    ['bench/run.mjs', false],
    ['docs/guide.md', false],
    ['evals/x.py', false],
    ['packaging/python/x.py', false],
    ['packages/x/package.json', false],
    ['.github/workflows/ci.yml', false],
    ['contributors/emails/a@b.c', false],
    ['.mailmap', false],
    ['plugins/iclone-permissions/tests/fixtures/table.json', false],
    ['plugins/hermes-achievements/docs/assets/x.png', false],
    ['skills/x/__tests__/a.js', false],
    ['assets/brand/Some.ttf', false],
    ['tools/x.OTF', false],
    // Critic r1 m1: the upstream's brand art, the conference templates (no licence / LPPL / PDFs with font programs)
    // and an unlicensed voice sample are not runtime; the skill's own text and the wake-word model are.
    ['assets/banner.png', false],
    ['assets/nous-girl-white.svg', false],
    ['optional-skills/research/research-paper-writing/templates/icml2026/icml2026.sty', false],
    ['optional-skills/research/research-paper-writing/templates/colm2025/colm2025_conference.pdf', false],
    ['optional-skills/research/research-paper-writing/SKILL.md', true],
    ['tools/neutts_samples/jo.wav', false],
    // Critics' panel M-1: the test runner never ships (tests/ does not), its siblings in scripts/ still do.
    ['scripts/run_tests.sh', false],
    ['scripts/run_tests_parallel.py', true],
    ['tools/wakewords/hey_hermes.tflite', true],
    ['gateway/assets/telegram-botfather-threads-settings.jpg', true]
  ])('%s -> %s', (rel, want) => {
    assert.equal(isShippedPath(rel), want)
  })
})

describe('inventory (RT-1)', () => {
  test('the repo runtime differs from the upstream pin only in iclone files (no drift, no stale row)', () => {
    const result = inventory()

    assert.equal(result.upstream, readUpstreamPin())
    assert.deepEqual(
      result.drift.map(row => row.path),
      []
    )
    assert.deepEqual(result.stale, [])
    assert.equal(result.rows.length, Object.keys(ICLONE_RUNTIME_PATHS).length)
    assert.ok(result.rows.some(row => row.path === 'hermes_cli/iclone_policy_env.py' && row.status === 'added'))
  })

  test('a change iclone did not make is drift; an iclone row that no longer differs is stale', () => {
    const repo = gitRepo()
    repo.write('hermes_cli/plugins.py', 'upstream\n')
    repo.write('model_tools.py', 'upstream\n')
    repo.write('tools/other.py', 'upstream\n')
    repo.write('tests/test_x.py', 'upstream\n')
    const upstream = repo.commit('upstream')

    repo.write('hermes_cli/plugins.py', 'iclone\n')
    repo.write('tools/other.py', 'drifted\n')
    repo.write('tests/test_x.py', 'changed test (not shipped)\n')
    repo.write('scripts/run.sh', '#!/bin/sh\n', 0o755)
    repo.commit('fork')

    const result = inventory({ cwd: repo.dir, rev: 'HEAD', upstream })

    assert.deepEqual(
      result.drift.map(row => `${row.status} ${row.path}`),
      ['added scripts/run.sh', 'modified tools/other.py']
    )
    assert.ok(result.stale.includes('model_tools.py'))
    assert.ok(!result.stale.includes('hermes_cli/plugins.py'))
    assert.ok(!result.rows.some(row => row.path.startsWith('tests/')))
  })

  test('listTree reads git objects (not the working tree) and refuses a submodule in the shipped set', () => {
    const repo = gitRepo()
    repo.write('a.py', 'committed\n')
    const rev = repo.commit('one')
    repo.write('a.py', 'dirty working tree\n')
    repo.write('b.py', 'untracked\n')

    assert.deepEqual(
      listTree(rev, { cwd: repo.dir }).map(entry => entry.path),
      ['a.py']
    )

    repo.run('update-index', '--add', '--cacheinfo', `160000,${rev},vendor/sub`)
    repo.run('commit', '-q', '--no-verify', '-m', 'submodule')
    assert.throws(() => listTree('HEAD', { cwd: repo.dir }), /commit entry cannot ship/)
  })
})

// `check` and `pin` read git objects: an uncommitted edit to a shipped file must refuse them, never be pinned silently.
describe('dirty working tree (check / pin refuse what git objects do not show)', () => {
  test('an uncommitted edit, an untracked file and a staged deletion in the shipped set are refused, named', () => {
    const repo = gitRepo()
    repo.write('pm/environment.py', 'committed\n')
    repo.write('tools/approval.py', 'committed\n')
    repo.write('apps/desktop/package.json', '{}\n')
    repo.commit('clean')

    assert.deepEqual(dirtyShippedPaths({ cwd: repo.dir }), [])
    assertCleanShippedTree('check', { cwd: repo.dir })

    repo.write('pm/environment.py', 'edited, not committed\n')
    repo.write('hermes_cli/new.py', 'untracked\n')
    repo.run('rm', '-q', 'tools/approval.py')

    assert.deepEqual(dirtyShippedPaths({ cwd: repo.dir }), [
      'hermes_cli/new.py',
      'pm/environment.py',
      'tools/approval.py'
    ])
    assert.throws(
      () => assertCleanShippedTree('pin', { cwd: repo.dir }),
      /^Error: pin reads git objects, but the working tree has uncommitted changes to 3 shipped file\(s\); commit or stash them first:\n {2}hermes_cli\/new\.py\n {2}pm\/environment\.py\n {2}tools\/approval\.py$/
    )
  })

  test('dirty paths outside the shipped set (apps/, docs/, tests/, iclone/) do not refuse', () => {
    const repo = gitRepo()
    repo.write('pm/environment.py', 'committed\n')
    repo.write('apps/desktop/package.json', '{}\n')
    repo.write('docs/guide.md', 'committed\n')
    repo.commit('clean')

    repo.write('apps/desktop/package.json', '{ "edited": true }\n')
    repo.write('docs/guide.md', 'edited\n')
    repo.write('tests/test_new.py', 'untracked\n')
    repo.write('iclone/RUNTIME_PIN.json', '{}\n')

    assert.deepEqual(dirtyShippedPaths({ cwd: repo.dir }), [])
    assertCleanShippedTree('check', { cwd: repo.dir })
  })
})

// The pin's bytecode is compiled by the interpreter the gate names: a wrong ICLONE_RUNTIME_PY is an error, never a
// silent fall-back to whatever uv has (ICLONE_RUNTIME_PY= empty is unset, as the gate's skip rows rely on).
describe('findRuntimePython', () => {
  const fakePython = (name, body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-py-'))
    const file = path.join(dir, name)
    fs.writeFileSync(file, body, { mode: 0o755 })

    return file
  }

  test('ICLONE_RUNTIME_PY naming another version is refused by name, not replaced by uv', () => {
    const other = fakePython('python3.9', '#!/bin/sh\necho 3.9.1\n')

    assert.throws(
      () => findRuntimePython('3.14.7', { env: { ICLONE_RUNTIME_PY: other } }),
      new RegExp(
        `^Error: ICLONE_RUNTIME_PY=${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not CPython 3\\.14\\.7: it is Python 3\\.9\\.1$`
      )
    )
  })

  test('ICLONE_RUNTIME_PY that cannot run is refused by name', () => {
    const missing = path.join(os.tmpdir(), 'rt-py-none', 'python3')

    assert.throws(
      () => findRuntimePython('3.14.7', { env: { ICLONE_RUNTIME_PY: missing } }),
      /^Error: ICLONE_RUNTIME_PY=.* is not CPython 3\.14\.7: it cannot be run \(ENOENT\)$/
    )
  })

  test('ICLONE_RUNTIME_PY printing exactly the version is the answer; empty means unset (uv or the no-Python error)', () => {
    const right = fakePython('python3.14', '#!/bin/sh\necho 3.14.7\n')

    assert.equal(findRuntimePython('3.14.7', { env: { ICLONE_RUNTIME_PY: right } }), right)

    // No managed CPython 0.0.1 exists: the empty value never reaches the ICLONE_RUNTIME_PY error.
    assert.throws(
      () => findRuntimePython('0.0.1', { env: { ICLONE_RUNTIME_PY: '' } }),
      /^Error: no Python 0\.0\.1 to compile the runtime's bytecode with: set ICLONE_RUNTIME_PY, or run uv python install 0\.0\.1$/
    )
  })
})

describe('buildRuntimeArtifact (RT-2)', () => {
  test('deterministic, from git objects only, and extracts with the system tar to exactly the manifest', () => {
    const repo = runtimeRepo()
    const a = buildRuntimeArtifact({ cwd: repo.dir, rev: repo.sha, upstream: 'u'.repeat(40) })
    repo.write('pyproject.toml', 'dirty working tree\n')
    repo.write('untracked.py', 'untracked\n')
    const b = buildRuntimeArtifact({ cwd: repo.dir, rev: repo.sha, upstream: 'u'.repeat(40) })

    assert.equal(a.tarballSha256, b.tarballSha256)
    assert.equal(a.manifestSha256, sha256(a.manifestBytes))
    assert.deepEqual(parseManifest(a.manifestBytes.toString('utf8')), a.manifest)
    assert.equal(manifestText(a.manifest), a.manifestBytes.toString('utf8'))
    assert.ok(!a.manifest.entries.some(row => row[0].startsWith('tests/') || row[0].startsWith('web/')))

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-extract-'))
    fs.writeFileSync(path.join(out, 't.tar.gz'), a.tarball)
    fs.mkdirSync(path.join(out, 'x'))
    execFileSync('/usr/bin/tar', [
      '-xzf',
      path.join(out, 't.tar.gz'),
      '-C',
      path.join(out, 'x'),
      '--strip-components',
      '1'
    ])

    for (const [rel, mode, size, digest] of a.manifest.entries) {
      const file = path.join(out, 'x', rel)
      const st = fs.lstatSync(file)

      if (mode === 'link') {
        assert.ok(st.isSymbolicLink(), rel)
        assert.equal(sha256(Buffer.from(fs.readlinkSync(file))), digest, rel)
      } else {
        assert.equal(st.size, size, rel)
        assert.equal(sha256(fs.readFileSync(file)), digest, rel)
        assert.equal((st.mode & 0o111) !== 0, mode === '755', rel)
      }
    }

    const listed = execFileSync('/usr/bin/tar', ['-tzf', path.join(out, 't.tar.gz')])
      .toString()
      .split('\n')
      .filter(line => line && !line.endsWith('/'))

    assert.equal(listed.length, a.files)
    assert.ok(listed.every(line => line.startsWith(`hermes-agent-${repo.sha}/`)))
  })

  test('a commit without the iclone core is refused', () => {
    const repo = gitRepo()
    repo.write('pyproject.toml', 'x')
    repo.write('scripts/install.sh', 'x')
    const sha = repo.commit('upstream only')

    assert.throws(
      () => buildRuntimeArtifact({ cwd: repo.dir, rev: sha, upstream: sha }),
      /no hermes_cli\/iclone_policy_env\.py/
    )
  })

  test('ruling 57.2: the packer reads V3-FX exclusion list and refuses a runtime whose PM list differs', () => {
    const repo = runtimeRepo()

    assert.deepEqual(venvExclusionProblems(repo.sha, { cwd: repo.dir }), [])
    repo.write('pm/runtime-venv-exclusions.txt', 'nemo-relay\nposthog\n')
    const differs = repo.commit('PM list drifts from V3-FX')
    assert.throws(
      () => buildRuntimeArtifact({ cwd: repo.dir, rev: differs, upstream: 'u'.repeat(40) }),
      /pm\/runtime-venv-exclusions\.txt \(nemo-relay, posthog\) does not name the distributions of iclone\/telemetry\/runtime-venv-exclusions\.txt \(langfuse, nemo-relay\)/
    )
  })

  test('ruling 57.2: the packer refuses a runtime without the V3-FX exclusion list (fail closed)', () => {
    const repo = runtimeRepo()

    repo.run('rm', '-q', 'iclone/telemetry/runtime-venv-exclusions.txt')
    const missing = repo.commit('V3-FX list removed')
    assert.throws(
      () => buildRuntimeArtifact({ cwd: repo.dir, rev: missing, upstream: 'u'.repeat(40) }),
      /iclone\/telemetry\/runtime-venv-exclusions\.txt is missing or empty/
    )
  })

  test('ruling 57.2: at HEAD the list PM ships names exactly the V3-FX list', () => {
    assert.deepEqual(venvExclusionProblems('HEAD'), [])
  })

  test.each([0, 1, 65_535, 65_536, 200_001])('gzipStored(%i bytes) round-trips through zlib', size => {
    const data = Buffer.alloc(size, 0x5a)

    assert.deepEqual(gunzipSync(gzipStored(data)), data)
    assert.deepEqual(gzipStored(data), gzipStored(Buffer.from(data)))
  })
})

describe('runtimeEqualsRepo (RT-5)', () => {
  /** A bundle folder exactly as fetch-runtime-pin writes it, and the pin record of it. */
  function bundled(repo) {
    const artifact = buildRuntimeArtifact({ cwd: repo.dir, rev: repo.sha, upstream: 'u'.repeat(40) })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-equal-'))
    fs.writeFileSync(path.join(dir, tarballName(repo.sha)), artifact.tarball)
    fs.writeFileSync(path.join(dir, 'RUNTIME_MANIFEST.json'), artifact.manifestBytes)
    fs.writeFileSync(path.join(dir, 'install.sh'), artifact.installSh)
    const pin = {
      sha: repo.sha,
      source: 'repo',
      tarball_sha256: artifact.tarballSha256,
      manifest_sha256: artifact.manifestSha256,
      install_sh_sha256: artifact.installShSha256,
      files: artifact.files
    }

    return { artifact, dir, pin }
  }

  const required = ['hermes_cli/iclone_policy_env.py']

  test('the bundle built from the commit is that commit: no problem', () => {
    const repo = runtimeRepo()
    const { dir, pin } = bundled(repo)

    assert.deepEqual(runtimeEqualsRepo({ cwd: repo.dir, dir, pin, required, rev: repo.sha }), [])
  })

  test('review r1 major D: check runs the ruling-57.2 gate at the commit it is checking, not at the build rev', () => {
    // The gate used to live only inside buildRuntimeArtifact, which the packer always calls at pin.sha — and the
    // V3-FX list is outside the shipped set, so a late change to it neither staled the pin nor reached the packer.
    // Landing the divergence AFTER the pin therefore shipped it. `check` now refuses it.
    const repo = runtimeRepo()
    const { dir, pin } = bundled(repo)

    assert.deepEqual(runtimeEqualsRepo({ cwd: repo.dir, dir, pin, required, rev: repo.sha }), [])

    // The escape is the V3-FX list, which is OUTSIDE the shipped set: changing the PM list instead would stale the
    // bundle and be caught by the file comparison, so it would not prove this hole.
    repo.write('iclone/telemetry/runtime-venv-exclusions.txt', 'nemo-relay\nposthog\n')

    const after = repo.commit('the V3-FX list drifts from PM, after the pin')
    const problems = runtimeEqualsRepo({ cwd: repo.dir, dir, pin, required, rev: after })

    assert.ok(
      problems.some(problem => /does not name the distributions of/.test(problem)),
      `check did not refuse the drifted list: ${JSON.stringify(problems)}`
    )
  })

  test('an upstream tarball pin is refused (mutation row: ship the upstream tarball)', () => {
    const repo = runtimeRepo()
    const { dir, pin } = bundled(repo)
    const upstream = { sha: '1ac3f97fbe0958aa2743c0c26202b20b3b4e760e', tarball_sha256: 'a'.repeat(64) }

    assert.match(
      runtimeEqualsRepo({ cwd: repo.dir, dir, pin: upstream, required, rev: repo.sha }).join('\n'),
      /not built from this repository \(source upstream/
    )
    assert.match(
      runtimeEqualsRepo({ cwd: repo.dir, dir, pin: { ...pin, source: undefined }, required }).join('\n'),
      /not built from this repository/
    )
  })

  test('a commit that drops an iclone core file after the pin is red (mutation row: drop one core file)', () => {
    const repo = runtimeRepo()
    const { dir, pin } = bundled(repo)
    repo.run('rm', '-q', 'hermes_cli/iclone_policy_env.py')
    repo.run('commit', '-q', '--no-verify', '-m', 'drop the core')

    const problems = runtimeEqualsRepo({ cwd: repo.dir, dir, pin, required, rev: 'HEAD' }).join('\n')

    assert.match(problems, /is not the repository at [0-9a-f]{12} \(1: extra hermes_cli\/iclone_policy_env\.py\)/)
  })

  test('a bundle whose manifest drops a core file (rebuilt and re-pinned to match) is still red', () => {
    const repo = runtimeRepo()
    const { dir, pin } = bundled(repo)

    assert.match(
      runtimeEqualsRepo({ cwd: repo.dir, dir, pin, required: [...required, 'tools/approval.py'] }).join('\n'),
      /the iclone core is not all in the runtime \(missing tools\/approval\.py\)/
    )
  })

  test('a tarball that is not its manifest is red even when the pin names its bytes (mutation row: mismatch ignored)', () => {
    const repo = runtimeRepo()
    const { artifact, dir, pin } = bundled(repo)
    const files = artifact.manifest.entries.map(([rel, mode]) => ({
      data:
        rel === 'hermes_cli/iclone_policy_env.py'
          ? Buffer.from('KEY = None\n')
          : execFileSync('git', ['show', `${repo.sha}:${rel}`], { cwd: repo.dir }),
      mode,
      path: rel
    }))
    const forged = gzipStored(tarOf(files, { top: `hermes-agent-${repo.sha}`, mtime: 0 }))
    fs.writeFileSync(path.join(dir, tarballName(repo.sha)), forged)

    const problems = runtimeEqualsRepo({
      cwd: repo.dir,
      dir,
      pin: { ...pin, tarball_sha256: sha256(forged) },
      required,
      rev: repo.sha
    })

    assert.deepEqual(problems, ['the tarball is not the manifest (1: differs hermes_cli/iclone_policy_env.py)'])
  })

  const realPin = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, '../../../iclone/RUNTIME_PIN.json'), 'utf8')
  )
  const realPython = realPin.python ? tryRuntimePython(realPin.python, realPin.python_build?.executable_sha256) : null

  test.skipIf(!realPython)(
    'a shipped module with a SyntaxWarning is refused (every spawn would print it on stderr)',
    () => {
      const file = (rel, text) => ({ path: rel, mode: '644', data: Buffer.from(text) })

      assert.throws(
        () => compilePycs([file('pm/bad.py', '"""C:\\Windows\\System32 at \\W"""\n')], { python: realPython }),
        /SyntaxWarnings under 3\.14\.\d+: pm\/bad\.py:1: "\\W" is an invalid escape sequence/
      )
      assert.equal(
        compilePycs([file('pm/good.py', 'r"""C:\\Windows at \\W"""\n')], { python: realPython }).pycs.length,
        1
      )
    }
  )

  // Critics' panel, minor 4: the pin's version string is not the pin's build. The same interpreter is refused when the
  // sha256 it must have is another one, and accepted with its own.
  test.skipIf(!realPython)(
    'tryRuntimePython refuses an interpreter of the pin version whose build is not the pin',
    () => {
      assert.equal(tryRuntimePython(realPin.python, 'f'.repeat(64)), null)
      assert.equal(tryRuntimePython(realPin.python, realPin.python_build.executable_sha256), realPython)
    }
  )

  // Needs the pin's exact CPython (ICLONE_RUNTIME_PY or uv's managed one): V3RT_gates.sh sets it and requires this row.
  test.skipIf(realPin.python && !realPython)(
    'the committed pin is the repository at HEAD: the bundle this commit packs equals its git content',
    () => {
      const pin = realPin
      const artifact = buildRuntimeArtifact({ rev: pin.sha, python: realPython })
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-equal-real-'))
      fs.writeFileSync(path.join(dir, tarballName(pin.sha)), artifact.tarball)
      fs.writeFileSync(path.join(dir, 'RUNTIME_MANIFEST.json'), artifact.manifestBytes)
      fs.writeFileSync(path.join(dir, 'install.sh'), artifact.installSh)

      try {
        assert.equal(artifact.tarballSha256, pin.tarball_sha256)
        assert.deepEqual(runtimeEqualsRepo({ dir, pin, python: realPython, rev: 'HEAD' }), [])
      } finally {
        fs.rmSync(dir, { force: true, recursive: true })
      }
    },
    120_000
  )
})

// Ruling 37: the artifact ships PEP 552 checked-hash bytecode, covered by the manifest. Any CPython works for the fixture.
const FIXTURE_PY = process.env.ICLONE_RUNTIME_PY || '/usr/bin/python3'

describe('checked-hash bytecode (ruling 37)', () => {
  test('every shipped .py but the V3-S plugin folders gets one, deterministic, checked-hash, in the manifest', () => {
    const repo = runtimeRepo()
    repo.write('plugins/iclone-permissions/policy.py', 'X = 1\n')
    repo.write('tools/broken.py', 'def (:\n')
    const sha = repo.commit('more')
    const a = buildRuntimeArtifact({ cwd: repo.dir, rev: sha, upstream: 'u'.repeat(40), python: FIXTURE_PY })
    const b = buildRuntimeArtifact({ cwd: repo.dir, rev: sha, upstream: 'u'.repeat(40), python: FIXTURE_PY })
    const rows = a.manifest.entries.map(row => row[0])
    const pycs = rows.filter(rel => rel.endsWith('.pyc'))

    assert.equal(a.tarballSha256, b.tarballSha256)
    assert.equal(a.manifest.pycs, pycs.length)
    assert.match(a.manifest.python, /^\d+\.\d+\.\d+$/)
    assert.ok(pycs.some(rel => /^hermes_cli\/__pycache__\/iclone_policy_env\.cpython-\d+\.pyc$/.test(rel)))
    assert.ok(!pycs.some(rel => rel.startsWith('plugins/iclone-')))
    // Not valid Python (the fixture's long-path files are plain text too): skipped, counted, never shipped as bytecode.
    assert.ok(a.pycFailed.includes('tools/broken.py'))
    assert.ok(!pycs.some(rel => rel.startsWith('tools/__pycache__/broken.')))

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-pyc-'))
    fs.writeFileSync(path.join(out, 't.tar.gz'), a.tarball)
    execFileSync('/usr/bin/tar', ['-xzf', path.join(out, 't.tar.gz'), '-C', out, '--strip-components', '1'])
    const pyc = fs.readFileSync(
      path.join(
        out,
        pycs.find(rel => rel.includes('iclone_policy_env'))
      )
    )
    // PEP 552 header: flags word = 0b11 (hash-based, checked).
    assert.equal(pyc.readUInt32LE(4), 3)
  })

  test('RT-5 re-compiles the bytecode: a forged pyc the pin names is red, and no Python means not verified', () => {
    const repo = runtimeRepo()
    const artifact = buildRuntimeArtifact({
      cwd: repo.dir,
      rev: repo.sha,
      upstream: 'u'.repeat(40),
      python: FIXTURE_PY
    })
    const pycRel = artifact.manifest.entries.find(row => row[0].endsWith('.pyc'))[0]
    const files = artifact.manifest.entries.map(([rel, mode]) => ({
      data:
        rel === pycRel
          ? Buffer.concat([Buffer.from('forged'), Buffer.alloc(32)])
          : rel.endsWith('.pyc')
            ? null
            : execFileSync('git', ['show', `${repo.sha}:${rel}`], { cwd: repo.dir }),
      mode,
      path: rel
    }))
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-pyc-forge-'))
    fs.writeFileSync(path.join(tmp, 't.tar.gz'), artifact.tarball)
    fs.mkdirSync(path.join(tmp, 'x'))
    execFileSync('/usr/bin/tar', [
      '-xzf',
      path.join(tmp, 't.tar.gz'),
      '-C',
      path.join(tmp, 'x'),
      '--strip-components',
      '1'
    ])

    for (const file of files) {
      if (file.data === null) file.data = fs.readFileSync(path.join(tmp, 'x', file.path))
    }

    const forgedFiles = files.map(file => (file.path === pycRel ? file : file))
    const manifestBytes = Buffer.from(
      manifestText(
        manifestOf(forgedFiles, {
          python: artifact.python,
          pycs: artifact.pycs,
          sha: repo.sha,
          upstream: 'u'.repeat(40)
        })
      ),
      'utf8'
    )
    const tarball = gzipStored(tarOf(forgedFiles, { top: `hermes-agent-${repo.sha}`, mtime: 0 }))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-pyc-dir-'))
    fs.writeFileSync(path.join(dir, tarballName(repo.sha)), tarball)
    fs.writeFileSync(path.join(dir, 'RUNTIME_MANIFEST.json'), manifestBytes)
    fs.writeFileSync(path.join(dir, 'install.sh'), artifact.installSh)
    const pin = {
      sha: repo.sha,
      source: 'repo',
      tarball_sha256: sha256(tarball),
      manifest_sha256: sha256(manifestBytes),
      install_sh_sha256: artifact.installShSha256,
      files: artifact.files
    }
    const required = ['hermes_cli/iclone_policy_env.py']

    assert.deepEqual(runtimeEqualsRepo({ cwd: repo.dir, dir, pin, python: FIXTURE_PY, required, rev: repo.sha }), [
      `the bundled runtime is not the repository at ${repo.sha.slice(0, 12)} (1: differs ${pycRel}); rebuild the pin: node scripts/runtime-artifact.mjs pin`
    ])
    assert.match(
      runtimeEqualsRepo({ cwd: repo.dir, dir, pin, required, rev: repo.sha }).join('\n'),
      /re-verifying it needs that Python/
    )
  })
})

describe('compression (K-RT10)', () => {
  test('Node zlib level 9, header mtime 0, no name, OS unknown: platform-neutral bytes that round-trip', () => {
    const data = Buffer.from('hermes '.repeat(50_000))
    const a = gzipDeterministic(data)
    const b = gzipDeterministic(Buffer.from(data))

    assert.deepEqual(a, b)
    assert.deepEqual([...a.subarray(0, 4)], [0x1f, 0x8b, 8, 0]) // gzip, deflate, FLG 0: no name, no comment, no extra
    assert.equal(a.readUInt32LE(4), 0) // mtime
    assert.equal(a[9], 0xff) // OS unknown
    assert.ok(a.length < data.length / 20)
    assert.deepEqual(gunzipSync(a), data)
    assert.match(gzipIdentity(), /^zlib \S+ level 9$/)
  })

  test('an artifact names its compressor and two builds are byte-identical', () => {
    const repo = runtimeRepo()
    const a = buildRuntimeArtifact({ cwd: repo.dir, rev: repo.sha, upstream: 'u'.repeat(40) })
    const b = buildRuntimeArtifact({ cwd: repo.dir, rev: repo.sha, upstream: 'u'.repeat(40) })

    assert.equal(a.gzip, gzipIdentity())
    assert.deepEqual(a.tarball, b.tarball)
    assert.equal(a.tarball[9], 0xff)
  })
})
