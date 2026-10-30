// REL-5 R5-5: staging keeps every notices problem that names a staged ACP package, with or without the "acp-cli:"
// prefix. Its own file (was in stage-acp-cli-lock.test.mjs) so the REL-6 branch, which carries that file unchanged,
// merges without an add/add conflict (REL-7).
import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { problemsForAcp } from './stage-acp-cli.mjs'
import { LICENCE_REVIEW, unreviewedLicences } from './third-party-closure.mjs'

describe('staging refuses the notices problems of the ACP tree (R5-5)', () => {
  test('R5-5: staging refuses an ACP package the notices problems name without the acp-cli prefix', () => {
    const rows = [
      { name: 'rpc-websockets', version: '9.3.9', license: 'LGPL-3.0-only' },
      { name: 'ws', version: '8.0.0', license: 'MIT' }
    ]
    const acp = new Map(rows.map(r => [`${r.name}@${r.version}`, r]))
    // The mutation the critic ran: rpc-websockets dropped from LICENCE_REVIEW.
    const review = { ...LICENCE_REVIEW }
    delete review['rpc-websockets@9.3.9']
    const problems = unreviewedLicences(rows, review)
      .filter(r => !r.reviewed)
      .map(r => `${r.id} (${r.licence}): ${r.flag}, and LICENCE_REVIEW does not name it: the lead rules on it first`)
    assert.equal(problems.length, 1)
    assert.deepEqual(problemsForAcp({ problems, acp }), problems)
    assert.deepEqual(problemsForAcp({ problems: ['react@19.0.0 (GPL-3.0): copyleft'], acp }), [])
    assert.deepEqual(problemsForAcp({ problems: ['acp-cli: section differs'], acp: null }), [
      'acp-cli: section differs'
    ])
  })
})
