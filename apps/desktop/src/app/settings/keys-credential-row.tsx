import type { ReactNode } from 'react'

import { useI18n } from '@/i18n'
import { ExternalLink } from '@/lib/icons'
import type { EnvVarInfo } from '@/types/hermes'

import { isKeyVar, KeyField, type KeyRowProps } from './credential-key-ui'
import { useKeysCopy } from './keys-copy'
import { SettingRow } from './setting-row'

interface CredentialRowProps {
  /** More under the hint, after the "Get a key" link (a provider's "More settings" disclosure). */
  below?: ReactNode
  /** Shown under the hint as "Get a key" when the credential has a sign-up page. */
  docsUrl?: string
  expanded: boolean
  hint?: ReactNode
  info: EnvVarInfo
  onExpand?: () => void
  placeholder?: string
  rowProps: KeyRowProps
  title: string
  varKey: string
}

/** One credential on THE settings row: the title in one line, what it is for under it, the secret field at
 *  the trailing edge (paste, replace, reveal, remove — the field and its menu are the shared KeyField). */
export function CredentialRow({
  below,
  docsUrl,
  expanded,
  hint,
  info,
  onExpand,
  placeholder,
  rowProps,
  title,
  varKey
}: CredentialRowProps) {
  const { t } = useI18n()
  const keyWords = useKeysCopy()
  const href = docsUrl?.trim()

  // The title is a whole sentence now, so the placeholder never repeats it ('Paste Search the web… key').
  const emptyPlaceholder = isKeyVar(varKey, info)
    ? keyWords.pasteKey
    : /URL$/i.test(varKey)
      ? 'https://…'
      : t.settings.credentials.optional

  return (
    <SettingRow
      below={
        href || below ? (
          <>
            {href ? (
              <a
                className="mt-1 inline-flex w-fit items-center gap-1 text-[length:var(--conversation-caption-font-size)] text-(--ic-text-3) underline-offset-4 hover:text-(--ic-text-1) hover:underline"
                href={href}
                rel="noreferrer"
                target="_blank"
              >
                {t.settings.credentials.getKey}
                <ExternalLink className="size-3" />
              </a>
            ) : null}
            {below}
          </>
        ) : undefined
      }
      control={
        <div className="w-full min-w-0" data-credential-key={varKey} onFocus={onExpand}>
          <KeyField
            expanded={expanded}
            info={info}
            placeholder={placeholder ?? emptyPlaceholder}
            rowProps={rowProps}
            varKey={varKey}
          />
        </div>
      }
      field
      hint={hint}
      title={title}
    />
  )
}
