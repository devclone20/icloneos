import { resolvePluginGitUrl } from '@/iclone-shared/plugin-git-url'

interface PluginSourceLinks {
  gitUrl: string
  browseUrl: string | null
  subdir: string | null
}

function githubBrowseBase(gitUrl: string): string | null {
  const sshMatch = gitUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i)

  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2].replace(/\.git$/, '')}`
  }

  try {
    const url = new URL(gitUrl)

    if (url.hostname.toLowerCase() === 'github.com') {
      const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean)

      if (parts.length >= 2) {
        return `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/, '')}`
      }
    }
  } catch {
    return null
  }

  return null
}

function browseUrlFromGitUrl(gitUrl: string, subdir: string | null): string | null {
  const githubBase = githubBrowseBase(gitUrl)

  if (githubBase) {
    return subdir ? `${githubBase}/tree/HEAD/${subdir}` : githubBase
  }

  if (/^https?:\/\//.test(gitUrl)) {
    const base = gitUrl.replace(/\.git$/, '')

    return subdir ? `${base}/tree/HEAD/${subdir}` : base
  }

  return null
}

export function resolvePluginSourceLinks(identifier: string): PluginSourceLinks | null {
  try {
    const { gitUrl, subdir } = resolvePluginGitUrl(identifier)

    return {
      gitUrl,
      browseUrl: browseUrlFromGitUrl(gitUrl, subdir),
      subdir
    }
  } catch {
    return null
  }
}
