import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'vitest'

import { checkAcpAbsent } from './acp-pack-absent.mjs'
import {
  checkDebControl,
  checkSelftestFiles,
  checkSelftestOutput,
  classifyBinary,
  DESKTOP_DIR,
  findMachO,
  foreignElf,
  linuxArtifactNames,
  parseArgs,
  releaseLinux,
  REQUIRED_DEPENDS,
  scanBinaries
} from './release-linux.mjs'

// Ruling 48: a test never reads the owner's private markers file, whatever the shell exports.
delete process.env.ICLONE_PRIVATE_MARKERS

const require = createRequire(import.meta.url)

// e_ident + e_type + e_machine of a 64-bit ELF; `be` = big-endian header.
function elfHead(machine, be = false) {
  const head = Buffer.alloc(20)
  Buffer.from('7f454c4602', 'hex').copy(head)
  head[5] = be ? 2 : 1
  if (be) head.writeUInt16BE(machine, 18)
  else head.writeUInt16LE(machine, 18)
  return head
}

// The control file dpkg-deb prints for the deb named in `debPath` (its Architecture follows the file name).
const controlFor = debPath =>
  DEB_CONTROL.replace(/^Architecture: .*$/m, `Architecture: ${/arm64/.test(debPath) ? 'arm64' : 'amd64'}`)

const X64_SIGNER = { elf: [{ machine: 62, path: '/u/resources/acp-cli/bin/acp-cli-signer-linux' }], machO: [] }
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf8'))
const REPO = path.resolve(DESKTOP_DIR, '..', '..')
const temps = []

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-release-linux-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const DEB_CONTROL = `Package: iclone-os
Version: 1.1.0
Architecture: amd64
Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libuuid1, libasound2t64 | libasound2, libgbm1, libsecret-1-0, libsecret-tools, gnome-keyring | kwalletmanager, git, curl, tar, ca-certificates, python3, libatomic1
Maintainer: CLONE FRAME <https://cloneframe.io>
`
const DESKTOP_ENTRY = `[Desktop Entry]
Name=iclone os
Exec=/opt/iclone os/iclone-os %U
MimeType=x-scheme-handler/iclone;
`

describe('electron-builder linux config', () => {
  const b = pkg.build

  test('passes electron-builder schema validation', async () => {
    const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js')
    await validateConfiguration(structuredClone(b), { isEnabled: false, add() {} })
  })

  test('linux block: category, executable, icon, desktop entry with the iclone scheme, deb + AppImage x64/arm64', () => {
    assert.equal(b.linux.category, 'Development')
    assert.equal(b.linux.executableName, 'iclone-os')
    assert.equal(b.linux.icon, 'assets/icon.png')
    assert.ok(fs.existsSync(path.join(DESKTOP_DIR, b.linux.icon)))
    assert.match(b.linux.maintainer, /cloneframe\.io/)
    assert.match(b.linux.vendor, /cloneframe\.io/)
    assert.equal(b.linux.desktop.entry.MimeType, 'x-scheme-handler/iclone;')
    assert.equal(b.linux.desktop.entry.StartupWMClass, 'iclone-os')
    assert.deepEqual(b.linux.target, [
      { target: 'deb', arch: ['x64', 'arm64'] },
      { target: 'AppImage', arch: ['x64', 'arm64'] }
    ])
    assert.equal(b.linux.artifactName, 'iclone-os-${version}-linux-${arch}.${ext}')
  })

  test('deb Depends keeps electron-builder defaults and adds the keyring + runtime tools', () => {
    assert.equal(b.deb.packageName, 'iclone-os')
    for (const dep of ['libgtk-3-0', 'libnss3', 'xdg-utils', ...REQUIRED_DEPENDS]) {
      assert.ok(b.deb.depends.includes(dep), dep)
    }
    assert.equal(b.deb.afterInstall, undefined, 'a custom postinst would drop the chrome-sandbox setup')
  })

  test('REL-6: no platform packs the ACP CLI; mac, win and linux ship only the pin (lockfile + our launcher)', () => {
    assert.equal(b.executableName, 'iclone os')
    const pin = [
      { from: 'acp-cli-lock', to: 'acp-pin', filter: ['package.json', 'package-lock.json'] },
      { from: 'scripts/acp-launch.cjs', to: 'acp-pin/launch.cjs' }
    ]
    for (const entries of [b.extraResources, b.mac.extraResources, b.win.extraResources, b.linux.extraResources]) {
      assert.ok(
        !entries.some(entry => /acp-cli/.test(entry.to) || /^build\/acp-cli/.test(entry.from)),
        'no acp-cli tree'
      )
    }
    for (const entries of [b.mac.extraResources, b.win.extraResources, b.linux.extraResources]) {
      assert.deepEqual(
        entries.filter(entry => entry.to.startsWith('acp-pin')),
        pin
      )
    }
    assert.ok(!pkg.scripts.build.includes('stage-acp-cli'), 'the build stages no ACP CLI')
    // The pinned runtime bundle is mac + linux only (Windows installs through install.ps1, no bundle branch).
    const runtime = {
      from: 'build/hermes-runtime',
      to: 'hermes-runtime',
      filter: ['hermes-agent-*.tar.gz', 'install.sh', 'BUNDLE.json', 'RUNTIME_MANIFEST.json']
    }
    assert.deepEqual(
      b.mac.extraResources.find(entry => entry.to === 'hermes-runtime'),
      runtime
    )
    assert.deepEqual(
      b.linux.extraResources.find(entry => entry.to === 'hermes-runtime'),
      runtime
    )
  })

  test('ships the R10 legal folder and the R12 hermes-plugins folder on every platform', () => {
    const top = Object.fromEntries(b.extraResources.map(entry => [entry.from, entry.to]))
    assert.equal(top['../../iclone/legal'], 'legal')
    assert.equal(top['../../iclone/hermes-plugins'], 'hermes-plugins')
    assert.equal(top['../../iclone/diagnostics'], 'diagnostics')
    assert.equal(top['../../iclone/skills'], 'hermes-skill')
  })

  test('scripts: dist:linux builds deb + AppImage only; web and distribution entry points exist', () => {
    assert.equal(pkg.scripts['dist:linux'], 'npm run build && npm run builder -- --linux deb AppImage')
    for (const script of ['release:linux', 'build:web', 'distribution']) {
      const file = pkg.scripts[script].split(' ')[1]
      assert.ok(fs.existsSync(path.join(DESKTOP_DIR, file)), file)
    }
  })
})

describe('release-linux', () => {
  test('parseArgs requires a known arch', () => {
    assert.deepEqual(parseArgs(['--arch', 'arm64', '--skip-build']), {
      arch: 'arm64',
      skipBuild: true,
      checkSelftest: [],
      checkSelftestMode: 'pty'
    })
    assert.throws(() => parseArgs([]), /--arch/)
    assert.throws(() => parseArgs(['--arch', 'ia32']), /--arch/)
    assert.throws(() => parseArgs(['--arch', 'x64', '--sign']), /unknown argument/)
  })

  test('artifact names follow electron-builder per-target arch spelling', () => {
    assert.deepEqual(linuxArtifactNames('1.1.0', 'x64'), {
      deb: 'iclone-os-1.1.0-linux-amd64.deb',
      appImage: 'iclone-os-1.1.0-linux-x86_64.AppImage',
      updateInfo: 'latest-linux.yml',
      unpacked: 'linux-unpacked',
      sums: 'SHA256SUMS-linux-x64.txt'
    })
    assert.equal(linuxArtifactNames('1.1.0', 'arm64').updateInfo, 'latest-linux-arm64.yml')
  })

  test('findMachO flags darwin binaries and ignores ELF', () => {
    const dir = tempDir()
    fs.mkdirSync(path.join(dir, 'resources', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'resources', 'bin', 'ok'), Buffer.from('7f454c46020101', 'hex'))
    fs.writeFileSync(path.join(dir, 'resources', 'bin', 'pty.node'), Buffer.from('cffaedfe07000001', 'hex'))
    assert.deepEqual(findMachO(dir), [path.join(dir, 'resources', 'bin', 'pty.node')])
  })

  test('checkDebControl accepts the expected control file and refuses gaps', () => {
    assert.deepEqual(checkDebControl(DEB_CONTROL, DESKTOP_ENTRY).problems, [])
    const bad = checkDebControl(
      DEB_CONTROL.replace(', libsecret-tools', '').replace('iclone-os', 'iclone os'),
      'Exec=x\n'
    )
    assert.deepEqual(bad.problems, [
      'Depends lacks libsecret-tools',
      'Package is iclone os, expected iclone-os',
      'desktop entry has no x-scheme-handler/iclone',
      'desktop entry Exec does not run iclone-os'
    ])
  })

  test('checkDebControl refuses a deb without the libraries Electron links at load time', () => {
    const control = DEB_CONTROL.replace(' libasound2t64 | libasound2,', '').replace(' libgbm1,', '')
    assert.deepEqual(checkDebControl(control, DESKTOP_ENTRY).problems, [
      'Depends lacks libasound2t64 | libasound2',
      'Depends lacks libgbm1'
    ])
    assert.ok(pkg.build.deb.depends.includes('libasound2t64 | libasound2'))
    assert.ok(pkg.build.deb.depends.includes('libgbm1'))
    assert.ok(pkg.build.deb.depends.includes('libatomic1'))
    assert.deepEqual(checkDebControl(DEB_CONTROL.replace(', libatomic1', ''), DESKTOP_ENTRY).problems, [
      'Depends lacks libatomic1'
    ])
  })

  test('parseArgs: --check-selftest needs no arch and a file', () => {
    assert.deepEqual(parseArgs(['--check-selftest', 'a.txt', '--check-selftest', 'b.txt']).checkSelftest, [
      'a.txt',
      'b.txt'
    ])
    assert.throws(() => parseArgs(['--check-selftest']), /needs a file/)
  })

  test('checkSelftestOutput passes one packaged pty report among log lines and refuses everything else', () => {
    const report = fields =>
      JSON.stringify({ selftest: 'pty', ok: true, electron: '40.0.0', packaged: true, pty: { ok: true }, ...fields })
    const logs = ['[iclone-selftest] mode=pty', '[1:1017/ERROR:bus.cc(407)] Failed to connect to the bus']
    assert.deepEqual(checkSelftestOutput([...logs, report({}), ''].join('\n')), [])
    assert.deepEqual(checkSelftestOutput(logs.join('\n')), ['expected one self-test report, found 0'])
    assert.deepEqual(checkSelftestOutput([report({}), report({})].join('\n')), [
      'expected one self-test report, found 2'
    ])
    assert.deepEqual(checkSelftestOutput(report({ ok: false, pty: { ok: false, error: 'node-pty: exit 1' } })), [
      `self-test failed: ${report({ ok: false, pty: { ok: false, error: 'node-pty: exit 1' } })}`,
      'pty check did not pass'
    ])
    assert.deepEqual(checkSelftestOutput(report({ packaged: false })), ['self-test did not run the packaged app'])
    assert.deepEqual(checkSelftestOutput(report({ selftest: 'acp', pty: undefined })), [
      'self-test ran mode acp, expected pty',
      'pty check did not pass'
    ])
    assert.deepEqual(checkSelftestOutput(report({ selftest: 'all', acp: { ok: true } }), 'all'), [])
  })

  test('release-linux.yml smoke-tests both packages in a clean ubuntu:24.04 before anything is uploaded', () => {
    const yaml = require('js-yaml')
    const workflow = yaml.load(
      fs.readFileSync(path.join(DESKTOP_DIR, '..', '..', '.github', 'workflows', 'release-linux.yml'), 'utf8')
    )
    const steps = workflow.jobs.build.steps
    const index = name => steps.findIndex(step => step.name?.startsWith(name))
    const smoke = steps[index('Smoke test')]
    assert.ok(smoke, 'no smoke step')
    assert.ok(index('Build, pack and check') < index('Smoke test'))
    assert.ok(index('Smoke test') < index('Collect the files'))
    assert.ok(index('Collect the files') < index('Upload artifacts'))
    assert.equal(smoke['continue-on-error'], undefined)
    assert.ok(steps.every(step => step['continue-on-error'] === undefined))

    const inner = smoke.run.split("<<'SMOKE'\n")[1].split('\nSMOKE\n')[0]
    const at = needle => {
      const where = inner.indexOf(needle)
      assert.ok(where >= 0, `container script lacks ${needle}`)
      return where
    }
    assert.equal(inner.split('\n')[0], 'set -euo pipefail')
    assert.ok(
      at('dpkg -i "$deb" || apt-get install -y -qq -f --no-install-recommends') < at("= 'install ok installed'")
    )
    // The shared-library check runs before xvfb is installed, so only the .deb's own Depends can satisfy it.
    assert.ok(at('ldd "$lib"') < at('apt-get install -y -qq --no-install-recommends xvfb xauth'))
    assert.ok(
      at('xvfb xauth') < at('xvfb-run -a iclone-os --iclone-selftest=all --no-sandbox | tee /out/deb-selftest.txt')
    )
    assert.ok(
      at('--appimage-extract') <
        at('xvfb-run -a ./squashfs-root/AppRun --iclone-selftest=all --no-sandbox | tee /out/appimage-selftest.txt')
    )
    assert.equal(spawnSync('bash', ['-n'], { input: inner }).status, 0, 'container script does not parse')

    assert.match(
      smoke.run,
      /docker run --rm --shm-size=1g \\\n\s+-v "\$PWD\/apps\/desktop\/release:\/pkg:ro" \\\n\s+-v "\$PWD\/smoke:\/out" \\\n\s+"\$UBUNTU_IMAGE" bash \/out\/in-container\.sh/
    )
    assert.match(smoke.run, /--check-selftest smoke\/deb-selftest\.txt/)
    assert.match(smoke.run, /--check-selftest smoke\/appimage-selftest\.txt/)
    assert.equal(spawnSync('bash', ['-n'], { input: smoke.run }).status, 0, 'smoke step does not parse')
  })

  test('refuses to run off Linux', async () => {
    await assert.rejects(releaseLinux({ arch: 'x64' }, { platform: 'darwin' }), /Linux host/)
  })

  function fakeDeps(over = {}) {
    const written = {}
    const runs = []
    const deps = {
      platform: 'linux',
      log() {},
      exists: () => true,
      scanBinaries: () => ({ elf: [], machO: [] }),
      hygiene: () => [],
      acpAbsent: () => ({ ok: true, problems: [] }),
      sha256File: file => createHash('sha256').update(path.basename(file)).digest('hex'),
      chmod() {},
      readText: file =>
        file.endsWith('package.json') ? JSON.stringify({ version: '1.1.0' }) : fs.readFileSync(file, 'utf8'),
      writeText: (file, text) => (written[path.basename(file)] = text),
      run: (cmd, args) => {
        runs.push([cmd, ...args].join(' '))
        if (cmd === 'dpkg-deb') return { status: 0, stdout: controlFor(args[1]) }
        if (cmd === 'sh') return { status: 0, stdout: DESKTOP_ENTRY }
        return { status: 0, stdout: '' }
      },
      ...over
    }
    return { deps, written, runs }
  }

  test('happy path: builds, checks the deb, writes runtime.json + per-arch SHA256SUMS + UPLOAD list', async () => {
    const { deps, written, runs } = fakeDeps()
    const out = await releaseLinux({ arch: 'arm64', skipBuild: false }, deps)
    assert.ok(
      runs.includes('npm run builder -- --linux deb AppImage --arm64 --publish never --iclone-release-identity')
    )
    assert.equal(
      JSON.parse(written['runtime.json']).sha,
      JSON.parse(fs.readFileSync(path.join(REPO, 'iclone', 'RUNTIME_PIN.json'), 'utf8')).sha
    )
    const sums = written['SHA256SUMS-linux-arm64.txt'].trim().split('\n')
    assert.equal(sums.length, 4)
    assert.match(sums[0], /^[0-9a-f]{64} {2}iclone-os-1\.1\.0-linux-arm64\.deb$/)
    assert.deepEqual(out.uploads, [
      'iclone-os-1.1.0-linux-arm64.deb',
      'iclone-os-1.1.0-linux-arm64.AppImage',
      'latest-linux-arm64.yml',
      'runtime.json',
      'SHA256SUMS-linux-arm64.txt'
    ])
  })

  test('ruling 48: without the private markers the default release scan fails closed', async () => {
    const { deps } = fakeDeps({ scanBinaries: () => X64_SIGNER })

    delete deps.hygiene
    await assert.rejects(releaseLinux({ arch: 'x64', skipBuild: true }, deps), /the release scan fails closed/)
  })

  test('artifact hygiene scans the unpacked tree and a hit aborts before anything is hashed or listed', async () => {
    const scanned = []
    const clean = fakeDeps({ scanBinaries: () => X64_SIGNER, hygiene: dir => (scanned.push(dir), []) })
    await releaseLinux({ arch: 'x64', skipBuild: true }, clean.deps)
    assert.deepEqual(
      scanned.map(dir => path.basename(dir)),
      ['linux-unpacked']
    )

    const dirty = fakeDeps({
      scanBinaries: () => X64_SIGNER,
      hygiene: () => [{ file: 'resources/app.asar/dist/main.js', id: 'owner.user-name' }]
    })
    await assert.rejects(
      releaseLinux({ arch: 'x64', skipBuild: true }, dirty.deps),
      /artifact hygiene: 1 marker hit\(s\) in release\/linux-unpacked[\s\S]*main\.js: owner\.user-name/
    )
    assert.equal(dirty.written['UPLOAD-linux-x64.txt'], undefined)
    assert.equal(dirty.written['runtime.json'], undefined)
  })

  test('--check-selftest-mode all requires both the acp and the pty checks', () => {
    assert.equal(parseArgs(['--check-selftest-mode', 'all', '--check-selftest', 'a.txt']).checkSelftestMode, 'all')
    assert.throws(() => parseArgs(['--check-selftest-mode', 'everything']), /must be one of pty, acp, all/)
    const line = over =>
      JSON.stringify({ selftest: 'all', ok: true, packaged: true, pty: { ok: true }, acp: { ok: true }, ...over })
    const files = { good: line({}), noAcp: line({ acp: { ok: false } }), pty: line({ selftest: 'pty' }) }
    assert.equal(
      checkSelftestFiles(['good'], 'all', name => files[name]),
      0
    )
    assert.equal(
      checkSelftestFiles(['good', 'noAcp'], 'all', name => files[name]),
      1
    )
    assert.equal(
      checkSelftestFiles(['pty'], 'all', name => files[name]),
      1
    )
  })

  function runtimeStep() {
    const yaml = require('js-yaml')
    const workflow = yaml.load(
      fs.readFileSync(path.join(DESKTOP_DIR, '..', '..', '.github', 'workflows', 'release-linux.yml'), 'utf8')
    )

    return { job: workflow.jobs.build, steps: workflow.jobs.build.steps }
  }

  function inContainerScript() {
    const boot = runtimeStep().steps.find(step => step.name?.startsWith('Runtime bootstrap from the bundled pin'))

    return boot.run.split("<<'RUNTIME'\n")[1].split('\nRUNTIME\n')[0]
  }

  test('the runtime container installs what the .deb pulls in for the first run, libatomic1 included, never git', () => {
    const installs = [...inContainerScript().matchAll(/apt-get install -y -qq --no-install-recommends ([^\n]*)/g)]
    assert.equal(installs.length, 1)
    const packages = installs[0][1].trim().split(/\s+/)
    assert.ok(packages.includes('libatomic1'))
    assert.ok(!packages.includes('git'), 'git must never run in the bootstrap container')
    for (const name of packages) {
      assert.ok(pkg.build.deb.depends.includes(name), `${name} is not in build.deb.depends`)
    }
  })

  test('release-linux.yml pins ubuntu:24.04 by digest and runs the bundled installer with only codeload blocked', () => {
    const { job, steps } = runtimeStep()
    assert.match(job.env.UBUNTU_IMAGE, /^ubuntu:24\.04@sha256:[0-9a-f]{64}$/)
    const index = name => steps.findIndex(step => step.name?.startsWith(name))
    const smoke = steps[index('Smoke test')]
    const boot = steps[index('Runtime bootstrap from the bundled pin')]
    assert.ok(boot, 'no runtime bootstrap step')
    assert.ok(
      index('Smoke test') < index('Runtime bootstrap') && index('Runtime bootstrap') < index('Collect the files')
    )
    assert.match(smoke.run, /--check-selftest-mode all/)
    assert.ok(!/ubuntu:24\.04 bash/.test(smoke.run + boot.run), 'every container runs the digest-pinned image')

    const inner = inContainerScript()
    assert.equal(inner.split('\n')[0], 'set -euo pipefail')
    assert.ok(!/pip install/.test(inner), 'the runtime is installed by install.sh, not by hand')
    assert.equal(spawnSync('bash', ['-n'], { input: inner }).status, 0, 'runtime script does not parse')
    assert.equal(spawnSync('bash', ['-n'], { input: boot.run }).status, 0, 'runtime step does not parse')
    // Only codeload (GitHub's tarball host) is mapped away: install.sh's sha-pinned uv comes from github.com releases.
    assert.deepEqual(boot.run.match(/--add-host [^ ]+/g), ['--add-host codeload.github.com:0.0.0.0'])
    assert.match(boot.run, /-v "\$PWD\/iclone:\/pin:ro"/)
    assert.match(boot.run, /"\$UBUNTU_IMAGE" bash \/out\/in-container\.sh/)
  })

  describe('the in-container runtime script, run against fakes', () => {
    const SHA = 'c0ffee'.repeat(6) + 'c0ff'

    function fixture({ installSh, curlExit = 7, tamper = false } = {}) {
      const root = tempDir()
      const dirs = Object.fromEntries(
        ['pkg', 'pin', 'out', 'work', 'bin', 'src'].map(name => [name, path.join(root, name)])
      )
      Object.values(dirs).forEach(dir => fs.mkdirSync(dir, { recursive: true }))
      const bundle = path.join(dirs.src, 'opt', 'iclone os', 'resources', 'hermes-runtime')
      fs.mkdirSync(path.join(dirs.src, 'tree', `hermes-agent-${SHA}`), { recursive: true })
      fs.writeFileSync(path.join(dirs.src, 'tree', `hermes-agent-${SHA}`, 'pyproject.toml'), '[project]\n')
      fs.mkdirSync(bundle, { recursive: true })
      const tarball = path.join(bundle, `hermes-agent-${SHA}.tar.gz`)
      spawnSync('tar', ['-czf', tarball, '-C', path.join(dirs.src, 'tree'), `hermes-agent-${SHA}`])
      fs.writeFileSync(path.join(bundle, 'BUNDLE.json'), '{}\n')
      fs.writeFileSync(path.join(bundle, 'install.sh'), installSh)
      const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
      fs.writeFileSync(
        path.join(dirs.pin, 'RUNTIME_PIN.json'),
        JSON.stringify(
          { sha: SHA, tarball_sha256: hash(tarball), install_sh_sha256: hash(path.join(bundle, 'install.sh')) },
          null,
          2
        )
      )
      if (tamper) {
        fs.appendFileSync(path.join(bundle, 'install.sh'), '\n# tampered\n')
      }
      fs.writeFileSync(path.join(dirs.pkg, 'iclone-os-1.2.3-amd64.deb'), 'deb')
      const fake = (name, body) =>
        fs.writeFileSync(path.join(dirs.bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
      fake('dpkg-deb', `[ "$1" = -x ] && mkdir -p "$3" && cp -R "${dirs.src}/opt" "$3/"`)
      fake('apt-get', `echo "apt-get $*" >> "${dirs.out}/apt.log"`)
      fake('curl', `exit ${curlExit}`)
      fake('sha256sum', 'exec shasum -a 256 "$@"')
      const result = spawnSync('bash', ['-c', inContainerScript()], {
        encoding: 'utf8',
        env: {
          ...process.env,
          OUT_DIR: dirs.out,
          PATH: `${dirs.bin}:${process.env.PATH}`,
          PIN_DIR: dirs.pin,
          PKG_DIR: dirs.pkg,
          WORK_DIR: dirs.work
        }
      })
      const read = name =>
        fs.existsSync(path.join(dirs.out, name)) ? fs.readFileSync(path.join(dirs.out, name), 'utf8') : ''

      return { dirs, read, result }
    }

    // Records its argv, lists stages like the real --manifest, and installs a hermes command in the venv stage.
    const FAKE_INSTALL = extra => `#!/bin/bash
echo "install.sh $*" >> "$OUT_DIR/calls.log"
dir=$(printf '%s\\n' "$@" | sed -n '/^--dir$/{n;p;}')
if [ "$1" = --manifest ]; then
  printf '%s' '[{"name":"prerequisites","title":"p","category":"system","needs_user_input":false},{"name":"repository","title":"r","category":"system","needs_user_input":false},{"name":"venv","title":"v","category":"runtime","needs_user_input":false},{"name":"setup","title":"s","category":"config","needs_user_input":true},{"name":"complete","title":"c","category":"runtime","needs_user_input":false}]'
  exit 0
fi
${extra}
if [ "$2" = venv ]; then
  mkdir -p "$dir/.hermes/bin"
  printf '#!/bin/sh\\necho "Hermes Agent v9.9.9 (fake)"\\n' > "$dir/.hermes/bin/hermes"
  chmod +x "$dir/.hermes/bin/hermes"
fi
echo '{"ok":true,"stage":"'"$2"'"}'
`

    test('runs install.sh from the bundle at the pin, skips git and user-input stages, ends with hermes --version', () => {
      const { dirs, read, result } = fixture({ installSh: FAKE_INSTALL('') })
      assert.equal(result.status, 0, result.stderr)
      const active = path.join(dirs.work, 'opt', 'hermes-agent')
      const tail = `--dir ${active} --hermes-home ${path.join(dirs.work, 'root', '.hermes')} --branch main --commit ${SHA}`
      assert.deepEqual(read('calls.log').trim().split('\n'), [
        `install.sh --manifest ${tail}`,
        `install.sh --stage venv --non-interactive --json ${tail}`,
        `install.sh --stage complete --non-interactive --json ${tail}`
      ])
      assert.ok(fs.existsSync(path.join(active, 'pyproject.toml')), 'the pinned tarball replaces the clone')
      assert.equal(read('hermes-version.txt').trim(), 'Hermes Agent v9.9.9 (fake)')
      assert.equal(read('git-calls.log'), '')
      assert.match(
        read('apt.log'),
        /install -y -qq --no-install-recommends ca-certificates curl tar python3 libatomic1/
      )
    })

    test('a shipped install.sh that does not match the pin is refused before it runs', () => {
      const { read, result } = fixture({ installSh: FAKE_INSTALL(''), tamper: true })
      assert.notEqual(result.status, 0)
      assert.equal(read('calls.log'), '')
    })

    test('any git call fails the step, even when install.sh ignores the error', () => {
      const { read, result } = fixture({ installSh: FAKE_INSTALL('git clone "$HERMES_REPO_URL" /tmp/x || true') })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /git was called/)
      assert.match(read('git-calls.log'), /^git clone https:\/\/192\.0\.2\.1\//)
    })

    test('a reachable codeload.github.com fails the step before anything is installed', () => {
      const { read, result } = fixture({ curlExit: 0, installSh: FAKE_INSTALL('') })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /codeload\.github\.com is reachable/)
      assert.equal(read('calls.log'), '')
    })

    test('a stage that reports ok:false fails the step', () => {
      const { result } = fixture({
        installSh: FAKE_INSTALL('[ "$2" = complete ] && { echo \'{"ok":false}\'; exit 0; }')
      })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /stage complete failed/)
    })
  })

  test('refuses darwin binaries, missing outputs and a deb without the keyring depends', async () => {
    await assert.rejects(
      releaseLinux(
        { arch: 'x64', skipBuild: true },
        fakeDeps({ scanBinaries: () => ({ elf: [], machO: ['/x/pty.node'] }) }).deps
      ),
      /darwin binaries/
    )
    await assert.rejects(
      releaseLinux({ arch: 'x64', skipBuild: true }, fakeDeps({ exists: () => false }).deps),
      /missing build output/
    )
    const noKeyring = fakeDeps({
      scanBinaries: () => X64_SIGNER,
      run: cmd => ({
        status: 0,
        stdout: cmd === 'dpkg-deb' ? DEB_CONTROL.replace(', gnome-keyring | kwalletmanager', '') : DESKTOP_ENTRY
      })
    })
    await assert.rejects(releaseLinux({ arch: 'x64', skipBuild: true }, noKeyring.deps), /gnome-keyring/)
  })

  test('classifyBinary: thin and fat Mach-O, ELF machine of either byte order, not a Java class', () => {
    assert.equal(classifyBinary(Buffer.from('cffaedfe07000001', 'hex')), 'mach-o')
    assert.equal(classifyBinary(Buffer.from('cafebabe00000002', 'hex')), 'mach-o')
    assert.equal(classifyBinary(Buffer.from('cafebabf00000002', 'hex')), 'mach-o')
    assert.equal(classifyBinary(Buffer.from('cafebabe00000034', 'hex')), null)
    assert.deepEqual(classifyBinary(elfHead(62)), { elf: 62 })
    assert.deepEqual(classifyBinary(elfHead(183, true)), { elf: 183 })
    assert.equal(classifyBinary(Buffer.from('7f45', 'hex')), null)
  })

  test('scanBinaries finds a universal Mach-O copied from the host and every ELF with its machine', () => {
    const dir = tempDir()
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'a', 'fat'),
      Buffer.concat([Buffer.from('cafebabe00000002', 'hex'), Buffer.alloc(64)])
    )
    fs.writeFileSync(path.join(dir, 'a', 'b', 'signer'), elfHead(62))
    fs.writeFileSync(path.join(dir, 'a', 'b', 'pty.node'), elfHead(183))
    fs.writeFileSync(path.join(dir, 'a', 'text'), 'hello')
    const found = scanBinaries(dir)
    assert.deepEqual(found.machO, [path.join(dir, 'a', 'fat')])
    assert.deepEqual(found.elf.map(e => e.machine).sort(), [183, 62])
    assert.deepEqual(
      foreignElf(found.elf, 'arm64').map(e => path.basename(e.path)),
      ['signer']
    )
    assert.deepEqual(
      foreignElf(found.elf, 'x64').map(e => path.basename(e.path)),
      ['pty.node']
    )
    if (process.platform === 'darwin' && classifyBinary(fs.readFileSync('/usr/bin/true').subarray(0, 8)) !== null) {
      fs.copyFileSync('/usr/bin/true', path.join(dir, 'host-true'))
      assert.ok(findMachO(dir).includes(path.join(dir, 'host-true')))
    }
  })

  test('an arm64 run refuses an x86-64 ELF from the real tree, a deb of another Architecture, and x64 without the signer', async () => {
    const desk = tempDir()
    const names = linuxArtifactNames('1.1.0', 'arm64')
    const bin = path.join(desk, 'release', names.unpacked, 'resources', 'acp-cli', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'acp-cli-signer-linux'), elfHead(62))
    const real = fakeDeps({ desktopDir: desk, scanBinaries: undefined })
    delete real.deps.scanBinaries
    await assert.rejects(releaseLinux({ arch: 'arm64', skipBuild: true }, real.deps), /another arch.*x86-64/)
    const wrongArch = fakeDeps({
      run: cmd => ({ status: 0, stdout: cmd === 'dpkg-deb' ? controlFor('x-amd64.deb') : DESKTOP_ENTRY })
    })
    await assert.rejects(
      releaseLinux({ arch: 'arm64', skipBuild: true }, wrongArch.deps),
      /Architecture is amd64, expected arm64/
    )
    const carried = fakeDeps({ acpAbsent: () => ({ ok: false, problems: ['1 acp-cli dir(s) in the pack'] }) })
    await assert.rejects(
      releaseLinux({ arch: 'x64', skipBuild: true }, carried.deps),
      /carries the ACP CLI.*acp-cli dir/
    )
    const foreignArch = fakeDeps()
    await assert.rejects(releaseLinux({ arch: 'ia32', skipBuild: false }, foreignArch.deps), /unknown arch ia32/)
    assert.deepEqual(foreignArch.runs, [], 'an unknown arch is refused before anything is built')
  })
})

describe('REL-6: the real ACP-absent check on an unpacked linux tree', () => {
  test('refuses an acp-cli tree and a Go signer, passes the pin alone (negative control first)', () => {
    const root = tempDir()
    const resources = path.join(root, 'resources')
    const bin = path.join(resources, 'acp-cli', 'runtime', 'node_modules', '@virtuals-protocol', 'acp-cli', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(
      path.join(bin, 'acp-cli-signer-linux'),
      Buffer.concat([elfHead(62), Buffer.from(['github.com', 'anthropics', 'acp-cli-signer'].join('/'))])
    )
    fs.mkdirSync(path.join(resources, 'acp-pin'))
    for (const [name, from] of Object.entries({
      'package.json': path.join(DESKTOP_DIR, 'acp-cli-lock', 'package.json'),
      'package-lock.json': path.join(DESKTOP_DIR, 'acp-cli-lock', 'package-lock.json'),
      'launch.cjs': path.join(DESKTOP_DIR, 'scripts', 'acp-launch.cjs')
    })) {
      fs.copyFileSync(from, path.join(resources, 'acp-pin', name))
    }
    const carried = checkAcpAbsent(root)
    assert.equal(carried.ok, false)
    assert.equal(carried.counts.acpCliDirs, 2, 'Resources/acp-cli and the package dir @virtuals-protocol/acp-cli')
    assert.equal(carried.counts.virtualsPaths, 1)
    assert.equal(carried.counts.signerBinaries, 1)
    fs.rmSync(path.join(resources, 'acp-cli'), { recursive: true })
    const clean = checkAcpAbsent(root)
    assert.deepEqual(clean.problems, [])
    assert.ok(clean.pinNames.alchemy > 0, 'the pin names what the installer fetches')
  })
})
