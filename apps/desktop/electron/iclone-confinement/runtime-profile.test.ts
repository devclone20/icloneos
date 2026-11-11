import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildProfileSpec, type ConfinementPaths, KEYCHAIN_SERVICES, NEVER_EXEC } from './profiles'
import {
  generateRuntimeProfile,
  HERMES_HOME_NEVER_WRITTEN,
  INTERPRETER_LINK_HOPS_MAX,
  interpreterLinks,
  judgeHelperInterpreter,
  launcherLedgerDir,
  PYTHON_SOCKET_SUFFIX_MAX,
  type RuntimeFacts,
  runtimeProfileParams,
  runtimeRoots,
  runtimeRunDir,
  runtimeSandboxArgv,
  runtimeTmpFolder,
  SANDBOX_EXEC_PATH,
  symlinkChain,
  UNIX_SOCKET_PATH_MAX,
  USERDATA_HOLES
} from './runtime-profile'
import { auditSbpl, debuggerDenials } from './sbpl'

const paths: ConfinementPaths = {
  home: '/Users/owner',
  hermesHome: '/Users/owner/.hermes',
  userDataDir: '/Users/owner/Library/Application Support/iclone os',
  hermesRoot: '/Users/owner/.hermes/hermes-agent',
  profilesDir: '/Users/owner/Library/Application Support/iclone os/confinement/profiles',
  scratchRoot: '/Users/owner/Library/Caches/iclone-os-confinement/scratch',
  membersDir: '/Users/owner/Library/Caches/iclone-os-confinement/members'
}

const facts: RuntimeFacts = {
  runtimeRoot: '/Users/owner/.hermes/hermes-agent',
  venvRoot: '/Users/owner/.hermes/hermes-agent/venv',
  python: '/Users/owner/.hermes/tools/python-3.11/bin/python3.11',
  pythonHome: '/Users/owner/.hermes/tools/python-3.11',
  project: '/Users/owner/code/app',
  webDist: '/Applications/iclone os.app/Contents/Resources/app.asar.unpacked/dist',
  tmpDir: '/private/var/folders/xx/T/icloneos-runtime',
  cacheDir: '/private/var/folders/xx/C/icloneos-runtime',
  permDir: '/Users/owner/Library/Application Support/iclone os/run',
  permSocket: '/Users/owner/Library/Application Support/iclone os/run/acp.sock',
  policyFile: '/Users/owner/Library/Application Support/iclone os/run/policy-1.json'
}

const text = generateRuntimeProfile(paths).text
const code = text.split('\n').filter(line => line.trim() && !line.trimStart().startsWith(';'))
const lastAllow = code.findLastIndex(line => /\(allow /.test(line))
const tail = code.slice(lastAllow + 1).join('\n')

describe('generateRuntimeProfile', () => {
  it('opens with a tagged (deny default) right after the version', () => {
    expect(code[0]).toBe('(version 1)')
    expect(code[1]).toBe('(deny default (with message "iclone-runtime"))')
  })

  it('is byte-stable for the same inputs, and the hash follows the text', () => {
    const a = generateRuntimeProfile(paths)
    const b = generateRuntimeProfile({ ...paths })

    expect(a.text).toBe(b.text)
    expect(a.sha256).toBe(b.sha256)
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(generateRuntimeProfile({ ...paths, home: '/Users/other' }).sha256).not.toBe(a.sha256)
  })

  it('denies every never-list entry after the last allow', () => {
    for (const denied of [
      '(subpath "/Users/owner/.ssh")',
      '(subpath "/Users/owner/.aws")',
      '(subpath "/Users/owner/.gnupg")',
      '(subpath "/Users/owner/Library/Keychains")',
      '(subpath "/Library/Keychains")',
      '(subpath "/Users/owner/Library/Application Support/Google/Chrome")',
      '(subpath "/Users/owner/Library/Safari")',
      `(subpath "${paths.userDataDir}")`,
      `(literal "${paths.membersDir}/.member")`,
      `(literal "${paths.membersDir}/.decoy")`,
      `(literal "${SANDBOX_EXEC_PATH}")`,
      ...KEYCHAIN_SERVICES.map(service => `(global-name "${service}")`),
      ...NEVER_EXEC.map(binary => `(literal "${binary}")`)
    ]) {
      expect(tail).toContain(denied)
    }

    // Every rule after the last allow is a deny, plain or built from the parameters passed, and carries the tag — but
    // for the two OS logging probes, denied without a report (and so without a tag, which is a message), and the browser
    // debugger's ports, exact lines, untagged on purpose (browser-debugger.live.test.ts).
    const silent = code.slice(-2)
    expect(code).toEqual(expect.arrayContaining(debuggerDenials()))
    expect(
      code.slice(lastAllow + 1, -2).filter(line => !debuggerDenials().includes(line)).every(line => /^(\(deny |\(let \(\(f .*\(deny )/.test(line) && line.includes('(with message "iclone-runtime")'))
    ).toBe(true)
    expect(silent).toEqual([
      '(deny mach-lookup (with no-report) (global-name "com.apple.diagnosticd"))',
      '(deny file-read* (with no-report) (subpath "/Library/Preferences/Logging"))'
    ])
    // fx32p: sysctl-read is refused with a report, no longer silent; what the runtime measured at boot is allowed by name right after it,
    // never kern.proc* or kern.argmax. Names only: runtime-profile.live measures what the mib form still gives.
    expect(text.match(/\(with no-report\)/g)).toHaveLength(2)
    const sysctlDeny = code.findIndex(line => line.startsWith('(deny sysctl-read (with message'))
    expect(sysctlDeny).toBeGreaterThan(0)
    expect(code[sysctlDeny + 1]).toContain('(allow sysctl-read (sysctl-name "kern.boottime")')
    expect(code[sysctlDeny + 1]).toContain('(sysctl-name-prefix "hw.") (sysctl-name-prefix "machdep.cpu."))')
    expect(code[sysctlDeny + 1]).not.toContain('kern.proc')
    expect(code[sysctlDeny + 1]).not.toContain('kern.argmax')
    expect(code.filter(line => line.startsWith('(allow sysctl-read'))).toHaveLength(1)
    // R31: the second half of the kernel route; a process asks about itself and nothing else.
    expect(code[sysctlDeny + 2]).toMatch(/^\(deny process-info\* \(with message/)
    expect(code[sysctlDeny + 3]).toBe('(allow process-info* (target self))')
    expect(code.filter(line => line.includes('process-info'))).toHaveLength(2)
    expect(text).not.toMatch(/\(allow [^\n]*(no-report|diagnosticd|Preferences\/Logging)/)
  })

  it('the userData denial keeps only the holes of the one userData policy, each a parameter', () => {
    expect(tail).toContain(
      `(deny file-read* (apply require-all (cons (subpath "${paths.userDataDir}") (iclone-holes (append (iclone-subpaths '("RUNTIME_ROOT" "VENV_ROOT" "PYTHON_HOME" "PLUGINS_DIR" "HERMES_HOME" "RUN_DIR" "READY_DIR" "PROFILES_DIR" "PERM_DIR" "PYCACHE" "REFUSALS_DIR")) (iclone-literals '("POLICY_FILE" "HARDLINK_ACKS")))))) (with message "iclone-runtime"))`
    )
    // Written: the runtime's own state and the layer's write holes; its code never (read-only holes).
    expect(tail).toContain(
      `(deny file-write* (apply require-all (cons (subpath "${paths.userDataDir}") (iclone-holes (iclone-subpaths '("HERMES_HOME" "RUN_DIR" "READY_DIR" "PYCACHE" "REFUSALS_DIR"))))) (with message "iclone-runtime"))`
    )
    expect(USERDATA_HOLES.code).toEqual(['RUNTIME_ROOT', 'VENV_ROOT', 'PYTHON_HOME', 'PLUGINS_DIR'])
    expect(USERDATA_HOLES.ownState).toEqual(['HERMES_HOME'])
  })

  it('leaves the runtime its own provider keys (HERMES_HOME is its folder) but never the agent mark', () => {
    expect(tail).not.toContain('/Users/owner/.hermes/.env')
    expect(tail).not.toContain('/Users/owner/.hermes/auth.json')
    expect(text).toContain(`(literal "${paths.membersDir}/.runtime")`)
  })

  it('never lets it write its own code, the plugins folder or the profiles; the run tokens stay creatable', () => {
    const writes = code.find(line => line.startsWith('(deny file-write* (subpath')) ?? ''

    expect(writes).toContain('(subpath "/Users/owner/.hermes/hermes-agent")')
    expect(writes).toContain('(subpath "/Users/owner/.hermes/plugins")')
    expect(writes).toContain(`(subpath "${paths.profilesDir}")`)
    expect(writes).not.toContain(`(subpath "${paths.membersDir}")`)
    expect(writes).toContain(`(literal "${paths.membersDir}/.runtime")`)
  })

  it('never lets it write PM’s records or Python store in HERMES_HOME, nor the venv and Python home of the spawn, after the HERMES_HOME allow', () => {
    const writes = code.find(line => line.startsWith('(deny file-write* (subpath')) ?? ''

    expect([...HERMES_HOME_NEVER_WRITTEN]).toEqual(['plugins', 'installs', 'tools'])
    expect(writes).toContain('(subpath "/Users/owner/.hermes/installs")')
    expect(writes).toContain('(subpath "/Users/owner/.hermes/tools")')

    // The interpreter's own folders, by parameter: built only from the parameters passed, denied whatever else allows
    // them (a venv under HERMES_HOME in a non-packaged layout), and placed after every allow.
    const interpreter = code.findIndex(line => line.includes(`(iclone-subpaths '("VENV_ROOT" "PYTHON_HOME"))`) && line.includes('(deny file-write*'))
    const hermesHomeAllow = code.findIndex(line => line.includes('(allow file-read* file-write*') && line.includes('"HERMES_HOME"'))

    expect(interpreter).toBeGreaterThan(lastAllow)
    expect(interpreter).toBeGreaterThan(hermesHomeAllow)
    expect(code[interpreter]).toContain('(with message "iclone-runtime")')
  })

  it('holds no forbidden construct and passes the widening audit', () => {
    expect(text).not.toMatch(/\(allow\s+default/)
    expect(text).not.toContain('no-sandbox')
    expect(code.filter(line => line.includes('process-exec') && line.includes('(allow')).join('\n')).not.toContain(
      SANDBOX_EXEC_PATH
    )
    expect(code.some(line => /^\(allow (file-read\*|file-write\*|network\*|mach-lookup|process-exec)\)$/.test(line))).toBe(
      false
    )
    expect(auditSbpl(text)).toEqual({ widened: false, problems: [] })
  })

  it('refuses sandbox-exec, or a relative path, as an extra exec allowance', () => {
    expect(() => generateRuntimeProfile(paths, { exec: [SANDBOX_EXEC_PATH] })).toThrow(/refusing/)
    expect(() => generateRuntimeProfile(paths, { exec: ['git'] })).toThrow(/refusing/)
  })

  it('refuses to embed an unsafe path', () => {
    expect(() => generateRuntimeProfile({ ...paths, home: '/Users/o"wner' })).toThrow(/unsafe/)
  })

  it('names the links the interpreter is reached through as metadata literals, before the never list; none ⇒ no line', () => {
    const links = ['/Users/owner/.hermes/hermes-agent/venv/bin/python', '/Users/owner/.local/share/uv/python/cpython-3.14-macos-aarch64-none']
    const withLinks = generateRuntimeProfile(paths, { links })
    const lines = withLinks.text.split('\n')
    const at = lines.indexOf(`(allow file-read-metadata ${links.map(link => `(literal "${link}")`).join(' ')})`)

    expect(at).toBeGreaterThan(0)
    expect(lines.slice(at + 1).some(line => line.startsWith('; never'))).toBe(true)
    expect(withLinks.text).not.toContain('(subpath "/Users/owner/.local/share/uv/python')
    expect(auditSbpl(withLinks.text)).toEqual({ widened: false, problems: [] })
    expect(withLinks.sha256).not.toBe(generateRuntimeProfile(paths).sha256)

    for (const none of [generateRuntimeProfile(paths, { links: [] }), generateRuntimeProfile(paths)]) {
      expect(none.text).not.toMatch(/\(allow file-read-metadata\s*\)/)
      expect(none.text).not.toMatch(/\(allow file-read-metadata \(literal "[^"]+(python|none)"\)/)
    }
  })

  it('refuses a link allowance that is relative, the root, or not normalised', () => {
    for (const link of ['venv/bin/python', '/', '/Users/owner/../owner/venv']) {
      expect(() => generateRuntimeProfile(paths, { links: [link] })).toThrow(/refusing a runtime link allowance/)
    }
  })
})

describe('symlinkChain — every link the kernel follows to the interpreter', () => {
  const roots: string[] = []

  const world = () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'iclone-links-')))

    roots.push(root)

    return root
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a plain path has no links; a venv link straight to the binary has one', () => {
    const root = world()
    const real = path.join(root, 'cpython-3.14.7', 'bin', 'python3.14')

    mkdirSync(path.dirname(real), { recursive: true })
    writeFileSync(real, '')
    mkdirSync(path.join(root, 'venv', 'bin'), { recursive: true })
    symlinkSync(real, path.join(root, 'venv', 'bin', 'python'))

    expect(symlinkChain(real)).toEqual([])
    expect(symlinkChain(path.join(root, 'venv', 'bin', 'python'))).toEqual([path.join(root, 'venv', 'bin', 'python')])
  })

  it('a folder link in the middle (uv’s minor-version alias) and a folder link in front are links too, in order, once', () => {
    const root = world()
    const real = path.join(root, 'store', 'cpython-3.14.7', 'bin', 'python3.14')
    const alias = path.join(root, 'store', 'cpython-3.14')
    const venv = path.join(root, 'venv')
    const front = path.join(root, 'checkout', 'venv')

    mkdirSync(path.dirname(real), { recursive: true })
    writeFileSync(real, '')
    // The alias as uv writes it: relative, beside the versioned install.
    symlinkSync('cpython-3.14.7', alias)
    mkdirSync(path.join(venv, 'bin'), { recursive: true })
    symlinkSync(path.join(alias, 'bin', 'python3.14'), path.join(venv, 'bin', 'python'))
    mkdirSync(path.dirname(front), { recursive: true })
    symlinkSync('../venv', front)

    expect(symlinkChain(path.join(front, 'bin', 'python'))).toEqual([front, path.join(venv, 'bin', 'python'), alias])
    // The venv named by its real folder (as main names it): the front link is not on the way.
    expect(symlinkChain(path.join(venv, 'bin', 'python'))).toEqual([path.join(venv, 'bin', 'python'), alias])
    // `bin/python3 -> python3.14` beside the binary (a Python install's own link) is one more hop, through the same alias once.
    symlinkSync('python3.14', path.join(root, 'store', 'cpython-3.14.7', 'bin', 'python3'))
    symlinkSync(path.join(alias, 'bin', 'python3'), path.join(venv, 'bin', 'python3'))
    expect(symlinkChain(path.join(venv, 'bin', 'python3'))).toEqual([
      path.join(venv, 'bin', 'python3'),
      alias,
      path.join(root, 'store', 'cpython-3.14.7', 'bin', 'python3')
    ])
  })

  it('a loop, a chain past the cap and a dangling link each throw, naming the path', () => {
    const root = world()

    symlinkSync(path.join(root, 'b'), path.join(root, 'a'))
    symlinkSync(path.join(root, 'a'), path.join(root, 'b'))
    expect(() => symlinkChain(path.join(root, 'a'))).toThrow(`${path.join(root, 'a')} is not reachable: the link ${path.join(root, 'a')} loops`)

    writeFileSync(path.join(root, 'end'), '')
    symlinkSync('end', path.join(root, 'hop0'))

    for (let hop = 1; hop <= INTERPRETER_LINK_HOPS_MAX; hop += 1) {
      symlinkSync(`hop${hop - 1}`, path.join(root, `hop${hop}`))
    }

    expect(symlinkChain(path.join(root, `hop${INTERPRETER_LINK_HOPS_MAX - 1}`))).toHaveLength(INTERPRETER_LINK_HOPS_MAX)
    expect(() => symlinkChain(path.join(root, `hop${INTERPRETER_LINK_HOPS_MAX}`))).toThrow(
      `more than ${INTERPRETER_LINK_HOPS_MAX} links on the way`
    )

    symlinkSync(path.join(root, 'nowhere', 'python'), path.join(root, 'dangling'))
    expect(() => symlinkChain(path.join(root, 'dangling'))).toThrow(
      `${path.join(root, 'dangling')} is not reachable: ${path.join(root, 'nowhere')} does not exist`
    )
    expect(() => symlinkChain(path.join(root, 'missing'))).toThrow(`${path.join(root, 'missing')} does not exist`)
    expect(() => symlinkChain('venv/bin/python')).toThrow(/not absolute/)
  })

  it('interpreterLinks: the chains of the command and the interpreter fact, each link once; a link in a denied folder is refused', () => {
    const root = world()
    const home = path.join(root, 'home')
    const real = path.join(root, 'base', 'bin', 'python3.14')
    const venv = path.join(root, 'venv')
    const here: ConfinementPaths = { ...paths, home, hermesHome: path.join(home, '.hermes') }

    mkdirSync(path.dirname(real), { recursive: true })
    writeFileSync(real, '')
    mkdirSync(path.join(venv, 'bin'), { recursive: true })
    symlinkSync(real, path.join(venv, 'bin', 'python'))

    expect(interpreterLinks(here, [path.join(venv, 'bin', 'python'), real, path.join(venv, 'bin', 'python')])).toEqual([
      path.join(venv, 'bin', 'python')
    ])

    mkdirSync(path.join(home, '.ssh'), { recursive: true })
    symlinkSync(real, path.join(home, '.ssh', 'python'))
    expect(() => interpreterLinks(here, [path.join(home, '.ssh', 'python')])).toThrow(
      `the interpreter is reached through ${path.join(home, '.ssh', 'python')}, a link inside ${path.join(home, '.ssh')}, which the runtime may never read`
    )
  })
})

describe('the userData policy across layouts', () => {
  const roots: string[] = []

  const world = () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'iclone-holes-')))

    roots.push(root)

    return root
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  const userData = paths.userDataDir
  const runtimeRoot = `${userData}/hermes-runtime/${'a'.repeat(64)}`
  const deps = `${runtimeRoot}/.iclone-deps/hermes`
  const venvRoot = `${deps}/installs/0123456789abcdef/environments/gen1/venv`
  const pythonHome = `${deps}/tools/python-3.14`

  /** A packed app's places: the runtime, its venv and its pinned Python under userData; HERMES_HOME outside. */
  const packaged: ConfinementPaths = { ...paths, hermesRoot: runtimeRoot }

  const packagedFacts: RuntimeFacts = {
    ...facts,
    runtimeRoot,
    venvRoot,
    python: `${pythonHome}/bin/python3.14`,
    pythonHome
  }

  const asMap = (list: string[]) =>
    Object.fromEntries(list.filter(item => item !== '-D').map(define => define.split('=', 2) as [string, string]))

  it('packaged: the runtime, venv and Python home are passed (and so are holes); the runtime code is a read root, never written', () => {
    const params = asMap(runtimeProfileParams(packaged, packagedFacts))
    const text = generateRuntimeProfile(packaged).text

    expect(params).toMatchObject({ RUNTIME_ROOT: runtimeRoot, VENV_ROOT: venvRoot, PYTHON_HOME: pythonHome })
    expect(runtimeRoots(packaged, packagedFacts).reads).toEqual(expect.arrayContaining([runtimeRoot, venvRoot, pythonHome]))
    expect(runtimeRoots(packaged, packagedFacts).writes).not.toContain(runtimeRoot)
    expect(code.find(line => line.startsWith('(deny file-write* (subpath'))).toBeDefined()
    expect(text.split('\n').find(line => line.startsWith('(deny file-write* (subpath'))).toContain(`(subpath "${runtimeRoot}")`)
  })

  it('fresh install: HERMES_HOME inside userData is passed, written, a launcher write root; its plugins folder is never written', () => {
    const fresh: ConfinementPaths = { ...packaged, hermesHome: `${userData}/hermes-home` }
    const params = asMap(runtimeProfileParams(fresh, packagedFacts))
    const text = generateRuntimeProfile(fresh).text
    const protectedLine = text.split('\n').find(line => line.startsWith('(deny file-write* (subpath')) ?? ''

    expect(params.HERMES_HOME).toBe(`${userData}/hermes-home`)
    expect(runtimeRoots(fresh, packagedFacts).writes).toContain(`${userData}/hermes-home`)
    expect(protectedLine).toContain(`(subpath "${userData}/hermes-home/plugins")`)
    // Its own keys stay its own, as for a HERMES_HOME elsewhere.
    expect(text).not.toContain(`${userData}/hermes-home/.env`)
  })

  it('the agent profiles still deny HERMES_HOME’s secrets, and userData whole, wherever HERMES_HOME lies', () => {
    for (const hermesHome of [paths.hermesHome, `${userData}/hermes-home`]) {
      const spec = buildProfileSpec('project', { ...packaged, hermesHome })

      expect(spec.denied).toEqual(expect.arrayContaining([userData, `${hermesHome}/.env`, `${hermesHome}/auth.json`, `${hermesHome}/config.yaml`]))
    }
  })

  it('refuses, with a plain sentence, a runtime folder that is or holds userData, lies in it anywhere but its own place, or overlaps the app’s own folders', () => {
    const refusal =
      /^HERMES_HOME \(.+\) (is or holds the app's own data folder|lies inside the app's own data folder .+ only .+ is allowed there|overlaps the app's own .+, which the agent runtime may never reach)/

    for (const hermesHome of [
      userData,
      path.dirname(userData),
      `${userData}/confinement`,
      `${userData}/confinement/ledger`,
      `${userData}/confinement/run/home`,
      paths.profilesDir,
      paths.membersDir,
      `${userData}/permissions`,
      `${userData}/run`,
      // Inside userData, HERMES_HOME has one place: not the runtimes' folder, not a runtime's own folder, not the
      // browser's state, not the dev plugin overlay, not a sibling named almost right.
      `${userData}/hermes-runtime`,
      `${userData}/hermes-runtime/${'a'.repeat(64)}`,
      `${userData}/Partitions`,
      `${userData}/Local Storage`,
      `${userData}/hermes-dev-plugins`,
      `${userData}/hermes-home-2`,
      `${userData}/hermes-home/inner`
    ]) {
      const bad = { ...paths, hermesHome }

      expect(() => generateRuntimeProfile(bad), hermesHome).toThrow(refusal)
      expect(() => runtimeProfileParams(bad, facts), hermesHome).toThrow(/^HERMES_HOME /)
    }

    for (const [name, over] of [
      ['RUNTIME_ROOT', { runtimeRoot: userData }],
      ['VENV_ROOT', { venvRoot: `${userData}/confinement/venv` }],
      ['PYTHON_HOME', { pythonHome: path.dirname(userData) }],
      // A code hole inside userData lies in one managed runtime's folder, nowhere else there.
      ['RUNTIME_ROOT', { runtimeRoot: `${userData}/Partitions` }],
      ['RUNTIME_ROOT', { runtimeRoot: `${userData}/hermes-runtime` }],
      ['VENV_ROOT', { venvRoot: `${userData}/hermes-home/venv` }],
      ['PYTHON_HOME', { pythonHome: `${userData}/Local Storage/py` }]
    ] as const) {
      expect(() => runtimeProfileParams(packaged, { ...packagedFacts, ...over }), name).toThrow(new RegExp(`^${name} \\(`))
    }

    expect(() => generateRuntimeProfile({ ...paths, hermesHome: `${userData}/hermes-home` })).not.toThrow()
    expect(() =>
      runtimeProfileParams(packaged, { ...packagedFacts, pluginsDir: `${userData}/hermes-dev-plugins/plugins` })
    ).not.toThrow()
  })

  it('the plugin overlay of an unmanaged dev runtime: a read-only hole and a launcher read root, only when given', () => {
    const overlay = `${userData}/hermes-dev-plugins/plugins`
    const withOverlay: RuntimeFacts = { ...facts, pluginsDir: overlay }
    const text = generateRuntimeProfile(paths).text

    expect(USERDATA_HOLES.code).toContain('PLUGINS_DIR')
    expect(asMap(runtimeProfileParams(paths, withOverlay)).PLUGINS_DIR).toBe(overlay)
    expect(asMap(runtimeProfileParams(paths, facts))).not.toHaveProperty('PLUGINS_DIR')
    expect(runtimeRoots(paths, withOverlay).reads).toContain(overlay)
    expect(runtimeRoots(paths, withOverlay).writes).not.toContain(overlay)
    expect(runtimeRoots(paths, facts).reads).not.toContain(overlay)

    const readDeny = text.split('\n').find(line => line.startsWith('(deny file-read* (apply require-all')) ?? ''
    const writeDeny = text.split('\n').find(line => line.startsWith('(deny file-write* (apply require-all')) ?? ''

    expect(readDeny).toContain('"PLUGINS_DIR"')
    expect(writeDeny).not.toContain('"PLUGINS_DIR"')
    expect(text.split('\n').find(line => line.startsWith('(allow file-read* (') || line.includes('(allow file-read* (apply require-any f)'))).toBeDefined()
    expect(text).toContain(`(iclone-subpaths '("RUNTIME_ROOT" "VENV_ROOT" "PYTHON_HOME" "PLUGINS_DIR" "PROFILES_DIR" "PROJECT" "WEB_DIST"))`)
  })

  it('interpreterLinks: a link inside an opened code hole is accepted; elsewhere in userData it is still refused', () => {
    const root = world()
    const ud = path.join(root, 'Application Support', 'iclone os')
    const rt = path.join(ud, 'hermes-runtime', 'a'.repeat(64))
    const py = path.join(rt, '.iclone-deps', 'hermes', 'tools', 'python-3.14')
    const venv = path.join(rt, '.iclone-deps', 'hermes', 'installs', 'k', 'environments', 'gen1', 'venv')

    const here: ConfinementPaths = {
      ...paths,
      home: path.join(root, 'home'),
      hermesHome: path.join(root, 'home', '.hermes'),
      userDataDir: ud,
      hermesRoot: rt,
      profilesDir: path.join(ud, 'confinement', 'profiles'),
      membersDir: path.join(root, 'members')
    }

    const hereFacts: RuntimeFacts = {
      ...facts,
      runtimeRoot: rt,
      venvRoot: venv,
      python: path.join(py, 'bin', 'python3.14'),
      pythonHome: py,
      project: null,
      tmpDir: path.join(root, 'tmp')
    }

    mkdirSync(path.join(py, 'bin'), { recursive: true })
    writeFileSync(path.join(py, 'bin', 'python3.14'), '')
    mkdirSync(path.join(venv, 'bin'), { recursive: true })
    symlinkSync(path.join(py, 'bin', 'python3.14'), path.join(venv, 'bin', 'python'))

    expect(interpreterLinks(here, [path.join(venv, 'bin', 'python')], hereFacts)).toEqual([path.join(venv, 'bin', 'python')])
    // Without the spawn's facts no hole is open: the same link is refused, as before.
    expect(() => interpreterLinks(here, [path.join(venv, 'bin', 'python')])).toThrow(/a link inside .*iclone os, which the runtime may never read/)

    // Another runtime's folder in userData is no hole of this spawn.
    const other = path.join(ud, 'hermes-runtime', 'b'.repeat(64), 'venv', 'bin')

    mkdirSync(other, { recursive: true })
    symlinkSync(path.join(py, 'bin', 'python3.14'), path.join(other, 'python'))
    expect(() => interpreterLinks(here, [path.join(other, 'python')], hereFacts)).toThrow(/a link inside .*iclone os, which the runtime may never read/)
  })
})

describe('runtimeProfileParams', () => {
  const asMap = (list: string[]) => {
    const out: Record<string, string> = {}

    for (let i = 0; i < list.length; i += 2) {
      expect(list[i]).toBe('-D')
      const [key, ...value] = list[i + 1].split('=')

      out[key] = value.join('=')
    }

    return out
  }

  it('passes each root once, absolute', () => {
    const params = asMap(runtimeProfileParams(paths, facts))

    expect(params.HERMES_HOME).toBe('/Users/owner/.hermes')
    expect(params.RUN_DIR).toBe(`${paths.userDataDir}/confinement/run`)
    expect(params.LAUNCHER_SOCKET).toBe(`${paths.userDataDir}/confinement/run/launcher.sock`)
    expect(params.PYTHON_EXE).toBe(facts.python)
    expect(params.PROJECT).toBe('/Users/owner/code/app')
    expect(params.PERM_SOCKET).toBe(facts.permSocket)
    expect(Object.values(params).every(value => value.startsWith('/'))).toBe(true)
  })

  it('leaves out a project that is the home (main falls back to it), and holes outside userData', () => {
    const params = asMap(
      runtimeProfileParams(paths, { ...facts, project: '/Users/owner', permDir: '/Users/owner/elsewhere' })
    )

    expect(params.PROJECT).toBeUndefined()
    expect(params.PERM_DIR).toBeUndefined()
    expect(params.HOME_DIR).toBe('/Users/owner')
  })

  it('leaves out a root that holds a denied path', () => {
    expect(asMap(runtimeProfileParams(paths, { ...facts, tmpDir: '/Users/owner' })).TMP).toBeUndefined()
    expect(asMap(runtimeProfileParams(paths, { ...facts, webDist: '/Users/owner/Library' })).WEB_DIST).toBeUndefined()
  })
})

describe('runtimeRoots — the launcher is told exactly what the profile gets', () => {
  const params = (facts: Parameters<typeof runtimeProfileParams>[1]) => {
    const out: Record<string, string> = {}
    const list = runtimeProfileParams(paths, facts)

    for (let i = 0; i < list.length; i += 2) {
      const [key, ...value] = list[i + 1].split('=')

      out[key] = value.join('=')
    }

    return out
  }

  it('the read roots are the profile’s read parameters and the write roots its write parameters, never the app state', () => {
    const roots = runtimeRoots(paths, facts)
    const given = params(facts)

    expect(roots.reads).toEqual(
      ['RUNTIME_ROOT', 'VENV_ROOT', 'PYTHON_HOME', 'PROFILES_DIR', 'PROJECT', 'WEB_DIST'].map(name => given[name])
    )
    expect(roots.writes).toEqual(
      ['HERMES_HOME', 'SCRATCH_ROOT', 'TMP', 'CACHE'].map(name => given[name]).filter(Boolean)
    )
    expect(roots.reads.every(Boolean) && roots.writes.every(Boolean)).toBe(true)

    // The app's state is the runtime's to hole, never a command's: of userData only the agent profiles are a root.
    for (const root of roots.writes) {
      expect(root.startsWith(paths.userDataDir), root).toBe(false)
    }

    for (const root of roots.reads) {
      expect(root === given.PROFILES_DIR || !root.startsWith(paths.userDataDir), root).toBe(true)
    }

    for (const hole of ['RUN_DIR', 'READY_DIR', 'PYCACHE', 'REFUSALS_DIR']) {
      expect(given[hole] === undefined || !roots.writes.includes(given[hole]), hole).toBe(true)
    }
  })

  it('a parameter the filter drops is no root either', () => {
    const dropped = { ...facts, tmpDir: '/Users/owner', project: '/Users/owner', webDist: null }
    const roots = runtimeRoots(paths, dropped)
    const given = params(dropped)

    expect(given.TMP).toBeUndefined()
    expect(roots.writes).toEqual(['HERMES_HOME', 'SCRATCH_ROOT', 'CACHE'].map(name => given[name]).filter(Boolean))
    expect(roots.reads).not.toContain('/Users/owner')
    expect(roots.reads).toHaveLength(4)
  })
})

describe('runtimeSandboxArgv', () => {
  it('is sandbox-exec, the text, the defines, then the command', () => {
    const profile = generateRuntimeProfile(paths)
    const params = runtimeProfileParams(paths, facts)
    const argv = runtimeSandboxArgv(profile, params, facts.python, ['-s', '-P', '-m', 'hermes_cli.main', 'serve'])

    expect(argv.slice(0, 3)).toEqual([SANDBOX_EXEC_PATH, '-p', profile.text])
    expect(argv.slice(3, 3 + params.length)).toEqual(params)
    expect(argv.slice(3 + params.length)).toEqual([facts.python, '-s', '-P', '-m', 'hermes_cli.main', 'serve'])
  })
})

describe('the launcher ledger', () => {
  it('lies under userData outside every hole the profile opens, so the whole-userData denial covers it', () => {
    const ledger = launcherLedgerDir(paths.userDataDir)

    const params = Object.fromEntries(
      runtimeProfileParams(paths, facts)
        .filter(item => item !== '-D')
        .map(define => define.split('=', 2) as [string, string])
    )

    expect(ledger).toBe(`${paths.userDataDir}/confinement/ledger`)
    expect(ledger.startsWith(`${paths.userDataDir}/`)).toBe(true)

    // HOME_DIR is a stat-only literal (never a subpath); every other parameter is a folder or file the runtime reaches.
    for (const [name, value] of Object.entries(params).filter(([name]) => name !== 'HOME_DIR')) {
      expect({ name, inside: ledger === value || ledger.startsWith(`${value}/`) }).toEqual({ name, inside: false })
    }

    expect(text).toContain(`(subpath "${paths.userDataDir}")`)
  })
})

describe('the runtime temp folder fits a unix socket', () => {
  // The installed app's paths for an explicit user name, as strings only (nothing is created, and nothing depends on
  // the HOME of the Mac running this): the per-user folders carry the user name, which is what decides the length.
  const homeOf = (user: string) => path.join('/Users', user)
  const userDataOf = (user: string) => path.join(homeOf(user), 'Library', 'Application Support', 'iclone os')
  const scratchOf = (user: string) => path.join(homeOf(user), 'Library', 'Caches', 'iclone-os-confinement', 'scratch')
  const fits = (folder: string) => folder.length + PYTHON_SOCKET_SUFFIX_MAX <= UNIX_SOCKET_PATH_MAX
  /** The longest macOS short name the runtime temp folder still fits a socket for, from the constants themselves
   *  (the folder for a one-letter name, less that letter). */
  const USER_NAME_BUDGET = UNIX_SOCKET_PATH_MAX - PYTHON_SOCKET_SUFFIX_MAX - (runtimeTmpFolder(scratchOf('x')).length - 1)
  /** The room the design promises: a short name of this many characters still fits. */
  const USER_NAME_ROOM = 22

  it('a socket Python makes in the run dir temp folder would not fit for a user name the design must allow', () => {
    const runDirTmp = path.join(runtimeRunDir(userDataOf('u'.repeat(USER_NAME_ROOM))), 'tmp')

    // The run dir sits under Application Support: with multiprocessing's listener name added, past the 103 the
    // kernel binds, already for a name far shorter than the room above.
    expect(fits(runDirTmp)).toBe(false)
    expect(fits(path.join(runtimeRunDir(userDataOf('u'.repeat(8))), 'tmp'))).toBe(false)
  })

  it(`the folder beside the scratch root fits a user name of ${USER_NAME_ROOM} characters, and its budget ends exactly where the constants say`, () => {
    const longest = 'u'.repeat(USER_NAME_BUDGET)
    const folder = runtimeTmpFolder(scratchOf(longest))

    expect(USER_NAME_BUDGET).toBeGreaterThanOrEqual(USER_NAME_ROOM)
    expect(folder).toBe(path.join(homeOf(longest), 'Library', 'Caches', 'iclone-os-confinement', 'tmp'))
    expect(fits(runtimeTmpFolder(scratchOf('a')))).toBe(true)
    expect(fits(runtimeTmpFolder(scratchOf('u'.repeat(USER_NAME_ROOM))))).toBe(true)
    expect(fits(folder)).toBe(true)
    expect(fits(runtimeTmpFolder(scratchOf('u'.repeat(USER_NAME_BUDGET + 1))))).toBe(false)
    expect(folder.length).toBeLessThan(path.join(runtimeRunDir(userDataOf(longest)), 'tmp').length - 14)
    // The agent profiles open the scratch itself, never its parent: the temp folder is the runtime's alone.
    expect(folder.startsWith(`${scratchOf(longest)}/`)).toBe(false)
  })

  it('is passed as TMP and the profile lets the runtime write it', () => {
    const tmpDir = runtimeTmpFolder(paths.scratchRoot)
    const params = runtimeProfileParams(paths, { ...facts, tmpDir })

    expect(params).toContain(`TMP=${tmpDir}`)
    expect(text).toContain('"TMP"')
  })
})

describe('judgeHelperInterpreter — what main may run outside every sandbox', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /** A non-packaged layout: PM's venv and Python under HERMES_HOME, the runtime root beside them. */
  function world() {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'iclone-helper-')))

    roots.push(root)

    const home = path.join(root, 'home')
    const hermesHome = path.join(home, '.hermes')
    const userDataDir = path.join(home, 'Library', 'Application Support', 'iclone os')
    const hermesRoot = path.join(hermesHome, 'hermes-agent')
    const pythonHome = path.join(hermesHome, 'tools', 'python-3.14')
    const binary = path.join(pythonHome, 'bin', 'python3.14')
    const venv = path.join(hermesHome, 'installs', '0123456789abcdef', 'environments', 'gen1', 'venv')
    const uv = path.join(home, '.local', 'share', 'uv', 'python', 'cpython-3.14', 'bin', 'python3.14')

    for (const dir of [hermesRoot, path.dirname(binary), path.join(venv, 'bin'), path.dirname(uv), userDataDir]) {
      mkdirSync(dir, { recursive: true })
    }

    writeFileSync(binary, '')
    writeFileSync(uv, '')
    symlinkSync(binary, path.join(venv, 'bin', 'python'))

    const layout: ConfinementPaths = {
      home,
      hermesHome,
      userDataDir,
      hermesRoot,
      profilesDir: path.join(userDataDir, 'confinement', 'profiles'),
      scratchRoot: path.join(home, 'Library', 'Caches', 'iclone-os-confinement', 'scratch'),
      membersDir: path.join(home, 'Library', 'Caches', 'iclone-os-confinement', 'members')
    }

    return { root, home, hermesHome, userDataDir, hermesRoot, binary, venv, uv, layout }
  }

  it('trusts PM’s venv and Python under HERMES_HOME (write-denied folders), the runtime root, and a binary outside every write root', () => {
    const w = world()

    expect(judgeHelperInterpreter(w.layout, path.join(w.venv, 'bin', 'python'))).toEqual({
      trusted: true,
      path: path.join(w.venv, 'bin', 'python'),
      real: w.binary
    })
    expect(judgeHelperInterpreter(w.layout, w.binary).trusted).toBe(true)
    expect(judgeHelperInterpreter(w.layout, w.uv).trusted).toBe(true)

    const inTree = path.join(w.hermesRoot, 'venv', 'bin', 'python')

    mkdirSync(path.dirname(inTree), { recursive: true })
    writeFileSync(inTree, '')
    expect(judgeHelperInterpreter(w.layout, inTree).trusted).toBe(true)
  })

  it('refuses, naming the folder, a binary anywhere else in HERMES_HOME, in the scratch, the temp folder, the run dir or the ready folder', () => {
    const w = world()

    const planted = [
      path.join(w.hermesHome, 'cache', 'v', 'bin', 'python'),
      path.join(w.layout.scratchRoot, 'python'),
      path.join(runtimeTmpFolder(w.layout.scratchRoot), 'python'),
      path.join(runtimeRunDir(w.userDataDir), 'python'),
      path.join(w.userDataDir, 'backend-ready', 'python')
    ]

    for (const file of planted) {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, '#!/bin/sh\n')

      const verdict = judgeHelperInterpreter(w.layout, file)

      expect(verdict.trusted).toBe(false)
      expect(verdict.trusted ? '' : verdict.reason).toMatch(/lies in .*, which the agent runtime can write$/)
    }

    const cache = judgeHelperInterpreter(w.layout, planted[0])

    expect(cache.trusted ? '' : cache.reason).toBe(`${planted[0]} lies in ${w.hermesHome}, which the agent runtime can write`)
  })

  it('refuses a trusted binary reached through a link the runtime could repoint', () => {
    const w = world()
    const link = path.join(w.hermesHome, 'cache', 'python')

    mkdirSync(path.dirname(link), { recursive: true })
    symlinkSync(w.binary, link)

    const verdict = judgeHelperInterpreter(w.layout, link)

    expect(verdict).toEqual({
      trusted: false,
      path: link,
      reason: `${link} is reached through ${link}, a link inside ${w.hermesHome}, which the agent runtime can write`
    })
  })

  it('the spawn’s own cache and bytecode folders count as writable when the facts name them', () => {
    const w = world()
    const cacheDir = path.join(w.root, 'cache')
    const file = path.join(cacheDir, 'python')

    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(file, '')
    expect(judgeHelperInterpreter(w.layout, file).trusted).toBe(true)
    expect(judgeHelperInterpreter(w.layout, file, { cacheDir }).trusted).toBe(false)
  })

  it('packaged: the managed runtime’s interpreter under userData is trusted (the runtime root is never written); a file beside it in userData is not', () => {
    const w = world()
    const runtimeRoot = path.join(w.userDataDir, 'hermes-runtime', 'a'.repeat(64))
    const binary = path.join(runtimeRoot, '.iclone-deps', 'hermes', 'tools', 'python-3.14', 'bin', 'python3.14')
    const stray = path.join(w.userDataDir, 'confinement', 'run', 'python')

    for (const file of [binary, stray]) {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, '')
    }

    const packaged: ConfinementPaths = { ...w.layout, hermesRoot: runtimeRoot }

    expect(judgeHelperInterpreter(packaged, binary).trusted).toBe(true)
    expect(judgeHelperInterpreter(packaged, stray).trusted).toBe(false)
  })

  it('a missing file, a folder or a relative path is refused with a plain reason', () => {
    const w = world()

    expect(judgeHelperInterpreter(w.layout, path.join(w.root, 'nowhere', 'python'))).toMatchObject({
      trusted: false,
      reason: expect.stringContaining('cannot be resolved')
    })
    expect(judgeHelperInterpreter(w.layout, w.hermesRoot)).toMatchObject({ trusted: false, reason: `${w.hermesRoot} is not a file` })
    expect(judgeHelperInterpreter(w.layout, 'bin/python')).toMatchObject({ trusted: false, reason: 'bin/python is not an absolute path' })
  })
})
