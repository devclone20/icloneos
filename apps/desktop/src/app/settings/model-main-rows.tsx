import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { ModelOptionProvider } from '@/hermes'
import { useI18n } from '@/i18n'
import { Loader2, Trash2 } from '@/lib/icons'
import { REASONING_EFFORT_VALUES } from '@/lib/reasoning-effort'
import { cn } from '@/lib/utils'

import { CONTROL_TEXT } from './constants'
import { credentialCopy, joinLabels } from './credential-removal'
import type { RemovalPlan } from './model-settings-parts'
import { withActive } from './model-settings-parts'
import { SettingRow } from './setting-row'

interface ProviderChoice {
  name: string
  slug: string
}

interface MainModelRowsProps {
  activateApiKeyProvider: () => Promise<void>
  activating: boolean
  activeRemovalPlan: RemovalPlan | null
  apiKeyDraft: string
  applyMainModel: () => Promise<void>
  applying: boolean
  canRemoveCredentials: boolean
  credentialRemovedHere: boolean
  effortValue: string
  fastOn: boolean
  mainProviderOptions: readonly ProviderChoice[]
  needsSetup: boolean
  remainingHere: readonly string[] | null
  removeProviderCredentials: () => Promise<void>
  removingCredentials: boolean
  selectedModel: string
  selectedProvider: string
  selectedProviderModels: readonly string[]
  selectedProviderRow: ModelOptionProvider | undefined
  setApiKeyDraft: (value: string) => void
  setSelectedModel: (value: string) => void
  setSelectedProvider: (value: string) => void
  setupIsApiKey: boolean
  /** The agent's defaults rows (thinking depth, fast lane) show only once a main model is set. */
  showDefaults: boolean
  showFast: boolean
  showReasoning: boolean
  startProviderSetup: () => void
  writeAgentDefault: (key: string, value: string) => Promise<void>
}

/**
 * The Model pane's own rows: which provider, which model (or the inline
 * sign-in / key step while the provider is not ready), and the agent's
 * thinking-depth and fast-lane defaults — each on THE row.
 */
export function MainModelRows(props: MainModelRowsProps) {
  const { t } = useI18n()
  const m = t.settings.model
  const row = props.selectedProviderRow
  const providerName = row?.name ?? m.providerFallback

  const providerHint =
    props.needsSetup && (props.credentialRemovedHere || row?.warning)
      ? props.credentialRemovedHere
        ? credentialCopy.chooseProvider(row?.name ?? props.selectedProvider)
        : row?.warning
      : m.mainProviderHint

  const modelHint =
    props.needsSetup && !props.setupIsApiKey && row
      ? row.auth_type === 'api_key'
        ? m.needsKey(row.name)
        : m.signsIn(row.name)
      : m.mainModelHint

  return (
    <>
      <SettingRow
        below={
          props.canRemoveCredentials && (
            <div>
              <Button
                className="text-muted-foreground hover:text-destructive"
                data-testid="model-remove-credentials"
                disabled={props.removingCredentials || !props.activeRemovalPlan}
                onClick={() => void props.removeProviderCredentials()}
                size="sm"
                type="button"
                variant="ghost"
              >
                {props.removingCredentials ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                {props.activeRemovalPlan?.kind === 'manage'
                  ? credentialCopy.manageInProviders
                  : credentialCopy.removeCredentialsFor(row?.name ?? '')}
              </Button>
              {props.remainingHere && (
                <p className="mt-1 text-xs text-muted-foreground" data-testid="model-credentials-remaining">
                  {credentialCopy.stillSignedIn(row?.name ?? '', joinLabels([...props.remainingHere]))}
                </p>
              )}
            </div>
          )
        }
        control={
          <Select onValueChange={props.setSelectedProvider} value={props.selectedProvider}>
            <SelectTrigger aria-label={m.mainProviderTitle} className={cn('w-full', CONTROL_TEXT)}>
              <SelectValue placeholder={m.provider} />
            </SelectTrigger>
            <SelectContent>
              {props.mainProviderOptions.map(provider => (
                <SelectItem key={provider.slug || 'none'} value={provider.slug || 'none'}>
                  {provider.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
        field
        hint={
          props.needsSetup && providerHint !== m.mainProviderHint ? (
            <span data-testid="model-choose-provider">{providerHint}</span>
          ) : (
            providerHint
          )
        }
        title={m.mainProviderTitle}
      />
      <SettingRow
        control={
          props.needsSetup ? (
            props.setupIsApiKey ? (
              <div className="flex items-center gap-2">
                <Input
                  aria-label={m.pasteKey(providerName)}
                  autoComplete="off"
                  className={cn('min-w-0 flex-1', CONTROL_TEXT)}
                  onChange={event => props.setApiKeyDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      void props.activateApiKeyProvider()
                    }
                  }}
                  placeholder={m.pasteKey(providerName)}
                  type="password"
                  value={props.apiKeyDraft}
                />
                <Button
                  disabled={!props.apiKeyDraft.trim() || props.activating}
                  onClick={() => void props.activateApiKeyProvider()}
                  size="sm"
                >
                  {props.activating && <Loader2 className="size-3.5 animate-spin" />}
                  {props.activating ? m.activating : m.activate}
                </Button>
              </div>
            ) : (
              <Button onClick={props.startProviderSetup} size="sm" variant="textStrong">
                {m.setUp(providerName)}
              </Button>
            )
          ) : (
            <div className="flex items-center gap-2">
              <Select onValueChange={props.setSelectedModel} value={props.selectedModel}>
                <SelectTrigger aria-label={m.mainModelTitle} className={cn('min-w-0 flex-1', CONTROL_TEXT)}>
                  <SelectValue placeholder={m.model} />
                </SelectTrigger>
                <SelectContent>
                  {withActive(props.selectedProviderModels, props.selectedModel).map(model => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                disabled={!props.selectedProvider || !props.selectedModel || props.applying}
                onClick={() => void props.applyMainModel()}
                size="sm"
              >
                {props.applying && <Loader2 className="size-3.5 animate-spin" />}
                {props.applying ? m.applying : t.common.apply}
              </Button>
            </div>
          )
        }
        field={!(props.needsSetup && !props.setupIsApiKey)}
        hint={modelHint}
        title={m.mainModelTitle}
      />
      {props.showDefaults && props.showReasoning && (
        <SettingRow
          control={
            <Select
              onValueChange={value => void props.writeAgentDefault('agent.reasoning_effort', value)}
              value={props.effortValue}
            >
              <SelectTrigger aria-label={m.reasoningTitle} className={cn('w-full', CONTROL_TEXT)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASONING_EFFORT_VALUES.map(value => (
                  <SelectItem key={value} value={value}>
                    {value === 'none' ? m.reasoningOff : t.shell.modelOptions[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
          field
          hint={m.reasoningHint}
          title={m.reasoningTitle}
        />
      )}
      {props.showDefaults && props.showFast && (
        <SettingRow
          control={
            <Switch
              aria-label={m.fastTitle}
              checked={props.fastOn}
              onCheckedChange={checked =>
                void props.writeAgentDefault('agent.service_tier', checked ? 'fast' : 'normal')
              }
            />
          }
          hint={m.fastHint}
          title={m.fastTitle}
        />
      )}
    </>
  )
}
