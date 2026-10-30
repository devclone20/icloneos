import { cn } from '@/lib/utils'

import appIcon from '../../assets/icon.png'

// Brand badge: the app's own icon — the same file the Dock and Finder show
// (assets/icon.png, the green metal-sweep head), imported rather than copied so
// the mark inside the app can never drift from the icon outside it. The art
// carries its own rounded tile; size via className (default size-14).
export function BrandMark({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span className={cn('inline-flex size-14 shrink-0 items-center justify-center', className)} {...props}>
      <img alt="" className="size-full object-contain" draggable={false} src={appIcon} />
    </span>
  )
}
