import { useCallback, useEffect, useState } from 'react'

import { getHermesConfigRecord } from '@/api/config'
import { getGlobalModelInfo, getRecommendedDefaultModel } from '@/api/models'
import { NEW_CHAT_ROUTE } from '@/app/routes'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Copy, Cpu, MessageCircle, RefreshCw } from '@/lib/icons'

import { requestComposerFocus } from '../chat/composer/focus'
import { setMsgView } from '../home/it-store'

import { useOptionalNavigate } from './credential-removal'
import {
  CLAUDE_MODELS,
  type ClaudeCodeStatus,
  clockOf,
  endpointOf,
  ENGINE_PROVIDER,
  engineLabel,
  engineSelection,
  engineState,
  type EngineTarget,
  INSTALL_COMMAND,
  LOGIN_COMMAND,
  readNousModel,
  returnTarget,
  statusLine,
  switchEngine,
  switchFailure,
  windowLine,
  writeNousModel
} from './engine-settings-model'
import { Pill, SettingsContent, SettingsSection } from './primitives'
import { SettingRow } from './setting-row'

/** The rows that can start an engine switch. */
type EngineRow = 'claude' | 'model' | 'nous' | 'provider' | 'status'

async function nousModel(): Promise<string> {
  const saved = readNousModel()

  if (saved) {
    return saved
  }

  const recommended = (await getRecommendedDefaultModel('nous').catch(() => null)) as { model?: string } | null

  return recommended?.model ?? ''
}

function CommandRow({ command, label }: { command: string; label: string }) {
  const e = useI18n().t.settings.engine
  const [copied, setCopied] = useState(false)

  return (
    <SettingRow
      control={
        <Button
          onClick={() => {
            void navigator.clipboard?.writeText(command)
            setCopied(true)
          }}
          size="sm"
          variant="outline"
        >
          <Copy className="size-3.5" />
          {copied ? e.copied : e.copy}
        </Button>
      }
      hint={<code className="font-mono text-xs">{command}</code>}
      title={label}
    />
  )
}

export function EngineSettings() {
  const e = useI18n().t.settings.engine
  const bridge = window.hermesDesktop?.icloneClaudeCode
  const navigate = useOptionalNavigate()
  const [status, setStatus] = useState<ClaudeCodeStatus | null>(null)
  const [main, setMain] = useState<EngineTarget | null>(null)
  const [busy, setBusy] = useState(false)
  // A refused switch is told on the row that asked for it (four rows can start one).
  const [error, setError] = useState<{ row: EngineRow; text: string } | null>(null)
  const [pending, setPending] = useState<{ row: EngineRow; target: EngineTarget } | null>(null)
  // The Status section is never silent: every check ends in a stamp or a reason.
  const [checking, setChecking] = useState(false)
  const [checkedAt, setCheckedAt] = useState<null | number>(null)
  // A failed read is said in the catalogue's words only — never the bridge's own message (S27.1).
  const [statusFailed, setStatusFailed] = useState(false)

  const refresh = useCallback(
    async (force = false) => {
      setChecking(true)

      const read: Promise<ClaudeCodeStatus | null> = bridge
        ? bridge.status(force).catch(() => null)
        : Promise.resolve(null)

      try {
        const [s, info, config] = await Promise.all([
          read,
          getGlobalModelInfo().catch(() => null),
          getHermesConfigRecord().catch(() => null)
        ])

        const baseUrl = endpointOf(config)

        if (s) {
          setStatus(s)
        }

        setStatusFailed(!s)

        setMain(info ? { model: info.model, provider: info.provider, ...(baseUrl ? { baseUrl } : {}) } : null)
        setCheckedAt(Date.now())
      } finally {
        setChecking(false)
      }
    },
    [bridge]
  )

  useEffect(() => {
    void refresh(true)
  }, [refresh])

  const onClaude = main?.provider === ENGINE_PROVIDER
  const state = engineState(status)
  const recorded = status?.fallbackTarget ?? null
  // Additive: a provider from Settings → Model is shown as it is, and Claude Code returns to it.
  const other = main?.provider && main.provider !== 'nous' && !onClaude ? main : null
  const previous = other ?? (onClaude && recorded && recorded.provider !== 'nous' ? recorded : null)

  /** One engine switch; true when the engine is now `target`. A confirm step or a refusal returns false. */
  const choose = async (row: EngineRow, target: EngineTarget | null, confirmed = false): Promise<boolean> => {
    setBusy(true)
    setError(null)
    setPending(null)

    try {
      const next = target ?? engineSelection('nous', await nousModel())

      if (next.provider === ENGINE_PROVIDER) {
        if (main?.provider === 'nous' && main.model) {
          writeNousModel(main.model)
        }

        await bridge?.setFallback(returnTarget(main, recorded) ?? engineSelection('nous', await nousModel()))
      }

      const result = await switchEngine(next, confirmed)

      if (result.ok) {
        await refresh()

        return true
      }

      if ('confirm' in result) {
        setPending({ row, target: next })
      } else {
        setError({ row, text: switchFailure(result.reason, e) })
      }
    } catch {
      setError({ row, text: e.switchFailed })
    } finally {
      setBusy(false)
    }

    return false
  }

  /** The landing the iNFT setup's "ask the agent" uses: a new chat with the composer focused. Nothing is sent. */
  const openChat = () => {
    setMsgView('chat')
    navigate?.(NEW_CHAT_ROUTE)
    requestComposerFocus('main')
  }

  /** The one-click path: Claude Code becomes the engine if it is not yet, then the chat opens. A refusal is told on
   *  the status row that asked; a confirm step, once confirmed, carries on into the chat. */
  const start = async () => {
    if (
      !onClaude &&
      !(await choose(
        'status',
        engineSelection(
          'claude',
          main?.model && CLAUDE_MODELS.some(m => m.id === main.model) ? main.model : CLAUDE_MODELS[0].id
        )
      ))
    ) {
      return
    }

    openChat()
  }

  const activePill = <Pill tone="primary">{e.active}</Pill>
  const errorOn = (row: EngineRow) => (error?.row === row ? error.text : undefined)

  return (
    <SettingsContent>
      <SettingsSection icon={Cpu} title={e.title}>
        <SettingRow
          control={
            main?.provider === 'nous' ? (
              activePill
            ) : (
              <Button disabled={busy} onClick={() => void choose('nous', null)} size="sm" variant="outline">
                {e.use}
              </Button>
            )
          }
          error={errorOn('nous')}
          hint={e.nousDescription}
          title={e.nousTitle}
        />
        {previous && (
          <div data-engine-row="provider">
            <SettingRow
              control={
                previous === other ? (
                  activePill
                ) : (
                  <Button disabled={busy} onClick={() => void choose('provider', previous)} size="sm" variant="outline">
                    {e.use}
                  </Button>
                )
              }
              error={errorOn('provider')}
              hint={e.otherDescription(previous.model)}
              title={e.otherTitle(engineLabel(previous.provider))}
            />
          </div>
        )}
        <SettingRow
          control={
            onClaude ? (
              activePill
            ) : (
              <Tip label={state !== 'ready' ? e.notReadyHint : undefined}>
                <span className="inline-flex">
                  <Button
                    className="disabled:pointer-events-none"
                    disabled={busy || state !== 'ready'}
                    onClick={() => void choose('claude', engineSelection('claude', CLAUDE_MODELS[0].id))}
                    size="sm"
                    variant="outline"
                  >
                    {e.use}
                  </Button>
                </span>
              </Tip>
            )
          }
          error={errorOn('claude')}
          hint={e.claudeDescription}
          title={e.claudeTitle}
        />
        {onClaude && (
          // A three-way segment is a field, not a compact control: it drops under the title wherever the row is
          // too narrow to give the sentence its width (large text), instead of squeezing the title.
          <SettingRow
            control={
              <div className="flex flex-wrap gap-1">
                {CLAUDE_MODELS.map(m => (
                  <Button
                    disabled={busy}
                    key={m.id}
                    onClick={() => void choose('model', engineSelection('claude', m.id))}
                    size="sm"
                    variant={main?.model === m.id ? 'default' : 'outline'}
                  >
                    {m.label}
                  </Button>
                ))}
              </div>
            }
            error={errorOn('model')}
            field
            title={e.model}
          />
        )}
        {pending && (
          <div data-engine-confirm="">
            <SettingRow
              control={
                <div className="flex gap-1">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void choose(pending.row, pending.target, true).then(
                        ok => ok && pending.row === 'status' && openChat()
                      )
                    }
                    size="sm"
                    variant="outline"
                  >
                    {e.confirm}
                  </Button>
                  <Button disabled={busy} onClick={() => setPending(null)} size="sm" variant="ghost">
                    {e.cancel}
                  </Button>
                </div>
              }
              hint={e.confirmFallback}
              title={e.confirmTitle}
            />
          </div>
        )}
      </SettingsSection>

      <SettingsSection icon={Cpu} title={e.statusTitle}>
        <div data-engine-state={state}>
          <SettingRow
            control={
              <div className="flex gap-1">
                {state === 'ready' && (
                  <Button data-engine-start="" disabled={busy} onClick={() => void start()} size="sm">
                    <MessageCircle className="size-3.5" />
                    {e.start}
                  </Button>
                )}
                <Button
                  data-engine-recheck=""
                  disabled={busy || checking}
                  onClick={() => void refresh(true)}
                  size="sm"
                  variant="ghost"
                >
                  <RefreshCw className={checking ? 'size-3.5 animate-spin' : 'size-3.5'} />
                  {checking ? e.rechecking : e.recheck}
                </Button>
              </div>
            }
            error={
              errorOn('status') ??
              (statusFailed && status ? <span data-engine-status-error="">{e.statusUnavailable}</span> : undefined)
            }
            hint={[
              state === 'ready' ? e.startDescription : '',
              state === 'ready' && status?.version ? e.version(status.version) : '',
              windowLine(status?.window ?? null, e),
              checkedAt ? e.checkedAt(clockOf(checkedAt)) : ''
            ]
              .filter(Boolean)
              .join(' · ')}
            title={statusFailed && !status ? e.statusUnavailable : statusLine(status, e)}
          />
        </div>
        {state === 'not-installed' && <CommandRow command={INSTALL_COMMAND} label={e.installHelp} />}
        {(state === 'not-installed' || state === 'not-logged-in') && (
          <CommandRow command={LOGIN_COMMAND} label={e.loginHelp} />
        )}
        <SettingRow hint={e.privacy} title={e.privacyTitle} />
      </SettingsSection>
    </SettingsContent>
  )
}
