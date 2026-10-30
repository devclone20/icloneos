import { useEffect, useState } from 'react'

import { APP_INTL_LOCALE } from '@/iclone-shared/app-intl-locale'
import { type CredentialAuditEntry, readCredentialAudit, subscribeCredentialAudit } from '@/lib/credential-audit'
import { KeyRound } from '@/lib/icons'

import { useMachineWords } from './machine/machine-words'
import { SectionHeading } from './primitives'
import { SettingRow } from './setting-row'

const SHOWN = 20

/** About → "Recent credential changes": names, surfaces and outcomes only. */
export function CredentialAuditSection() {
  const [entries, setEntries] = useState<CredentialAuditEntry[]>(() => readCredentialAudit())

  useEffect(() => subscribeCredentialAudit(() => setEntries(readCredentialAudit())), [])

  const copy = useMachineWords().audit

  return (
    <section data-testid="credential-audit">
      <SectionHeading icon={KeyRound} meta={copy.hint} title={copy.heading} />
      {entries.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">{copy.empty}</p>
      ) : (
        entries
          .slice(0, SHOWN)
          .map(entry => (
            <SettingRow
              control={<span className="text-xs text-muted-foreground">{copy.results[entry.result]}</span>}
              hint={`${copy.kinds[entry.kind]} · ${new Date(entry.ts).toLocaleString(APP_INTL_LOCALE)}`}
              key={`${entry.ts}-${entry.id}-${entry.result}`}
              title={<span className="font-mono">{entry.id}</span>}
            />
          ))
      )}
    </section>
  )
}
