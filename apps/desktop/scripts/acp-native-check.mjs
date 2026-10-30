#!/usr/bin/env node
/**
 * acp-native-check.mjs — REL-6 round 2, ruling 33: the ACP native add-ons inside a packed app.
 *
 *   node scripts/acp-native-check.mjs <app> [--signed --team <TEAMID> | --unsigned]
 *
 * Reads <app>/Contents/Resources/acp-native/<target>/ADDONS.json (the list the installer checks each copy against)
 * and proves: the list parses, is for the lockfile the app ships (Resources/acp-pin), names every add-on file the
 * closure installs for that target, and every shipped copy hashes to it; every licence file the list names ships
 * beside the copies with its listed sha256 (critic r2 M3), and no unlisted one does. `--signed`: the list says Team-signed by
 * --team and codesign agrees for every copy (release:mac). `--unsigned`: the marker of an unsigned `--dir` pack
 * (`signed: false`). Prints one JSON line; exit 1 on any problem.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { isMain } from './utils.mjs'

const { ADDONS_FILE, parseAddonList, isAddonPackage } = await import('../src/iclone-shared/acp-native.ts')
const { installsFile, parsePin, runtimeClosure, ACP_CLI_NAME } = await import('../src/iclone-shared/acp-pin.ts')

const sha256 = data => createHash('sha256').update(data).digest('hex')

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })

  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export function checkAcpNative(app, { signed = null, team = null, run = defaultRun } = {}) {
  const resources = path.join(app, 'Contents', 'Resources')
  const root = path.join(resources, 'acp-native')
  const problems = []
  const report = { target: null, signed: null, team: null, files: 0, notices: 0, problems }

  if (!existsSync(root)) {
    problems.push('no Resources/acp-native in the app')

    return report
  }

  const targets = readdirSync(root).filter(name => !name.startsWith('.'))

  if (targets.length !== 1) {
    problems.push(`expected one target folder in acp-native, found ${targets.length}`)

    return report
  }

  const target = targets[0]
  const dir = path.join(root, target)
  const list = (() => {
    try {
      return parseAddonList(readFileSync(path.join(dir, ADDONS_FILE), 'utf8'))
    } catch {
      return null
    }
  })()

  report.target = target

  if (!list) {
    problems.push(`${ADDONS_FILE} is missing or malformed`)

    return report
  }

  report.signed = list.signed
  report.team = list.team
  report.files = list.addons.length

  const pinDir = path.join(resources, 'acp-pin')
  const lockText = readFileSync(path.join(pinDir, 'package-lock.json'), 'utf8')

  if (list.lockSha256 !== sha256(lockText) || list.target !== target) {
    problems.push('the list is for another lockfile or target than the app ships')
  }

  const [platform, arch] = target.split('-')
  const pin = parsePin(readFileSync(path.join(pinDir, 'package.json'), 'utf8'), lockText)
  const expected = new Set()

  for (const row of runtimeClosure(pin, { platform, arch, libc: null })) {
    if (row.name !== ACP_CLI_NAME && isAddonPackage(row.name)) {
      expected.add(row.key)
    }
  }

  for (const key of expected) {
    const listed = list.addons.some(
      entry =>
        entry.file.startsWith(`${key}/`) &&
        installsFile({ name: entry.package }, entry.file.slice(key.length + 1), { platform, arch })
    )

    if (!listed) {
      problems.push(`no add-on listed for ${key}`)
    }
  }

  for (const entry of list.addons) {
    const file = path.join(dir, entry.blob)

    if (!existsSync(file)) {
      problems.push(`${entry.blob} is missing`)
      continue
    }

    if (sha256(readFileSync(file)) !== entry.sha256) {
      problems.push(`${entry.blob} is not the listed bytes`)
    }

    if (signed === true) {
      const shown = run('codesign', ['-dvv', file])

      if (run('codesign', ['--verify', '--strict', file]).status !== 0) {
        problems.push(`${entry.blob} does not verify`)
      } else if (!new RegExp(`^TeamIdentifier=${team}$`, 'm').test(`${shown.stdout}\n${shown.stderr}`)) {
        problems.push(`${entry.blob} is not signed by team ${team}`)
      }
    }
  }

  // Critic r2 M3: every copy ships with the licence files that cover it, byte for byte.
  for (const notice of list.notices) {
    const file = path.join(dir, notice.file)

    if (!existsSync(file)) {
      problems.push(`${notice.file} is missing (a licence notice the list names)`)
    } else if (sha256(readFileSync(file)) !== notice.sha256) {
      problems.push(`${notice.file} is not the listed licence text`)
    }
  }

  const listedNotices = new Set(list.notices.map(notice => notice.file))
  const licenceDir = path.join(dir, 'licences')

  for (const name of existsSync(licenceDir) ? readdirSync(licenceDir) : []) {
    if (!listedNotices.has(`licences/${name}`)) {
      problems.push(`licences/${name} ships but the list does not name it`)
    }
  }

  report.notices = list.notices.length

  if (signed === true && (list.signed !== true || list.team !== team)) {
    problems.push(`the list is not marked Team-signed by ${team}`)
  }

  if (signed === false && list.signed !== false) {
    problems.push('an unsigned pack whose list says signed')
  }

  return report
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const teamAt = args.indexOf('--team')
  const app = args.find((arg, index) => !arg.startsWith('--') && (teamAt < 0 || index !== teamAt + 1))
  const signed = args.includes('--signed') ? true : args.includes('--unsigned') ? false : null
  const team = args.includes('--team') ? args[args.indexOf('--team') + 1] : null

  if (!app) {
    console.error('usage: acp-native-check.mjs <app> [--signed --team <TEAMID> | --unsigned]')
    process.exit(64)
  }

  const report = checkAcpNative(path.resolve(app), { signed, team })

  console.log(JSON.stringify(report))
  process.exit(report.problems.length ? 1 : 0)
}
