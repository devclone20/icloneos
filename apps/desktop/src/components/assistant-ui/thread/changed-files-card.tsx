import { type FC, useMemo } from 'react'

import { deriveChangedFiles } from '@/components/assistant-ui/thread/changed-files'
import { WIDGET_SHELL_CLASS } from '@/components/chat/widget-shell'
import { DiffCount } from '@/components/ui/diff-count'
import { FadeScroll } from '@/components/ui/fade-scroll'
import { FileTypeIcon } from '@/components/ui/file-type-icon'
import { useI18n } from '@/i18n'
import { displayPath } from '@/lib/display-path'
import { cn } from '@/lib/utils'

// ~5 rows. A turn that rewrites twenty files should still read as one card in
// the transcript, not a wall the user has to scroll past to reach the composer.
const MAX_ROWS_HEIGHT = '9.375rem'

/**
 * Cursor-style "N files changed" summary closing out the newest assistant turn:
 * one row per file it edited with that file's +/-. Read-only — E3r deleted the
 * review pane, so the card reports what the turn touched and nothing in it is
 * a control (a dead "Review" button is worse than no button).
 *
 * Wears the shared `WIDGET_SHELL_CLASS` so it reads as the same panel as the
 * transcript's other inline widgets rather than inventing its own chrome.
 */
export const ChangedFilesCard: FC<{ parts: readonly unknown[] }> = ({ parts }) => {
  const { t } = useI18n()
  const copy = t.assistant.thread
  const files = useMemo(() => deriveChangedFiles(parts), [parts])

  if (files.length === 0) {
    return null
  }

  return (
    <div
      className={cn(WIDGET_SHELL_CLASS, 'mt-1.5 text-[length:var(--conversation-tool-font-size)]')}
      data-slot="aui_changed-files"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-(--ic-text-1)">{copy.filesChanged(files.length)}</span>
      </div>
      <FadeScroll className="-mx-1.5 mt-1.5 flex flex-col px-1.5" maxHeight={MAX_ROWS_HEIGHT}>
        {files.map(file => (
          <div
            className="flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1"
            key={file.path}
            title={displayPath(file.path)}
          >
            <FileTypeIcon className="shrink-0 text-(--ic-text-2)" path={file.path} size="0.875rem" />
            <span className="min-w-0 flex-1 truncate text-(--ic-text-ramp-80)">{file.name}</span>
            <DiffCount added={file.added} removed={file.removed} />
          </div>
        ))}
      </FadeScroll>
    </div>
  )
}
