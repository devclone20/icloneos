// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { enPermissions } from '@/i18n/en/enPermissions'
import { PERMISSION_MODES } from '@/iclone-shared/permissions'

import { ModePicker } from './mode-picker'

afterEach(cleanup)

describe('U-1: Settings › Agent › Permissions keeps the full account of every mode', () => {
  it('renders every mode with its name and its whole summary', () => {
    const { container } = render(<ModePicker chosen="manual" inForce="manual" target={{ scope: 'standing', key: null }} />)
    const text = container.textContent ?? ''

    for (const mode of PERMISSION_MODES) {
      expect(text).toContain(enPermissions.modes[mode].name)
      expect(text).toContain(enPermissions.modes[mode].summary)
    }
  })

  it('the project scope shows the same summaries', () => {
    const { container } = render(<ModePicker chosen="plan" inForce="plan" target={{ scope: 'project', key: '/p' }} />)

    for (const mode of PERMISSION_MODES) {
      expect(container.textContent).toContain(enPermissions.modes[mode].summary)
    }
  })
})
