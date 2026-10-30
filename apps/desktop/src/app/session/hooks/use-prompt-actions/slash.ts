import { skillInvocationText } from '@hermes/shared'
import { type MutableRefObject, useCallback } from 'react'

import { getProfiles } from '@/hermes'
import { type Translations, useI18n } from '@/i18n'
import { errorMessage } from '@/iclone-shared/errors'
import { NO_UPLOAD_SLASH_TEXT, uploadsDiagnostics } from '@/iclone-shared/no-upload'
import type { ChatMessage } from '@/lib/chat-messages'
import { parseCommandDispatch, parseSlashCommand, sessionTitle } from '@/lib/chat-runtime'
import {
  type CommandsCatalogLike,
  type DesktopActionId,
  type DesktopCommandSurface,
  type DesktopPickerId,
  desktopSlashTerminalOnlyMessage,
  desktopSlashUnavailableMessage,
  isDesktopSlashCommand,
  resolveDesktopCommand
} from '@/lib/desktop-slash-commands'
import { isFencedBackendCommand } from '@/lib/desktop-slash-fence'
import { isMissingRpcMethod } from '@/lib/gateway-rpc'
import { noteSessionLost } from '@/lib/provider-block'
import { cachedSlashCompletion, peekCachedSlashCompletion } from '@/lib/slash-completion-cache'
import { setComposerDraft } from '@/store/composer'
import { enqueueQueuedPrompt } from '@/store/composer-queue'
import { applyGoalStatusText } from '@/store/goals'
import { notify, notifyError } from '@/store/notifications'
import {
  $activeGatewayProfile,
  $newChatProfile,
  captureNewChatSource,
  ensureGatewayProfile,
  normalizeProfileKey
} from '@/store/profile'
import { requestSendDiagnostics } from '@/store/send-diagnostics'
import {
  $connection,
  $sessions,
  resolveComposerSessionKey,
  setActiveSessionId,
  setModelPickerOpen,
  setSessionPickerOpen,
  setSessions
} from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import {
  applyWakeStartResult,
  applyWakeStatus,
  applyWakeStopResult,
  MICROPHONE_OFF_NOTICE,
  microphoneSwitchedOff,
  type WakeInputDeviceStatus,
  type WakeStartResponse,
  type WakeStatusResponse,
  type WakeStopResponse
} from '@/store/wake-word'

import type { BrowserManageResponse, ClientSessionState, SessionTitleResponse, SlashExecResponse } from '../../../types'
import { compactionEntry } from '../../compact/compact-store'
import {
  compactNoticeId,
  presentCompactionOutcome,
  presentCompactionProgress,
  presentCompactionStart
} from '../../compact/present-compaction'
import { runCompaction } from '../../compact/run-compaction'

import { resolveTargetSessionId } from './resolve-target-session'
import { renderSkillsList } from './skills-list'
import {
  type GatewayRequest,
  isSessionIdCandidate,
  isSessionNotFoundError,
  isTargetSessionBusy,
  renderCommandsCatalog,
  renderRpcResult,
  slashStatusText,
  type SubmitTextOptions,
  withSessionNotFoundResume
} from './utils'

const WAKE_START_TIMEOUT_MS = 180_000

const wakeDeviceLabel = (device?: WakeInputDeviceStatus): string => {
  if (!device) {
    return 'system default'
  }

  const selector = device.selector
  const name = device.name?.trim() || (selector == null ? 'system default' : String(selector))

  return device.hostapi?.trim() ? `${name} (${device.hostapi.trim()})` : name
}

const renderWakeStatus = (status: WakeStatusResponse): string => {
  const lines = [
    'Wake Word Status',
    `State: ${status.listening ? 'LISTENING' : 'OFF'}`,
    `Phrase: "${status.phrase?.trim() || 'hey hermes'}"`,
    `Provider: ${status.provider?.trim() || 'unknown'}`,
    `Surface: ${status.owner_surface?.trim() || status.configured_surface?.trim() || 'auto'}`,
    `Input: ${wakeDeviceLabel(status.input_device)}`
  ]

  if (status.audio_silent) {
    lines.push('Audio: silent')
  }

  if (status.input_device?.error?.trim()) {
    lines.push(`Input error: ${status.input_device.error.trim()}`)
  }

  if (status.hint?.trim()) {
    lines.push(`Hint: ${status.hint.trim()}`)
  }

  return lines.join('\n')
}

/** Everything a slash handler needs about the invocation it's serving. */
interface SlashActionCtx {
  arg: string
  command: string
  name: string
  recordInput: boolean
  sessionHint?: string
}

interface SlashCommandDeps {
  activeSessionIdRef: MutableRefObject<string | null>
  appendSessionTextMessage: (
    sessionId: string,
    role: ChatMessage['role'],
    text: string,
    storedSessionId?: string | null
  ) => void
  branchCurrentSession: () => Promise<boolean>
  busyRef: MutableRefObject<boolean>
  copy: Translations['desktop']
  createBackendSessionForSend: (preview?: string | null) => Promise<string | null>
  getRoutedStoredSessionId: () => null | string
  getRuntimeIdForStoredSession: (storedSessionId: string) => null | string
  handleSkinCommand: (arg: string) => string
  handoffSession: (
    platform: string,
    options?: { onProgress?: (state: string) => void; sessionId?: string }
  ) => Promise<{ ok: boolean; error?: string }>
  openMemoryGraph: () => void
  refreshSessions: () => Promise<void>
  requestGateway: GatewayRequest
  resumeStoredSession: (storedSessionId: string) => Promise<void> | void
  selectedStoredSessionIdRef: MutableRefObject<string | null>
  startFreshSessionDraft: () => void
  submitPromptText: (rawText: string, options?: SubmitTextOptions) => Promise<boolean>
  updateSessionState: (
    sessionId: string,
    updater: (state: ClientSessionState) => ClientSessionState,
    storedSessionId?: string | null
  ) => ClientSessionState
}

/** The /slash command dispatcher, extracted from usePromptActions. */
export function useSlashCommand(deps: SlashCommandDeps) {
  const {
    activeSessionIdRef,
    appendSessionTextMessage,
    branchCurrentSession,
    busyRef,
    copy,
    createBackendSessionForSend,
    getRoutedStoredSessionId,
    getRuntimeIdForStoredSession,
    handleSkinCommand,
    handoffSession,
    openMemoryGraph,
    refreshSessions,
    requestGateway,
    resumeStoredSession,
    selectedStoredSessionIdRef,
    startFreshSessionDraft,
    submitPromptText,
    updateSessionState
  } = deps

  // V3-B: the /skills list speaks the slash domain; the dispatcher's own copy stays the desktop block.
  const slashCopy = useI18n().t.slash

  return useCallback(
    async (rawCommand: string, options?: { sessionId?: string; recordInput?: boolean }) => {
      // Resolve the session this command targets through the SHARED ladder that
      // submit.ts uses. A slash command runs backend commands against a runtime
      // session, and per-session state (`/goal`, `/usage`, `/status`) is keyed by
      // that id — so resolving it differently than submit would run the command
      // against a different session than the user's chat. The old bare
      // `hint || activeRef || createSession()` did exactly that: with the runtime
      // binding momentarily absent (profile swap, reconnect, orphan-reap,
      // timeout) it minted a NEW session, so `/goal status` reported "No active
      // goal" for a goal that was live on the real chat.
      const ensureSessionId = async (sessionHint?: string, preview?: null | string) =>
        resolveTargetSessionId({
          activeRuntimeId: activeSessionIdRef.current,
          createSession: () => createBackendSessionForSend(preview),
          explicitRuntimeId: sessionHint,
          getRuntimeIdForStoredSession,
          requestGateway,
          routedStoredSessionId: getRoutedStoredSessionId(),
          selectedStoredSessionId: selectedStoredSessionIdRef.current
        })

      // Resolve the target session plus a writer for inline slash output, or
      // notify + return null when none can be created. Folds the ensure / bail /
      // build-renderSlashOutput boilerplate every exec-style handler repeats.
      const withSlashOutput = async (
        ctx: SlashActionCtx
      ): Promise<{ render: (text: string) => void; sessionId: string; storedSessionId: string | null } | null> => {
        // A slash on a fresh draft creates the backend session; seed the
        // sidebar preview with the typed command so the row doesn't sit as
        // "Untitled session" (auto-title only fires after a full exchange,
        // which a bare exec command never produces).
        const sessionId = await ensureSessionId(ctx.sessionHint, ctx.command)

        if (!sessionId) {
          notify({ kind: 'error', title: copy.sessionUnavailable, message: copy.createSessionFailed })

          return null
        }

        // Bind output to the TARGET session's own stored id, snapshotted now so
        // a command that outlives a session switch still lands on the right
        // chat. NOT the foreground selection: a tile (⌘T tab, split) runs its
        // slash commands through this hook with an explicit runtime id while
        // the selection names a different conversation, and passing that down
        // to updateSessionState re-keyed the tile's cache entry onto the
        // primary's stored session. Fall back to the selection only for a
        // session with no published state yet (a draft this call just created).
        const storedSessionId = $sessionStates.get()[sessionId]?.storedSessionId ?? selectedStoredSessionIdRef.current

        // Header carries the command token only. The full invocation would
        // duplicate long args — `/goal <prose>` echoed the whole goal in the
        // mono header, then again in the backend notice right under it.
        const render = (text: string) =>
          appendSessionTextMessage(
            sessionId,
            'system',
            ctx.recordInput ? slashStatusText(`/${ctx.name}`, text) : text,
            storedSessionId
          )

        return { render, sessionId, storedSessionId }
      }

      // `exec` commands (and unknown skill / quick commands the backend owns)
      // run on the gateway and render their text output inline. This is the only
      // path that talks to slash.exec / command.dispatch.
      async function runExec(ctx: SlashActionCtx): Promise<void> {
        const { arg, command, name } = ctx
        const resolved = await withSlashOutput(ctx)

        if (!resolved) {
          return
        }

        const { render: renderSlashOutput, sessionId, storedSessionId } = resolved

        // Ruling 47 (V3-FX M3): a command that would make the runtime upload diagnostics or logs never leaves the
        // desktop, whatever route reached here (an alias, a catalog entry, a typed command).
        if (uploadsDiagnostics(name, arg)) {
          renderSlashOutput(NO_UPLOAD_SLASH_TEXT)
          requestSendDiagnostics()

          return
        }

        if (!isDesktopSlashCommand(name)) {
          renderSlashOutput(desktopSlashUnavailableMessage(name) || `/${name} is not available in the desktop app.`)

          return
        }

        // V3-B: a categorised backend verb the desktop has no row for (the runtime's terminal-only commands) never
        // reaches the slash worker. The catalog is the fence's only source of names, so the fence fails CLOSED
        // (F4): a command with no desktop row waits for the catalog — fetched here when the popover has not yet,
        // served from the same cache otherwise — and is not sent at all when the catalog cannot be read. A pasted
        // or queued terminal-only verb on a cold cache therefore never slips through.
        if (!resolveDesktopCommand(`/${name}`)) {
          let catalog = peekCachedSlashCompletion<CommandsCatalogLike>('catalog') ?? null

          if (!catalog) {
            try {
              catalog = await cachedSlashCompletion('catalog', () =>
                requestGateway<CommandsCatalogLike>('commands.catalog')
              )
            } catch {
              renderSlashOutput(slashCopy.catalogUnavailable(`/${name}`))

              return
            }
          }

          if (isFencedBackendCommand(name, catalog)) {
            renderSlashOutput(desktopSlashTerminalOnlyMessage(name))

            return
          }
        }

        let slashExecError: unknown = null

        const handleDispatch = async (
          dispatch: NonNullable<ReturnType<typeof parseCommandDispatch>>
        ): Promise<void> => {
          if (dispatch.type === 'exec' || dispatch.type === 'plugin') {
            // `/goal clear|pause|resume|status` can come back as a TYPED exec
            // dispatch (command.dispatch routing) instead of the plain-output
            // shape handled below. This branch used to render and return
            // without touching the goal store, so "✓ Goal cleared." printed
            // while the stale "Goal paused" card kept showing until the chat
            // was reopened (#80348). Mirror the output into the store exactly
            // like the plain-output path does.
            if (name === 'goal' && dispatch.output) {
              applyGoalStatusText(sessionId, dispatch.output)
            }

            renderSlashOutput(dispatch.output ?? '(no output)')

            return
          }

          if (dispatch.type === 'alias') {
            await runSlash(`/${dispatch.target}${arg ? ` ${arg}` : ''}`, sessionId, false)

            return
          }

          // send / prefill carry an optional `notice` (e.g. "⊙ Goal set …")
          // that the backend wants shown as a system line before the message
          // is acted on. Mirrors the TUI's createSlashHandler — without it a
          // `/goal <text>` looked like it did nothing.
          if ((dispatch.type === 'send' || dispatch.type === 'prefill') && dispatch.notice?.trim()) {
            renderSlashOutput(dispatch.notice.trim())

            // `/goal <text>` returns its "⊙ Goal set …" notice here and kicks
            // off the first turn immediately; the backend only emits a
            // `status.update kind:"goal"` after that turn's post-turn judge
            // runs. Seed the goal store from the notice so the indicator shows
            // the active goal right away instead of after the first turn.
            if (name === 'goal') {
              applyGoalStatusText(sessionId, dispatch.notice.trim())
            }
          }

          const message = ('message' in dispatch ? dispatch.message : '')?.trim() ?? ''

          // /undo returns a prefill directive: drop the backed-up message into
          // the composer for editing instead of submitting it immediately.
          if (dispatch.type === 'prefill') {
            if (message) {
              setComposerDraft(message)
            }

            return
          }

          if (!message) {
            renderSlashOutput(
              `/${name}: ${dispatch.type === 'skill' ? 'skill payload missing message' : 'empty message'}`
            )

            return
          }

          // A skill/bundle dispatch's `message` is the expanded skill body —
          // model-facing scaffolding. Never render it; the bubble shows the
          // invocation the gateway projected, or one read from the payload
          // when the backend is older than this app.
          const projected = 'display' in dispatch ? dispatch.display?.trim() : ''
          const displayText = projected || skillInvocationText(message) || undefined

          // Gate on the TARGET session's own busy state, not the foreground
          // view's — see isTargetSessionBusy. `busyRef` mirrors whatever chat
          // is on screen, while this command runs against the session
          // resolveTargetSessionId picked, routinely a different one.
          if (isTargetSessionBusy($sessionStates.get(), sessionId, busyRef.current)) {
            // The backend already executed the command — for `/goal <text>`
            // the goal is set and `message` is its kickoff prompt. Dropping
            // it here loses the kickoff silently (the goal exists but the
            // agent never hears about it, #63352). Queue it on the composer
            // queue instead: it fires when the running turn settles, and the
            // queue panel above the composer shows it in the meantime.
            //
            // Park it on the same stored session the output writer is bound to
            // rather than re-reading the globals here — a session switch between
            // dispatch and this branch would otherwise queue the kickoff on
            // whichever chat is now in front.
            const queueKey = resolveComposerSessionKey(storedSessionId, $sessions.get()) || storedSessionId || sessionId

            if (enqueueQueuedPrompt(queueKey, { attachments: [], text: message, displayText })) {
              renderSlashOutput('session busy — message queued to send when the current turn finishes')
            } else {
              renderSlashOutput('session busy — /interrupt the current turn before sending this command')
            }

            return
          }

          // Submit into the session this command was resolved against — the
          // same pair the output writer and the busy gate above already use.
          // Bare `submitPromptText(message)` let submit re-resolve from
          // `activeSessionIdRef`, which names the FOREGROUND chat: a `/work`
          // typed into a fresh ⌘T tab loaded the skill in that tab, then fired
          // its kickoff as a user message into whatever conversation was on
          // screen. Every other target the dispatcher serves (tile, background
          // queue drain, a session created by this very call) had the same leak.
          await submitPromptText(message, { sessionId, storedSessionId, displayText })
        }

        let execAttempts = 0

        try {
          // A reaped runtime session ("not in memory" → 4001) is resumed once
          // and the command retried once, like prompt.submit.
          const { result } = await withSessionNotFoundResume(
            sessionId,
            storedSessionId,
            liveId => {
              execAttempts += 1

              return requestGateway<unknown>('slash.exec', {
                session_id: liveId,
                command: command.replace(/^\/+/, '')
              })
            },
            { requestGateway }
          )

          const dispatch = parseCommandDispatch(result)

          if (dispatch) {
            await handleDispatch(dispatch)

            return
          }

          const output = result && typeof result === 'object' ? (result as SlashExecResponse) : null
          const body = output?.output || `/${name}: no output`

          // `/goal status|pause|resume|clear` come back as plain exec output
          // ("⊙ Goal (active, 3/20 turns): …", "⏸ Goal paused: …", "✓ Goal
          // cleared." …). Mirror it into the goal store so the composer
          // indicator tracks pause/resume/clear immediately.
          if (name === 'goal' && output?.output) {
            applyGoalStatusText(sessionId, output.output)
          }

          renderSlashOutput(output?.warning ? `warning: ${output.warning}\n${body}` : body)

          return
        } catch (error) {
          // Failed again after the resume (or the resume itself failed): the
          // runtime lost this session — the banner says "reconnecting".
          if (execAttempts > 1 || isSessionNotFoundError(error)) {
            noteSessionLost()
          }

          // Fall back to command.dispatch for skill/send/alias directives, but
          // keep the worker error: a slash.exec worker timeout/crash is the real
          // failure, not the "not a quick/plugin/skill command" routing noise.
          slashExecError = error
        }

        try {
          const dispatch = parseCommandDispatch(
            await requestGateway<unknown>('command.dispatch', { session_id: sessionId, name, arg })
          )

          if (!dispatch) {
            renderSlashOutput('error: invalid response: command.dispatch')

            return
          }

          await handleDispatch(dispatch)
        } catch (err) {
          // "not a quick/plugin/skill command" just means the fallback had
          // nothing to add — the slash.exec failure (worker timeout, crash) is
          // the real error, so don't bury it under the routing noise.
          const dispatchMessage = errorMessage(err)

          if (slashExecError && /not a quick\/plugin\/skill command/i.test(dispatchMessage)) {
            const original = errorMessage(slashExecError)
            renderSlashOutput(`error: /${name} failed: ${original}`)

            return
          }

          renderSlashOutput(`error: ${dispatchMessage}`)
        }
      }

      // `rpc` commands have a dedicated gateway handler — skip slash.exec /
      // command.dispatch entirely. The response is structured (a JSON RPC
      // reply, not an inline text stream) so we render it via the generic
      // `renderRpcResult` shaper that knows the field conventions shared by
      // session.save / session.status / session.usage / session.steer /
      // process.stop / agents.list.
      async function runRpc(
        surface: Extract<DesktopCommandSurface, { kind: 'rpc' }>,
        ctx: SlashActionCtx
      ): Promise<void> {
        const resolved = await withSlashOutput(ctx)

        if (!resolved) {
          return
        }

        const { render: renderSlashOutput, sessionId } = resolved

        try {
          const params = surface.buildParams({
            arg: ctx.arg,
            command: ctx.command,
            name: ctx.name,
            sessionId
          })

          // Forward the surface's declared timeout when present; the default
          // requestGateway layer keeps (30s) is too tight for RPCs that do
          // real work.
          const result = await requestGateway<unknown>(surface.rpc, params, surface.timeoutMs)
          const body = renderRpcResult(result, ctx.name)

          renderSlashOutput(body || `/${ctx.name}: no output`)
        } catch (err) {
          // TODO: remove this compatibility fallback once every supported
          // managed runtime exposes the dedicated RPC surface. Desktop and its
          // gateway update independently; older gateways still support the
          // slash-worker route.
          if (isMissingRpcMethod(err)) {
            await runExec(ctx)

            return
          }

          renderSlashOutput(`error: ${errorMessage(err)}`)
        }
      }

      // One handler per `action` command. Adding a desktop-native command is a
      // registry row in desktop-slash-commands.ts plus an entry here — never a
      // new branch in a dispatch ladder.
      const actionHandlers: Record<DesktopActionId, (ctx: SlashActionCtx) => Promise<void>> = {
        new: async () => {
          startFreshSessionDraft()
        },
        branch: async () => {
          await branchCurrentSession()
        },
        // /compress (alias /compact) runs the gateway's dedicated
        // session.compress RPC — the TUI's path
        // (ui-tui/src/app/slash/commands/session.ts). It must NOT go through
        // runExec: compressing a large session outlives the slash worker's pipe
        // timeout (45s) and the desktop's 30s WS default, and the resulting
        // slash.exec error cascaded into command.dispatch's misleading "not a
        // quick/plugin/skill command: compress" (#44456). The Compact button
        // routes through here as well, so every surface shares one engine.
        compress: async ctx => {
          const resolved = await withSlashOutput(ctx)

          if (!resolved) {
            return
          }

          const { render, sessionId, storedSessionId } = resolved
          const focusTopic = ctx.arg.trim()

          // Coalesce: a compaction of this session already in flight (double
          // enter, button + slash) must not fire a second LLM summarise call.
          if (compactionEntry(sessionId)?.phase === 'running') {
            return
          }

          presentCompactionStart(sessionId, focusTopic)

          const outcome = await runCompaction(
            {
              isActiveSession: id => activeSessionIdRef.current === id,
              onProgress: text => presentCompactionProgress(sessionId, text),
              onRecovered: (initialId, recoveredId) => {
                if (activeSessionIdRef.current === initialId) {
                  activeSessionIdRef.current = recoveredId
                  setActiveSessionId(recoveredId)
                }
              },
              requestGateway,
              updateSessionState
            },
            { focusTopic, sessionId, storedSessionId }
          )

          if (!outcome) {
            return
          }

          presentCompactionOutcome(outcome, compactNoticeId(sessionId), render)

          // Desktop and gateway runtimes update independently. Preserve the
          // historical slash-worker path for an older gateway that has not
          // shipped session.compress yet; it cannot offer the longer RPC
          // timeout, but it must not turn a once-working command into an
          // immediate "method not found" error.
          if (outcome.kind === 'unsupported') {
            await runExec(ctx)
          }
        },
        // V3-F: /permissions (and the retired /yolo, /approvals) opens the mode picker; the mode changes only
        // from the user's own click there.
        permissions: async () => {
          window.dispatchEvent(new CustomEvent('hermes:open-permissions'))
        },
        // /wake must stay in the gateway process that owns the Desktop wake
        // lease. Sending it through slash.exec creates a separate HermesCLI in
        // the slash worker, which can claim the machine-wide microphone lock
        // while the Desktop UI still reports the GUI listener as off.
        wake: async ctx => {
          const resolved = await withSlashOutput(ctx)

          if (!resolved) {
            return
          }

          const { render: renderSlashOutput } = resolved
          const requested = ctx.arg.trim().toLowerCase()

          if (requested && !['on', 'off', 'status'].includes(requested)) {
            renderSlashOutput('usage: /wake [on|off|status]')

            return
          }

          const status = async (): Promise<WakeStatusResponse> => {
            const current = await requestGateway<WakeStatusResponse>('wake.status', {
              client_capture: true,
              surface: 'gui'
            })

            applyWakeStatus(current)

            return current
          }

          try {
            let action = requested

            // Bare /wake is an authoritative toggle. Query the gateway instead
            // of trusting a potentially stale renderer cache.
            if (!action) {
              action = (await status()).listening ? 'off' : 'on'
            }

            if (action === 'on') {
              // FX-4: the microphone switch OFF (Settings › Privacy) — never ask the backend to arm.
              if (await microphoneSwitchedOff()) {
                renderSlashOutput(`Failed to start wake word: ${MICROPHONE_OFF_NOTICE}`)

                return
              }

              const started = await requestGateway<WakeStartResponse>(
                'wake.start',
                { persist: true, surface: 'gui', client_capture: true },
                WAKE_START_TIMEOUT_MS
              )

              applyWakeStartResult(started)

              if (!started?.started) {
                renderSlashOutput(
                  `Failed to start wake word: ${started?.hint?.trim() || started?.reason?.trim() || 'unknown error'}`
                )

                return
              }
            } else if (action === 'off') {
              applyWakeStopResult(await requestGateway<WakeStopResponse>('wake.stop', { persist: true }))
            }

            renderSlashOutput(renderWakeStatus(await status()))
          } catch (err) {
            renderSlashOutput(`error: ${errorMessage(err)}`)
          }
        },
        // /handoff hands this session to a messaging platform. The platform is
        // completed inline in the slash popover (backend _handoff_completions),
        // so there is no overlay: `/handoff <platform>` runs the desktop's own
        // handoff RPC. cli_only on the backend, so it must not reach slash.exec.
        handoff: async ({ arg, command, recordInput, sessionHint }) => {
          const platform = arg.trim()

          if (!platform) {
            notify({ kind: 'success', message: copy.handoff.pickPlatform })

            return
          }

          const sid = sessionHint || activeSessionIdRef.current

          if (!sid) {
            notify({ kind: 'error', title: copy.sessionUnavailable, message: copy.createSessionFailed })

            return
          }

          const result = await handoffSession(platform, { sessionId: sid })

          if (!result.ok && result.error) {
            appendSessionTextMessage(sid, 'system', recordInput ? slashStatusText(command, result.error) : result.error)
          }
        },
        // /profile selects which profile new chats open in — no app relaunch.
        // A profile is per-session now, so an existing thread can't change its
        // profile mid-stream; `/profile <name>` points the next new chat (and
        // the current empty draft) at that profile's backend.
        profile: async ({ arg }) => {
          const target = arg.trim()
          const current = normalizeProfileKey($activeGatewayProfile.get())

          if (!target) {
            notify({ kind: 'success', message: copy.profileStatus(current) })

            return
          }

          try {
            const { profiles } = await getProfiles()
            const match = profiles.find(profile => profile.name === target)

            if (!match) {
              notify({
                kind: 'error',
                title: copy.unknownProfile,
                message: copy.noProfileNamed(target, profiles.map(profile => profile.name).join(', '))
              })

              return
            }

            const key = normalizeProfileKey(match.name)

            $newChatProfile.set(key)
            await ensureGatewayProfile(key)
            // Capture the source the swap landed on (null on the v1 profile path)
            // so the draft's owner matches the socket that will mint it.
            captureNewChatSource()
            notify({ kind: 'success', message: copy.newChatsProfile(match.name) })
          } catch (err) {
            notifyError(err, copy.setProfileFailed)
          }
        },
        skin: async ({ arg, command, recordInput, sessionHint }) => {
          const sid = sessionHint || activeSessionIdRef.current
          const message = handleSkinCommand(arg)

          // No session to print into yet — surface it as a toast instead of
          // spinning up a backend session just to change the theme.
          if (!sid) {
            notify({ kind: 'success', message })

            return
          }

          appendSessionTextMessage(sid, 'system', recordInput ? slashStatusText(command, message) : message)
        },
        // /title <name> renames via the gateway's session.title RPC — the same
        // path the TUI uses, NOT REST renameSession (which 404s on runtime ids)
        // nor the slash worker (whose DB write can silently fail). Bare /title
        // shows the current title, which the worker owns, so delegate to exec.
        title: async ctx => {
          if (!ctx.arg) {
            await runExec(ctx)

            return
          }

          const resolved = await withSlashOutput(ctx)

          if (!resolved) {
            return
          }

          const { render: renderSlashOutput, sessionId } = resolved
          const { arg } = ctx

          try {
            const result = await requestGateway<SessionTitleResponse>('session.title', {
              session_id: sessionId,
              title: arg
            })

            const finalTitle = (result?.title || arg).trim()
            const queued = result?.pending === true

            setSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, title: finalTitle || null } : s)))
            await refreshSessions().catch(() => undefined)
            renderSlashOutput(
              finalTitle
                ? `Session title set: ${finalTitle}${queued ? ' (queued while session initializes)' : ''}`
                : 'Session title cleared.'
            )
          } catch (err) {
            renderSlashOutput(`error: ${errorMessage(err)}`)
          }
        },
        help: async ctx => {
          const resolved = await withSlashOutput(ctx)

          if (!resolved) {
            return
          }

          const { render: renderSlashOutput, sessionId } = resolved

          try {
            const catalog = await requestGateway<CommandsCatalogLike>('commands.catalog', { session_id: sessionId })

            renderSlashOutput(renderCommandsCatalog(catalog, copy))
          } catch (err) {
            renderSlashOutput(`error: ${errorMessage(err)}`)
          }
        },
        // V3-B: /skills — the bundle catalog (with the port facts of the owner's skills, evaluated on this host by
        // the main process) plus the backend's skill commands, grouped, one line each. Read-only; no RPC but the
        // catalog the popover already uses.
        skills: async ctx => {
          const resolved = await withSlashOutput(ctx)

          if (!resolved) {
            return
          }

          const { render: renderSlashOutput, sessionId } = resolved

          try {
            const [catalog, iclone] = await Promise.all([
              requestGateway<CommandsCatalogLike>('commands.catalog', { session_id: sessionId }),
              window.hermesDesktop?.icloneSkills?.catalog?.().catch(() => null) ?? Promise.resolve(null)
            ])

            renderSlashOutput(renderSkillsList({ catalog, iclone, copy: slashCopy }))
          } catch (err) {
            renderSlashOutput(`error: ${errorMessage(err)}`)
          }
        },
        // /journey (aliases /learning, /memory-graph) opens the memory graph
        // overlay — the desktop's visual counterpart of the TUI journey
        // timeline — instead of printing a text rendering into the transcript.
        // Args are ignored, matching the TUI overlay behavior.
        journey: async () => {
          openMemoryGraph()
        },
        // Ruling 47 (V3-FX M3): /debug (any argument) opens the local diagnostics report, saved to a file the owner
        // chooses. The runtime's upload (/debug, /debug nous) is never reached from here.
        diagnostics: async () => {
          requestSendDiagnostics()
        },
        // /browser connect|disconnect|status manages the live CDP connection on
        // the gateway host, mirroring the TUI's browser.manage RPC. It mutates
        // BROWSER_CDP_URL (and may launch Chrome) in the gateway process — only
        // meaningful when that process runs on this machine, so it's gated to
        // local connections. A remote gateway would act on the wrong host.
        browser: async ctx => {
          const resolved = await withSlashOutput(ctx)

          if (!resolved) {
            return
          }

          const { render: renderSlashOutput, sessionId } = resolved

          if ($connection.get()?.mode === 'remote') {
            renderSlashOutput(
              '/browser manages a Chromium-family browser on the gateway host — only available when connected to a local gateway.'
            )

            return
          }

          const [rawAction = 'status', ...rest] = ctx.arg.trim().split(/\s+/).filter(Boolean)
          const cmdAction = rawAction.toLowerCase()

          if (!['connect', 'disconnect', 'status'].includes(cmdAction)) {
            renderSlashOutput(
              'usage: /browser [connect|disconnect|status] [url] · persistent: set browser.cdp_url in config.yaml'
            )

            return
          }

          const url = cmdAction === 'connect' ? rest.join(' ').trim() || 'http://127.0.0.1:9222' : undefined

          if (url) {
            renderSlashOutput(`checking Chromium-family browser remote debugging at ${url}...`)
          }

          try {
            const result = await requestGateway<BrowserManageResponse>('browser.manage', {
              action: cmdAction,
              session_id: sessionId,
              ...(url && { url })
            })

            // Without a streamed session subscription, the gateway bundles its
            // progress lines into `messages` — flush them inline.
            result?.messages?.forEach(message => renderSlashOutput(message))

            if (cmdAction === 'status') {
              renderSlashOutput(
                result?.connected
                  ? `browser connected: ${result.url || '(url unavailable)'}`
                  : 'browser not connected (try /browser connect <url> or set browser.cdp_url in config.yaml)'
              )

              return
            }

            if (cmdAction === 'disconnect') {
              renderSlashOutput('browser disconnected')

              return
            }

            if (result?.connected) {
              renderSlashOutput('Browser connected to live Chromium-family browser via CDP')
              renderSlashOutput(`Endpoint: ${result.url || '(url unavailable)'}`)
              renderSlashOutput('next browser tool call will use this CDP endpoint')
            }
          } catch (err) {
            renderSlashOutput(`error: ${errorMessage(err)}`)
          }
        }
      }

      // Picker commands open a desktop overlay; a typed arg is resolved by that
      // picker so the command never dead-ends or falls through to the backend.
      const openPicker = async (pickerId: DesktopPickerId, ctx: SlashActionCtx): Promise<void> => {
        if (pickerId === 'model') {
          if (!ctx.arg.trim()) {
            setModelPickerOpen(true)

            return
          }

          // Power users can still type `/model <name>` — run it on the backend.
          await runExec(ctx)

          return
        }

        // session picker — /resume, /sessions, /switch
        const query = ctx.arg.trim()

        if (!query) {
          setSessionPickerOpen(true)

          return
        }

        const sessions = $sessions.get()
        const lower = query.toLowerCase()

        const match =
          sessions.find(session => session.id === query) ||
          sessions.find(session => sessionTitle(session).toLowerCase().includes(lower)) ||
          sessions.find(session => (session.preview ?? '').toLowerCase().includes(lower))

        if (!match) {
          if (isSessionIdCandidate(query)) {
            await resumeStoredSession(query)

            return
          }

          notify({ kind: 'error', message: copy.resumeFailed })

          return
        }

        await resumeStoredSession(match.id)
      }

      // The whole dispatcher: resolve the command's desktop surface, then act on
      // its kind. No per-command ladder — behavior lives in the registry.
      async function runSlash(commandText: string, sessionHint?: string, recordInput = true): Promise<void> {
        const command = commandText.trim()
        const { name, arg } = parseSlashCommand(command)

        if (!name) {
          // The composer draft was already cleared on submit, and slash input
          // never lands in the Up-arrow history ring (it derives from sent user
          // messages) — so without this restore, any payload after a degenerate
          // slash (`/ text`, `/` + newline) is lost forever. Hand it back.
          if (command.replace(/^\/+/, '').trim()) {
            setComposerDraft(command)
          }

          const sessionId = await ensureSessionId(sessionHint)

          if (sessionId) {
            appendSessionTextMessage(sessionId, 'system', copy.emptySlashCommand)
          }

          return
        }

        const ctx: SlashActionCtx = { arg, command, name, recordInput, sessionHint }
        const surface = resolveDesktopCommand(`/${name}`)?.surface

        switch (surface?.kind) {
          case 'unavailable': {
            const resolved = await withSlashOutput(ctx)
            resolved?.render(desktopSlashUnavailableMessage(name) || `/${name} is not available in the desktop app.`)

            return
          }

          case 'picker':
            return openPicker(surface.picker, ctx)

          case 'action':
            return actionHandlers[surface.action](ctx)

          case 'rpc':
            return runRpc(surface, ctx)

          default:
            // exec spec, or an unknown skill / quick command the backend owns.
            return runExec(ctx)
        }
      }

      await runSlash(rawCommand, options?.sessionId, options?.recordInput ?? true)
    },
    [
      activeSessionIdRef,
      appendSessionTextMessage,
      branchCurrentSession,
      busyRef,
      copy,
      createBackendSessionForSend,
      getRoutedStoredSessionId,
      getRuntimeIdForStoredSession,
      handleSkinCommand,
      handoffSession,
      openMemoryGraph,
      refreshSessions,
      requestGateway,
      resumeStoredSession,
      selectedStoredSessionIdRef,
      slashCopy,
      startFreshSessionDraft,
      submitPromptText,
      updateSessionState
    ]
  )
}
