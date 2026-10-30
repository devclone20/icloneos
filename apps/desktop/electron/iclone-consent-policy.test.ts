import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { bundledLegalDir, CONSENT_PERMISSION_KEYS, decodePolicyText, POLICY_HTML } from './iclone-consent'
import { BUNDLED_POLICY } from './policy-version.generated'

// Parity with the ONE policy source: iclone/legal is a generated copy (apps/desktop/scripts/sync-legal.mjs).
const LEGAL = bundledLegalDir({ appPath: path.resolve(__dirname, '..'), packaged: false, resourcesPath: '' })
const html = readFileSync(path.join(LEGAL, POLICY_HTML), 'utf8')
const json = JSON.parse(readFileSync(path.join(LEGAL, 'policy-version.json'), 'utf8'))

const SITE =
  process.env.ICLONE_SITE_LEGAL ||
  path.resolve(
    LEGAL,
    '..',
    '..',
    '..',
    '..',
    '021 - ALL_PROJECT_icloneOS_iNFT_2026',
    'CLONEFRAME_SITE',
    'legal',
    POLICY_HTML
  )

describe('bundled policy parity', () => {
  it('names no e-mail address anywhere in iclone/legal: privacy requests go to the public repo', () => {
    const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/
    const files = readdirSync(LEGAL).map(name => path.join(LEGAL, name))

    expect(files.length).toBeGreaterThanOrEqual(3)
    expect(files.filter(file => email.test(readFileSync(file, 'utf8'))).map(file => path.basename(file))).toEqual([])
    expect(html).not.toMatch(/mailto:/i)
    expect(html).toContain('https://github.com/devclone20/icloneos/security/advisories/new')
  })

  it('generated facts equal policy-version.json and the bundled html hash', async () => {
    const { createHash } = await import('node:crypto')

    expect(createHash('sha256').update(html).digest('hex')).toBe(json.sha256)
    expect({
      version: BUNDLED_POLICY.version,
      effective: BUNDLED_POLICY.effective,
      sha256: BUNDLED_POLICY.sha256
    }).toEqual({
      version: json.version,
      effective: json.effective,
      sha256: json.sha256
    })
  })

  it('the version is the one in p-meta', () => {
    const meta = decodePolicyText(/<p class="p-meta">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '')

    expect(meta).toBe(`Effective ${BUNDLED_POLICY.effectiveLabel} · Version ${BUNDLED_POLICY.version}`)
  })

  it('has the 21 pp- sections and no script', () => {
    expect([...html.matchAll(/id="(pp-[a-z]+)"/g)]).toHaveLength(21)
    expect(/<script/i.test(html)).toBe(false)
  })

  it('the short version and the §9 rows in the app are the policy text verbatim', () => {
    const text = decodePolicyText(html.replace(/<[^>]*>/g, ' '))

    for (const item of BUNDLED_POLICY.short) {
      expect(text).toContain(`${item.lead} ${item.text}`)
    }

    // Every §9 row is a switch except `files` (reading), which File writing's line covers, and `localNetwork`,
    // which the policy states for information only — the app offers no switch for it (U1-08-p2, fixer wave UF2C).
    expect(
      BUNDLED_POLICY.permissions
        .map(row => row.key)
        .filter(key => key !== 'files' && key !== 'localNetwork')
        .sort()
    ).toEqual(CONSENT_PERMISSION_KEYS.filter(key => BUNDLED_POLICY.permissions.some(row => row.key === key)).sort())
    expect(CONSENT_PERMISSION_KEYS).toHaveLength(13)

    for (const row of BUNDLED_POLICY.permissions) {
      expect(text).toContain(`${row.name} ${row.purpose}`)
    }
  })

  it.runIf(existsSync(SITE))('the bundled copy equals the site source byte for byte', () => {
    expect(readFileSync(SITE, 'utf8')).toBe(html)
  })
})
