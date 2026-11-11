import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { ImageLightbox } from '@/components/chat/zoomable-image'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useImageDownload } from '@/hooks/use-image-download'
import { useI18n } from '@/i18n'
import { readDesktopFileDataUrlLocalFirst } from '@/lib/desktop-fs'
import { AlertCircle, FileText, FolderOpen, ImageIcon, Link, Loader2, MessageCode, Terminal } from '@/lib/icons'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { cn } from '@/lib/utils'
import type { ComposerAttachment } from '@/store/composer'
import { notifyError } from '@/store/notifications'
import { openPreview } from '@/store/preview'
import { isScreenFramePath } from '@/store/screen-record'

/** A frame of a screen recording: up to 20 arrive at once, too many for a full chip each. */
const isScreenFrame = (attachment: ComposerAttachment) =>
  attachment.kind === 'image' && [attachment.path, attachment.detail].some(file => file && isScreenFramePath(file))

export function AttachmentList({
  attachments,
  onRemove
}: {
  attachments: ComposerAttachment[]
  onRemove?: (id: string) => void
}) {
  const { t } = useI18n()
  const present = attachments.filter(Boolean)
  const frames = present.filter(isScreenFrame)
  const keyOf = (attachment: ComposerAttachment) =>
    attachment.occurrenceId ? `occ:${attachment.occurrenceId}` : attachment.id

  // The frames overlap as one strip, with their count after them (a pseudo-element: the list's children stay the chips).
  return (
    <div
      className={cn(
        'flex max-w-full flex-wrap gap-1.5 px-1 pt-1',
        frames.length > 0 &&
          'items-center after:text-[0.72rem] after:font-medium after:text-[color:var(--ic-chat-2-65)] after:content-[attr(data-frames-label)]'
      )}
      data-frames-label={frames.length > 0 ? t.composer.screenFrames(frames.length) : undefined}
      data-slot="composer-attachments"
    >
      {present
        .filter(attachment => !isScreenFrame(attachment))
        .map(attachment => (
          <AttachmentPill attachment={attachment} key={keyOf(attachment)} onRemove={onRemove} />
        ))}
      {frames.map((attachment, index) => (
        <AttachmentPill
          attachment={attachment}
          frame={index === 0 ? 'first' : 'next'}
          key={keyOf(attachment)}
          onRemove={onRemove}
        />
      ))}
    </div>
  )
}

function AttachmentPill({
  attachment,
  frame,
  onRemove
}: {
  attachment: ComposerAttachment
  /** In the frame strip: only the thumbnail, the next one over this one's right part. */
  frame?: 'first' | 'next'
  onRemove?: (id: string) => void
}) {
  const { t } = useI18n()
  const c = t.composer

  const Icon = {
    file: FileText,
    folder: FolderOpen,
    image: ImageIcon,
    review: MessageCode,
    terminal: Terminal,
    url: Link
  }[attachment.kind]

  // The tile's cwd when this pill lives in a tile composer, not the primary's:
  // a relative attachment path has to resolve against its own session's root.
  const cwd = useStore(useSessionView().$cwd)
  const isUploading = attachment.uploadState === 'uploading'
  const hasUploadError = attachment.uploadState === 'error'

  // A review card's detail is its resolved-comment JSON, not a previewable
  // path — clicking it should do nothing rather than toast a bogus failure.
  const canPreview =
    attachment.kind !== 'folder' && attachment.kind !== 'terminal' && attachment.kind !== 'review' && !isUploading

  const detail =
    attachment.kind !== 'review' && attachment.detail && attachment.detail !== attachment.label
      ? attachment.detail
      : undefined

  // Keep full image bytes out of composer state. New chips read their path only
  // when clicked; previewUrl remains a compatibility fallback for older drafts.
  const [loadedImageSrc, setLoadedImageSrc] = useState<string>()
  const lightboxSrc = attachment.kind === 'image' && !isUploading ? attachment.previewUrl || loadedImageSrc : undefined
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const { download, saving } = useImageDownload(lightboxSrc)

  async function openAttachment() {
    if (!canPreview) {
      return
    }

    if (attachment.kind === 'image') {
      try {
        let source = lightboxSrc || ''

        // Upload may replace `path` with a gateway-side staged path while
        // `detail` still carries the original host path. If submit then fails,
        // keep the surviving chip previewable across split-filesystem setups.
        if (!source) {
          const paths = [attachment.path, attachment.detail].filter(
            (path, index, candidates): path is string => Boolean(path) && candidates.indexOf(path) === index
          )

          let lastError: unknown

          for (const path of paths) {
            try {
              source = await readDesktopFileDataUrlLocalFirst(path)

              if (source) {
                break
              }
            } catch (error) {
              lastError = error
            }
          }

          if (!source && lastError) {
            throw lastError
          }
        }

        if (!source) {
          throw new Error(c.couldNotPreview(attachment.label))
        }

        setLoadedImageSrc(source)
        setLightboxOpen(true)
      } catch (error) {
        notifyError(error, c.previewUnavailable)
      }

      return
    }

    const rawTarget =
      attachment.path ||
      attachment.detail ||
      attachment.refText?.replace(/^@(file|image|url):/, '') ||
      attachment.label ||
      ''

    const target = rawTarget.replace(/^`|`$/g, '')

    if (!target) {
      return
    }

    try {
      const preview = await normalizeOrLocalPreviewTarget(target, cwd || undefined)

      if (!preview) {
        throw new Error(c.couldNotPreview(attachment.label))
      }

      openPreview(preview, 'manual')
    } catch (error) {
      notifyError(error, c.previewUnavailable)
    }
  }

  return (
    <>
      <Tip label={attachment.path || attachment.detail || attachment.label}>
        <div
          className={cn(
            'group/attachment relative min-w-0 shrink-0',
            frame && 'hover:z-10 focus-within:z-10',
            frame === 'next' && '-ml-[26px]'
          )}
        >
          <button
            aria-busy={isUploading || undefined}
            aria-label={canPreview ? c.previewLabel(attachment.label) : attachment.label}
            className={cn(
              frame
                ? 'block rounded-lg disabled:cursor-default'
                : 'flex max-w-56 items-center gap-2 rounded-2xl border bg-[var(--ic-chat-stage-50)] px-2 py-1.5 text-left shadow-[inset_0_1px_0_var(--ic-glint)] transition-colors disabled:cursor-default',
              frame
                ? ''
                : hasUploadError
                  ? 'border-[color:var(--ic-chat-danger-45)] hover:border-[color:var(--ic-chat-danger-60)]'
                  : 'border-[color:var(--ic-chat-subtle-60)] hover:border-[color:var(--ic-chat-accent-35)] hover:bg-[var(--ic-chat-hover-45)]'
            )}
            disabled={!canPreview}
            onClick={() => void openAttachment()}
            type="button"
          >
            <span className="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg border border-[color:var(--ic-chat-subtle-55)] bg-[var(--ic-chat-raised-35)] text-[color:var(--ic-text-2)]">
              {(attachment.thumbnailUrl || attachment.previewUrl) && attachment.kind === 'image' ? (
                <img
                  alt={attachment.label}
                  className="size-full object-cover"
                  draggable={false}
                  src={attachment.thumbnailUrl ?? attachment.previewUrl}
                />
              ) : (
                <Icon className="size-3.5" />
              )}
              {isUploading && (
                <span className="absolute inset-0 grid place-items-center bg-[var(--ic-chat-stage-60)] backdrop-blur-[1px]">
                  <Loader2 aria-hidden="true" className="size-3.5 animate-spin text-[color:var(--ic-chat-1-75)]" />
                </span>
              )}
              {hasUploadError && (
                <span className="absolute inset-0 grid place-items-center bg-[var(--ic-chat-danger-15)]">
                  <AlertCircle aria-hidden="true" className="size-3.5 text-[color:var(--ic-danger)]" />
                </span>
              )}
            </span>
            {!frame && (
              <span className="min-w-0">
                <span className="block truncate text-[0.72rem] font-medium leading-4 text-[color:var(--ic-chat-1-90)]">
                  {attachment.label}
                </span>
                {detail && (
                  <span
                    className={cn(
                      'block truncate text-[0.62rem] leading-3.5',
                      hasUploadError ? 'text-[color:var(--ic-chat-danger-80)]' : 'text-[color:var(--ic-chat-2-65)]'
                    )}
                  >
                    {detail}
                  </span>
                )}
              </span>
            )}
          </button>
          {onRemove && (
            <button
              aria-label={c.removeAttachment(attachment.label)}
              className={cn(
                'absolute -top-1 grid size-3.5 place-items-center rounded-full border border-[color:var(--ic-chat-subtle-70)] bg-[var(--ic-surface)] text-[color:var(--ic-text-2)] opacity-0 shadow-xs transition hover:bg-[var(--ic-fill-hover)] hover:text-[color:var(--ic-text-1)] group-hover/attachment:opacity-100 focus-visible:opacity-100',
                frame ? '-left-1' : '-right-1'
              )}
              onClick={() => onRemove(attachment.id)}
              type="button"
            >
              <Codicon name="close" size="0.625rem" />
            </button>
          )}
        </div>
      </Tip>
      {lightboxSrc && (
        <ImageLightbox
          alt={attachment.label}
          copy={t.desktop}
          onClick={download}
          onOpenChange={open => {
            setLightboxOpen(open)

            if (!open && !attachment.previewUrl) {
              setLoadedImageSrc(undefined)
            }
          }}
          open={lightboxOpen}
          saving={saving}
          src={lightboxSrc}
        />
      )}
    </>
  )
}
