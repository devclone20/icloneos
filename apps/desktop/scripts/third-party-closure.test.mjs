// K103 / REL-2: the packages the notices must carry are read from the lockfile with npm's own resolution, and the
// check re-renders the generated section and requires a byte-for-byte match (negative controls included).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, test } from 'vitest'

import {
  ACP_BEGIN,
  ACP_END,
  acpClosure,
  BEGIN,
  checkNotices,
  compareSection,
  copyleftTextProblems,
  computeClosure,
  desktopRoots,
  END,
  FONT_FAMILIES,
  fontLicenceText,
  FONTS_BEGIN,
  FONTS_END,
  ELECTRON_FRAMEWORKS,
  frameworkLicenceText,
  frameworkListProblems,
  FRAMEWORKS_BEGIN,
  FRAMEWORKS_END,
  renderFrameworksSection,
  importedPackages,
  PRIVY_BUNDLE_FONT,
  LICENCE_REVIEW,
  licenceFlag,
  nativeBinaryNotice,
  nativeBinaryProblems,
  readLicence,
  removeSection,
  renderSection,
  requiredCopyleftTexts,
  resolveFrom,
  renderFontsSection,
  spliceSection,
  STANDARD_TEXTS,
  standardText,
  unlicensedRows,
  unlistedFontFiles,
  unreviewedLicences
} from './third-party-closure.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const LOCK = {
  packages: {
    '': { name: 'root' },
    'apps/desktop': {
      dependencies: { top: '1.0.0', '@tailwindcss/vite': '4', 'node-pty': '1', '@hermes/shared': 'file:../shared' },
      devDependencies: { electron: '40' }
    },
    'apps/desktop/node_modules/electron': { version: '40.0.0', license: 'MIT', dependencies: { '@electron/get': '2' } },
    'node_modules/@hermes/shared': { link: true, resolved: 'apps/shared' },
    'apps/shared': { version: '0.0.0', dependencies: { leaf: '1' } },
    'node_modules/@tailwindcss/vite': { version: '4.0.0', license: 'MIT', dependencies: { lightningcss: '1' } },
    'node_modules/node-pty': { version: '1.0.0', license: 'MIT', dependencies: { 'node-addon-api': '7' } },
    'node_modules/top': { version: '1.0.0', license: 'MIT', dependencies: { mid: '2', leaf: '1' } },
    'node_modules/top/node_modules/leaf': { version: '3.0.0', license: 'MIT' },
    'node_modules/mid': {
      version: '2.0.0',
      license: 'ISC',
      dependencies: { leaf: '1' },
      optionalDependencies: { 'not-installed': '1' },
      peerDependencies: { typescript: '5' }
    },
    'node_modules/leaf': { version: '1.0.0', license: 'MIT' },
    'node_modules/lucide-react': { version: '0.5.0', license: 'ISC' },
    'node_modules/supports-color': { version: '10.0.0', license: 'MIT', dev: true },
    'node_modules/typescript': { version: '5.0.0', license: 'Apache-2.0', dev: true }
  }
}
const ROOTS = [{ workspace: 'apps/desktop', name: 'top' }]
const temps = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpc-'))
  temps.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A fake installed package under `base`. */
function install(base, key, manifest, files = {}) {
  const dir = join(base, key)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))

  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text)
  }
}

describe('third-party closure (K103, REL-2)', () => {
  test('resolves the nearest node_modules first, then walks up to the root', () => {
    assert.equal(resolveFrom(LOCK.packages, 'node_modules/top', 'leaf'), 'node_modules/top/node_modules/leaf')
    assert.equal(resolveFrom(LOCK.packages, 'node_modules/mid', 'leaf'), 'node_modules/leaf')
    assert.equal(resolveFrom(LOCK.packages, 'apps/desktop', 'top'), 'node_modules/top')
    assert.equal(resolveFrom(LOCK.packages, 'apps/desktop', 'absent'), null)
  })

  test('follows dependencies and installed optionals, never peers', () => {
    const ids = [...computeClosure(LOCK, ROOTS).keys()]
    assert.deepEqual(ids, ['leaf@1.0.0', 'leaf@3.0.0', 'mid@2.0.0', 'top@1.0.0'])
    assert.ok(!ids.some(id => id.startsWith('typescript@')))
  })

  test('an unresolvable required dependency is an error, not a silent gap', () => {
    const broken = structuredClone(LOCK)
    delete broken.packages['node_modules/leaf']
    assert.throws(() => computeClosure(broken, ROOTS), /unresolved dependency leaf/)
  })

  test('desktop roots: declared deps from the lockfile, minus build-only, plus undeclared and electron', () => {
    const roots = desktopRoots(LOCK)
    const names = roots.map(r => r.name)
    assert.ok(!names.includes('@tailwindcss/vite'))
    assert.ok(names.includes('supports-color') && names.includes('electron'))
    assert.ok(!names.includes('lucide-react'), 'an installed package nobody declares is not shipped')
    assert.equal(roots.find(r => r.name === 'node-pty').follow, false)
    assert.equal(roots.find(r => r.name === 'electron').follow, false)

    const ids = [...computeClosure(LOCK, roots).keys()]
    // electron and node-pty are listed but not followed; the workspace link is followed but never listed.
    assert.ok(ids.includes('electron@40.0.0') && ids.includes('node-pty@1.0.0') && ids.includes('leaf@1.0.0'))
    assert.ok(!ids.some(id => /^(@electron\/get|node-addon-api|lightningcss|@hermes\/shared|@0\.0\.0)/.test(id)))
  })

  test('a BUILD_ONLY entry the workspace no longer declares is refused, so the list cannot rot', () => {
    const stale = structuredClone(LOCK)
    delete stale.packages['apps/desktop'].dependencies['@tailwindcss/vite']
    assert.throws(() => desktopRoots(stale), /BUILD_ONLY names @tailwindcss\/vite/)
  })

  test('ruling 23: an UNDECLARED entry the workspace now declares is refused, so a phantom cannot hide a declaration', () => {
    const declared = structuredClone(LOCK)
    declared.packages['apps/desktop'].dependencies['supports-color'] = '10.0.0'
    assert.throws(() => desktopRoots(declared), /UNDECLARED names supports-color/)
  })

  test('ruling 22: Codicons ships both texts (CC BY 4.0 font, MIT code) under its attribution, BOM stripped', () => {
    const base = temp()
    install(
      base,
      'node_modules/@vscode/codicons',
      { name: '@vscode/codicons', version: '0.0.45', license: 'CC-BY-4.0' },
      { LICENSE: '\uFEFFAttribution 4.0 International\r\n\r\nlegal code\r\n', 'LICENSE-CODE': 'MIT License\n' }
    )
    const row = {
      name: '@vscode/codicons',
      version: '0.0.45',
      license: 'CC-BY-4.0',
      paths: ['node_modules/@vscode/codicons']
    }
    const got = readLicence(base, row)
    assert.equal(got.text, 'Attribution 4.0 International\n\nlegal code\n\n----- LICENSE-CODE -----\n\nMIT License')
    assert.match(got.note, /^attribution under CC BY 4\.0: the Codicons icon font .* copyright Microsoft Corporation/)
    assert.match(
      renderSection(new Map([['c', row]]), r => readLicence(base, r)),
      /\(Attribution under CC BY 4\.0: /
    )
  })

  test('ruling 19: an LGPL-3.0 package brings the full LGPL-3.0 and GPL-3.0 texts, and their absence is a problem', () => {
    const lgpl = { name: 'rpc-like', version: '1.0.0', license: 'LGPL-3.0-only', paths: ['node_modules/rpc-like'] }
    const mit = { name: 'leaf', version: '1.0.0', license: 'MIT', paths: ['node_modules/leaf'] }
    assert.deepEqual(requiredCopyleftTexts([mit]), [])

    const texts = requiredCopyleftTexts([mit, lgpl])
    assert.deepEqual(
      texts.map(x => x.file),
      ['LGPL-3.0.txt', 'GPL-3.0.txt']
    )
    assert.match(texts[0].body, /^\s*GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/)
    assert.match(texts[1].body, /^\s*GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/)

    const section = renderSection(
      new Map([
        ['a', mit],
        ['b', lgpl]
      ]),
      () => 'pointer to gnu.org'
    )
    assert.ok(section.includes(texts[0].body) && section.includes(texts[1].body))
    assert.deepEqual(copyleftTextProblems(section, [lgpl]), [])

    // The mutation the lead asked for: the GPL text removed, the LGPL text kept.
    const noGpl = section.replace(texts[1].body, '')
    const problems = copyleftTextProblems(noGpl, [lgpl])
    assert.equal(problems.length, 1)
    assert.match(problems[0], /rpc-like@1\.0\.0: .*GNU General Public License, version 3/)
  })

  test('ruling 19: a vendored GNU text that is not the canonical file (sha256) is refused', () => {
    const dir = temp()
    writeFileSync(join(dir, 'LGPL-3.0.txt'), 'GNU LESSER GENERAL PUBLIC LICENSE (truncated)')
    writeFileSync(join(dir, 'GPL-3.0.txt'), 'x')
    const lgpl = { name: 'rpc-like', version: '1.0.0', license: 'LGPL-3.0-only' }
    assert.throws(() => requiredCopyleftTexts([lgpl], dir), /LGPL-3\.0\.txt is not the canonical text/)
  })

  test('ruling 20: a package with no licence never passes, whatever LICENCE_REVIEW says', () => {
    const base = temp()
    install(base, 'node_modules/nolic', { name: 'nolic', version: '1.0.0' })
    install(base, 'node_modules/khroma', { name: 'khroma', version: '2.1.0' }, { license: 'The MIT License (MIT)' })
    install(base, 'node_modules/fake', { name: 'fake', version: '1.0.0' })
    const row = (name, version, license = '') => ({ name, version, license, paths: [`node_modules/${name}`] })
    const read = r => readLicence(base, r)
    const rows = [row('nolic', '1.0.0'), row('khroma', '2.1.0'), row('mit', '1.0.0', 'MIT')]

    assert.deepEqual(
      unlicensedRows(rows, r => (r.name === 'mit' ? { text: 'MIT' } : read(r))).map(r => r.name),
      ['nolic']
    )
    // A reviewed id that ships no file is still refused (the reviewed file must exist), and a review entry is no waiver.
    const khromaNoFile = row('khroma', '2.1.0')
    khromaNoFile.paths = ['node_modules/fake']
    assert.equal(unlicensedRows([{ ...khromaNoFile, version: '2.1.0' }], () => read(row('nolic', '1.0.0'))).length, 1)
    assert.ok(Object.hasOwn(LICENCE_REVIEW, '@alchemy/wallet-api-types@0.1.0-alpha.26'))
    assert.equal(unlicensedRows([row('@alchemy/wallet-api-types', '0.1.0-alpha.26')], () => ({ text: 'x' })).length, 1)
  })

  test('identical licence texts share one heading; the splice is idempotent', () => {
    const closure = computeClosure(LOCK, ROOTS)
    const section = renderSection(closure, () => 'MIT text')
    assert.match(section, /### `leaf@1\.0\.0`, `leaf@3\.0\.0`, `mid@2\.0\.0`, `top@1\.0\.0`/)

    const base = '# Notices\n\n## Packages\n\n## Vendored skills\n\nrows\n'
    const once = spliceSection(base, section)
    assert.ok(once.indexOf(BEGIN) < once.indexOf('## Vendored skills'))
    assert.equal(spliceSection(once, section), once)
    assert.equal(once.split(END).length, 2)

    const acp = renderSection(closure, () => 'x', { begin: ACP_BEGIN, end: ACP_END, title: 'ACP' })
    const both = spliceSection(once, acp, { begin: ACP_BEGIN, end: ACP_END, after: END })
    assert.ok(both.indexOf(END) < both.indexOf(ACP_BEGIN) && both.indexOf(ACP_END) < both.indexOf('## Vendored skills'))
    assert.equal(spliceSection(both, acp, { begin: ACP_BEGIN, end: ACP_END, after: END }), both)
  })

  test('the byte check: equal passes; a deleted licence text, a GPL row or a heading-only entry is red', () => {
    const closure = computeClosure(LOCK, ROOTS)
    const section = renderSection(closure, row => ({ licence: row.license, text: `licence of ${row.name}`, note: '' }))
    const file = spliceSection('# N\n\n## Vendored skills\n', section)
    assert.deepEqual(compareSection(file, section), [])

    // Negative control 1: one licence text deleted (its heading stays).
    const noText = file.replace('licence of mid\n', '')
    assert.equal(compareSection(noText, section).length, 1)

    // Negative control 2: one row's licence changed to GPL-3.0.
    const gpl = file.replace(/^(\| `mid` +\| 2\.0\.0 +\| )ISC/m, '$1GPL-3.0')
    assert.notEqual(gpl, file)
    assert.equal(compareSection(gpl, section).length, 1)

    // The M4 forgery: rows + one heading naming every id, no text at all, used to pass the old presence check.
    const forged = `${BEGIN}\n${[...closure.values()].map(r => `| \`${r.name}\` | ${r.version} | GPL-3.0 |`).join('\n')}\n### ${[...closure.keys()].map(id => `\`${id}\``).join(' ')}\n${END}`
    assert.equal(compareSection(forged, section).length, 1)

    assert.match(compareSection('# no markers', section)[0], /no generated section/)
  })

  test('licence texts: the shipped file, else the standard text it declares, else an explicit no-licence entry', () => {
    const base = temp()
    install(
      base,
      'node_modules/a',
      { name: 'a', version: '1.0.0', license: 'MIT' },
      { 'LICENSE-MIT': 'own text  \r\n' }
    )
    install(base, 'node_modules/b', { name: 'b', version: '1.0.0', license: 'ISC', author: 'Ann <a@x>' })
    install(base, 'node_modules/c', { name: 'c', version: '1.0.0' })
    install(base, 'node_modules/d', { name: 'd', version: '1.0.0', license: 'BSD-3-Clause' })
    install(base, 'node_modules/e', { name: 'e', version: '2.0.0', license: 'MIT' }, { LICENSE: 'x' })
    const row = (name, version = '1.0.0', license = '') => ({ name, version, license, paths: [`node_modules/${name}`] })

    assert.deepEqual(readLicence(base, row('a')), { licence: 'MIT', text: 'own text', note: '' })
    const b = readLicence(base, row('b'))
    assert.equal(b.licence, 'ISC')
    assert.match(b.text, /^ISC License\n\nCopyright \(c\) Ann\n/)
    assert.match(b.note, /standard ISC text/)
    assert.match(readLicence(base, row('c')).text, /^No licence/)
    assert.equal(readLicence(base, row('c')).licence, 'UNKNOWN')
    assert.throws(() => readLicence(base, row('d')), /write its text by hand/)
    assert.throws(() => readLicence(base, row('e', '1.0.0')), /run npm ci/)
  })

  test('licence flags: permissive passes, copyleft/custom/none are flagged, and only reviewed ids are let through', () => {
    for (const ok of ['MIT', '(MPL-2.0 OR Apache-2.0)', 'Apache 2.0', 'BSD-3-Clause AND MIT']) {
      assert.equal(licenceFlag(ok), null, ok)
    }

    assert.equal(licenceFlag('GPL-3.0'), 'copyleft')
    assert.equal(licenceFlag('LGPL-3.0-only'), 'copyleft')
    assert.equal(licenceFlag(''), 'no licence declared')
    assert.equal(licenceFlag('UNKNOWN'), 'no licence declared')
    assert.match(licenceFlag('SEE LICENSE IN LICENSE'), /custom/)

    const rows = [
      { name: 'ok', version: '1.0.0', license: 'MIT' },
      { name: 'known', version: '1.0.0', license: 'GPL-3.0' },
      { name: 'new', version: '1.0.0', license: 'GPL-3.0' }
    ]
    const flagged = unreviewedLicences(rows, { 'known@1.0.0': 'pending' })
    assert.deepEqual(
      flagged.map(f => [f.id, f.reviewed]),
      [
        ['known@1.0.0', true],
        ['new@1.0.0', false]
      ]
    )
  })

  test('the ACP CLI rows come from its tree lockfile, only for packages still on disk; strays are refused', () => {
    const tree = temp()
    install(tree, 'node_modules/@v/cli', { name: '@v/cli', version: '1.0.0', license: 'ISC' })
    install(tree, 'node_modules/kept', { name: 'kept', version: '2.0.0', license: 'MIT' })
    const lock = {
      packages: {
        '': {},
        'node_modules/@v/cli': { version: '1.0.0', license: 'ISC' },
        'node_modules/kept': { version: '2.0.0', license: 'MIT' },
        'node_modules/pruned': { version: '3.0.0', license: 'MIT' }
      }
    }
    writeFileSync(join(tree, 'node_modules', '.package-lock.json'), JSON.stringify(lock))
    assert.deepEqual([...acpClosure(tree).keys()], ['@v/cli@1.0.0', 'kept@2.0.0'])

    install(tree, 'node_modules/stray', { name: 'stray', version: '1.0.0' })
    assert.throws(() => acpClosure(tree), /node_modules\/stray is in the staged ACP CLI tree but not in its lockfile/)
  })

  test('the import scan names bare packages of shipped sources, not tests, types, aliases or builtins', () => {
    const repo = temp()
    const src = join(repo, 'apps/desktop/src')
    mkdirSync(join(src, 'test'), { recursive: true })
    mkdirSync(join(repo, 'apps/desktop/src/debug'), { recursive: true })
    writeFileSync(
      join(src, 'a.tsx'),
      [
        "import { x } from 'pkg-a/sub'",
        "import type { T } from 'types-only'",
        "import '@scope/side-effect'",
        "export { y } from 'pkg-b'",
        "const z = await import('pkg-c')",
        "const fs = require('node:fs'); import path from 'path'; import e from 'electron'",
        "import a from '@/alias'; import s from '@hermes/shared'; import r from './rel'",
        "// import('…') in a comment"
      ].join('\n')
    )
    writeFileSync(join(src, 'a.test.ts'), "import { vi } from 'vitest'")
    // A helper only that file's tests import (electron/iclone-telemetry-seal.test-helpers.ts imports `typescript`):
    // a test file, so the shipped closure must not grow a build-only package because of it.
    writeFileSync(join(src, 'a.test-helpers.ts'), "import ts from 'typescript'")
    writeFileSync(join(src, 'b.spec-helper.ts'), "import ts from 'typescript'")
    writeFileSync(join(src, 'test', 'jsdom.ts'), "import 'vitest'")
    writeFileSync(join(repo, 'apps/desktop/src/debug', 'counter.ts'), "import 'bippy'")
    assert.deepEqual(
      [...importedPackages(repo).keys()].sort(),
      ['@scope/side-effect', 'pkg-a', 'pkg-b', 'pkg-c'],
      'a test helper must not put its build-only package in the shipped closure'
    )
  })

  test('REL-6 (ruling 26): the notices cover what the DMG ships; an ACP CLI section is refused and --write drops it', () => {
    const section = `${ACP_BEGIN}\n\n## ACP CLI (Resources/acp-cli)\n\nrows\n\n${ACP_END}`
    const text = `# Notices\n\n${BEGIN}\nx\n${END}\n\n${section}\n\n## Vendored skills\n`
    const once = removeSection(text, { begin: ACP_BEGIN, end: ACP_END })

    assert.ok(!once.includes(ACP_BEGIN) && !once.includes('ACP CLI'))
    assert.equal(removeSection(once, { begin: ACP_BEGIN, end: ACP_END }), once)
    assert.ok(once.includes(`${END}\n\n## Vendored skills`))

    const repo = mkdtempSync(join(tmpdir(), 'iclone-rel6-notices-'))

    try {
      writeFileSync(join(repo, 'package-lock.json'), readFileSync(join(REPO, 'package-lock.json')))
      writeFileSync(
        join(repo, 'THIRD_PARTY_NOTICES.md'),
        `${readFileSync(join(REPO, 'THIRD_PARTY_NOTICES.md'), 'utf8')}\n${section}\n`
      )
      const { problems } = checkNotices({ repo, modules: REPO })

      assert.ok(problems.some(p => /still lists the ACP CLI, which the app no longer ships/.test(p)))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('REL-6 r3 (critic r2 M3): the native add-ons the DMG ships are in the notices; one LICENSE removed is red', () => {
    const notices = readFileSync(join(REPO, 'THIRD_PARTY_NOTICES.md'), 'utf8')

    for (const id of [
      '`@napi-rs/keyring-darwin-arm64@1.3.0` LICENSE',
      '`bufferutil@4.1.0` LICENSE',
      '`utf-8-validate@6.0.6` deps/is_utf8/LICENSE-MIT',
      '`utf-8-validate@5.0.10` LICENSE',
      '`security-framework@3.7.0` (Rust crate) LICENSE-MIT',
      'Rust standard library ('
    ]) {
      assert.ok(notices.includes(`### ${id}`), id)
    }

    const repo = mkdtempSync(join(tmpdir(), 'iclone-rel6-native-'))

    try {
      for (const dir of ['acp-native-notices', 'acp-cli-lock']) {
        cpSync(join(REPO, 'apps/desktop', dir), join(repo, 'apps/desktop', dir), { recursive: true })
      }

      writeFileSync(join(repo, 'package-lock.json'), readFileSync(join(REPO, 'package-lock.json')))
      writeFileSync(join(repo, 'THIRD_PARTY_NOTICES.md'), notices)
      rmSync(join(repo, 'apps/desktop/acp-native-notices/texts/bufferutil@4.1.0--LICENSE'))

      const { problems } = checkNotices({ repo, modules: REPO })

      assert.ok(problems.includes('acp-native: texts/bufferutil@4.1.0--LICENSE is missing'), problems.join('\n'))
      assert.ok(problems.some(p => /^acp-native: cannot render the section|^acp-native: the generated section/.test(p)))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('the shipped notices match the render of the real lockfile byte for byte', () => {
    const { problems, closure } = checkNotices({ repo: REPO, acpTree: join(REPO, 'no-acp-tree-here') })
    const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'))
    assert.ok(closure.has(`viem@${lock.packages['node_modules/viem'].version}`))
    assert.ok(
      closure.has(
        `react@${lock.packages['apps/desktop/node_modules/react']?.version ?? lock.packages['node_modules/react'].version}`
      )
    )
    assert.ok(
      [...closure.keys()].some(id => id.startsWith('three@')) &&
        [...closure.keys()].some(id => id.startsWith('mermaid@'))
    )
    assert.deepEqual(problems, [])
  })

  test('M1 (REL-7): every font licence ships verbatim; a cut word, a cut section or an unlisted font is red', () => {
    const desktop = join(REPO, 'apps', 'desktop')
    const notices = readFileSync(join(REPO, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    const section = renderFontsSection()
    assert.deepEqual(compareSection(notices, section, { begin: FONTS_BEGIN, end: FONTS_END, label: 'fonts' }), [])

    for (const family of FONT_FAMILIES) {
      assert.ok(notices.includes(`\`\`\`text\n${fontLicenceText(family)}\n\`\`\``), family.heading)
    }

    // A copy of apps/desktop with the critic's corruption: four words cut at line ends (the v0.0.3 Fonts section).
    const fake = temp()
    mkdirSync(join(fake, 'src', 'fonts'), { recursive: true })

    for (const family of FONT_FAMILIES) {
      mkdirSync(dirname(join(fake, family.licence.file)), { recursive: true })
      copyFileSync(join(desktop, family.licence.file), join(fake, family.licence.file))
    }

    const noto = FONT_FAMILIES[0]
    const cut = readFileSync(join(desktop, noto.licence.file), 'utf8').replace(
      'by the Copyright\n',
      'by the Copyrigh\n'
    )
    writeFileSync(join(fake, noto.licence.file), cut)
    assert.throws(() => fontLicenceText(noto, fake), /is not the verbatim licence/)
    assert.throws(() => renderFontsSection(FONT_FAMILIES, fake), /is not the verbatim licence/)

    // The pin follows the corruption (someone re-pins it): the OFL body check still refuses it.
    const repinned = { ...noto, licence: { ...noto.licence, sha256: createHash('sha256').update(cut).digest('hex') } }
    assert.throws(() => fontLicenceText(repinned, fake), /is not the SIL Open Font License 1\.1 text/)

    // The notices with the PERMISSION & CONDITIONS body cut out of the Noto block (critic mutation S2).
    const a = notices.indexOf('PERMISSION & CONDITIONS', notices.indexOf(FONTS_BEGIN))
    const b = notices.indexOf('TERMINATION', a)
    const mutated = notices.slice(0, a) + notices.slice(b)
    assert.equal(compareSection(mutated, section, { begin: FONTS_BEGIN, end: FONTS_END, label: 'fonts' }).length, 1)

    // A font file of ours that no family lists.
    writeFileSync(join(fake, 'src', 'fonts', 'Stray-Bold.woff2'), 'wOF2')
    assert.deepEqual(unlistedFontFiles(fake), ['apps/desktop/src/fonts/Stray-Bold.woff2'])
    assert.deepEqual(unlistedFontFiles(desktop), [])
  })

  test('N-a (REL-8, ruling 39): every Electron framework ships with its pinned text; a stray or cut one is red', () => {
    const notices = readFileSync(join(REPO, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    const section = renderFrameworksSection()
    const label = { begin: FRAMEWORKS_BEGIN, end: FRAMEWORKS_END, label: 'frameworks' }
    assert.deepEqual(compareSection(notices, section, label), [])
    assert.deepEqual(ELECTRON_FRAMEWORKS.map(f => f.framework).sort(), [
      'Electron Framework.framework',
      'Mantle.framework',
      'ReactiveObjC.framework',
      'Squirrel.framework'
    ])

    for (const entry of ELECTRON_FRAMEWORKS) {
      assert.ok(section.includes(`| \`${entry.framework}\` |`), entry.framework)
      assert.ok(notices.includes(`\`\`\`text\n${frameworkLicenceText(entry)}\n\`\`\``), entry.framework)
    }

    // One byte of Mantle's text changed: refused by its pin, and the section no longer renders.
    const dir = temp()
    mkdirSync(join(dir, 'frameworks'))

    for (const entry of ELECTRON_FRAMEWORKS) {
      copyFileSync(join(REPO, 'apps/desktop/scripts/licence-texts', entry.file), join(dir, entry.file))
    }

    const mantle = ELECTRON_FRAMEWORKS.find(f => f.framework === 'Mantle.framework')
    const text = readFileSync(join(dir, mantle.file), 'utf8')
    writeFileSync(join(dir, mantle.file), text.replace('NONINFRINGEMENT', 'INFRINGEMENT'))
    assert.throws(() => frameworkLicenceText(mantle, dir), /is not the verbatim licence of Mantle\.framework/)
    assert.throws(() => renderFrameworksSection(ELECTRON_FRAMEWORKS, dir), /is not the verbatim licence/)

    // The notices with the ReactiveObjC block deleted: the byte check is red.
    const a = notices.indexOf('### `ReactiveObjC.framework`')
    const b = notices.indexOf(FRAMEWORKS_END)
    assert.equal(compareSection(notices.slice(0, a) + notices.slice(b), section, label).length, 1)

    // A distribution that carries a framework the list does not name, and lacks one it names.
    const fake = temp()
    const fw = join(fake, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Frameworks')

    for (const name of [
      'Electron Framework.framework',
      'Squirrel.framework',
      'Mantle.framework',
      'Sparkle.framework'
    ]) {
      mkdirSync(join(fw, name), { recursive: true })
    }

    assert.deepEqual(frameworkListProblems(fake), [
      'frameworks: Electron carries Sparkle.framework, but ELECTRON_FRAMEWORKS has no entry (its licence would ship unnoticed)',
      'frameworks: ELECTRON_FRAMEWORKS lists ReactiveObjC.framework, but Electron no longer carries it'
    ])
    assert.deepEqual(frameworkListProblems(temp()), [])
    assert.deepEqual(frameworkListProblems(REPO), [])
  })

  test('ruling 32 (REL-7): the standard MIT and ISC texts are committed files, pinned; a changed byte is refused', () => {
    assert.match(
      standardText('MIT', 'Jane Doe'),
      /^MIT License\n\nCopyright \(c\) Jane Doe\n\nPermission is hereby granted/
    )
    assert.match(standardText('ISC', 'Jane Doe'), /^ISC License\n\nCopyright \(c\) Jane Doe\n/)
    assert.equal(standardText('Apache-2.0', 'x'), null)

    const dir = temp()

    for (const entry of Object.values(STANDARD_TEXTS)) {
      writeFileSync(join(dir, entry.file), readFileSync(join(REPO, 'apps/desktop/scripts/licence-texts', entry.file)))
    }

    assert.match(standardText('MIT', 'x', dir), /Copyright \(c\) x/)
    const mit = readFileSync(join(dir, 'MIT.txt'), 'utf8')
    writeFileSync(join(dir, 'MIT.txt'), mit.replace('NONINFRINGEMENT', 'INFRINGEMENT'))
    assert.throws(() => standardText('MIT', 'x', dir), /is not the verbatim MIT text/)
  })

  test('N2 (REL-7, ruling 31): the KaTeX fonts ship with their own OFL text, and a katex bump is a problem', () => {
    const notices = readFileSync(join(REPO, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    const katex = FONT_FAMILIES.find(f => f.package?.name === 'katex')
    const text = fontLicenceText(katex)
    assert.match(text, /with Reserved Font Names KaTeX_AMS,[\s\S]*KaTeX_Typewriter\./)
    assert.ok(notices.includes(`### ${katex.heading}`) && notices.includes(`\`\`\`text\n${text}\n\`\`\``))

    // Every KaTeX font family the package ships names its Reserved Font Name in our header.
    const shipped = new Set(
      readdirSync(join(REPO, 'node_modules', 'katex', 'dist', 'fonts')).map(f => f.replace(/-.*$/, ''))
    )
    assert.equal(shipped.size, 12)

    for (const family of shipped) {
      assert.ok(text.includes(family), family)
    }

    const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'))
    const key = Object.keys(lock.packages).find(k => k.endsWith('node_modules/katex') && !k.includes('rehype'))
    const bumped = structuredClone(lock)
    bumped.packages[key].version = '0.99.0'
    const repo = temp()
    writeFileSync(join(repo, 'package-lock.json'), JSON.stringify(bumped))
    writeFileSync(join(repo, 'THIRD_PARTY_NOTICES.md'), notices)
    const { problems } = checkNotices({ repo, modules: REPO, acpTree: join(repo, 'none') })
    assert.ok(
      problems.some(p => /the Fonts section describes katex@0\.16\.47, the desktop ships katex@0\.99\.0/.test(p))
    )
  })

  test('N1 (REL-7, ruling 30): the notices name the font inside the Privy bundle and whose terms it travels under', () => {
    const notices = readFileSync(join(REPO, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    const fonts = notices.slice(notices.indexOf(FONTS_BEGIN), notices.indexOf(FONTS_END))
    const flat = fonts.split(/\s+/).join(' ')
    assert.ok(flat.includes(PRIVY_BUNDLE_FONT.join(' ')))
    assert.ok(flat.includes('The embedded "Base Sans" font is part of Privy\'s bundle'))
    assert.match(notices.slice(0, 2000), /also embeds one font, "Base Sans"/)
    // The bundle really carries it: a base64 WOFF2 data URI.
    const bundle = readFileSync(join(REPO, 'iclone', 'privy', 'privy-login.js'), 'utf8')
    assert.match(bundle, /data:font\/woff2;charset=utf-8;base64,d09GMg/)
  })

  test('R5-2: a native executable needs a NATIVE_BINARIES entry, and the binary must carry every listed module', () => {
    const tree = temp()
    const cli = {
      name: '@virtuals-protocol/acp-cli',
      version: '1.0.38',
      license: 'ISC',
      paths: ['node_modules/@virtuals-protocol/acp-cli']
    }
    const macho = text => Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from(text)])
    install(tree, cli.paths[0], { name: cli.name, version: cli.version })
    const bin = join(tree, cli.paths[0], 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'acp-cli-signer-macos'),
      macho('go1.26.2 golang.org/x/crypto@v0.45.0 golang.org/x/sys@v0.38.0')
    )
    writeFileSync(join(bin, 'acp.js'), 'console.log(1)')
    const closure = new Map([['cli', cli]])
    assert.deepEqual(nativeBinaryProblems(tree, closure), [])
    assert.match(
      nativeBinaryNotice(tree, closure).join('\n'),
      /golang\.org\/x\/sys v0\.38\.0: BSD-3-Clause[\s\S]*Copyright 2009 The Go Authors/
    )

    writeFileSync(
      join(bin, 'acp-cli-signer-macos'),
      macho('go1.26.2 golang.org/x/crypto@v0.46.0 golang.org/x/sys@v0.38.0')
    )
    assert.match(nativeBinaryProblems(tree, closure).join(), /does not carry golang\.org\/x\/crypto v0\.45\.0/)

    writeFileSync(join(bin, 'helper'), Buffer.from('7f454c46', 'hex'))
    assert.match(nativeBinaryProblems(tree, closure).join(), /native executable bin\/helper with no notice entry/)
  })
})
