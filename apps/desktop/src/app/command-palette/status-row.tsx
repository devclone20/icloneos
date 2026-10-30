import type { ReactNode } from 'react'

/** Centered loading / empty / error line for a ⌘K page's result list. */
export function StatusRow({ icon, text, tone }: { icon?: ReactNode; text: string; tone?: 'error' }) {
  return (
    <div className="icp-status" data-tone={tone}>
      {icon}
      {text}
    </div>
  )
}
