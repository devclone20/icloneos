// REL-5 R5-2: the app ships every licence file a recipient needs, next to each other in Contents/Resources: LICENSE
// (ours, MIT), NOTICE (the exceptions: artwork not MIT, Reown's required line, fonts, vendored skills) and
// THIRD_PARTY_NOTICES.md (every third-party text, the fonts' OFL included; v0.0.9: the ACP CLI ships in Resources/acp-tools
// with its own NOTICES.md). v0.0.2 shipped
// no NOTICE, so in the DMG the artwork read as MIT. The packed app is checked by RESUME run/gates/V3REL/packed_notices_gate.py.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'vitest'

import { FONT_FAMILIES, fontLicenceText } from './third-party-closure.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const build = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')).build

test('LICENSE, NOTICE and THIRD_PARTY_NOTICES.md ship as extraResources on every platform, from the repo root', () => {
  const shipped = new Map((build.extraResources ?? []).filter(e => typeof e === 'object').map(e => [e.to, e.from]))

  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
    assert.equal(shipped.get(name), `../../${name}`, `${name} is not in build.extraResources`)
    assert.ok(existsSync(join(desktop, '..', '..', name)), `${name} is missing from the repo root`)
  }
})

test("the notices that ship carry the fonts OFL texts, and point at the shipped ACP CLI's own notices (v0.0.9)", () => {
  const notices = readFileSync(join(desktop, '..', '..', 'THIRD_PARTY_NOTICES.md'), 'utf8')
  // M1 (REL-7): each font's whole licence text, verbatim (a heading and a copyright line are not enough).
  for (const family of FONT_FAMILIES) {
    assert.ok(notices.includes(`### ${family.heading}`), family.heading)
    assert.ok(notices.includes(`\`\`\`text\n${fontLicenceText(family)}\n\`\`\``), `${family.heading}: the full text`)
  }

  // v0.0.9 (owner decision 17 Nov, replaces ruling 26): the CLI ships in Resources/acp-tools; its packages' own licence
  // texts travel with it (Resources/acp-tools/NOTICES.md) and the pin's table beside the pin (Resources/acp-pin).
  assert.ok(!/The Virtuals ACP CLI is not shipped/.test(notices), 'the notices no longer say the CLI is not shipped')
  assert.match(notices, /The Virtuals ACP CLI ships in `Resources\/acp-tools`/)
  assert.match(notices, /Resources\/acp-tools\/NOTICES\.md/)
  assert.match(notices, /apps\/desktop\/acp-cli-lock\/NOTICES\.md/)
  // REL-6 r3 (critic r2 M3): what ruling 33 does ship of it, the native add-ons, with their notices.
  assert.match(notices, /## ACP native add-ons \(Resources\/acp-native\)/)
  for (const pkg of ['@napi-rs/keyring-darwin-arm64', 'bufferutil', 'utf-8-validate']) {
    assert.ok(notices.includes(`| \`${pkg}\` |`), pkg)
  }
})

test("m4 (REL-7): NOTICE carries Reown's required notice as a line of its own, not only inside the quoted clause", () => {
  const notice = readFileSync(join(desktop, '..', '..', 'NOTICE'), 'utf8')
  const lines = notice.split('\n').map(line => line.trim())
  assert.ok(lines.includes('Portions © 2025 Reown, Inc. All Rights Reserved'))
})
