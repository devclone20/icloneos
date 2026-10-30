import { describe, expect, it } from 'vitest'

import {
  compareAppVersions,
  compareVersions,
  displayVersion,
  LEGACY_RELEASE_LABELS,
  semverFromLegacyLabel
} from './version'

describe('three-number version scheme (ruling 0)', () => {
  it('shows a version as three numbers, never four', () => {
    expect(displayVersion('0.0.3')).toBe('0.0.3')
    expect(displayVersion('0.0.10')).toBe('0.0.10')
    expect(displayVersion('1.0.0')).toBe('1.0.0')
    expect(displayVersion(' v0.0.3 ')).toBe('0.0.3')

    for (let patch = 0; patch < 200; patch += 1) {
      const shown = displayVersion(`0.3.${patch}`)

      expect(shown).toBe(`0.3.${patch}`)
      expect(shown.split('.')).toHaveLength(3)
    }
  })

  it('reads a legacy four-digit label back to the three numbers it stood for', () => {
    expect(displayVersion('0.0.0.2')).toBe('0.0.2')
    expect(displayVersion('v0.0.0.1')).toBe('0.0.1')
    expect(displayVersion('0.0.1.0')).toBe('0.0.10')
    expect(semverFromLegacyLabel('v0.0.0.2')).toBe('0.0.2')
    expect(semverFromLegacyLabel('1.0.0.0')).toBe('1.0.0')
    expect(semverFromLegacyLabel('0.0.0.12')).toBeNull()
    expect(semverFromLegacyLabel('0.0.3')).toBeNull()
  })

  it('leaves text that is not an app version alone', () => {
    expect(displayVersion('0.17.0-beta')).toBe('0.17.0-beta')
    expect(displayVersion('0.0.0.12')).toBe('0.0.0.12')
    expect(displayVersion('')).toBe('')
  })
})

describe('compareAppVersions across the scheme change', () => {
  it('sees the 0.0.0.2-labelled build (and its semver 0.0.2) as older than 0.0.3', () => {
    expect(compareAppVersions('0.0.0.2', '0.0.3')).toBeLessThan(0)
    expect(compareAppVersions('0.0.3', '0.0.0.2')).toBeGreaterThan(0)
    expect(compareAppVersions('0.0.2', '0.0.3')).toBeLessThan(0)
    expect(compareAppVersions('v0.0.0.1', '0.0.3')).toBeLessThan(0)
  })

  it('treats a label and the semver it stood for as the same release', () => {
    expect(compareAppVersions('0.0.0.2', '0.0.2')).toBe(0)
    expect(compareAppVersions('0.0.3', 'v0.0.3')).toBe(0)
  })

  it('reads a carried label by its value, not its digits (0.0.1.0 = 0.0.10 > 0.0.3)', () => {
    expect(compareAppVersions('0.0.1.0', '0.0.3')).toBeGreaterThan(0)
    expect(compareVersions('0.0.1.0', '0.0.3')).toBeLessThan(0)
  })

  it('every shipped legacy label is older than 0.0.3', () => {
    expect(LEGACY_RELEASE_LABELS).toEqual(['0.0.0.1', '0.0.0.2'])

    for (const label of LEGACY_RELEASE_LABELS) {
      expect(compareAppVersions(label, '0.0.3')).toBeLessThan(0)
    }
  })
})

describe('compareVersions', () => {
  it('compares each dotted part numerically, not as text', () => {
    expect(compareVersions('1.10', '1.9')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0)
  })

  it('treats missing and non-numeric parts as zero', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.x', '1.0')).toBe(0)
    expect(compareVersions('2', '1.9.9')).toBeGreaterThan(0)
  })
})
