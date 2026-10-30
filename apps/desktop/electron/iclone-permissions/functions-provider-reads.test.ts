/**
 * V3-UP r3 — the plugin's `_NO_FUNCTION_PROVIDER_READS` and main's `NO_FUNCTION_PROVIDER_READS` are one list
 * (tests/fixtures/functions_provider_reads.json; tests/plugins/test_iclone_permissions_tool_table.py reads the same
 * file), and main gives such a call no row, like every other no-function tool, instead of every row (R3-U).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { coverFunctions, NO_FUNCTION_PROVIDER_READS, PERMISSION_FUNCTIONS } from './functions'

const FIXTURE_PATH = path.join(
  __dirname,
  '../../../../plugins/iclone-permissions/tests/fixtures/functions_provider_reads.json'
)

describe('V3-UP r3 — provider reads and Tool Search lookups', () => {
  it('the committed fixture is what this build lists', () => {
    const fixture = { noFunctionProviderReads: [...NO_FUNCTION_PROVIDER_READS].sort() }

    if (process.env.V3F2_WRITE_FIXTURE === '1') {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 1)}\n`)
    }

    expect(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))).toEqual(fixture)
  })

  it('main covers a provider read with no row, and an unknown tool with every row', () => {
    for (const tool of NO_FUNCTION_PROVIDER_READS) {
      expect(coverFunctions(tool, 'N', []), tool).toEqual([])
    }

    expect(coverFunctions('a_tool_nobody_registered', 'N', [])).toEqual([...PERMISSION_FUNCTIONS])
  })
})
