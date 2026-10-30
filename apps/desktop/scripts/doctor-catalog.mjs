#!/usr/bin/env node
// CI catalogue gate for iclone/diagnostics/*/pack.json: every impl exists in the checks/fixes modules, every fix has a
// backup + undo + a known consent key, network checks live only in the network pack. Exit 1 on the first problem list.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desk = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.resolve(desk, '..', '..', 'iclone', 'diagnostics')
const source = name => fs.readFileSync(path.join(desk, 'electron', name), 'utf8')
const checksSrc = source('iclone-doctor-checks.ts')
const fixesSrc = source('iclone-doctor-fixes.ts')
const consentKeys = [
  ...source('iclone-consent.ts').matchAll(
    /'(microphone|screen|automation|localNetwork|files|notifications|clipboard|keychain)'/g
  )
].map(m => m[1])
const problems = []
let checks = 0
let fixes = 0

for (const id of ['runtime', 'gateway', 'acp', 'wallet', 'permissions', 'storage', 'native', 'network']) {
  const pack = JSON.parse(fs.readFileSync(path.join(dir, id, 'pack.json'), 'utf8'))

  for (const c of pack.checks) {
    checks += 1
    if (!new RegExp(`\\basync ${c.impl}\\(`).test(checksSrc)) problems.push(`${c.id}: impl ${c.impl} missing`)
    if (c.network && id !== 'network') problems.push(`${c.id}: network check outside the network pack`)
    if (c.fix && !pack.fixes.some(f => f.id === c.fix)) problems.push(`${c.id}: fix ${c.fix} missing`)
  }

  for (const f of pack.fixes) {
    fixes += 1
    if (!new RegExp(`\\basync ${f.impl}\\(`).test(fixesSrc)) problems.push(`${f.id}: impl ${f.impl} missing`)
    if (f.backup !== true || f.dryRun !== true || !f.undo) problems.push(`${f.id}: backup/dryRun/undo`)
    if (f.consent !== null && !consentKeys.includes(f.consent)) problems.push(`${f.id}: consent ${f.consent} unknown`)
  }
}

console.log(JSON.stringify({ ok: problems.length === 0, packs: 8, checks, fixes, problems }))
process.exit(problems.length ? 1 : 0)
