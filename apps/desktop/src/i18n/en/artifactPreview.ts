import type { Translations } from '../types'

export const artifactPreview: Translations['artifactPreview'] = {
  versionOf: (current, total) => `v${current} of ${total}`,
  olderVersion: 'Older version',
  newerVersion: 'Newer version',
  latest: 'Latest',
  copyContent: 'Copy content',
  download: 'Download',
  openInBrowser: 'Open in browser',
  openInBrowserFailed: 'Could not open in browser',
  missingTitle: 'Artifact unavailable',
  missingBody: 'This artifact is no longer in the local registry.'
}
