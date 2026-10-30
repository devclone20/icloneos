/** Upstream release tags: the one parser for the developer pane (for-each-ref) and the agent check (ls-remote). */
import type { IcloneUpstreamTag } from '../src/iclone-shared/update-status'

// CalVer releases (v2026.9.24, v2026.8.16.2) and semver releases (v0.21.5).
// Canaries (`v0.21.4+canary.…`) and pre-releases (`-rc…`) are not re-import
// points: they are cut from main between releases and never promised stable.
const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:\.\d+)?$/

/**
 * The first release tag in `git for-each-ref --sort=-creatordate` output
 * (TAG_FORMAT). Annotated tags are peeled so `sha` is always the commit.
 */
export function parseLatestReleaseTag(text: string): IcloneUpstreamTag | null {
  for (const line of String(text ?? '').split('\n')) {
    const [name = '', object = '', peeled = '', date = ''] = line.trim().split('\t')
    const sha = (peeled || object).toLowerCase()

    if (RELEASE_TAG.test(name) && /^[0-9a-f]{40}$/.test(sha) && date) {
      return { date, name, sha }
    }
  }

  return null
}
