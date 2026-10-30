import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'

import { IcField } from '../command-center/ui/field'

import { DeliverCheckboxes } from './deliver-checkboxes'

afterEach(cleanup)

// Regression for the delivery-target group losing its accessible name: `Field`
// renders the visible label as `<label htmlFor>`, which only associates with
// labelable elements (input, select, ...) — not a `div[role="group"]`. The
// group must pick up the label via `aria-labelledby` instead.
describe('DeliverCheckboxes accessible name', () => {
  it('exposes the Field label as the group name', () => {
    render(
      <IcField htmlFor="cron-deliver" label={en.cron.deliverLabel}>
        <DeliverCheckboxes
          c={en.cron}
          id="cron-deliver"
          onChange={() => {}}
          targets={[{ home_env_var: null, home_target_set: true, id: 'local', name: 'This desktop' }]}
          value="local"
        />
      </IcField>
    )

    expect(screen.getByRole('group', { name: en.cron.deliverLabel })).toBeTruthy()
  })
})
