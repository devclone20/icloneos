/**
 * iCLONE OS — the one parser of a plugin identifier (GitHub shorthand, URL or
 * browser link) into a clonable git URL plus an optional subdirectory. Pure:
 * the main process installs from it and the renderer links to its source.
 */

const GITHUB_BROWSER_SEGMENTS = new Set(['tree', 'blob', 'commit'])

export interface ResolvedGitUrl {
  gitUrl: string
  subdir: string | null
}

export function resolvePluginGitUrl(identifier: string): ResolvedGitUrl {
  const trimmed = identifier.trim()

  if (!trimmed) {
    throw new Error('Plugin identifier is required.')
  }

  if (/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(trimmed)) {
    if (trimmed.startsWith('https://github.com/')) {
      const rest = trimmed.slice('https://github.com/'.length).split(/[?#]/)[0].replace(/\/+$/, '')
      const parts = rest.split('/').filter(Boolean)

      if (parts.length >= 3 && parts[2] && GITHUB_BROWSER_SEGMENTS.has(parts[2])) {
        const repo = parts[1].replace(/\.git$/, '')
        let subdir: string | null = null

        if (parts[2] === 'tree' && parts.length >= 5) {
          subdir = parts.slice(4).join('/').replace(/\/+$/, '') || null
        }

        return { gitUrl: `https://github.com/${parts[0]}/${repo}.git`, subdir }
      }
    }

    if (trimmed.includes('#')) {
      const hashIdx = trimmed.indexOf('#')
      const gitUrl = trimmed.slice(0, hashIdx)
      const subdir = trimmed.slice(hashIdx + 1).replace(/^\/+|\/+$/g, '') || null

      return { gitUrl, subdir }
    }

    const marker = '.git/'

    if (trimmed.includes(marker)) {
      const idx = trimmed.indexOf(marker)
      const gitUrl = trimmed.slice(0, idx + marker.length - 1)
      const subdir = trimmed.slice(idx + marker.length).replace(/^\/+|\/+$/g, '') || null

      return { gitUrl, subdir }
    }

    return { gitUrl: trimmed, subdir: null }
  }

  const parts = trimmed.split('/').filter(Boolean)

  if (parts.length >= 2) {
    const [owner, repo, ...rest] = parts
    const gitUrl = `https://github.com/${owner}/${repo}.git`
    const subdir = rest.join('/').replace(/\/+$/, '') || null

    return { gitUrl, subdir }
  }

  throw new Error("Invalid plugin identifier. Use a Git URL or 'owner/repo' (optionally with a subdirectory).")
}
