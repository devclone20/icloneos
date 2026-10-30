import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { $replyAnnouncement, announcementFor, ReplyAnnouncer, useReplyAnnouncement } from './status'

type Content = ReadonlyArray<{ type: string; text?: string }>

/** Stands in for the turn-activity row: it feeds the hook exactly as the row
 *  does and, like the row, renders nothing once the turn is over. */
function TurnRow({ content, running }: { content: Content; running: boolean }) {
  useReplyAnnouncement(running, announcementFor(content))

  return running ? <div data-testid="working" /> : null
}

const announcer = () => globalThis.document.querySelector('[data-slot="aui_reply-announcer"]')

afterEach(() => {
  cleanup()
  $replyAnnouncement.set('')
})

describe('reply announcer (U4-p2-04)', () => {
  it('flattens an assistant message to one plain line', () => {
    expect(
      announcementFor([
        { type: 'text', text: 'Hello.\n\nWhat are we  working on' },
        { type: 'tool-call' },
        { type: 'text', text: 'today?' }
      ])
    ).toBe('Hello. What are we working on today?')
    expect(announcementFor([])).toBe('')
  })

  it('announces the reply once the turn completes, from a node that outlives the row', () => {
    const content: Content = [{ type: 'text', text: 'Done.\nThree files changed.' }]

    const { rerender } = render(
      <>
        <ReplyAnnouncer />
        <TurnRow content={content} running />
      </>
    )

    const region = announcer()

    expect(region).toBeTruthy()
    expect(region?.getAttribute('aria-live')).toBe('polite')
    expect(region?.getAttribute('aria-atomic')).toBe('true')
    expect(region?.textContent).toBe('')

    rerender(
      <>
        <ReplyAnnouncer />
        <TurnRow content={content} running={false} />
      </>
    )

    expect(globalThis.document.querySelector('[data-testid="working"]')).toBeNull()
    expect(globalThis.document.contains(region)).toBe(true)
    expect(region?.textContent).toBe(announcementFor(content))
  })

  it('stays silent while the reply streams and when a turn ends empty', () => {
    const { rerender } = render(
      <>
        <ReplyAnnouncer />
        <TurnRow content={[{ type: 'text', text: 'Hel' }]} running />
      </>
    )

    rerender(
      <>
        <ReplyAnnouncer />
        <TurnRow content={[{ type: 'text', text: 'Hello there' }]} running />
      </>
    )
    expect(announcer()?.textContent).toBe('')

    rerender(
      <>
        <ReplyAnnouncer />
        <TurnRow content={[{ type: 'tool-call' }]} running={false} />
      </>
    )
    expect(announcer()?.textContent).toBe('')
  })
})
