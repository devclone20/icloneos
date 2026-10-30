import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

/**
 * An overflow box with a fade at its bottom while more content lies below the fold (U1-p2-01): the eye is told to
 * scroll, and nothing a step requires is ever placed inside it.
 */
export function ScrollBox({ children, className }: { children: React.ReactNode; className?: string }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)

  useEffect(() => {
    const box = boxRef.current
    const content = contentRef.current

    if (!box || !content) {
      return
    }

    const measure = () => setMore(box.scrollHeight - box.clientHeight - box.scrollTop > 1)

    measure()
    box.addEventListener('scroll', measure, { passive: true })
    // The box is capped, so opening the offline reader changes only its content's size; a window resize changes both.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)

    observer?.observe(box)
    observer?.observe(content)

    return () => {
      box.removeEventListener('scroll', measure)
      observer?.disconnect()
    }
  }, [])

  return (
    <div className="relative">
      <div className={cn('overflow-y-auto', className)} data-consent-scroll-box="" ref={boxRef}>
        <div ref={contentRef}>{children}</div>
      </div>
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-(--ui-chat-bubble-background) to-transparent transition-opacity duration-200',
          more ? 'opacity-100' : 'opacity-0'
        )}
        data-consent-scroll-cue={more ? 'on' : 'off'}
      />
    </div>
  )
}
