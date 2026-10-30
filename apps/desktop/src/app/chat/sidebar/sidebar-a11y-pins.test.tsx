import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { SidebarDateDivider } from './chrome'

afterEach(cleanup)

describe('sidebar a11y pins', () => {
  // The row age (U4-p2-12) is pinned by session-row.test.tsx, which renders the
  // row and reads the <time>; the session-ref anchor (F-r3-A11Y) by
  // markdown-text.session.test.tsx, which reads the link's accessible name.
  it('the date divider label uses the tertiary ramp (≥ 4.5:1), not quaternary (U4-p2-05)', () => {
    render(<SidebarDateDivider label="Yesterday" />)

    const label = screen.getByText('Yesterday')

    expect(label.className).toContain('text-(--ui-text-tertiary)')
    expect(label.className).not.toContain('quaternary')
  })

  it('the preview source line carries aria-label, never a native title (F-r3-A11Y)', () => {
    // preview-file.tsx needs a live right-rail store to render; its one
    // clickable non-button is pinned at the source until that harness exists.
    const source = readFileSync(resolve(__dirname, '../right-rail/preview-file.tsx'), 'utf8')

    expect(source).toContain('aria-label={filePath ? t.preview.sourceLineTitle')
    expect(source).not.toContain('title={filePath ? t.preview.sourceLineTitle')
  })
})
