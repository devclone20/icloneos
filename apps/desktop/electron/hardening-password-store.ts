// Linux safeStorage backend default. The `hermes desktop` launcher bridges the
// session keyring in through HERMES_DESKTOP_PASSWORD_STORE, but the .deb desktop
// entry and the AppImage start Electron directly, so nothing sets it. Chromium's
// own fallback for a desktop it does not recognise (Sway, Hyprland, a bare X
// session) is its plain-text "basic" store, which Electron reports as
// unavailable — remote gateway tokens are then refused (hardening.ts). libsecret
// is strictly better there: it works whenever any Secret Service daemon runs.
// 'basic' is never chosen here; plain text stays an explicit opt-in.

type LinuxPasswordStore = 'gnome-libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6'

interface PasswordStoreOptions {
  argv?: readonly string[]
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

function desktopTokens(env: NodeJS.ProcessEnv): string[] {
  const raw = `${env.XDG_CURRENT_DESKTOP || ''}:${env.XDG_SESSION_DESKTOP || ''}:${env.DESKTOP_SESSION || ''}`

  return raw
    .split(/[:;]/)
    .map(token => token.trim().toLowerCase())
    .filter(Boolean)
}

/** Pick the keyring backend Chromium should use for this desktop session. */
function detectLinuxPasswordStore(env: NodeJS.ProcessEnv = process.env): LinuxPasswordStore {
  const tokens = desktopTokens(env)

  if (tokens.some(token => token === 'kde' || token.startsWith('plasma'))) {
    const version = String(env.KDE_SESSION_VERSION || '').trim()

    if (version === '6') {
      return 'kwallet6'
    }

    if (version === '5') {
      return 'kwallet5'
    }

    return 'kwallet'
  }

  return 'gnome-libsecret'
}

/**
 * Fill HERMES_DESKTOP_PASSWORD_STORE from the desktop session when nobody set
 * it. An explicit env value or a `--password-store` argument always wins.
 * Returns the store it applied, or null when it left the environment alone.
 */
function applyLinuxPasswordStoreDefault(options: PasswordStoreOptions = {}): LinuxPasswordStore | null {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const argv = options.argv ?? process.argv

  if (platform !== 'linux' || String(env.HERMES_DESKTOP_PASSWORD_STORE || '').trim()) {
    return null
  }

  if (argv.some(arg => arg === '--password-store' || arg.startsWith('--password-store='))) {
    return null
  }

  const store = detectLinuxPasswordStore(env)
  env.HERMES_DESKTOP_PASSWORD_STORE = store

  return store
}

export { applyLinuxPasswordStoreDefault, detectLinuxPasswordStore }
