// Our primitives for the system surfaces a user meets outside the home: boot, failure, install, updates,
// onboarding, toasts and the find bar. They read only --ic-* roles; the stylesheet also pulls the token
// layer in, because these surfaces paint before the home chunk (which owns home.css) has loaded.
import '@/app/home/ic-tokens.css'
import '@/app/home/ic-bridge.css'
import './ic-system.css'

import { Dialog as DialogPrimitive, Slot, Tooltip as TooltipPrimitive } from 'radix-ui'
import { type ComponentProps, forwardRef, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import { writeClipboardText } from '@/components/ui/copy-button'
import { DialogPortalContainerContext } from '@/components/ui/dialog-portal-context'
import { Loader } from '@/components/ui/loader'
import { suppressNonKeyboardFocusOpen } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { clamp } from '@/iclone-shared/math'
import { triggerHaptic } from '@/lib/haptics'
import { AlertCircle, Check, Copy, X } from '@/lib/icons'
import { cn } from '@/lib/utils'

// The variant and size names match the upstream Button so a call site swaps the component, not its props.
type IcButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link' | 'text' | 'textStrong'

type IcButtonSize = 'default' | 'xs' | 'sm' | 'lg' | 'inline' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg'

interface IcButtonProps extends ComponentProps<'button'> {
  asChild?: boolean
  size?: IcButtonSize | null
  variant?: IcButtonVariant | null
}

export function IcButton({ asChild = false, className, size, variant, ...props }: IcButtonProps) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      className={cn('ic-btn', className)}
      data-size={size ?? 'default'}
      data-slot="ic-button"
      data-variant={variant ?? 'default'}
      {...props}
    />
  )
}

export const IcInput = forwardRef<HTMLInputElement, ComponentProps<'input'>>(function IcInput(
  { className, ...props },
  ref
) {
  return <input className={cn('ic-field', className)} data-slot="ic-input" ref={ref} {...props} />
})

// Raw log text: selectable, because logs exist to be read and copied. Pass a max-h-* via className.
export function IcLog({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('ic-log', className)} data-selectable-text="true" {...props} />
}

interface IcProgressProps {
  'aria-label'?: string
  className?: string
  /** Paints the fill in the danger role (a failed install or boot). */
  destructive?: boolean
  indeterminate?: boolean
  size?: 'sm' | 'md' | 'lg'
  /** Completion as a 0–1 fraction; clamped. Ignored when `indeterminate`. */
  value?: number
}

export function IcProgress({
  className,
  destructive = false,
  indeterminate = false,
  size = 'md',
  value = 0,
  ...aria
}: IcProgressProps) {
  const pct = Math.round(clamp(value, 0, 1) * 100)

  return (
    <div
      aria-label={aria['aria-label']}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={indeterminate ? undefined : pct}
      className={cn('ic-progress', className)}
      data-indeterminate={indeterminate ? '' : undefined}
      data-size={size}
      data-tone={destructive ? 'danger' : undefined}
      role="progressbar"
    >
      <div className="ic-progress__fill" style={indeterminate ? undefined : { width: `${pct}%` }} />
    </div>
  )
}

export function IcErrorGlyph({ className, size = '1.25rem' }: { className?: string; size?: string }) {
  return (
    <AlertCircle
      aria-hidden
      className={cn('ic-sys-danger-glyph shrink-0', className)}
      style={{ height: size, width: size }}
    />
  )
}

// The upstream loader paints in --color-primary; ours paints in the accent unless the call site names a colour.
export function IcSpinner({ className, ...props }: ComponentProps<typeof Loader>) {
  return <Loader className={cn('text-(--ic-accent)', className)} data-slot="ic-spinner" {...props} />
}

/** Hover-open delay, the same as the app's `Tip`: below 150 ms a passing cursor opens the tip, above 250 ms a hover
 *  feels broken. */
const IC_TIP_DELAY_MS = 200

/** After a tip closes the next trigger opens instantly for this long (Radix `skipDelayDuration`), as in `Tip`. */
const IC_TIP_SKIP_DELAY_MS = 300

interface IcTipProps {
  children: ReactNode
  delayDuration?: number
  label: ReactNode
  side?: ComponentProps<typeof TooltipPrimitive.Content>['side']
}

// The tooltip on our material: the open rules of the app's `Tip` (hover only, keyboard focus, never hoverable, never
// click-blocking) with the chip painted on our roles. It brings its own Radix provider because the system surfaces also
// mount outside the app root (boot, failure); the few instances here never reach the count the app-wide `Tip` hoists for.
export function IcTip({ children, delayDuration = IC_TIP_DELAY_MS, label, side }: IcTipProps) {
  if (!label) {
    return <>{children}</>
  }

  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      disableHoverableContent
      skipDelayDuration={IC_TIP_SKIP_DELAY_MS}
    >
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild data-slot="tooltip-trigger" onFocus={suppressNonKeyboardFocusOpen}>
          {children}
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            className="pointer-events-none z-(--z-over-modal) w-fit max-w-64 select-none"
            data-slot="tooltip-content"
            side={side}
            sideOffset={6}
          >
            {/* The chip hugs each wrapped line; a block child collapses its geometry, so children stay inline-flex. */}
            <span className="box-decoration-clone inline rounded-(--ic-radius-xs) border border-(--ic-border-subtle) bg-(--ic-surface) px-1.5 py-1 text-[11px] leading-normal font-medium text-(--ic-text-1) [&>*]:!inline-flex">
              {label}
            </span>
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}

type IcCopyStatus = 'copied' | 'failed' | 'idle'

/** How long the copied / failed feedback replaces the label. */
const IC_COPY_FEEDBACK_MS = 1_500

interface IcCopyButtonProps {
  children?: ReactNode
  className?: string
  disabled?: boolean
  /** Feedback after a failed write; defaults to the common string. */
  errorMessage?: string
  iconClassName?: string
  /** Accessible name and tip while idle; defaults to the common "Copy". */
  label?: string
  text: string | (() => Promise<string> | string)
}

// The inline copy control on our roles: the canonical clipboard write, then copied / failed feedback for a moment in the
// label, the tip and the accessible name.
export function IcCopyButton({
  children,
  className,
  disabled = false,
  errorMessage,
  iconClassName,
  label,
  text
}: IcCopyButtonProps) {
  const { t } = useI18n()
  const [status, setStatus] = useState<IcCopyStatus>('idle')
  const resetTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(resetTimer.current), [])

  const settle = useCallback((next: IcCopyStatus) => {
    window.clearTimeout(resetTimer.current)
    setStatus(next)
    resetTimer.current = window.setTimeout(() => setStatus('idle'), IC_COPY_FEEDBACK_MS)
  }, [])

  const copy = useCallback(async () => {
    try {
      const value = typeof text === 'function' ? await text() : text

      if (!value) {
        return
      }

      await writeClipboardText(value)
      triggerHaptic('selection')
      settle('copied')
    } catch {
      settle('failed')
    }
  }, [settle, text])

  const idleLabel = label ?? t.common.copy

  const feedback =
    status === 'copied' ? t.common.copied : status === 'failed' ? (errorMessage ?? t.common.copyFailed) : idleLabel

  const Icon = status === 'copied' ? Check : status === 'failed' ? X : Copy

  return (
    <IcTip label={feedback}>
      <button
        aria-label={feedback}
        className={cn(
          'inline-flex items-center gap-1 rounded-(--ic-radius-xs) px-1.5 py-0.5 text-[0.75rem] text-(--ic-text-2) transition-colors hover:bg-(--ic-fill-hover) hover:text-(--ic-text-1) disabled:opacity-40',
          className
        )}
        disabled={disabled}
        onClick={() => void copy()}
        type="button"
      >
        <Icon className={cn('size-3.5', iconClassName)} />
        {status === 'copied' ? t.common.copied : status === 'failed' ? t.common.failed : (children ?? idleLabel)}
      </button>
    </IcTip>
  )
}

interface IcSurfaceStateProps {
  /** Optional actions stack rendered below the copy. */
  children?: ReactNode
  className?: string
  description?: ReactNode
  /** Defaults to the danger glyph. */
  icon?: ReactNode
  /** Nodes are accepted so a dialog can pass its accessible Title / Description. */
  title: ReactNode
}

// A centred state: glyph over title + body, then the actions. Failure screens and in-dialog states use it.
// `IcState` (state.tsx) is the canonical empty/loading/error state (contract IC §3); this one keeps the system
// surfaces' material until E3h unifies the look, and is re-exported as `IcState` from the onboarding shim.
export function IcSurfaceState({ children, className, description, icon, title }: IcSurfaceStateProps) {
  return (
    <div className={cn('ic-state', className)}>
      <div className="ic-state__copy">
        {icon ?? <IcErrorGlyph size="1.75rem" />}
        {typeof title === 'string' ? <h2 className="ic-sys-title">{title}</h2> : title}
        {typeof description === 'string' ? <p className="ic-sys-body max-w-prose">{description}</p> : description}
      </div>
      {children && <div className="ic-state__actions">{children}</div>}
    </div>
  )
}

interface IcDialogProps {
  bodyClassName?: string
  children: ReactNode
  className?: string
  closeLabel: string
  onOpenAutoFocus?: (event: Event) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  showCloseButton?: boolean
}

// A modal on our material. The content node is published so a popover opened inside portals into it and focus
// never leaves the dialog (dialog-portal-context.ts).
export function IcDialog({
  bodyClassName,
  children,
  className,
  closeLabel,
  onOpenAutoFocus,
  onOpenChange,
  open,
  showCloseButton = true
}: IcDialogProps) {
  const [contentNode, setContentNode] = useState<HTMLElement | null>(null)

  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="ic-sys-scrim fixed inset-0 z-(--z-modal-backdrop) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            'ic-sys ic-sys-card fixed top-1/2 left-1/2 z-(--z-modal) flex max-h-[85vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            className
          )}
          data-slot="ic-dialog"
          onOpenAutoFocus={onOpenAutoFocus}
          ref={setContentNode}
        >
          <DialogPortalContainerContext.Provider value={contentNode}>
            <div
              className={cn('grid min-h-0 grid-cols-[minmax(0,1fr)] overflow-y-auto rounded-[inherit]', bodyClassName)}
            >
              {children}
            </div>
            {showCloseButton && (
              <DialogPrimitive.Close asChild>
                <IcButton aria-label={closeLabel} className="absolute top-3 right-3" size="icon-xs" variant="ghost">
                  <X className="size-3.5" />
                </IcButton>
              </DialogPrimitive.Close>
            )}
          </DialogPortalContainerContext.Provider>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function IcDialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('ic-sys-title', className)} {...props} />
}

export function IcDialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('ic-sys-body', className)} {...props} />
}
