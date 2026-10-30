import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ExternalLink } from '@/lib/external-link'
import { triggerHaptic } from '@/lib/haptics'
import { AlertCircle, Check, Cloud, FileText, Globe, Loader2, LogIn, Monitor, RefreshCw, Terminal } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { ConnectionsRegistrySection } from '../connections-registry'
import { CONTROL_TEXT } from '../constants'
import { ManagedUpdatesSection } from '../managed-updates-section'
import { EmptyState, Pill, SettingsContent, SettingsSkeleton } from '../primitives'
import { SettingRow } from '../setting-row'
import { selectSshHost } from '../ssh-host-selection'

import type { GatewayHandlers } from './gateway-handlers'
import { ModeCard, SSH_HOST_CUSTOM } from './gateway-model'
import type { GatewayConnectionState } from './gateway-state'

interface GatewayViewProps {
  connection: GatewayConnectionState
  embedded: boolean
  handlers: GatewayHandlers
}

/** The Gateway pane's rows (moved verbatim from gateway-settings.tsx); the state lives in the two hooks. */
export function GatewayView({ connection, embedded, handlers }: GatewayViewProps) {
  const {
    t,
    g,
    loading,
    saving,
    testing,
    signingIn,
    state,
    setState,
    remoteToken,
    setRemoteToken,
    lastTest,
    sshHostSuggestions,
    sshCustomHost,
    setSshCustomHost,
    keychainEncryption,
    keychainEncryptionBusy,
    setKeychainEncryption,
    plainTextConfirm,
    setPlainTextConfirm,
    cloudSignedIn,
    cloudSigningIn,
    cloudAgents,
    cloudDiscover,
    cloudConnectingId,
    cloudOrgs,
    cloudOrg,
    probeStatus,
    trimmedUrl,
    isConnectedAgent,
    authMode,
    authResolved,
    providerLabel,
    isPasswordProvider,
    oauthConnected,
    canUseRemote,
    performSave,
    save,
    signIn,
    signOut
  } = connection

  const {
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
  } = handlers

  if (loading) {
    return (
      <SettingsSkeleton
        sections={[
          { heading: true, rows: 3 },
          { heading: true, rows: 3 }
        ]}
      />
    )
  }

  if (!window.hermesDesktop?.getConnectionConfig) {
    return <EmptyState description={g.unavailableDesc} title={g.unavailableTitle} />
  }

  return (
    <SettingsContent bare={embedded}>
      {embedded ? null : (
        <div className="mb-5">
          <div className="flex items-center gap-2 text-[length:var(--conversation-text-font-size)] font-medium">
            <Globe className="size-4 text-muted-foreground" />
            {g.title}
            {state.envOverride ? <Pill tone="primary">{g.envOverride}</Pill> : null}
          </div>
          <p className="mt-2 max-w-2xl text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
            {g.intro}
          </p>
        </div>
      )}

      {state.envOverride ? (
        <div className="mb-5 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-[length:var(--conversation-caption-font-size)] text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <div>
            <div className="font-medium">{g.envOverrideTitle}</div>
            <div className="mt-1 leading-5">{g.envOverrideDesc}</div>
          </div>
        </div>
      ) : null}

      <SettingRow
        className="mb-5"
        control={
          // w-full: a container query box has no intrinsic width, so inside the row's flex control cell it would
          // collapse to 0 and every card to its padding (I-D r5).
          <div className="@container w-full">
            <div className="grid auto-rows-fr grid-cols-1 gap-2 @lg:grid-cols-2 @4xl:grid-cols-4">
              <ModeCard
                active={state.mode === 'local'}
                description={g.localDesc}
                disabled={state.envOverride}
                icon={Monitor}
                onSelect={() => setState(current => ({ ...current, mode: 'local' }))}
                title={g.localTitle}
              />
              <ModeCard
                active={state.mode === 'cloud'}
                description={g.cloudDesc}
                disabled={state.envOverride}
                icon={Cloud}
                onSelect={() => setState(current => ({ ...current, mode: 'cloud' }))}
                title={g.cloudTitle}
              />
              <ModeCard
                active={state.mode === 'remote'}
                description={g.remoteDesc}
                disabled={state.envOverride}
                hint={g.remoteAuthHint}
                icon={Globe}
                onSelect={() => setState(current => ({ ...current, mode: 'remote' }))}
                title={g.remoteTitle}
              />
              <ModeCard
                active={state.mode === 'ssh'}
                description={g.sshDesc}
                disabled={state.envOverride}
                hint={g.sshTrustHint}
                icon={Terminal}
                onSelect={() => setState(current => ({ ...current, mode: 'ssh' }))}
                title={g.sshTitle}
              />
            </div>
          </div>
        }
        title={g.modeTitle}
        wide
      />

      {/* Hermes Cloud panel: one portal sign-in, then a discovered-agent picker
          whose selection drives the silent per-agent cascade + a cloud
          connection. Replaces the URL/token form while in cloud mode. */}
      {state.mode === 'cloud' && !state.envOverride ? (
        <div className="mt-5 grid gap-1">
          <SettingRow
            control={
              cloudSignedIn ? (
                <div className="flex items-center gap-2">
                  <Pill tone="primary">
                    <Check className="size-3" /> {g.cloudSignedIn}
                  </Pill>
                  <Button disabled={cloudSigningIn} onClick={() => void cloudSignOut()} variant="outline">
                    {cloudSigningIn ? <Loader2 className="animate-spin" /> : null}
                    {g.signOut}
                  </Button>
                </div>
              ) : (
                <Button disabled={cloudSigningIn} onClick={() => void cloudSignIn()}>
                  {cloudSigningIn ? <Loader2 className="animate-spin" /> : <LogIn />}
                  {g.cloudSignIn}
                </Button>
              )
            }
            hint={cloudSignedIn ? g.cloudSignedInDesc : g.cloudNeedsSignIn}
            title={g.cloudSignInTitle}
          />

          {cloudSignedIn ? (
            cloudOrgs.length > 0 && !cloudOrg ? (
              // Multi-org user who hasn't picked an org yet: show the org picker
              // instead of the agent list. Selecting one re-runs discovery
              // scoped to it.
              <div className="mt-3">
                <div className="mb-2 text-[length:var(--conversation-caption-font-size)] font-medium text-(--ui-text-secondary)">
                  {g.cloudOrgPickerTitle}
                </div>
                <div className="grid gap-1">
                  {cloudOrgs.map(orgEntry => (
                    <SettingRow
                      control={
                        <Button onClick={() => selectCloudOrg(orgEntry)} size="sm">
                          {g.cloudOrgSelect}
                        </Button>
                      }
                      hint={g.cloudOrgRole(orgEntry.role)}
                      key={orgEntry.id}
                      title={orgEntry.name}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="mt-3">
                <SettingRow
                  control={
                    <div className="flex items-center gap-2">
                      {cloudOrg ? (
                        // Let the user switch orgs. Gating on cloudOrgs.length would
                        // hide this after a restore-open (which discovers straight
                        // into the saved org and never populates the org list). So
                        // show it whenever an org is selected: clicking clears the
                        // org and re-runs discovery with no org arg — a multi-org
                        // user gets the picker (NAS 409), a single-org user simply
                        // auto-resolves back to their one org (harmless).
                        <Button onClick={() => changeCloudOrg()} size="sm" variant="text">
                          {g.cloudOrgChange}
                        </Button>
                      ) : null}
                      <Button
                        disabled={cloudDiscover === 'loading'}
                        onClick={() => void discoverCloud(cloudOrg ?? undefined)}
                        size="sm"
                        variant="text"
                      >
                        {cloudDiscover === 'loading' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                        {g.cloudRefresh}
                      </Button>
                    </div>
                  }
                  title={g.cloudAgentsTitle}
                />

                {cloudDiscover === 'loading' ? (
                  <div className="flex items-center gap-2 py-3 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                    <Loader2 className="size-4 animate-spin" />
                    {g.cloudLoadingAgents}
                  </div>
                ) : cloudAgents.length === 0 ? (
                  <div className="flex items-start gap-2 py-3 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                    <span>
                      {g.cloudNoAgents.before}
                      <ExternalLink href="https://portal.nousresearch.com/agents" showExternalIcon={false}>
                        {g.cloudNoAgents.linkText}
                      </ExternalLink>
                      {g.cloudNoAgents.after}
                    </span>
                  </div>
                ) : (
                  <div className="grid gap-1">
                    {cloudAgents.map(agent => {
                      const connected = isConnectedAgent(agent)

                      return (
                        <div
                          className={cn('rounded-md px-2', connected && 'bg-primary/5 ring-1 ring-primary/25')}
                          key={agent.id}
                        >
                          <SettingRow
                            control={
                              connected ? (
                                <Pill tone="primary">
                                  <Check className="mr-1 inline size-3" />
                                  {g.cloudConnectedPill}
                                </Pill>
                              ) : (
                                <Button
                                  disabled={!agent.dashboardUrl || cloudConnectingId !== null}
                                  onClick={() => void connectCloudAgent(agent)}
                                  size="sm"
                                >
                                  {cloudConnectingId === agent.id ? <Loader2 className="animate-spin" /> : null}
                                  {agent.dashboardUrl
                                    ? cloudConnectingId === agent.id
                                      ? g.cloudConnecting
                                      : g.cloudConnect
                                    : g.cloudAgentProvisioning}
                                </Button>
                              )
                            }
                            hint={g.cloudStatusLabel(agent.dashboardGatewayState)}
                            title={agent.name}
                          />
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          ) : null}
        </div>
      ) : null}

      {state.mode === 'remote' && !state.envOverride ? (
        <div className="mt-5 grid gap-1">
          <SettingRow
            control={
              <Input
                className={cn('h-8', CONTROL_TEXT)}
                disabled={state.envOverride}
                onChange={event => setState(current => ({ ...current, remoteUrl: event.target.value }))}
                placeholder="https://gateway.example.com/hermes"
                value={state.remoteUrl}
              />
            }
            field
            hint={g.remoteUrlDesc}
            title={g.remoteUrlTitle}
          />

          {state.mode === 'remote' && probeStatus === 'probing' ? (
            <div className="flex items-center gap-2 py-3 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
              <Loader2 className="size-4 animate-spin" />
              {g.probing}
            </div>
          ) : null}

          {state.mode === 'remote' && probeStatus === 'error' ? (
            <div className="flex items-start gap-2 py-3 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {g.probeError}
            </div>
          ) : null}

          {/* OAuth / password gateways: present a sign-in button + connection status. */}
          {state.mode === 'remote' && authResolved && authMode === 'oauth' ? (
            <SettingRow
              control={
                oauthConnected ? (
                  <div className="flex items-center gap-2">
                    <Pill tone="primary">
                      <Check className="size-3" /> {g.signedIn}
                    </Pill>
                    <Button disabled={signingIn || state.envOverride} onClick={() => void signOut()} variant="outline">
                      {signingIn ? <Loader2 className="animate-spin" /> : null}
                      {g.signOut}
                    </Button>
                  </div>
                ) : (
                  <Button disabled={signingIn || state.envOverride || !trimmedUrl} onClick={() => void signIn()}>
                    {signingIn ? <Loader2 className="animate-spin" /> : <LogIn />}
                    {isPasswordProvider ? g.signIn : g.signInWith(providerLabel)}
                  </Button>
                )
              }
              hint={
                oauthConnected
                  ? isPasswordProvider
                    ? g.authSignedInPassword
                    : g.authSignedInOauth
                  : isPasswordProvider
                    ? g.authNeedsPassword
                    : g.authNeedsOauth(providerLabel)
              }
              title={g.authTitle}
            />
          ) : null}

          {/* Session-token gateways: keep the existing token entry box. */}
          {state.mode === 'remote' && authResolved && authMode === 'token' ? (
            <>
              <SettingRow
                control={
                  <Input
                    autoComplete="off"
                    className={cn('h-8 font-mono', CONTROL_TEXT)}
                    disabled={state.envOverride}
                    onChange={event => setRemoteToken(event.target.value)}
                    placeholder={
                      state.remoteTokenSet
                        ? g.existingToken(state.remoteTokenPreview ?? g.savedToken)
                        : g.pasteSessionToken
                    }
                    type="password"
                    value={remoteToken}
                  />
                }
                field
                hint={g.tokenDesc}
                title={g.tokenTitle}
              />

              {/* The saved token is on disk in plain text (no OS keyring). Same
                  banner idiom as envOverride so it reads as a real warning. */}
              {state.remoteTokenPlainText ? (
                <div className="mt-2 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-[length:var(--conversation-caption-font-size)] text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <div>
                    <div className="font-medium">{g.plainTextStoredTitle}</div>
                    <div className="mt-1 leading-5">{g.plainTextStoredDesc}</div>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {state.mode === 'ssh' && !state.envOverride ? (
        <div className="mt-5 grid gap-1">
          {sshHostSuggestions.length > 0 && !sshCustomHost ? (
            <SettingRow
              control={
                <Select
                  onValueChange={selectHost}
                  value={sshHostSuggestions.includes(state.sshHost) ? state.sshHost : SSH_HOST_CUSTOM}
                >
                  <SelectTrigger className={cn('h-8', CONTROL_TEXT)}>
                    <SelectValue placeholder={g.sshHostPick} />
                  </SelectTrigger>
                  <SelectContent>
                    {sshHostSuggestions.map(host => (
                      <SelectItem key={host} value={host}>
                        {host}
                      </SelectItem>
                    ))}
                    <SelectItem value={SSH_HOST_CUSTOM}>{g.sshHostCustom}</SelectItem>
                  </SelectContent>
                </Select>
              }
              field
              hint={g.sshHostPickDesc}
              title={g.sshHostPickTitle}
            />
          ) : (
            <SettingRow
              control={
                <Input
                  autoFocus={sshCustomHost}
                  className={cn('h-8', CONTROL_TEXT)}
                  onBlur={() => {
                    // Empty host on blur with suggestions available = the user backed
                    // out of Custom; return to the dropdown.
                    if (!state.sshHost.trim() && sshHostSuggestions.length > 0) {
                      setSshCustomHost(false)

                      return
                    }

                    void resolveSshHost(state.sshHost)
                  }}
                  onChange={event => setState(current => selectSshHost(current, event.target.value))}
                  value={state.sshHost}
                />
              }
              field
              hint={g.sshHostDesc}
              title={g.sshHostTitle}
            />
          )}
          <SettingRow
            control={
              <Input
                className={cn('h-8', CONTROL_TEXT)}
                onChange={event => setState(current => ({ ...current, sshUser: event.target.value }))}
                placeholder={g.sshUserPlaceholder}
                value={state.sshUser}
              />
            }
            field
            hint={g.sshUserDesc}
            title={g.sshUserTitle}
          />
          <SettingRow
            control={
              <Input
                className={cn('h-8', CONTROL_TEXT)}
                inputMode="numeric"
                onChange={event =>
                  setState(current => ({ ...current, sshPort: event.target.value ? Number(event.target.value) : null }))
                }
                placeholder="22"
                value={state.sshPort ?? ''}
              />
            }
            field
            hint={g.sshPortDesc}
            title={g.sshPortTitle}
          />
          <SettingRow
            control={
              <Input
                className={cn('h-8 font-mono', CONTROL_TEXT)}
                onChange={event => setState(current => ({ ...current, sshKeyPath: event.target.value }))}
                value={state.sshKeyPath}
              />
            }
            field
            hint={g.sshKeyDesc}
            title={g.sshKeyTitle}
          />
          <SettingRow
            control={
              <Input
                className={cn('h-8 font-mono', CONTROL_TEXT)}
                onChange={event => setState(current => ({ ...current, sshRemoteHermesPath: event.target.value }))}
                placeholder={g.sshHermesPathPlaceholder}
                value={state.sshRemoteHermesPath}
              />
            }
            field
            hint={g.sshHermesPathDesc}
            title={g.sshHermesPathTitle}
          />
        </div>
      ) : null}

      {lastTest ? <div className="mt-4 text-xs text-primary">{lastTest}</div> : null}

      {/* Test/Save apply to local + remote. Cloud connects via the agent picker
          above (which applies a cloud connection on select), so its only
          bottom-row action would be redundant — hidden in cloud mode. */}
      {state.mode !== 'cloud' ? (
        <SettingRow
          control={
            <div className="flex flex-wrap items-center justify-end gap-4">
              {state.mode === 'remote' ? (
                <Button
                  className="mr-auto"
                  disabled={state.envOverride || testing || !canUseRemote}
                  onClick={() => void testRemote()}
                  size="sm"
                  variant="text"
                >
                  {testing ? <Loader2 className="animate-spin" /> : null}
                  {g.testRemote}
                </Button>
              ) : state.mode === 'ssh' ? (
                <Button
                  className="mr-auto"
                  disabled={testing || !state.sshHost.trim()}
                  onClick={() => void testSsh()}
                  size="sm"
                  variant="text"
                >
                  {testing ? <Loader2 className="animate-spin" /> : null}
                  {g.sshTestConnection}
                </Button>
              ) : null}
              {embedded ? null : (
                <Button
                  disabled={state.envOverride || saving}
                  onClick={() => void save(false)}
                  size="sm"
                  variant="textStrong"
                >
                  {g.saveForRestart}
                </Button>
              )}
              <Button disabled={state.envOverride || saving} onClick={() => void save(true)} size="sm">
                {saving ? <Loader2 className="animate-spin" /> : null}
                {g.saveAndReconnect}
              </Button>
            </div>
          }
          title={g.applyTitle}
          wide
        />
      ) : null}

      {embedded ? null : (
        <div className="mt-6 grid gap-1">
          <SettingRow
            control={
              <Switch
                aria-label={g.keychainEncryptionTitle}
                checked={keychainEncryption}
                disabled={keychainEncryptionBusy}
                onCheckedChange={on => {
                  triggerHaptic('selection')
                  void setKeychainEncryption(on)
                }}
              />
            }
            disabled={keychainEncryptionBusy}
            hint={g.keychainEncryptionDesc}
            title={g.keychainEncryptionTitle}
          />
          <SettingRow
            control={
              <Button onClick={() => void window.hermesDesktop?.revealLogs()} size="sm" variant="textStrong">
                <FileText />
                {g.openLogs}
              </Button>
            }
            hint={g.diagnosticsDesc}
            title={g.diagnostics}
          />
        </div>
      )}

      {/* Unified Gateways page: the full connections registry (add/edit/delete
          named agent sources) lives on this page now, below the window
          connection controls. Hidden in the embedded (boot-recovery) form. */}
      {embedded ? null : (
        <>
          <ConnectionsRegistrySection />
          {/* Per-connection driver for the transactional managed SSH update
              engine (#95942). Renders only when SSH sources are registered and
              the Electron main exposes connections.updateManaged. */}
          <ManagedUpdatesSection />
        </>
      )}

      {/* Plain-text token opt-in: gated when secure storage is unavailable and a
          new token would be persisted. Confirm resumes the remembered save/apply. */}
      <ConfirmDialog
        confirmLabel={g.plainTextConfirmAction}
        description={g.plainTextConfirmDesc}
        destructive
        onClose={() => setPlainTextConfirm(null)}
        onConfirm={async () => {
          if (!plainTextConfirm) {
            return
          }

          await performSave(plainTextConfirm.apply, true)
        }}
        open={plainTextConfirm !== null}
        title={g.plainTextConfirmTitle}
      />
    </SettingsContent>
  )
}
