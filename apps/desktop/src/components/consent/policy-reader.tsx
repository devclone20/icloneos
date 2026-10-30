import { useEffect, useState } from 'react'

import { useConsentCopy } from './copy'
import { consentBridge } from './store'
import type { PolicyBlock } from './types'

const BODY = 'text-[0.8125rem] leading-5 text-(--ui-text-secondary)'

/** The bundled policy as plain text (main parses it; no markup ever reaches the renderer). */
export function PolicyReader() {
  const copy = useConsentCopy().sheet
  const [blocks, setBlocks] = useState<PolicyBlock[] | null | undefined>(undefined)

  useEffect(() => {
    let live = true

    void (consentBridge()?.policyText() ?? Promise.resolve(null)).then(
      value => live && setBlocks(value),
      () => live && setBlocks(null)
    )

    return () => {
      live = false
    }
  }, [])

  return (
    <div
      aria-label={copy.readOffline}
      className="max-h-[50dvh] overflow-y-auto rounded-lg border border-(--stroke-nous) px-4 py-3"
      data-consent-reader=""
      role="document"
      tabIndex={0}
    >
      {blocks === null ? <p className={BODY}>{copy.offlineUnavailable}</p> : null}
      {(blocks ?? []).map((block, index) => {
        const key = `${index}-${block.kind}`

        if (block.kind === 'title') {
          return (
            <h3 className="text-[0.9375rem] font-semibold tracking-tight" key={key}>
              {block.text}
            </h3>
          )
        }

        if (block.kind === 'heading') {
          return (
            <h4 className="mt-4 text-[0.8125rem] font-semibold tracking-tight text-foreground" id={block.id} key={key}>
              {block.text}
            </h4>
          )
        }

        if (block.kind === 'meta') {
          return (
            <p className="mt-1 text-[0.75rem] text-(--ui-text-tertiary)" key={key}>
              {block.text}
            </p>
          )
        }

        return (
          <p className={block.kind === 'paragraph' ? `mt-2 ${BODY}` : `mt-1 pl-3 ${BODY}`} key={key}>
            {block.kind === 'item' ? '· ' : ''}
            {block.text}
          </p>
        )
      })}
    </div>
  )
}
