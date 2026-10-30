#!/usr/bin/env node
/**
 * sign-acp-native.mjs — REL-6 round 2, ruling 33: `release:mac` Team-signs the ACP CLI's native add-ons the app ships.
 *
 *   node scripts/sign-acp-native.mjs --identity <sha1> --keychain <path> --team <TEAMID> [--dir build/acp-native/darwin-arm64]
 *
 * Runs inside release:mac's signing window (the release keychain unlocked by the owner), AFTER `npm run build` staged
 * the unsigned copies (stage-acp-native.mjs) and BEFORE electron-builder packs the app: each copy is signed with the
 * Developer ID identity (hardened runtime, secure timestamp), verified (`codesign --verify --strict`, TeamIdentifier =
 * --team), and ADDONS.json is rewritten with `signed: true`, the team and the SIGNED bytes' sha256 — the list the
 * installer checks each copy against, sealed into the signed app with it. electron-builder must not re-sign them
 * (sign-hook.mjs ignores Resources/acp-native), or the bytes would no longer be the listed ones.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMain } from './utils.mjs'

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { ADDONS_FILE, parseAddonList } = await import('../src/iclone-shared/acp-native.ts')

export const DEFAULT_DIR = path.join(DESKTOP, 'build', 'acp-native', 'darwin-arm64')

const sha256 = data => createHash('sha256').update(data).digest('hex')

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })

  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export function parseArgs(argv) {
  const opts = { identity: null, keychain: null, team: null, dir: DEFAULT_DIR }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[(i += 1)] ?? null

    if (arg === '--identity') {
      opts.identity = next()
    } else if (arg === '--keychain') {
      opts.keychain = next()
    } else if (arg === '--team') {
      opts.team = next()
    } else if (arg === '--dir') {
      opts.dir = path.resolve(next() ?? '')
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }

  if (!/^[0-9A-F]{40}$/.test(opts.identity ?? '')) {
    throw new Error('--identity <40-hex SHA-1 of the Developer ID Application identity> is required')
  }

  if (!opts.keychain) {
    throw new Error('--keychain <path> is required')
  }

  if (!/^[A-Z0-9]{10}$/.test(opts.team ?? '')) {
    throw new Error('--team <TEAMID> is required')
  }

  return opts
}

/** Sign, verify and re-list every add-on copy in `dir`. `run` is the process seam (tests pass a fake codesign). */
export function signAcpNative({ dir, identity, keychain, team, run = defaultRun, log = () => undefined }) {
  const listPath = path.join(dir, ADDONS_FILE)
  const list = parseAddonList(readFileSync(listPath, 'utf8'))

  if (!list) {
    throw new Error(`${listPath} is not an add-on list`)
  }

  for (const entry of list.addons) {
    const file = path.join(dir, entry.blob)
    const before = sha256(readFileSync(file))

    if (before !== entry.sha256) {
      throw new Error(`${entry.blob} is not the staged copy (sha256 ${before.slice(0, 12)})`)
    }

    const sign = run('codesign', [
      '--force',
      '--sign',
      identity,
      '--keychain',
      keychain,
      '--options',
      'runtime',
      '--timestamp',
      file
    ])

    if (sign.status !== 0) {
      throw new Error(`codesign failed for ${entry.blob} (exit ${sign.status})`)
    }

    if (run('codesign', ['--verify', '--strict', file]).status !== 0) {
      throw new Error(`${entry.blob} does not verify after signing`)
    }

    const shown = run('codesign', ['-dvv', file])

    if (!new RegExp(`^TeamIdentifier=${team}$`, 'm').test(`${shown.stdout}\n${shown.stderr}`)) {
      throw new Error(`${entry.blob} is not signed by team ${team}`)
    }

    entry.sha256 = sha256(readFileSync(file))
    log(`[sign-acp-native] ${entry.package}@${entry.version} signed (${team})`)
  }

  const signed = { ...list, signed: true, team }

  writeFileSync(listPath, `${JSON.stringify(signed, null, 2)}\n`)

  return signed
}

if (isMain(import.meta.url)) {
  try {
    if (process.platform !== 'darwin') {
      throw new Error('sign-acp-native only runs on macOS')
    }

    signAcpNative({ ...parseArgs(process.argv.slice(2)), log: line => console.log(line) })
  } catch (error) {
    console.error(`[sign-acp-native] ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}
