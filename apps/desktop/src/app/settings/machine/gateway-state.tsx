import { useEffect, useMemo, useRef, useState } from 'react'

import type { DesktopAuthProvider, DesktopCloudAgent, DesktopCloudOrg, DesktopConnectionProbeResult } from '@/global'
import { useI18n } from '@/i18n'
import { coerceRemoteUrlScheme } from '@/lib/remote-url'
import { notify, notifyError, readableError } from '@/store/notifications'

import type { AuthMode, CloudDiscoverStatus, GatewaySettingsState, ProbeStatus } from './gateway-model'
import { auditSignOut, EMPTY_STATE, normalizeGatewaySettingsState, savedCloudConnectionUrl } from './gateway-model'

/** The Gateway pane's connection state and its first handlers (moved verbatim from gateway-settings.tsx). */
export function useGatewayConnectionState() {
  const { t } = useI18n()
  const g = t.settings.gateway
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [state, setState] = useState<GatewaySettingsState>(EMPTY_STATE)
  const [remoteToken, setRemoteToken] = useState('')
  const [lastTest, setLastTest] = useState<null | string>(null)
  const [sshHostSuggestions, setSshHostSuggestions] = useState<string[]>([])
  const [sshCustomHost, setSshCustomHost] = useState(false)
  const sshResolveSeq = useRef(0)
  const sshTestSeq = useRef(0)
  const saveSeq = useRef(0)
  const signingSeq = useRef(0)
  const cloudConnectSeq = useRef(0)
  const contextSeq = useRef(0)
  const [connectedCloudUrl, setConnectedCloudUrl] = useState('')

  // Opt-in OS-keychain encryption for stored gateway secrets. Read lazily via
  // IPC (never touches the keychain); flipping it re-encodes stored secrets
  // in the main process and can legitimately prompt for keychain access.
  const [keychainEncryption, setKeychainEncryptionState] = useState(false)
  const [keychainEncryptionBusy, setKeychainEncryptionBusy] = useState(false)

  useEffect(() => {
    let cancelled = false

    void window.hermesDesktop
      ?.getSecretStorageEncryption?.()
      .then(res => {
        if (!cancelled && res) {
          setKeychainEncryptionState(res.on === true)
        }
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [])

  const setKeychainEncryption = async (on: boolean) => {
    setKeychainEncryptionBusy(true)
    // Optimistic paint; the IPC result (or a failure rollback) gets the last word.
    setKeychainEncryptionState(on)

    try {
      const res = await window.hermesDesktop.setSecretStorageEncryption(on)

      setKeychainEncryptionState(res?.on === true)
    } catch (err) {
      setKeychainEncryptionState(!on)
      notifyError(err, g.keychainEncryptionFailed)
    } finally {
      setKeychainEncryptionBusy(false)
    }
  }

  const acceptSavedConfig = (config: GatewaySettingsState) => {
    const normalized = normalizeGatewaySettingsState(config)

    setState(normalized)
    setConnectedCloudUrl(savedCloudConnectionUrl(normalized))
  }

  // When set, the plain-text opt-in dialog is open; `apply` remembers whether
  // the gated action was Save-for-restart (false) or Save-and-reconnect (true)
  // so confirm resumes the right one.
  const [plainTextConfirm, setPlainTextConfirm] = useState<null | { apply: boolean }>(null)

  // --- Hermes Cloud (cloud mode) state ---
  // One portal session powers discovery + the silent per-agent cascade. These
  // track the cloud panel: whether we're signed in, the discovered agent list,
  // and which agent is mid-connect.
  const [cloudSignedIn, setCloudSignedIn] = useState(false)
  const [cloudSigningIn, setCloudSigningIn] = useState(false)
  const [cloudAgents, setCloudAgents] = useState<DesktopCloudAgent[]>([])
  const [cloudDiscover, setCloudDiscover] = useState<CloudDiscoverStatus>('idle')
  const [cloudConnectingId, setCloudConnectingId] = useState<null | string>(null)
  // Multi-org users: when discovery returns needsOrgSelection, we hold the org
  // list here and show a picker. `cloudOrg` is the chosen org slug/id (null =
  // not yet chosen / single-org user).
  const [cloudOrgs, setCloudOrgs] = useState<DesktopCloudOrg[]>([])
  const [cloudOrg, setCloudOrgState] = useState<null | string>(null)
  // Mirror the selected org into a ref so connect reads the CURRENT value, not a
  // value captured in a stale render closure. discoverCloud() resolves the org
  // asynchronously (from the NAS response) and a user can click Connect in the
  // same render tick; without the ref, connectCloudAgent could persist a null
  // org even though discovery just resolved one. Always set both together.
  const cloudOrgRef = useRef<null | string>(null)

  const setCloudOrg = (value: null | string) => {
    cloudOrgRef.current = value
    setCloudOrgState(value)
  }

  // Auth-mode probe: as the user types a remote URL we ask the gateway (via
  // its public /api/status) whether it gates with OAuth or a static session
  // token, so we can show the right control (login button vs token box).
  const [probeStatus, setProbeStatus] = useState<ProbeStatus>('idle')
  const [probe, setProbe] = useState<DesktopConnectionProbeResult | null>(null)
  const probeSeq = useRef(0)

  useEffect(() => {
    let cancelled = false
    const desktop = window.hermesDesktop

    if (!desktop?.getConnectionConfig) {
      setLoading(false)

      return () => void (cancelled = true)
    }

    setLoading(true)

    desktop
      .getConnectionConfig(null)
      .then(config => {
        if (cancelled) {
          return
        }

        acceptSavedConfig(config)
      })
      .catch(err => notifyError(err, g.failedLoad))
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => void (cancelled = true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount; copy is stable
  }, [])

  // Debounced probe of the entered remote URL. Only runs in remote mode with a
  // syntactically plausible URL. The probe result drives whether we render the
  // OAuth login button or the session-token entry box. The effective auth mode
  // prefers a fresh probe result over the saved value.
  const trimmedUrl = coerceRemoteUrlScheme(state.remoteUrl)

  // The dashboardUrl of the currently-connected cloud instance (the saved
  // cloud connection's remoteUrl), normalized for comparison against each
  // discovered agent's dashboardUrl so we can highlight the active one and hide
  // its Connect button. Empty unless the saved connection is a cloud one.
  // The saved cloud URL was stored via the main-side normalizeRemoteBaseUrl
  // (which lowercases the host through URL.toString()), but a discovered agent's
  // dashboardUrl arrives raw from NAS — so normalize both sides the same way
  // (trim, drop trailing slash, lowercase) or a host-casing difference would
  // silently break the connected-highlight.
  const normalizeCloudUrl = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase()

  const isConnectedAgent = (agent: DesktopCloudAgent) =>
    Boolean(connectedCloudUrl && agent.dashboardUrl && normalizeCloudUrl(agent.dashboardUrl) === connectedCloudUrl)

  useEffect(() => {
    if (state.mode !== 'remote' || !trimmedUrl || !/^https?:\/\//i.test(trimmedUrl)) {
      setProbeStatus('idle')
      setProbe(null)

      return
    }

    const desktop = window.hermesDesktop

    if (!desktop?.probeConnectionConfig) {
      return
    }

    const seq = ++probeSeq.current
    setProbeStatus('probing')

    const timer = setTimeout(() => {
      desktop
        .probeConnectionConfig(trimmedUrl)
        .then(result => {
          if (seq !== probeSeq.current) {
            return
          }

          setProbe(result)
          setProbeStatus(result.reachable ? 'done' : 'error')
        })
        .catch(() => {
          if (seq !== probeSeq.current) {
            return
          }

          setProbe(null)
          setProbeStatus('error')
        })
    }, 500)

    return () => clearTimeout(timer)
  }, [state.mode, trimmedUrl])

  // Effective auth mode: a reachable probe wins; otherwise fall back to the
  // saved config's mode so a re-open of settings doesn't flicker.
  const authMode: AuthMode = useMemo(() => {
    if (probeStatus === 'done' && probe && probe.authMode !== 'unknown') {
      return probe.authMode
    }

    return state.remoteAuthMode
  }, [probe, probeStatus, state.remoteAuthMode])

  // Whether we actually KNOW how this gateway authenticates yet. Until we do,
  // neither the OAuth button nor the session-token box should render —
  // `authMode` defaults to 'token', so without this gate the token box flashes
  // for every gateway (including OAuth ones) during the idle/probing window
  // before the first probe lands. The scheme is known when either:
  //   * the live probe finished (probeStatus 'done'), or
  //   * we're idle but showing a previously-saved remote config (re-opening
  //     settings for a gateway already signed-in or with a saved token), so
  //     its control appears immediately with no flicker.
  // While probing (or after a probe error), the scheme is unknown and we show
  // the probe status row instead of a control.
  const hasSavedRemote = state.remoteTokenSet || state.remoteOauthConnected

  const authResolved = useMemo(() => {
    if (probeStatus === 'done') {
      return true
    }

    return probeStatus === 'idle' && hasSavedRemote
  }, [probeStatus, hasSavedRemote])

  const providerLabel = useMemo(() => {
    const providers: DesktopAuthProvider[] = probe?.providers ?? []

    if (providers.length === 1) {
      return providers[0].displayName || providers[0].name
    }

    if (providers.length > 1) {
      return providers.map(p => p.displayName || p.name).join(' / ')
    }

    return t.boot.failure.identityProvider
  }, [probe, t.boot.failure.identityProvider])

  // A username/password gateway authenticates through a credential form on the
  // gateway's /login page (POST /auth/password-login) rather than an OAuth
  // redirect. Everything downstream — the session cookie, the ws-ticket mint,
  // the persistent partition — is identical, so the desktop drives it through
  // the same sign-in window; only the button copy changes. We treat the
  // gateway as password-style only when EVERY advertised provider supports
  // password, so a mixed deployment keeps the generic OAuth copy.
  const isPasswordProvider = useMemo(() => {
    const providers: DesktopAuthProvider[] = probe?.providers ?? []

    return providers.length > 0 && providers.every(p => p.supportsPassword)
  }, [probe])

  useEffect(() => {
    // One-directional: a saved host that isn't in the suggestions must render
    // the free-text input (rehydration). Never force custom OFF here — that
    // instantly snapped the just-clicked-Custom (empty-host) input back to the
    // dropdown, making a raw-IP host impossible to type. The way back to the
    // dropdown is the input's onBlur (empty host + suggestions).
    if (state.sshHost && !sshHostSuggestions.includes(state.sshHost)) {
      setSshCustomHost(true)
    }
  }, [state.sshHost, sshHostSuggestions])

  useEffect(() => {
    if (state.mode !== 'ssh' || !window.hermesDesktop?.sshConfigHosts) {
      return
    }

    let cancelled = false
    void window.hermesDesktop
      .sshConfigHosts()
      .then(result => {
        if (!cancelled) {
          setSshHostSuggestions(result.hosts)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSshHostSuggestions([])
        }
      })

    return () => void (cancelled = true)
  }, [state.mode])

  // eslint-disable-next-line no-restricted-syntax -- monotonic request-sequence counters, not an atom mirror
  useEffect(() => {
    contextSeq.current += 1
    sshTestSeq.current += 1
    saveSeq.current += 1
    signingSeq.current += 1
    cloudConnectSeq.current += 1
    setLastTest(null)
  }, [
    state.mode,
    state.sshHost,
    state.sshUser,
    state.sshPort,
    state.sshKeyPath,
    state.sshRemoteHermesPath,
    state.sshRemoteProfile
  ])

  const oauthConnected = state.remoteOauthConnected

  const canUseRemote = useMemo(() => {
    if (!trimmedUrl) {
      return false
    }

    if (authMode === 'oauth') {
      return oauthConnected
    }

    return Boolean(remoteToken.trim()) || state.remoteTokenSet
  }, [authMode, oauthConnected, remoteToken, state.remoteTokenSet, trimmedUrl])

  const payload = (allowPlainTextToken?: boolean) => ({
    mode: state.mode,
    remoteAuthMode: authMode,
    remoteToken: authMode === 'token' ? remoteToken.trim() || undefined : undefined,
    remoteUrl: trimmedUrl,
    sshHost: state.sshHost.trim(),
    sshUser: state.sshUser.trim() || undefined,
    sshPort: state.sshPort,
    sshKeyPath: state.sshKeyPath.trim() || undefined,
    sshRemoteHermesPath: state.sshRemoteHermesPath.trim(),
    // Preserve an intentional blank so an existing remote-profile mapping can
    // be cleared instead of being mistaken for an omitted field.
    sshRemoteProfile: state.sshRemoteProfile.trim(),
    ...(allowPlainTextToken ? { allowPlainTextToken: true } : {})
  })

  // A pending Save/Apply would write a NEW token to disk in plain text when
  // we're on a remote-like connection using token auth, the user typed a token,
  // and this machine has no OS keyring (safeStorage unavailable). In that case
  // we must get an explicit opt-in before persisting.
  const wouldPersistPlainTextToken =
    (state.mode === 'remote' || state.mode === 'cloud') &&
    authMode !== 'oauth' &&
    Boolean(remoteToken.trim()) &&
    state.secureTokenStorage === false

  const performSave = async (apply: boolean, allowPlainTextToken: boolean) => {
    const seq = ++saveSeq.current
    setSaving(true)

    try {
      const next = apply
        ? await window.hermesDesktop.applyConnectionConfig(payload(allowPlainTextToken))
        : await window.hermesDesktop.saveConnectionConfig(payload(allowPlainTextToken))

      if (seq !== saveSeq.current) {
        return
      }

      acceptSavedConfig(next)
      setRemoteToken('')
      notify({
        kind: 'success',
        title: apply ? g.restartingTitle : g.savedTitle,
        message: apply ? g.restartingMessage : g.savedMessage
      })
    } catch (err) {
      if (seq !== saveSeq.current) {
        return
      }

      // The plain-text opt-in path runs inside ConfirmDialog's onConfirm, which
      // keeps the dialog open with an inline error when it throws — rethrow a
      // readable message there so a failed save can't play the success beat.
      if (allowPlainTextToken) {
        throw new Error(readableError(err, apply ? g.applyFailed : g.saveFailed).message)
      }

      const sshError = err && typeof err === 'object' && 'sshError' in err ? String(err.sshError) : ''

      const errors = {
        'auth-failed': g.sshErrAuth,
        'hermes-not-found': g.sshErrNotInstalled,
        'host-key-changed': g.sshErrHostKey,
        timeout: g.sshErrTimeout,
        unreachable: g.sshErrUnreachable,
        'unsupported-platform': g.sshErrPlatform,
        'update-required': g.sshErrUpdateRequired
      }

      if (state.mode === 'ssh' && sshError) {
        notify({
          kind: 'error',
          title: apply ? g.applyFailed : g.saveFailed,
          message: (errors as Record<string, string>)[sshError] || g.sshErrUnknown
        })
      } else {
        notifyError(err, apply ? g.applyFailed : g.saveFailed)
      }
    } finally {
      if (seq === saveSeq.current) {
        setSaving(false)
      }
    }
  }

  const save = async (apply: boolean) => {
    if (state.mode === 'remote' && !canUseRemote) {
      notify({
        kind: 'warning',
        title: g.incompleteTitle,
        message: authMode === 'oauth' ? g.incompleteSignIn : g.incompleteToken
      })

      return
    }

    // Defer to the opt-in dialog; confirm resumes with allowPlainTextToken.
    if (wouldPersistPlainTextToken) {
      setPlainTextConfirm({ apply })

      return
    }

    await performSave(apply, false)
  }

  // OAuth sign-in: persist the URL + oauth mode first (so the saved config has
  // the URL the login window needs), then open the gateway login window and
  // refresh the connection status from the saved config once it completes.
  const signIn = async () => {
    const seq = ++signingSeq.current

    if (!trimmedUrl) {
      notify({ kind: 'warning', title: g.incompleteTitle, message: g.enterUrlFirst })

      return
    }

    setSigningIn(true)

    try {
      // Save (don't apply/restart) so the login window has a URL to use and the
      // oauth mode is persisted, without yet flipping the live connection.
      const saved = await window.hermesDesktop.saveConnectionConfig({
        mode: state.mode,
        remoteAuthMode: 'oauth',
        remoteUrl: trimmedUrl
      })

      if (seq !== signingSeq.current) {
        return
      }

      acceptSavedConfig(saved)

      const result = await window.hermesDesktop.oauthLoginConnectionConfig(trimmedUrl)

      if (seq !== signingSeq.current) {
        return
      }

      if (result.connected) {
        const refreshed = await window.hermesDesktop.getConnectionConfig(null)
        acceptSavedConfig(refreshed)
        notify({ kind: 'success', title: g.signedIn, message: g.connectedTo(providerLabel) })
      } else {
        notify({
          kind: 'warning',
          title: t.boot.failure.signInIncompleteTitle,
          message: t.boot.failure.signInIncompleteMessage
        })
      }
    } catch (err) {
      if (seq === signingSeq.current) {
        notifyError(err, g.signInFailed)
      }
    } finally {
      if (seq === signingSeq.current) {
        setSigningIn(false)
      }
    }
  }

  const signOut = async () => {
    if (!trimmedUrl) {
      return
    }

    const seq = ++signingSeq.current
    setSigningIn(true)

    try {
      await window.hermesDesktop.oauthLogoutConnectionConfig(trimmedUrl)
      const refreshed = await window.hermesDesktop.getConnectionConfig(null)

      if (seq !== signingSeq.current) {
        return
      }

      acceptSavedConfig(refreshed)
      notify({ kind: 'success', title: g.signedOutTitle, message: g.signedOutMessage })
      auditSignOut(trimmedUrl, 'gateway', 'signed_out')
    } catch (err) {
      auditSignOut(trimmedUrl, 'gateway', 'failed')

      if (seq === signingSeq.current) {
        notifyError(err, g.signOutFailed)
      }
    } finally {
      if (seq === signingSeq.current) {
        setSigningIn(false)
      }
    }
  }

  return {
    t,
    g,
    loading,
    saving,
    testing,
    setTesting,
    signingIn,
    state,
    setState,
    remoteToken,
    setRemoteToken,
    lastTest,
    setLastTest,
    sshHostSuggestions,
    sshCustomHost,
    setSshCustomHost,
    sshResolveSeq,
    sshTestSeq,
    signingSeq,
    contextSeq,
    keychainEncryption,
    keychainEncryptionBusy,
    setKeychainEncryption,
    acceptSavedConfig,
    plainTextConfirm,
    setPlainTextConfirm,
    cloudSignedIn,
    setCloudSignedIn,
    cloudSigningIn,
    setCloudSigningIn,
    cloudAgents,
    setCloudAgents,
    cloudDiscover,
    setCloudDiscover,
    cloudConnectingId,
    setCloudConnectingId,
    cloudOrgs,
    setCloudOrgs,
    cloudOrg,
    cloudOrgRef,
    setCloudOrg,
    probeStatus,
    trimmedUrl,
    isConnectedAgent,
    authMode,
    authResolved,
    providerLabel,
    isPasswordProvider,
    oauthConnected,
    canUseRemote,
    payload,
    performSave,
    save,
    signIn,
    signOut
  }
}

export type GatewayConnectionState = ReturnType<typeof useGatewayConnectionState>
