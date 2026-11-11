import { useStore } from '@nanostores/react'

import { cn } from '@/lib/utils'
import { $confinement } from '@/store/confinement'

import { useContainersCopy } from './containers-copy'

/**
 * A confined command waiting for the project's first hard-link scan: one calm line, gone when main reports none. In
 * the chat it stays live through main's change notices (a first scan's start, count and end, CF4) that the composer's
 * isolation note already reads on; the Containers pane also polls.
 */
export function FirstScanStatus({ className }: { className?: string }) {
  const scan = useStore($confinement).state?.firstScan ?? null
  const copy = useContainersCopy()

  if (!scan) {
    return null
  }

  return (
    <p className={cn('px-1 text-xs text-(--ic-text-2) tabular-nums', className)} data-first-scan="" role="status">
      {copy.firstScan(scan.dirs)}
    </p>
  )
}
