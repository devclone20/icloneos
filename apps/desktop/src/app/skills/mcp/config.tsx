import { ChevronLeft, ClipboardPaste } from 'lucide-react'
/**
 * MCP — the inspector for one server, and the paste/import door into the
 * editor (E3 decision #8). Lifted out of `mcp-tab.tsx`; the logic is the same,
 * the chrome is ours.
 */
import { useMemo, useState } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { type McpImportEntry, parseMcpImport } from '@/lib/mcp-import'
import { isToolEnabled } from '@/lib/mcp-tool-filter'
import { cn } from '@/lib/utils'

import { IcDialog, IcPageButton, IcPageState } from '../../profiles/ic-page'
import { prettyName } from '../../settings/helpers'

import { aimHint } from './hint'
import { McpAvatar, ServerIconActions, ServerSwitch } from './row'
import { capabilitySummary, type Probe, type ServerCost, serverEnabled, statusOf } from './servers'

// ---------------------------------------------------------------------------
// Left column: one server's config (mirrors the block under the cursor).
// ---------------------------------------------------------------------------

export function ServerConfig({
  authing,
  cost,
  description,
  entry,
  name,
  onAuthenticate,
  onBack,
  onProbe,
  onRemove,
  onToggle,
  onToggleTool,
  probe,
  saved,
  saving
}: {
  authing: boolean
  cost?: ServerCost
  description: null | string
  entry: Record<string, unknown>
  name: string
  onAuthenticate: () => void
  onBack: () => void
  onProbe: () => void
  onRemove: () => void
  onToggle: (checked: boolean) => void
  onToggleTool: (toolName: string) => void
  probe: Probe | undefined
  saved: boolean
  saving: boolean
}) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const status = statusOf(entry, probe)

  // OAuth is only offered to servers that are actually OAuth-shaped. A server
  // with `headers` uses API-key/bearer auth — a 401 there means a bad key, NOT
  // "log in with OAuth"; routing it through the browser flow would wrongly
  // rewrite its config to `auth: oauth`. So: explicit `auth: oauth` can re-auth
  // on failure; an auth-less HTTP server may try OAuth on a 401; header servers
  // never do.
  const hasHeaderAuth = !!entry.headers && typeof entry.headers === 'object'

  const canAuth =
    typeof entry.url === 'string' &&
    !hasHeaderAuth &&
    (entry.auth === 'oauth' ? status === 'needs-auth' || status === 'error' : !entry.auth && status === 'needs-auth')

  const summary = probe && probe !== 'probing' && probe.ok ? capabilitySummary(m, probe, entry, cost) : null

  return (
    // p-2 matches the list view's container so flipping list ⇄ config keeps
    // content anchored at the same origin.
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 [scrollbar-gutter:stable]">
      {/* Geometry cloned from McpRow so nothing jumps when flipping list ⇄
          config: items-start with per-element top margins that reproduce the
          row's h-11 centering exactly (h-5 controls → mt-3, size-6 avatar →
          mt-2.5, h-4 switch → mt-3.5) no matter how tall the text column gets. */}
      <div className="flex items-start gap-2 pr-1.5">
        <button
          aria-label={m.allServers}
          className="icsk__iconbtn mt-3"
          onClick={onBack}
          onFocus={aimHint}
          onPointerEnter={aimHint}
          type="button"
        >
          <ChevronLeft aria-hidden="true" size={13} />
        </button>
        <McpAvatar className="mt-2.5" name={name} status={status} />
        <div className="min-w-0 flex-1 pt-1">
          <h3 className="min-w-0 truncate text-[0.9375rem] font-semibold tracking-tight">{prettyName(name)}</h3>
          <p className="icsk__note truncate">
            {typeof entry.url === 'string' ? entry.url : [entry.command, ...((entry.args as string[]) ?? [])].join(' ')}
          </p>
          {summary && <p className="icsk__note">{summary}</p>}
        </div>
        {saved && (
          // Direct row children (no wrapper): the icons↔switch gap must be the
          // row's own gap-2, byte-identical to McpRow.
          <>
            <ServerIconActions
              className="mt-3"
              onProbe={onProbe}
              onRemove={onRemove}
              probing={probe === 'probing'}
              saving={saving}
            />
            <ServerSwitch
              className="icsk__srv-switch--offset"
              disabled={saving}
              enabled={serverEnabled(entry)}
              name={name}
              onToggle={onToggle}
            />
          </>
        )}
      </div>

      {description && <p className="icsk__note icsk__note--body">{description}</p>}

      {canAuth && saved && (
        <div className="mt-3 flex justify-end">
          <IcPageButton disabled={authing} onClick={onAuthenticate}>
            {authing ? m.waitingForBrowser : m.authenticate}
          </IcPageButton>
        </div>
      )}
      {!saved && <p className="icsk__hint mt-3">{m.unsavedConnect}</p>}

      {status === 'probing' && <IcPageState kind="loading" title={t.skills.loading} />}

      {/* No inline error dump — the status dot/line says "Error"/"Needs
          authentication", and the actual failure lands in the logs pane below
          (and the console). A big red block here just shouts the same thing. */}

      {probe && probe !== 'probing' && probe.ok && probe.tools.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {/* Chip = a discovered tool; click to include/exclude it (struck
              through when excluded, so it won't register). The probe always
              lists every tool regardless of the filter. */}
          {probe.tools.map(tool => {
            const on = isToolEnabled(entry, tool.name)

            return (
              <Tip key={tool.name} label={on ? m.disableTool(tool.name) : m.enableTool(tool.name)}>
                <button
                  aria-pressed={on}
                  className={cn('icsk__tool', saved ? 'cursor-pointer' : 'cursor-default')}
                  disabled={!saved}
                  onClick={() => onToggleTool(tool.name)}
                  type="button"
                >
                  {tool.name}
                </button>
              </Tip>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Paste-anything import: a compact popover on the Servers header. Paste any
// README shape — mcp.json snippet, npx/docker command line, `claude mcp add`,
// a bare URL, or a Cursor deeplink — see the inferred name + config, then
// merge it into the editor draft (unsaved, like the "+" starter entry).
export function McpImportButton({
  disabled,
  onImport
}: {
  disabled: boolean
  onImport: (entries: McpImportEntry[]) => void
}) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')

  const entries = useMemo(() => parseMcpImport(text), [text])

  // One exit for both the Cancel button and Escape: the draft never survives a
  // dismissal, so reopening always starts empty.
  const close = () => {
    setOpen(false)
    setText('')
  }

  const confirm = () => {
    if (!entries) {
      return
    }

    onImport(entries)
    close()
  }

  return (
    <>
      <IcPageButton disabled={disabled} onClick={() => setOpen(true)} tone="quiet">
        <ClipboardPaste aria-hidden="true" size={12} />
        {m.importButton}
      </IcPageButton>
      <IcDialog
        footer={
          <div className="icdlg__foot">
            <IcPageButton onClick={close} tone="quiet">
              {t.common.cancel}
            </IcPageButton>
            <IcPageButton disabled={!entries} onClick={confirm} tone="accent">
              {entries && entries.length > 1 ? m.importConfirmMany(entries.length) : m.importConfirm}
            </IcPageButton>
          </div>
        }
        onClose={close}
        open={open}
        title={m.importButton}
      >
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={m.importButton}
            autoFocus
            className="icsk__field icsk__field--mono"
            onChange={event => setText(event.currentTarget.value)}
            placeholder={m.importPlaceholder}
            value={text}
          />
          {entries ? (
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {entries.map((entry, index) => (
                <div className="icsk__envrow" key={`${entry.name}-${index}`}>
                  <span className="icsk__srv-name block truncate">{entry.name}</span>
                  <span className="icsk__srv-cmd block truncate">
                    {typeof entry.config.url === 'string'
                      ? entry.config.url
                      : [entry.config.command, ...((entry.config.args as string[]) ?? [])].join(' ')}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            text.trim() && <p className="icsk__hint px-0.5">{m.importNoMatch}</p>
          )}
        </div>
      </IcDialog>
    </>
  )
}
