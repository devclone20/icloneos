import { Button } from '@/components/ui/button'
import { RowButton } from '@/components/ui/row-button'
import { useI18n } from '@/i18n'
import { ChevronDown, Terminal } from '@/lib/icons'
import type { EnvVarInfo } from '@/types/hermes'

import type { KeyRowProps } from './credential-key-ui'
import { credentialWords, useKeysCopy } from './keys-copy'
import { CredentialRow } from './keys-credential-row'
import { Pill } from './primitives'
import { SettingRow } from './setting-row'

interface ProviderChoiceRowProps {
  /** A short pill beside the name ("Recommended"). */
  badge?: string
  /** Signs in from the terminal instead of the browser. */
  external?: boolean
  hint: string
  onSelect: () => void
  title: string
}

/** A provider you can connect, on THE settings row: its name, what connecting it gives you under it,
 *  and Connect at the trailing edge. The name opens the same flow, as the whole card used to. */
export function ProviderChoiceRow({ badge, external = false, hint, onSelect, title }: ProviderChoiceRowProps) {
  const { t } = useI18n()

  return (
    <SettingRow
      control={
        <Button
          aria-label={`${t.common.connect} ${title}`}
          data-provider-connect=""
          onClick={onSelect}
          size="sm"
          type="button"
          variant="outline"
        >
          {external ? <Terminal className="size-3.5" /> : null}
          {t.common.connect}
        </Button>
      }
      hint={hint}
      title={
        <RowButton className="flex min-w-0 items-center gap-2 text-left" onClick={onSelect} tabIndex={-1}>
          <span className="truncate">{title}</span>
          {badge ? <Pill tone="primary">{badge}</Pill> : null}
        </RowButton>
      }
    />
  )
}

export interface ProviderKeyGroup {
  advanced: [string, EnvVarInfo][]
  docsUrl?: string
  hasAnySet: boolean
  name: string
  primary: [string, EnvVarInfo]
  priority: number
}

interface ProviderKeyGroupRowsProps {
  expanded: boolean
  group: ProviderKeyGroup
  /** Focus inside the key opens the provider's extra settings. */
  onExpand: () => void
  /** "More settings" opens them, "Fewer settings" folds them back. */
  onToggle: () => void
  rowProps: KeyRowProps
}

/** A provider's API key on THE settings row; its optional overrides (base URL, region…) follow as rows of
 *  their own once the key is focused or "More settings" is asked for. */
export function ProviderKeyGroupRows({ expanded, group, onExpand, onToggle, rowProps }: ProviderKeyGroupRowsProps) {
  const { t } = useI18n()
  const copy = useKeysCopy()
  const more = group.advanced.length

  return (
    <div data-provider-key-group={group.name}>
      <CredentialRow
        below={
          more > 0 ? (
            <Button
              aria-expanded={expanded}
              className="mt-1 w-fit text-[length:var(--conversation-caption-font-size)]"
              data-provider-more-settings=""
              onClick={onToggle}
              size="inline"
              type="button"
              variant="text"
            >
              {expanded ? copy.lessFields : t.settings.providers.moreFields(more)}
              <ChevronDown className={expanded ? 'size-3.5 rotate-180' : 'size-3.5'} />
            </Button>
          ) : undefined
        }
        docsUrl={group.docsUrl}
        expanded={expanded}
        hint={copy.providers[group.name] || undefined}
        info={group.primary[1]}
        onExpand={onExpand}
        placeholder={t.settings.credentials.pasteLabelKey(group.name)}
        rowProps={rowProps}
        title={group.name}
        varKey={group.primary[0]}
      />
      {expanded
        ? group.advanced.map(([key, info]) => {
            const words = credentialWords(copy, key, info, 'kind')

            return (
              <CredentialRow
                expanded
                hint={words.hint || undefined}
                info={info}
                key={key}
                rowProps={rowProps}
                title={words.title}
                varKey={key}
              />
            )
          })
        : null}
    </div>
  )
}
