#!/usr/bin/env node
// check-version.mjs — the one version, three numbers, everywhere (prebuild gate; owner ruling 0 of v0.0.3).
//   package.json version            = A.B.C  (npm, electron-updater, latest-mac.yml, artifact names, tag vA.B.C)
//   build.mac.bundleShortVersion    = A.B.C  (Finder's version, CFBundleShortVersionString)
//   build.mac.bundleVersion         = A.B.C  (CFBundleVersion; pinned so a BUILD_NUMBER env cannot append a 4th part)
// and the version must be newer than every release already shipped, including the two four-digit-labelled ones
// (0.0.0.1, 0.0.0.2 = 0.0.1, 0.0.2) — see src/iclone-shared/version.ts.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareAppVersions, LEGACY_RELEASE_LABELS } from '../src/iclone-shared/version.ts'

const THREE = /^\d+\.\d+\.\d+$/

/** Every reason this package.json's version is not shippable; empty when it is. */
export function versionProblems(pkg, shipped = LEGACY_RELEASE_LABELS) {
  const version = String(pkg?.version ?? '')
  const mac = pkg?.build?.mac ?? {}
  const problems = []

  if (!THREE.test(version)) {
    return [`package.json version must be three numbers A.B.C, got ${version || '(missing)'}`]
  }

  for (const [key, plist] of [
    ['bundleShortVersion', 'CFBundleShortVersionString'],
    ['bundleVersion', 'CFBundleVersion']
  ]) {
    if (mac[key] !== version) {
      problems.push(`build.mac.${key} (${plist}) is ${mac[key] ?? '(missing)'}; it must be ${version}`)
    }
  }

  if (pkg?.build?.buildVersion !== undefined) {
    problems.push(`build.buildVersion is set (${pkg.build.buildVersion}); the version lives in package.json only`)
  }

  const newest = [...shipped].sort(compareAppVersions).at(-1)

  if (newest && compareAppVersions(version, newest) <= 0) {
    problems.push(`package.json version ${version} is not newer than the shipped release ${newest}`)
  }

  return problems
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  const problems = versionProblems(pkg)

  for (const problem of problems) {
    console.error(`[check-version] ${problem}`)
  }

  if (problems.length) {
    process.exit(1)
  }

  console.log(`[check-version] ok — v${pkg.version} (package.json, CFBundleShortVersionString, CFBundleVersion)`)
}
