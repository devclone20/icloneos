import { describe, expect, it } from 'vitest'

import { replaceDraftText } from './replace-draft-text'

describe('replaceDraftText', () => {
  it('B5: changes that text and leaves what the user wrote around it', () => {
    expect(replaceDraftText('look at this\n\nOLD $& line\n\nthanks', 'OLD $& line', 'NEW $& line')).toBe(
      'look at this\n\nNEW $& line\n\nthanks'
    )
  })

  it('B5: an empty replacement takes the line and its blank line with it', () => {
    expect(replaceDraftText('look at this\n\nOLD\n\nthanks', 'OLD', '')).toBe('look at this\n\nthanks')
    expect(replaceDraftText('OLD', 'OLD', '')).toBe('')
  })

  it('text the user has changed is theirs: nothing happens', () => {
    expect(replaceDraftText('my own words', 'OLD', 'NEW')).toBeNull()
  })
})
