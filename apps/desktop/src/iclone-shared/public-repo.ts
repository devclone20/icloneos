/**
 * The public full-release repository: the app's update feed (electron-builder `build.publish`, so app-update.yml),
 * the runtime pin of the latest release, and every link the app opens to releases. One owner/repo, here, so a
 * surface cannot drift to another repo; `public-repo.test.ts` pins it against package.json.
 *
 * From 0.0.3 this is the only repository the app contacts for releases; the earlier releases repo is archived and is
 * never read.
 */
export const PUBLIC_REPOSITORY = 'devclone20/icloneos'

export const PUBLIC_REPO_URL = `https://github.com/${PUBLIC_REPOSITORY}`

export const PUBLIC_RELEASES_URL = `${PUBLIC_REPO_URL}/releases`

export const PUBLIC_LATEST_RELEASE_URL = `${PUBLIC_RELEASES_URL}/latest`

/** A named asset of the latest full (non-pre-release) release. */
export const latestReleaseAssetUrl = (file: string) =>
  `${PUBLIC_LATEST_RELEASE_URL}/download/${encodeURIComponent(file)}`

/** The release page of one version (tags are `v<version>`). */
export const releaseTagUrl = (version: string) => `${PUBLIC_RELEASES_URL}/tag/v${version}`
