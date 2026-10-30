/**
 * iclone os — the owner's version scheme (ruling 0 of v0.0.3): three numbers, `vA.B.C`, everywhere.
 * The same spelling is the technical identity (package.json, electron-updater, latest-mac.yml, release tags, artifact
 * names) and what people see (About, Finder's version, update notices, release titles, the distribution folder).
 *
 * History: v0.0.0.1 and v0.0.0.2 shipped with a four-digit DISPLAY label `A.B.C.D` for the semver `A.B.(C*10+D)`
 * (`0.0.2` showed as `0.0.0.2` in Finder and About). Those labels may still turn up (an installed build's
 * CFBundleShortVersionString, an old log or note), so they are read back to their semver before anything is shown
 * or compared: a `0.0.0.2`-labelled build is `0.0.2`, older than `0.0.3`.
 */
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/
const LEGACY_LABEL = /^v?(\d+)\.(\d+)\.(\d+)\.(\d)$/

/** The four-digit labels the app shipped under before the three-number scheme, oldest first. History only. */
export const LEGACY_RELEASE_LABELS: readonly string[] = ['0.0.0.1', '0.0.0.2']

/** `v0.0.0.2` → `0.0.2` (the semver an old four-digit label stood for); null for anything else. */
export function semverFromLegacyLabel(label: string): null | string {
  const m = LEGACY_LABEL.exec(label.trim())

  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3]) * 10 + Number(m[4])}` : null
}

/**
 * The version as people see it: three numbers, no `v`. `0.0.3` → `0.0.3`; a legacy label `0.0.0.2` → `0.0.2`;
 * anything else (a pre-release, a runtime string) comes back trimmed and otherwise unchanged.
 */
export function displayVersion(version: string): string {
  const text = version.trim()
  const m = SEMVER.exec(text)

  if (m) {
    return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`
  }

  return semverFromLegacyLabel(text) ?? text
}

/** Numeric dotted-version compare: <0 when a is older than b; missing or non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0)

    if (diff !== 0) {
      return diff
    }
  }

  return 0
}

/**
 * Compare two versions of THIS app across the scheme change: legacy four-digit labels are read as the semver they
 * stood for first, so `0.0.0.2` < `0.0.3` and `0.0.1.0` (= `0.0.10`) > `0.0.3`. <0 when a is older than b.
 */
export function compareAppVersions(a: string, b: string): number {
  return compareVersions(displayVersion(a), displayVersion(b))
}
