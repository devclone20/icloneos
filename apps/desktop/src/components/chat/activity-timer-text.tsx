import { formatElapsedSeconds } from '@/iclone-shared/format'
import { cn } from '@/lib/utils'

import { StableText } from './stable-text'

interface ActivityTimerTextProps {
  seconds: number
  className?: string
}

export function ActivityTimerText({ seconds, className }: ActivityTimerTextProps) {
  return (
    <StableText
      className={cn(
        // Tinted with --ic-accent (very low alpha) so the timer reads
        // as part of the same "live signal" cluster as the dither block /
        // arc-border / working-session dot, instead of being neutral chrome.
        'shrink-0 text-[0.56rem] leading-none tracking-[0.02em] text-[color:var(--ic-chat-accent-55)]',
        className
      )}
    >
      {formatElapsedSeconds(seconds)}
    </StableText>
  )
}
