import { describe, expect, it } from 'vitest'

import { screenTimeline } from '@/iclone-shared/screen-timeline'

import { type ScreenRecordResult, timelineAfterRemoval, timelineDelivered } from './screen-record'

const recording = (folder: string, times: number[], over: Partial<ScreenRecordResult> = {}): ScreenRecordResult => {
  const frames = times.map(tMs => ({ path: `${folder}/screen-t${String(tMs / 1000).padStart(3, '0')}s.png`, tMs }))
  const base = { blankDropped: 0, durationMs: 12_000, hitTimeLimit: false, thinnedFrom: times.length, ...over }

  return { ...base, folder, frames, timeline: screenTimeline({ ...base, frames }) }
}

describe('a frame taken off the message', () => {
  it('B5: the text is rebuilt from the frames that remain: count, numbers and times, in order', () => {
    const result = recording('/s/a', [0, 3000, 7000, 12_000])

    timelineDelivered(result)

    expect(timelineAfterRemoval('/s/a/screen-t003s.png')).toEqual({
      from: result.timeline,
      to: 'Screen recording, 12 s of the whole screen, 3 frames attached in this order, each taken when the screen changed. Frame times: 1 t+0 s, 2 t+7 s, 3 t+12 s. 1 frame was taken off by the user.'
    })
  })

  it('B5: a second removal starts from the text the first one wrote; the last frame takes the text with it', () => {
    const result = recording('/s/b', [0, 5000])

    timelineDelivered(result)

    const first = timelineAfterRemoval('/s/b/screen-t000s.png')

    expect(first?.to).toBe(
      'Screen recording, 12 s of the whole screen, 1 frame attached in this order, each taken when the screen changed. Frame times: 1 t+5 s. 1 frame was taken off by the user.'
    )
    expect(timelineAfterRemoval('/s/b/screen-t005s.png')).toEqual({ from: first?.to, to: '' })
    expect(timelineAfterRemoval('/s/b/screen-t005s.png')).toBeNull()
  })

  it('B5: the limit and the blank captures stay said; another recording in the message is not touched', () => {
    const one = recording('/s/c', [0, 1000, 2000], { blankDropped: 2, hitTimeLimit: true })
    const two = recording('/s/d', [0, 1000])

    timelineDelivered(one)
    timelineDelivered(two)

    expect(timelineAfterRemoval('/s/c/screen-t001s.png')?.to).toBe(
      'Screen recording, 12 s of the whole screen, 2 frames attached in this order, each taken when the screen changed. Frame times: 1 t+0 s, 2 t+2 s. 1 frame was taken off by the user. It stopped at the 5 minute limit. 2 blank captures were left out.'
    )
    expect(timelineAfterRemoval('/s/d/screen-t000s.png')?.from).toBe(two.timeline)
  })

  it('minor 6: a removal is never told as thinning; real thinning keeps its own sentence and count, each removal adds to its own', () => {
    const untouched = recording('/s/e', [0, 1000, 2000], { thinnedFrom: 40 })

    expect(untouched.timeline).toContain('The screen changed 40 times; 3 frames were kept across the whole span.')

    timelineDelivered(untouched)

    const first = timelineAfterRemoval('/s/e/screen-t000s.png')?.to

    expect(first).toContain('The screen changed 40 times; 3 frames were kept across the whole span. 1 frame was taken off by the user.')
    expect(timelineAfterRemoval('/s/e/screen-t001s.png')?.to).toContain('3 frames were kept across the whole span. 2 frames were taken off by the user.')
  })

  it('a file no recording delivered changes nothing', () => {
    expect(timelineAfterRemoval('/s/none/screen-t000s.png')).toBeNull()
  })
})
