/**
 * The Python launcher tests read the policy body from a file this test pins to buildPolicyBody, byte for byte, so their
 * fixture cannot keep a shape or a mode table main no longer writes. Change the writer: this goes red until the file is
 * rewritten with ICLONE_WRITE_POLICY_FIXTURE=1, and the Python tests then run on the new body.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { CONSENT_CAPABILITY_KEYS, type ConsentRecord } from '../iclone-consent'

import { ceilingsFrom } from './classify-policy'
import { DEFAULT_FUNCTION_LEVELS } from './functions'
import { buildPolicyBody } from './policy-file'

const FIXTURE = path.resolve(__dirname, '../../../../tests/plugins/fixtures/iclone_policy_body.json')
const AT = '2026-01-01T00:00:00.000Z'

const everySwitchOn: ConsentRecord = {
  schema: 1,
  policyVersion: 'fixture',
  policyEffective: 'fixture',
  acceptedAt: AT,
  permissions: Object.fromEntries(CONSENT_CAPABILITY_KEYS.map(key => [key, true])) as ConsentRecord['permissions'],
  permissionsDecidedAt: AT,
  skipped: false,
  aiProviderConsent: null
}

describe('the policy body the Python launcher fixture reads', () => {
  it('is, byte for byte, a body buildPolicyBody wrote', () => {
    const written = `${JSON.stringify(
      buildPolicyBody({
        mode: { v: 1, standing: 'acceptEdits', projects: {}, sessions: {}, updatedAt: AT },
        folders: [],
        grants: [],
        ceilings: ceilingsFrom(everySwitchOn),
        protectedPaths: [],
        secretPaths: [],
        guardPids: [],
        inftContracts: [],
        functions: { ...DEFAULT_FUNCTION_LEVELS },
        fnGrants: [],
        now: new Date(AT)
      }),
      null,
      1
    )}\n`

    if (process.env.ICLONE_WRITE_POLICY_FIXTURE === '1') {
      writeFileSync(FIXTURE, written)
    }

    expect(readFileSync(FIXTURE, 'utf8')).toBe(written)
  })
})
