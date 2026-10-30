#!/usr/bin/env node
/**
 * acp-native-notices.mjs — REL-6 r3 (critic r2 M3; rulings 32 + 33): the licence notices of the native add-ons the
 * app ships in Resources/acp-native/<target>.
 *
 *   node scripts/acp-native-notices.mjs --check      exit 1 unless acp-native-notices/ is complete and pinned
 *   node scripts/acp-native-notices.mjs --pack <app> [--notices <dir>]
 *                                                    exit 1 unless EVERY Rust crate path a shipped add-on binary names
 *                                                    (/rust/deps/<crate>-<ver>/, a cargo registry src path) is a
 *                                                    crate@version its notices list (critic r3 M4)
 *
 * acp-native-notices/NOTICES.json lists, for every add-on the ACP closure loads on the target (the lockfile's rows of
 * @napi-rs/keyring-<platform>, bufferutil, utf-8-validate), the licence texts that cover its bytes, each committed
 * verbatim and pinned by sha256: the package's own LICENSE (and the licences of code compiled into it, e.g.
 * utf-8-validate's deps/is_utf8), and for the keyring binding the Rust crates and the Rust standard library statically
 * linked into it, with how that list was established. --check proves the list against the lockfile and the files (no
 * missing, changed or unlisted text). stage-acp-native.mjs refuses a tarball whose texts are not these bytes and ships
 * them beside the add-ons; third-party-closure.mjs renders THIRD_PARTY_NOTICES.md's "ACP native add-ons" section with
 * renderNativeSection().
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMain } from './utils.mjs'

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { ACP_CLI_NAME, parsePin, runtimeClosure } = await import('../src/iclone-shared/acp-pin.ts')
const { isAddonPackage } = await import('../src/iclone-shared/acp-native.ts')

export const NOTICES_DIR = 'acp-native-notices'
export const NATIVE_BEGIN =
  '<!-- BEGIN GENERATED (ACP native add-ons) by apps/desktop/scripts/third-party-closure.mjs; edit the script, not this -->'
export const NATIVE_END = '<!-- END GENERATED (ACP native add-ons) by apps/desktop/scripts/third-party-closure.mjs -->'

const sha256 = data => createHash('sha256').update(data).digest('hex')

/** NOTICES.json, parsed (throws when it is not there or not JSON). */
export function loadNativeNotices(desktopDir = DESKTOP) {
  return JSON.parse(readFileSync(path.join(desktopDir, NOTICES_DIR, 'NOTICES.json'), 'utf8'))
}

/** Every text an add-on's notices name: its package texts, then (keyring) the crates and the Rust std text. */
export function textsOf(addon) {
  return [...addon.texts, ...(addon.linked?.crates ?? []), ...(addon.linked?.rust ? [addon.linked.rust] : [])]
}

/** The add-on rows of the ACP closure for `target` (`darwin-arm64`), from the committed pin. */
export function addonRowsFor(pinDir, targetName) {
  const [platform, arch] = targetName.split('-')
  const pin = parsePin(
    readFileSync(path.join(pinDir, 'package.json'), 'utf8'),
    readFileSync(path.join(pinDir, 'package-lock.json'), 'utf8')
  )

  return runtimeClosure(pin, { platform, arch, libc: null }).filter(
    row => row.name !== ACP_CLI_NAME && isAddonPackage(row.name)
  )
}

/** Problems with acp-native-notices/ (empty = complete and pinned). */
export function checkNativeNotices({ desktopDir = DESKTOP, pinDir = path.join(desktopDir, 'acp-cli-lock') } = {}) {
  const problems = []
  let notices

  try {
    notices = loadNativeNotices(desktopDir)
  } catch (error) {
    return [`acp-native: ${NOTICES_DIR}/NOTICES.json cannot be read: ${error.message}`]
  }

  if (notices.v !== 1 || typeof notices.target !== 'string' || !Array.isArray(notices.addons)) {
    return ['acp-native: NOTICES.json is not a v1 notices list']
  }

  const rows = addonRowsFor(pinDir, notices.target)
  const listed = new Map(notices.addons.map(addon => [addon.key, addon]))

  for (const row of rows) {
    const addon = listed.get(row.key)

    if (!addon) {
      problems.push(`acp-native: ${row.name}@${row.version} (${row.key}) ships with no licence notice`)
    } else if (addon.package !== row.name || addon.version !== row.version) {
      problems.push(
        `acp-native: ${row.key} is ${row.name}@${row.version}, the notices say ${addon.package}@${addon.version}`
      )
    }
  }

  for (const addon of notices.addons) {
    if (!rows.some(row => row.key === addon.key)) {
      problems.push(`acp-native: ${addon.package}@${addon.version} is not an add-on of the pinned closure`)
    }

    if (!Array.isArray(addon.texts) || addon.texts.length === 0) {
      problems.push(`acp-native: ${addon.package}@${addon.version} has no licence text`)
    }
  }

  const named = new Set()

  for (const text of notices.addons.flatMap(textsOf)) {
    const file = path.join(desktopDir, NOTICES_DIR, text.file)

    named.add(text.file)

    if (!existsSync(file)) {
      problems.push(`acp-native: ${text.file} is missing`)
    } else if (sha256(readFileSync(file)) !== text.sha256) {
      problems.push(`acp-native: ${text.file} is not the pinned text (sha256)`)
    }
  }

  for (const folder of ['texts', 'crates']) {
    const dir = path.join(desktopDir, NOTICES_DIR, folder)

    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      if (!named.has(`${folder}/${name}`)) {
        problems.push(`acp-native: ${folder}/${name} is not listed in NOTICES.json`)
      }
    }
  }

  return problems
}

/**
 * Every Rust crate a binary names in its own source paths (panic locations, debug strings): the Rust standard
 * library's vendored dependencies (`/rust/deps/<crate>-<version>/`) and cargo registry sources
 * (`index.crates.io-<hash>/<crate>-<version>/`, `registry/src/<index>/<crate>-<version>/`). Sorted `name@version`.
 */
export function cratePathsIn(binary) {
  const text = Buffer.from(binary).toString('latin1')
  const found = new Set()
  const pattern =
    /(?:\/rust\/deps\/|index\.crates\.io-[0-9a-f]+\/|\/registry\/src\/[^/\0]+\/)([A-Za-z0-9_][A-Za-z0-9_-]*?)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?)\//g

  for (const match of text.matchAll(pattern)) {
    found.add(`${match[1]}@${match[2]}`)
  }

  return [...found].sort()
}

/** The crate paths of an add-on binary its notices do not list (empty = covered). */
export function unlistedCrates(addon, binary) {
  const listed = new Set((addon?.linked?.crates ?? []).map(c => `${c.name}@${c.version}`))

  return cratePathsIn(binary).filter(id => !listed.has(id))
}

/** Problems: a shipped add-on (a pack's Resources/acp-native) naming a crate its notices do not list. */
export function packCrateProblems(app, notices) {
  const root = path.join(app, 'Contents', 'Resources', 'acp-native')
  const problems = []
  let checked = 0

  for (const target of existsSync(root) ? readdirSync(root).filter(name => !name.startsWith('.')) : []) {
    const list = JSON.parse(readFileSync(path.join(root, target, 'ADDONS.json'), 'utf8'))

    for (const entry of list.addons) {
      const addon = notices.addons.find(a => a.package === entry.package && a.version === entry.version)
      const unlisted = unlistedCrates(addon, readFileSync(path.join(root, target, entry.blob)))

      checked += 1

      for (const id of unlisted) {
        problems.push(`${entry.package}@${entry.version}: the binary names crate ${id}, which its notices do not list`)
      }
    }
  }

  if (checked === 0) {
    problems.push('no add-on binary found under Resources/acp-native (the check would pass vacuously)')
  }

  return { problems, checked }
}

const fence = text => {
  const body = text.replace(/\s+$/, '')
  const ticks = '`'.repeat(Math.max(4, ...[...body.matchAll(/`+/g)].map(m => m[0].length + 1)))

  return `${ticks}text\n${body}\n${ticks}`
}

/** THIRD_PARTY_NOTICES.md's "ACP native add-ons" section, between its markers. */
export function renderNativeSection(
  notices = loadNativeNotices(),
  readText = file => readFileSync(path.join(DESKTOP, NOTICES_DIR, file), 'utf8')
) {
  const where = `Resources/acp-native/${notices.target}`
  const out = [
    NATIVE_BEGIN,
    '',
    '## ACP native add-ons (Resources/acp-native)',
    '',
    `Ruling 33: the app ships its own copies of the native add-ons the Virtuals ACP CLI loads, in \`${where}/\` (the CLI`,
    'itself is not shipped: the app installs it from npm at first use). Each copy is made from the exact npm version below',
    `and signed by the app's developer; the licence files ship beside them in \`${where}/licences/\`. The keyring binding`,
    'also contains Rust crates and the Rust standard library, statically linked; they are listed after the packages, each',
    'with the licence it is used under.',
    '',
    '| Package | Version | Licence |',
    '| --- | --- | --- |',
    ...notices.addons.map(addon => `| \`${addon.package}\` | ${addon.version} | ${addon.licence} |`),
    ''
  ]

  for (const addon of notices.addons) {
    for (const text of addon.texts) {
      out.push(`### \`${addon.package}@${addon.version}\` ${text.path}`, '')

      if (text.source) {
        out.push(`Source: ${text.source}.`, '')
      }

      out.push(fence(readText(text.file)), '')
    }
  }

  for (const addon of notices.addons.filter(a => a.linked)) {
    const { linked } = addon

    out.push(
      `### Rust code linked into \`${addon.package}@${addon.version}\``,
      '',
      `${linked.what}. ${linked.method}`,
      '',
      '| Crate | Version | Licence | Used under |',
      '| --- | --- | --- | --- |',
      ...linked.crates.map(
        c =>
          `| \`${c.name}\` | ${c.version} | ${c.licence} | ${c.usedUnder}${c.via ? ' (via the Rust standard library)' : ''} |`
      ),
      `| Rust standard library (${linked.rust.toolchain}) | — | ${linked.rust.licence} | ${linked.rust.usedUnder} |`,
      ''
    )

    for (const c of linked.crates) {
      out.push(`### \`${c.name}@${c.version}\` (Rust crate) ${path.basename(c.file).split('--')[1]}`, '')

      if (c.source !== 'the crate source') {
        out.push(`Source: ${c.source}.`, '')
      }

      out.push(fence(readText(c.file)), '')
    }

    out.push(
      `### Rust standard library (${linked.rust.toolchain}) LICENSE-MIT`,
      '',
      `Source: ${linked.rust.source}.`,
      ''
    )
    out.push(fence(readText(linked.rust.file)), '')
  }

  out.push(NATIVE_END)

  return out.join('\n')
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2)
  const arg = flag => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null)

  if (argv.includes('--pack')) {
    const noticesDir = arg('--notices')
    const notices = noticesDir ? loadNativeNotices(path.dirname(path.resolve(noticesDir))) : loadNativeNotices()
    const { problems, checked } = packCrateProblems(path.resolve(arg('--pack')), notices)

    for (const problem of problems) {
      console.error(`[acp-native-notices] FAIL ${problem}`)
    }

    console.log(
      `[acp-native-notices] ${checked} shipped add-on binaries: every crate path they name is listed; ${problems.length} problem(s)`
    )
    process.exit(problems.length ? 1 : 0)
  }

  if (process.argv.includes('--check')) {
    const problems = checkNativeNotices()

    for (const problem of problems) {
      console.error(`[acp-native-notices] FAIL ${problem}`)
    }

    const notices = loadNativeNotices()

    console.log(
      `[acp-native-notices] ${notices.addons.length} add-on packages, ${notices.addons.flatMap(textsOf).length} pinned texts; ` +
        `${problems.length} problem(s)`
    )
    process.exit(problems.length ? 1 : 0)
  }

  process.stdout.write(`${renderNativeSection()}\n`)
}
