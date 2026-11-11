#!/usr/bin/env node
/**
 * iclone-fsevents-check.mjs — v0.0.7 FSEV: the F7 guard's FSEvents addon inside a packed macOS app.
 *
 *   node scripts/iclone-fsevents-check.mjs <app> --unsigned            afterPack (before electron-builder signs)
 *   node scripts/iclone-fsevents-check.mjs <app> --signed --team <ID>  release:mac, on the signed app
 *
 * Proves: Contents/Resources/app.asar.unpacked/dist/native/iclone_fsevents.node is there, and the old `fsevents`
 * module is not. `--unsigned`: its bytes are exactly the pin (PIN.json sha256). `--signed`: codesign verifies it
 * strictly, its TeamIdentifier is --team, and with the signature removed it is byte for byte the pinned build
 * (sha256Unsigned), so signing changed nothing but the signature. Prints one JSON line; exit 1 on any problem.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { readAddonPin, unsignedSha256 } from './build-iclone-fsevents.mjs'
import { isMain } from './utils.mjs'

const sha256 = data => createHash('sha256').update(data).digest('hex')

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })

  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export const packedAddonPath = app =>
  path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'dist', 'native', 'iclone_fsevents.node')

export function checkIcloneFsevents(
  app,
  { signed = false, team = null, pin = readAddonPin(), run = defaultRun, stripped = unsignedSha256 } = {}
) {
  const file = packedAddonPath(app)
  const problems = []
  const report = { file, signed, team: null, problems }
  const oldModule = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'dist', 'node_modules', 'fsevents')

  if (existsSync(oldModule)) {
    problems.push('the fsevents npm module is still packed (dist/node_modules/fsevents)')
  }

  if (!existsSync(file)) {
    problems.push('no app.asar.unpacked/dist/native/iclone_fsevents.node in the app')

    return report
  }

  if (!signed) {
    if (sha256(readFileSync(file)) !== pin.sha256) {
      problems.push('iclone_fsevents.node is not the pinned build')
    }

    return report
  }

  if (!/^[A-Z0-9]{10}$/.test(String(team))) {
    problems.push('--signed needs --team <10-character Team ID>')

    return report
  }

  const verify = run('/usr/bin/codesign', ['--verify', '--strict', file])

  if (verify.status !== 0) {
    problems.push('codesign --verify --strict fails on iclone_fsevents.node')
  }

  const details = run('/usr/bin/codesign', ['-dv', file])
  const teamMatch = /^TeamIdentifier=(\S+)$/m.exec(`${details.stdout}\n${details.stderr}`)

  report.team = teamMatch ? teamMatch[1] : null

  if (report.team !== team) {
    problems.push(`iclone_fsevents.node is signed by ${report.team ?? 'no team'}, not ${team}`)
  }

  if (stripped(file) !== pin.sha256Unsigned) {
    problems.push('iclone_fsevents.node without its signature is not the pinned build')
  }

  return report
}

if (isMain(import.meta.url)) {
  const [app, ...flags] = process.argv.slice(2)
  const signed = flags.includes('--signed')
  const teamAt = flags.indexOf('--team')
  const report = app
    ? checkIcloneFsevents(path.resolve(app), { signed, team: teamAt >= 0 ? flags[teamAt + 1] : null })
    : { problems: ['usage: iclone-fsevents-check.mjs <app> [--unsigned | --signed --team <ID>]'] }

  console.log(JSON.stringify(report))
  process.exit(report.problems.length === 0 ? 0 : 1)
}
