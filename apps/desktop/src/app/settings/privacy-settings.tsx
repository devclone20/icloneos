import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { PolicyReader } from '@/components/consent/policy-reader'
import {
  $consent,
  applyConsentResult,
  consentBridge,
  displayedPermissions,
  loadConsent
} from '@/components/consent/store'
import { CONSENT_CAPABILITY_KEYS, CONSENT_DEVICE_KEYS, CONSENT_NEVER_USED } from '@/components/consent/types'
import type { ConsentDoorRecent, ConsentPermissionKey, ConsentRecord } from '@/components/consent/types'
import { Button } from '@/components/ui/button'
import { codiconIcon } from '@/components/ui/codicon'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Switch } from '@/components/ui/switch'
import { triggerHaptic } from '@/lib/haptics'
import { ExternalLink } from '@/lib/icons'

import { SETTINGS_ROUTE } from '../routes'

import { ListRowSkeleton, Pill, SectionHeading, SectionHeadingSkeleton, SettingsContent } from './primitives'
import { usePrivacyCopy } from './privacy-copy'
import { SettingRow } from './setting-row'

const PolicyIcon = codiconIcon('law')
const PermissionsIcon = codiconIcon('shield')
const ProviderIcon = codiconIcon('hubot')
const RequestsIcon = codiconIcon('comment-discussion')

// Capabilities first, then what the app itself uses: the order the first-launch sheet shows.
const PRIVACY_GROUPS = [
  { id: 'capabilities', keys: CONSENT_CAPABILITY_KEYS },
  { id: 'device', keys: CONSENT_DEVICE_KEYS }
] as const

const CAPTION = 'mt-1 text-[0.75rem] leading-4 text-muted-foreground'
const GROUP_TITLE = 'pt-3 pb-1 text-[0.8125rem] font-medium text-(--ui-text-tertiary)'

export function formatConsentDate(iso: string): string {
  const date = new Date(iso)

  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

/** A request row: the date and the local time of day it was answered ("17 October 2026, 14:05"). */
export function formatRequestTime(iso: string): string {
  const date = new Date(iso)

  return Number.isNaN(date.getTime())
    ? iso
    : `${formatConsentDate(iso)}, ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}

function permissionsNotConfigured(record: ConsentRecord | null): boolean {
  return !record || record.skipped || record.permissionsDecidedAt === null
}

/** Settings › Privacy — the same record the first-launch sheet wrote (main owns `consent.json`). */
export function PrivacySettings({ navigate }: { navigate?: (route: string) => void }) {
  const words = usePrivacyCopy()
  const copy = words.settings
  const { snapshot, status } = useStore($consent)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [withdrawing, setWithdrawing] = useState(false)
  const [keychainOn, setKeychainOn] = useState<boolean | null>(null)
  const [requests, setRequests] = useState<ConsentDoorRecent[]>([])

  useEffect(() => {
    const door = consentBridge()
    const refresh = () => void door?.requests?.().then(setRequests, () => undefined)

    refresh()

    // A request answered while this pane is open shows up at once (null = the sheet closed).
    return door?.onDoor?.(next => {
      if (!next) {
        refresh()
        void loadConsent(true)
      }
    })
  }, [])

  useEffect(() => {
    void loadConsent(true)
    void window.hermesDesktop?.getSecretStorageEncryption?.().then(
      result => setKeychainOn(result.on === true),
      () => setKeychainOn(null)
    )
  }, [])

  if (status === 'unavailable') {
    return (
      <SettingsContent>
        <p className="pt-4 text-[0.8125rem] text-(--ui-text-tertiary)">{copy.unavailable}</p>
      </SettingsContent>
    )
  }

  if (!snapshot) {
    return (
      <SettingsContent>
        <SectionHeadingSkeleton />
        <ListRowSkeleton wide />
        <ListRowSkeleton />
      </SettingsContent>
    )
  }

  const bridge = consentBridge()
  const { bundled, record } = snapshot
  const notConfigured = permissionsNotConfigured(record)
  const keychain = keychainOn ?? snapshot.keychainEncrypted
  const ai = record?.aiProviderConsent ?? null
  const aiAccepted = ai?.accepted === true
  const aiPill = !ai ? copy.aiNotRecorded : (aiAccepted ? copy.accepted : copy.aiWithdrawn)(formatConsentDate(ai.at))

  const save = async (work: () => Promise<Parameters<typeof applyConsentResult>[0]>) => {
    setError(null)

    try {
      if (applyConsentResult(await work())) {
        setError(copy.saveFailed)
      }
    } catch {
      setError(copy.saveFailed)
    }
  }

  const setPermission = (key: ConsentPermissionKey, on: boolean) =>
    bridge &&
    void save(() =>
      bridge.setPermissions({
        // Every row as shown (a row shown OFF is saved OFF); Keychain as its real encryption state.
        permissions: displayedPermissions(k =>
          k === key ? on : k === 'keychain' ? keychain : !notConfigured && record?.permissions[k] === true
        )
      })
    )

  const policyPill = !record
    ? copy.notAccepted
    : record.policyVersion === bundled.version
      ? copy.accepted(formatConsentDate(record.acceptedAt))
      : copy.acceptedOlder(record.policyVersion)

  return (
    <SettingsContent>
      <div className="grid gap-6 pt-2" data-privacy-settings="">
        <section>
          <SectionHeading icon={PolicyIcon} title={copy.policyHeading} />
          <SettingRow
            below={
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                <Button className="px-0" onClick={() => void bridge?.openPolicy()} size="sm" variant="link">
                  {copy.openLive}
                  <ExternalLink className="size-3.5" />
                </Button>
                <Button
                  aria-expanded={reading}
                  className="px-0"
                  onClick={() => setReading(open => !open)}
                  size="sm"
                  variant="link"
                >
                  {reading ? copy.hideOffline : copy.readOffline}
                </Button>
              </div>
            }
            control={<Pill tone={record ? 'primary' : 'warn'}>{policyPill}</Pill>}
            hint={copy.effective(bundled.effectiveLabel)}
            title={copy.policyRow(bundled.version)}
          />
          {reading ? <PolicyReader /> : null}
        </section>

        <section data-privacy-permissions={notConfigured ? 'not-configured' : 'configured'}>
          <SectionHeading
            icon={PermissionsIcon}
            meta={notConfigured ? copy.notConfigured : undefined}
            title={copy.permissionsHeading}
          />
          {notConfigured ? (
            <p className="mb-1 text-[0.8125rem] text-(--ui-text-tertiary)">{copy.notConfiguredHint}</p>
          ) : null}
          {PRIVACY_GROUPS.map(group => (
            <div data-privacy-group={group.id} key={group.id}>
              <h3 className={GROUP_TITLE}>{words.groups[group.id]}</h3>
              {group.keys
                .map(key => ({ key, ...words.rows[key] }))
                .map(row =>
                  row.key === 'keychain' ? (
                    <SettingRow
                      below={
                        <div className="mt-1 grid justify-items-start gap-1">
                          <p className={CAPTION}>{row.effect}</p>
                          <Button
                            className="px-0"
                            onClick={() => navigate?.(`${SETTINGS_ROUTE}?tab=gateway`)}
                            size="sm"
                            variant="link"
                          >
                            {copy.keychainOpen}
                          </Button>
                        </div>
                      }
                      control={<Pill tone={keychain ? 'primary' : 'warn'}>{copy.keychainState(keychain)}</Pill>}
                      hint={row.hint}
                      key={row.key}
                      title={row.title}
                    />
                  ) : (
                    <SettingRow
                      below={<p className={CAPTION}>{row.effect}</p>}
                      control={
                        <Switch
                          aria-label={row.title}
                          checked={!notConfigured && record?.permissions[row.key] === true}
                          data-privacy-permission={row.key}
                          onCheckedChange={on => {
                            triggerHaptic('selection')
                            setPermission(row.key, on)
                          }}
                        />
                      }
                      hint={row.hint}
                      key={row.key}
                      title={row.title}
                    />
                  )
                )}
            </div>
          ))}
          <div data-privacy-group="never-used">
            <h3 className={GROUP_TITLE}>{words.groups.neverUsed}</h3>
            {CONSENT_NEVER_USED.map(key => (
              <SettingRow key={key} title={words.neverUsed[key]} />
            ))}
          </div>
          <p className="pt-2 text-[0.75rem] leading-4 text-(--ui-text-tertiary)">{copy.permissionsFooter}</p>
        </section>

        <section>
          <SectionHeading
            aside={
              aiAccepted ? (
                <Button onClick={() => setWithdrawing(true)} size="sm" variant="outline">
                  {copy.withdraw}
                </Button>
              ) : ai ? (
                <Button
                  onClick={() => void (bridge && save(() => bridge.setAiProvider({ accepted: true })))}
                  size="sm"
                  variant="outline"
                >
                  {copy.aiAcceptAgain}
                </Button>
              ) : undefined
            }
            icon={ProviderIcon}
            title={copy.aiHeading}
          />
          {/* A record of consent, not a switch: the send itself is not gated here (see withdrawDesc). */}
          <SettingRow
            below={
              <div className="mt-2 grid gap-1">
                {ai && !aiAccepted ? <p className={CAPTION}>{copy.aiWithdrawnHint}</p> : null}
                <div>
                  <Button
                    className="px-0"
                    onClick={() => navigate?.(`${SETTINGS_ROUTE}?tab=providers&pview=accounts`)}
                    size="sm"
                    variant="link"
                  >
                    {copy.openProviders}
                  </Button>
                </div>
              </div>
            }
            control={
              <span data-privacy-ai-provider="">
                <Pill tone={aiAccepted ? 'primary' : 'warn'}>{aiPill}</Pill>
              </span>
            }
            hint={copy.aiRowDesc}
            title={copy.aiRow}
          />
        </section>

        <p aria-live="polite" className="text-[0.75rem] text-(--ui-text-tertiary)" role="status">
          {error}
        </p>
      </div>
      <section className="pt-6" data-privacy-requests={requests.length}>
        <SectionHeading icon={RequestsIcon} title={copy.requestsHeading} />
        {requests.length === 0 ? (
          <p className="text-[0.8125rem] text-(--ui-text-tertiary)">{copy.requestsEmpty}</p>
        ) : (
          requests.map(item => (
            <div data-privacy-request={item.key} key={`${item.at}-${item.key}-${item.inft}`}>
              <SettingRow
                below={<p className={CAPTION}>{copy.requestBy(item.inft, formatRequestTime(item.at))}</p>}
                control={
                  <Pill tone={item.answer === 'always' || item.answer === 'once' ? 'primary' : 'warn'}>
                    {copy.requestAnswer[item.answer]}
                  </Pill>
                }
                hint={item.reason}
                title={words.rows[item.key].title}
              />
            </div>
          ))
        )}
      </section>
      <ConfirmDialog
        confirmLabel={copy.withdrawConfirm}
        description={copy.withdrawDesc}
        destructive
        onClose={() => setWithdrawing(false)}
        onConfirm={async () => {
          if (bridge) {
            await save(() => bridge.setAiProvider({ accepted: false }))
          }
        }}
        open={withdrawing}
        title={copy.withdrawTitle}
      />
    </SettingsContent>
  )
}
