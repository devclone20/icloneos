import { describe, expect, it } from 'vitest'

import { isRestartRequiredError } from './model-restart'

describe('isRestartRequiredError', () => {
  it('recognizes the code-skew refusal as it arrives over IPC', () => {
    const raw =
      'Error invoking remote method \'hermes:api\': Error: 503: {"detail":"Restart required: This dashboard is running ' +
      'code from 1a2b3c4d5e but the checkout on disk is now 6f7a8b9c0d. The model picker would risk a stale-module ' +
      'crash — restart the dashboard to load the new code (systemctl --user restart hermes-dashboard, or hermes ' +
      'dashboard --port <port>)"}'

    expect(isRestartRequiredError(new Error(raw))).toBe(true)
    expect(isRestartRequiredError('503: {detail: Restart required: drift}')).toBe(true)
  })

  it('leaves every other failure alone', () => {
    expect(isRestartRequiredError(new Error('503: {"detail":"Service unavailable"}'))).toBe(false)
    expect(isRestartRequiredError(new Error('500: Restart required'))).toBe(false)
    expect(isRestartRequiredError(new Error('15030: restart required'))).toBe(false)
    expect(isRestartRequiredError(undefined)).toBe(false)
  })
})
