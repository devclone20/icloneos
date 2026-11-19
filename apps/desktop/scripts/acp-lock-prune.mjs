#!/usr/bin/env node
// acp-lock-prune.mjs — v0.0.9: the optional ACP CLI's pin (acp-cli-lock/package-lock.json, shipped as Resources/acp-pin)
// carries no row the app never installs through a build tool.
//
//   node scripts/acp-lock-prune.mjs           rewrite acp-cli-lock/package-lock.json without those rows
//   node scripts/acp-lock-prune.mjs --check   exit 1 if the committed lock still has any (what the tests assert)
//
// @virtuals-protocol/acp-node lists tsup, a bundler, in `dependencies`, so npm writes tsup and everything only it needs
// (sucrase, tinyglobby, fdir, picomatch, rollup, esbuild, chokidar, ...) into the lock. Nothing in the CLI's module
// graph loads them, and the app never fetched them: runtimeClosure (src/iclone-shared/acp-pin.ts) already skips
// tsup as build tooling. Their rows still made the shipped lock carry picomatch 4.0.7 (GHSA-fc5q-39xc-vjpf, ReDoS, no
// patched release), which the audit gate judges. This drops exactly the rows the CLI reaches ONLY through an edge to a
// PRUNED_TOOLS name; every other row, the runtime closure on every platform included, is left byte for byte.
//
// Bump procedure (stage-acp-cli.mjs): `npm install --package-lock-only --ignore-scripts` inside acp-cli-lock/, then
// this script, then review the diff. The pruned lock is not for `npm ci` (npm would want tsup back); nothing installs it
// with npm: the app materialises runtimeClosure from it (electron/iclone-acp-tools/materialise.ts) and the gate audits
// it with `npm audit --package-lock-only`.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ACP_CLI_NAME, parsePin, resolveFrom } from '../src/iclone-shared/acp-pin.ts'
import { isMain } from './utils.mjs'

export const LOCK_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'acp-cli-lock')

/** Build tools a dependency mis-declares as a runtime dependency, whose exclusive subtree the pin does not carry. */
export const PRUNED_TOOLS = Object.freeze(['tsup'])

/** The row keys the CLI reaches through dependencies, optionalDependencies and peerDependencies, skipping `skip` names. */
function reachable(pin, skip) {
  const seen = new Set()
  const queue = [`node_modules/${ACP_CLI_NAME}`]

  while (queue.length > 0) {
    const key = queue.pop()
    const row = pin.rows.get(key)

    if (!row || seen.has(key)) {
      continue
    }

    seen.add(key)

    for (const name of row.wants) {
      const found = skip.has(name) ? null : resolveFrom(pin.rows, key, name)

      if (found) {
        queue.push(found)
      }
    }
  }

  return seen
}

/**
 * The lock without the rows reachable only through PRUNED_TOOLS: `{ lock, removed }`, `removed` sorted. The input is
 * not modified; key order and every kept row are preserved. Throws (parsePin) on a pin the app would refuse.
 */
export function pruneLock(packageJsonText, lockText, tools = PRUNED_TOOLS) {
  const pin = parsePin(packageJsonText, lockText)
  const all = reachable(pin, new Set())
  const kept = reachable(pin, new Set(tools))
  const removed = [...all].filter(key => !kept.has(key)).sort()
  const lock = JSON.parse(lockText)

  for (const key of removed) {
    delete lock.packages[key]
  }

  return { lock, removed }
}

/** npm's own lockfile text: two-space JSON and a final newline. */
export function lockText(lock) {
  return `${JSON.stringify(lock, null, 2)}\n`
}

if (isMain(import.meta.url)) {
  const check = process.argv.includes('--check')
  const file = join(LOCK_DIR, 'package-lock.json')
  const { lock, removed } = pruneLock(readFileSync(join(LOCK_DIR, 'package.json'), 'utf8'), readFileSync(file, 'utf8'))

  if (check) {
    console.log(
      removed.length === 0
        ? '[acp-lock-prune] clean: no row reachable only through ' + PRUNED_TOOLS.join(', ')
        : `[acp-lock-prune] ${removed.length} row(s) reachable only through ${PRUNED_TOOLS.join(', ')}: ${removed.join(', ')}`
    )
    process.exitCode = removed.length === 0 ? 0 : 1
  } else {
    writeFileSync(file, lockText(lock))
    console.log(`[acp-lock-prune] removed ${removed.length} row(s): ${removed.join(', ') || 'none'}`)
  }
}
