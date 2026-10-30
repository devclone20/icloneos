import { SettingRow } from '@/app/settings/setting-row'
import { useI18n } from '@/i18n'
import { APP_INTL_LOCALE } from '@/iclone-shared/app-intl-locale'
import type { AuditRecordView } from '@/iclone-shared/permissions'

import { auditTitle, describeAuditRecord } from './audit-detail'

const SHOWN = 40

function when(iso: string): string {
  const date = new Date(iso)

  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(APP_INTL_LOCALE, { dateStyle: 'medium', timeStyle: 'short' })
}

/** The newest decisions from main's hash-chained log (read-only; export arrives in a later round). */
export function AuditList({ records }: { records: readonly AuditRecordView[] }) {
  const copy = useI18n().t.settings.permissions

  if (records.length === 0) {
    return <p className="text-[0.8125rem] text-(--ui-text-tertiary)">{copy.audit.empty}</p>
  }

  return (
    <div data-permission-audit="">
      {records
        .slice(-SHOWN)
        .reverse()
        .map(record => (
          <SettingRow
            detail={describeAuditRecord(record, copy)}
            hint={[
              when(record.ts),
              record.class ? copy.classes[record.class] : null,
              record.mode ? copy.modes[record.mode].name : null,
              record.agent?.inft
            ]
              .filter(Boolean)
              .join(' · ')}
            key={record.seq_main}
            title={auditTitle(copy, record)}
          />
        ))}
    </div>
  )
}
