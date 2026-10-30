import { useEffect } from 'react'

import type { DesktopCloudAgent, DesktopCloudOrg } from '@/global'
import { notify, notifyError } from '@/store/notifications'

import { enrichSelectedSshHost, selectSshHost } from '../ssh-host-selection'

import { auditSignOut, SSH_HOST_CUSTOM } from './gateway-model'
import type { GatewayConnectionState } from './gateway-state'

/** The Gateway pane's cloud, SSH and keychain handlers (moved verbatim from gateway-settings.tsx). */
export function useGatewayHandlers(connection: GatewayConnectionState) {
  const {
    t,
    g,
    loading,
    setTesting,
    state,
    setState,
    remoteToken,
    setLastTest,
    setSshCustomHost,
    sshResolveSeq,
    sshTestSeq,
    signingSeq,
    contextSeq,
    acceptSavedConfig,
    setCloudSignedIn,
    setCloudSigningIn,
    setCloudAgents,
    setCloudDiscover,
    setCloudConnectingId,
    setCloudOrgs,
    cloudOrg,
    cloudOrgRef,
    setCloudOrg,
    trimmedUrl,
    authMode,
    canUseRemote,
    payload
  } = connection

  // --- Hermes Cloud handlers ---

  // Pull the discovered agent list over the shared portal session. Tolerant of
  // a lapsed session: a needsCloudLogin error flips us back to signed-out.
  // `org` scopes discovery for multi-org users; when discovery comes back with
  // needsOrgSelection we surface the org list and show a picker instead.
  const discoverCloud = async (org?: string) => {
    const desktop = window.hermesDesktop
    const seq = contextSeq.current

    if (!desktop?.cloud) {
      return
    }

    setCloudDiscover('loading')

    try {
      const result = await desktop.cloud.discover(org)

      if (seq !== contextSeq.current) {
        return
      }

      if ('needsOrgSelection' in result && result.needsOrgSelection) {
        // Multi-org user with no org chosen yet: show the picker. Don't clear a
        // previously-chosen org list on a refresh.
        setCloudOrgs(result.orgs)
        setCloudAgents([])
        setCloudDiscover('done')

        return
      }

      // Single org (or org now chosen): we have agents.
      setCloudAgents('agents' in result ? result.agents : [])

      // Record the org AUTHORITATIVELY from the response (NAS echoes the org the
      // list was scoped to), falling back to the org we requested. This is what
      // gets persisted on connect, so it must be set even on single-membership
      // auto-resolve where no picker ran and no `org` arg was passed.
      const resolvedOrgRef = 'org' in result && result.org ? (result.org.slug ?? result.org.id) : null

      if (resolvedOrgRef) {
        setCloudOrg(resolvedOrgRef)
      } else if (org) {
        setCloudOrg(org)
      }

      setCloudDiscover('done')
    } catch (err) {
      if (seq !== contextSeq.current) {
        return
      }

      setCloudAgents([])
      setCloudDiscover('error')

      // A lapsed/absent portal session means we're effectively signed out.
      if (err && typeof err === 'object' && 'needsCloudLogin' in err) {
        setCloudSignedIn(false)
      }

      notifyError(err, g.cloudDiscoverFailed)
    }
  }

  // User picked an org from the multi-org picker: remember it and re-run
  // discovery scoped to it.
  const selectCloudOrg = (org: DesktopCloudOrg) => {
    const ref = org.slug ?? org.id
    setCloudOrg(ref)
    void discoverCloud(ref)
  }

  // "Change org": clear the selected org and re-discover with no org arg. A
  // multi-org user gets NAS's 409 → the picker; a single-org user auto-resolves
  // back to their one org. Also clear the agent list so the current org's
  // agents don't linger under the picker while discovery re-runs.
  const changeCloudOrg = () => {
    setCloudOrg(null)
    setCloudAgents([])
    void discoverCloud()
  }

  // On entering cloud mode, read the portal session status and
  // auto-discover when already signed in, so the picker is populated on open.
  useEffect(() => {
    if (state.mode !== 'cloud') {
      return
    }

    const desktop = window.hermesDesktop

    if (!desktop?.cloud) {
      return
    }

    let cancelled = false
    desktop.cloud
      .status()
      .then(status => {
        if (cancelled) {
          return
        }

        setCloudSignedIn(status.signedIn)

        if (status.signedIn) {
          // Restore the persisted org (if any) so we reopen straight into that
          // org's agent list instead of the picker; discoverCloud(org) also
          // records it as the selected org. Empty → normal discovery (single-org
          // resolves automatically; multi-org shows the picker).
          const savedOrg = state.cloudOrg || ''

          if (savedOrg) {
            setCloudOrg(savedOrg)
          }

          void discoverCloud(savedOrg || undefined)
        } else {
          setCloudAgents([])
          setCloudOrgs([])
          setCloudOrg(null)
          setCloudDiscover('idle')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCloudSignedIn(false)
        }
      })

    return () => void (cancelled = true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on mode change only
  }, [state.mode])

  const cloudSignIn = async () => {
    const desktop = window.hermesDesktop
    const seq = ++signingSeq.current

    if (!desktop?.cloud) {
      return
    }

    setCloudSigningIn(true)

    try {
      const result = await desktop.cloud.login()

      if (seq !== signingSeq.current) {
        return
      }

      setCloudSignedIn(result.signedIn)

      if (result.signedIn) {
        await discoverCloud()
      }
    } catch (err) {
      if (seq === signingSeq.current) {
        notifyError(err, g.cloudSignInFailed)
      }
    } finally {
      if (seq === signingSeq.current) {
        setCloudSigningIn(false)
      }
    }
  }

  const cloudSignOut = async () => {
    const desktop = window.hermesDesktop
    const seq = ++signingSeq.current

    if (!desktop?.cloud) {
      return
    }

    setCloudSigningIn(true)

    try {
      await desktop.cloud.logout()

      if (seq !== signingSeq.current) {
        return
      }

      setCloudSignedIn(false)
      setCloudAgents([])
      setCloudOrgs([])
      setCloudOrg(null)
      setCloudDiscover('idle')
      notify({ kind: 'success', title: g.cloudSignedOutTitle, message: g.cloudSignedOutMessage })
      auditSignOut('hermes-cloud', 'cloud', 'signed_out')
    } catch (err) {
      auditSignOut('hermes-cloud', 'cloud', 'failed')

      if (seq === signingSeq.current) {
        notifyError(err, g.signOutFailed)
      }
    } finally {
      if (seq === signingSeq.current) {
        setCloudSigningIn(false)
      }
    }
  }

  // Select a discovered agent: drive the silent per-agent cascade (no second
  // prompt — the shared portal session auto-approves), then persist a cloud-mode
  // connection pointed at its dashboardUrl and apply it (soft-reconnects in place).
  const connectCloudAgent = async (agent: DesktopCloudAgent) => {
    const seq = contextSeq.current

    if (!agent.dashboardUrl) {
      return
    }

    const desktop = window.hermesDesktop

    if (!desktop?.cloud) {
      return
    }

    setCloudConnectingId(agent.id)

    try {
      const result = await desktop.cloud.agentSignIn(agent.dashboardUrl)

      if (seq !== contextSeq.current) {
        return
      }

      if (!result.connected) {
        notify({
          kind: 'warning',
          title: t.boot.failure.signInIncompleteTitle,
          message: t.boot.failure.signInIncompleteMessage
        })

        return
      }

      // Persist a cloud-mode connection (remote-shaped, oauth) and soft-reconnect.
      // Include the selected org so Settings reopens into the same org + instance.
      // Read the REF (not the cloudOrg state) so a just-resolved org from
      // discovery in this same render tick is captured, not a stale null.
      const next = await desktop.applyConnectionConfig({
        mode: 'cloud',
        remoteAuthMode: 'oauth',
        remoteUrl: agent.dashboardUrl,
        cloudOrg: cloudOrgRef.current ?? undefined
      })

      if (seq !== contextSeq.current) {
        return
      }

      acceptSavedConfig(next)
      notify({ kind: 'success', title: g.cloudConnectedTitle, message: g.cloudConnectedTo(agent.name) })
    } catch (err) {
      if (seq !== contextSeq.current) {
        return
      }

      if (err && typeof err === 'object' && 'needsCloudLogin' in err) {
        setCloudSignedIn(false)
      }

      notifyError(err, g.cloudConnectFailed)
    } finally {
      if (seq === contextSeq.current) {
        setCloudConnectingId(null)
      }
    }
  }

  const resolveSshHost = async (host: string) => {
    if (!host || !window.hermesDesktop?.sshResolveHost) {
      return
    }

    const seq = ++sshResolveSeq.current

    try {
      const resolved = await window.hermesDesktop.sshResolveHost(host)

      if (seq !== sshResolveSeq.current) {
        return
      }

      setState(current => enrichSelectedSshHost(current, host, resolved))
    } catch {
      return
    }
  }

  const selectHost = (value: string) => {
    if (value === SSH_HOST_CUSTOM) {
      setSshCustomHost(true)
      setState(current => selectSshHost(current, ''))

      return
    }

    setSshCustomHost(false)
    setState(current => selectSshHost(current, value))
    void resolveSshHost(value)
  }

  const testSsh = async () => {
    const seq = ++sshTestSeq.current

    if (!state.sshHost.trim()) {
      notify({ kind: 'warning', title: g.incompleteTitle, message: g.sshIncompleteHost })

      return
    }

    setTesting(true)
    setLastTest(null)

    try {
      const result = await window.hermesDesktop.testConnectionConfig(payload())

      if (seq !== sshTestSeq.current) {
        return
      }

      if (!result.reachable) {
        const errors = {
          'auth-failed': g.sshErrAuth,
          'hermes-not-found': g.sshErrNotInstalled,
          'host-key-changed': g.sshErrHostKey,
          timeout: g.sshErrTimeout,
          unreachable: g.sshErrUnreachable,
          'unsupported-platform': g.sshErrPlatform,
          'update-required': g.sshErrUpdateRequired,
          unknown: g.sshErrUnknown
        }

        throw new Error(errors[result.sshError || 'unknown'] || result.error || g.sshErrUnknown)
      }

      const message = g.sshReachable(result.host || state.sshHost, result.remotePlatform || '?')
      setLastTest(message)
      notify({ kind: 'success', title: g.reachableTitle, message })
    } catch (err) {
      if (seq === sshTestSeq.current) {
        notifyError(err, g.testFailed)
      }
    } finally {
      if (seq === sshTestSeq.current) {
        setTesting(false)
      }
    }
  }

  const testRemote = async () => {
    const seq = ++sshTestSeq.current

    if (!canUseRemote) {
      notify({
        kind: 'warning',
        title: g.incompleteTitle,
        message: authMode === 'oauth' ? g.incompleteSignInTest : g.incompleteTokenTest
      })

      return
    }

    setTesting(true)
    setLastTest(null)

    try {
      const result = await window.hermesDesktop.testConnectionConfig({
        mode: 'remote',
        remoteAuthMode: authMode,
        remoteToken: authMode === 'token' ? remoteToken.trim() || undefined : undefined,
        remoteUrl: trimmedUrl
      })

      if (seq !== sshTestSeq.current) {
        return
      }

      const message = g.connectedTo(result.baseUrl || trimmedUrl, result.version ?? undefined)
      setLastTest(message)
      notify({ kind: 'success', title: g.reachableTitle, message })
    } catch (err) {
      if (seq === sshTestSeq.current) {
        notifyError(err, g.testFailed)
      }
    } finally {
      if (seq === sshTestSeq.current) {
        setTesting(false)
      }
    }
  }

  return {
    discoverCloud,
    selectCloudOrg,
    changeCloudOrg,
    cloudSignIn,
    cloudSignOut,
    connectCloudAgent,
    resolveSshHost,
    selectHost,
    testSsh,
    testRemote
  }
}

export type GatewayHandlers = ReturnType<typeof useGatewayHandlers>
