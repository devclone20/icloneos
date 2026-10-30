/**
 * Pure helpers for choosing a remote URL during passive update checks.
 *
 * A public install can end up with `origin=git@github.com:NousResearch/hermes-agent.git`.
 * If the user's GitHub SSH key is FIDO2/passkey-backed, a background `git fetch
 * origin` triggers an unexplained hardware-touch prompt. For passive checks
 * against the official repo we substitute the public HTTPS `ls-remote` path,
 * which needs no auth and cannot prompt. Active update/apply flows are left
 * unchanged.
 *
 * Extracted from main.ts so the security-critical remote detection is unit
 * testable without booting Electron (main.ts requires('electron') at load).
 */

const OFFICIAL_REPO_HTTPS_URL = 'https://github.com/NousResearch/hermes-agent.git'
const OFFICIAL_REPO_CANONICAL = 'github.com/nousresearch/hermes-agent'

// Normalize common GitHub remote URL forms to `host/owner/repo` (lowercased,
// no trailing slash, no .git suffix) so SSH and HTTPS forms of the same repo
// compare equal.
function canonicalGitHubRemote(url: string | null | undefined) {
  if (!url) {
    return ''
  }

  let value = String(url).trim()

  if (value.startsWith('git@github.com:')) {
    value = `github.com/${value.slice('git@github.com:'.length)}`
  } else if (value.startsWith('ssh://git@github.com/')) {
    value = `github.com/${value.slice('ssh://git@github.com/'.length)}`
  } else {
    try {
      const parsed = new URL(value)

      if (parsed.hostname && parsed.pathname) {
        value = `${parsed.hostname}${parsed.pathname}`
      }
    } catch {
      // Leave non-URL forms unchanged.
    }
  }

  value = value.trim().replace(/\/+$/, '')

  if (value.endsWith('.git')) {
    value = value.slice(0, -4)
  }

  return value.toLowerCase()
}

function isSshRemote(url: string | null) {
  const value = String(url || '')
    .trim()
    .toLowerCase()

  return value.startsWith('git@') || value.startsWith('ssh://')
}

// Only transports that authenticate github.com end to end: TLS (https) or SSH. A bare
// `github.com/...` path, http://, git:// or file:// can name the same repo and still be
// served by anyone on the path, so the apply door must never treat them as official.
function isAuthenticatedGitHubTransport(url: string | null | undefined) {
  const value = String(url || '')
    .trim()
    .toLowerCase()

  return (
    value.startsWith('https://github.com/') ||
    value.startsWith('git@github.com:') ||
    value.startsWith('ssh://git@github.com/')
  )
}

/** An authenticated transport (https://, git@, ssh://git@; any case, with or without .git) that names NousResearch/hermes-agent. */
function isOfficialRemote(url: string | null | undefined) {
  return isAuthenticatedGitHubTransport(url) && canonicalGitHubRemote(url) === OFFICIAL_REPO_CANONICAL
}

function isOfficialSshRemote(url: string | null) {
  return isSshRemote(url) && isOfficialRemote(url)
}

export {
  canonicalGitHubRemote,
  isOfficialRemote,
  isOfficialSshRemote,
  isSshRemote,
  OFFICIAL_REPO_CANONICAL,
  OFFICIAL_REPO_HTTPS_URL
}
