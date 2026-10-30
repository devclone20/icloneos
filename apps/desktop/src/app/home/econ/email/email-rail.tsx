/**
 * Email — the folder rail, the one line that says where the owner's marks
 * live, and the agent's own address under it.
 */
import { Archive, AtSign, CircleDot, Inbox, Send, ShieldAlert, Trash2 } from 'lucide-react'
import { memo, type ReactNode } from 'react'

import { Tip } from '@/components/ui/tooltip'

import { CopyText, Pill, RailItem, RailSection } from '../ui'

import type { Mailbox } from './email-data'
import type { MailFolder } from './email-state'

const ICON = { size: 14, strokeWidth: 1.7 } as const

const FOLDERS: Array<{ id: MailFolder; label: string; icon: ReactNode }> = [
  { id: 'inbox', label: 'Inbox', icon: <Inbox {...ICON} /> },
  { id: 'unread', label: 'Unread', icon: <CircleDot {...ICON} /> },
  { id: 'sent', label: 'Sent', icon: <Send {...ICON} /> },
  { id: 'archive', label: 'Archive', icon: <Archive {...ICON} /> },
  { id: 'spam', label: 'Spam', icon: <ShieldAlert {...ICON} /> },
  { id: 'trash', label: 'Trash', icon: <Trash2 {...ICON} /> }
]

/** Inbox wears its unread count; the others their rows. `7+` when older
 *  pages may hold more. */
export type FolderCounts = Partial<Record<MailFolder, number | string>>

export const MailRail = memo(function MailRail({
  counts,
  folder,
  mailbox,
  mailboxNote,
  onSelect
}: {
  counts: FolderCounts
  folder: MailFolder
  mailbox: Mailbox | null
  /** Why no address is shown; null while the first read is still out. */
  mailboxNote: null | string
  onSelect: (folder: MailFolder) => void
}) {
  return (
    <>
      <RailSection title="Folders">
        {FOLDERS.map(item => (
          <RailItem
            active={folder === item.id}
            count={counts[item.id]}
            icon={item.icon}
            key={item.id}
            label={item.label}
            onClick={() => onSelect(item.id)}
          />
        ))}
      </RailSection>

      <p className="em-rail__local">
        Read, Archive and Trash live in iclone os on this computer — the mail service itself is never changed.
      </p>

      <div className="em-rail__foot">
        <p className="e-rail__title">Address</p>
        {mailbox ? (
          <div className="em-address">
            <AtSign aria-hidden="true" className="em-address__icon" size={12} strokeWidth={1.8} />
            <Tip label={mailbox.address}>
              <span className="em-address__value">{mailbox.address}</span>
            </Tip>
            <CopyText text={mailbox.address} />
          </div>
        ) : mailboxNote ? (
          <p className="em-address__none">{mailboxNote}</p>
        ) : (
          <span aria-hidden="true" className="em-address__skeleton" />
        )}
        {mailbox?.status && mailbox.status !== 'active' ? <Pill tone="warn">{mailbox.status}</Pill> : null}
      </div>
    </>
  )
})
