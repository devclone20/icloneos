import './ic-ui.css'

import { IcSkeleton } from './feedback'

/** A log/stream tail: plain text, selectable, never a virtual list (the pages
 *  that use it fetch a bounded tail). */
export function IcMonoLines({ emptyLabel, lines }: { emptyLabel: string; lines: readonly string[] | null }) {
  if (lines === null) {
    return (
      <pre className="icui-mono">
        <IcSkeleton label={emptyLabel} rows={4} />
      </pre>
    )
  }

  return (
    <pre className="icui-mono" data-selectable-text="true">
      {lines.length === 0 ? emptyLabel : lines.join('\n')}
    </pre>
  )
}
