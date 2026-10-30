import { type ChangeEvent, type KeyboardEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Loader2, Save, Trash2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { EnvVarInfo } from '@/types/hermes'

import { CONTROL_TEXT } from './constants'
import { credentialCopy } from './credential-removal'
import { EnvVarActionsMenu, EnvVarActionsTrigger } from './env-var-actions-menu'
import { prettyName, withoutKey } from './helpers'
import { useSettingRowA11y } from './setting-row'
import type { EnvRowProps } from './types'

export type KeyRowProps = Omit<EnvRowProps, 'info' | 'varKey'>

/** Matches Advanced / config field controls (ListRow + Input). */
const CREDENTIAL_CONTROL_CLASS = cn('h-8', CONTROL_TEXT)

// Resting credential field: chrome stripped so it reads as plain subtext.
// Stacked (<@2xl) it collapses to zero box (flush under its label); at @2xl it
// keeps the full control metrics (h-8 + px-2.5/py-1.5) so it centres on the
// label and nothing shifts when focus/expand adds the border. `!` beats the
// unlayered chrome CSS and the shared control sizing.
const CRED_BARE = 'border-0! bg-transparent! shadow-none! h-auto! p-0! @2xl:h-8! @2xl:px-2.5! @2xl:py-1.5!'

export const isKeyVar = (key: string, info: EnvVarInfo) => info.is_password || /(?:_API_KEY|_TOKEN|_KEY)$/.test(key)

// A single credential field: a set key shows as a filled read-only input
// (redacted value) that edits in place on click. Save appears once typed; a set
// key also offers Remove, and Esc cancels without closing the overlay.
export function KeyField({
  expanded = false,
  info,
  placeholder,
  rowProps,
  varKey
}: {
  expanded?: boolean
  info: EnvVarInfo
  placeholder?: string
  rowProps: KeyRowProps
  varKey: string
}) {
  // Named by the enclosing row's title (tester U2-p2b-06): the placeholder is not a name.
  const rowA11y = useSettingRowA11y()
  const { t } = useI18n()
  const { edits, onClear, onSave, saving, setEdits } = rowProps
  const editing = edits[varKey] !== undefined
  // Bare (plain subtext) only while the group is collapsed and idle. Expanding
  // the card counts as "focused in", so it gets full input chrome too.
  const bare = !editing && !expanded
  const draft = edits[varKey] ?? ''
  const dirty = draft.trim().length > 0
  const busy = saving === varKey
  const masked = info.redacted_value ?? '••••••••'
  const startEdit = () => setEdits(c => ({ ...c, [varKey]: '' }))
  const cancel = () => setEdits(c => withoutKey(c, varKey))
  const update = (e: ChangeEvent<HTMLInputElement>) => setEdits(c => ({ ...c, [varKey]: e.target.value }))

  const keydown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && dirty) {
      void onSave(varKey)
    } else if (e.key === 'Escape' && editing) {
      e.preventDefault()
      e.stopPropagation()
      cancel()
    }
  }

  const editType = info.is_password ? 'password' : 'text'

  // At rest a set key keeps one control: the actions kebab (Replace / Reveal /
  // Remove). While editing the kebab hides and the inline trash takes over, so
  // a row never shows two removal controls.
  if (info.is_set && !editing) {
    const revealedValue = rowProps.revealed[varKey]

    return (
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <Input
          {...rowA11y}
          className={cn(CREDENTIAL_CONTROL_CLASS, bare && CRED_BARE, 'cursor-pointer text-muted-foreground')}
          onFocus={startEdit}
          readOnly
          value={revealedValue ?? masked}
        />
        <EnvVarActionsMenu
          clearDisabled={busy}
          docsUrl={info.url}
          isRevealed={Boolean(revealedValue)}
          isSet
          label={varKey}
          onClear={() => void onClear(varKey)}
          onEdit={startEdit}
          onReveal={() => void rowProps.onReveal(varKey)}
        >
          <EnvVarActionsTrigger
            aria-label={credentialCopy.actionsFor(varKey)}
            data-testid="credential-actions"
            disabled={busy}
            title={credentialCopy.actionsFor(varKey)}
          />
        </EnvVarActionsMenu>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
      <Input
        {...rowA11y}
        autoFocus={editing}
        className={cn(CREDENTIAL_CONTROL_CLASS, bare && CRED_BARE)}
        onChange={update}
        onFocus={() => {
          if (!editing) {
            startEdit()
          }
        }}
        onKeyDown={keydown}
        placeholder={placeholder ?? t.settings.credentials.pasteKey}
        type={editType}
        value={draft}
      />
      {/* Inline trailing controls — mirrors SearchField's inline clear button.
          No floating hint row that reflows the grid or overlaps the card body;
          Esc still cancels via keydown. */}
      {editing && (info.is_set || dirty) && (
        <div className="flex items-center gap-1">
          {info.is_set && (
            <Tip label={t.settings.credentials.remove}>
              <Button
                aria-label={t.settings.credentials.remove}
                className="text-muted-foreground hover:text-destructive"
                data-testid="credential-remove"
                disabled={busy}
                onClick={() => void onClear(varKey)}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <Trash2 />
              </Button>
            </Tip>
          )}
          {dirty && (
            <Button className="h-8" disabled={busy} onClick={() => void onSave(varKey)} size="sm">
              {busy ? <Loader2 className="animate-spin" /> : <Save />}
              {busy ? t.settings.credentials.saving : t.common.save}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export function credentialRowLabel(varKey: string, info: EnvVarInfo): string {
  if (isKeyVar(varKey, info)) {
    return prettyName(varKey.replace(/(?:_API_KEY|_TOKEN|_KEY)$/i, ''))
  }

  return prettyName(varKey)
}
