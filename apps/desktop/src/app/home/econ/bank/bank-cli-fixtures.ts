/**
 * Test fixtures: `acp card … --json` answers exactly as the bundled CLI
 * (@virtuals-protocol/acp-cli 1.0.38, dist/bin/acp.js) prints them, after the
 * bridge's redaction (no PAN/CVV/expiry/ZIP/cardholderName). Imported by
 * tests only.
 */

export const CLI_WHOAMI = { email: 'pat@example.com', verified: true }

export const CLI_WHOAMI_UNVERIFIED = {
  email: 'pat@example.com',
  verified: false,
  nextStep: { hint: 'Magic link sent but not clicked', endpoint: 'GET /agents/:id/card/signup/poll' }
}

export const CLI_LIMIT = { spendLimitCents: 5000, spentCents: 1200, remainingCents: 3800 }

export const CLI_PROFILE = {
  email: 'pat@example.com',
  firstName: 'Pat',
  lastName: 'One',
  phoneNumber: '+14155551234',
  paymentMethod: { brand: 'visa', last4: '4242' },
  spendLimitCents: 5000,
  locked: false
}

export const CLI_REQUEST_CAPTURED = {
  id: 'sr_8f2c41d09a7e',
  amountCents: 1200,
  status: 'captured',
  createdAt: '2026-09-25T10:00:00.000Z',
  expiresAt: '2026-09-25T11:00:00.000Z',
  issuedAt: '2026-09-25T10:00:05.000Z',
  capturedAmountCents: 1140,
  capturedAt: '2026-09-25T10:03:00.000Z',
  last4: '4242'
}

export const CLI_REQUEST_OPEN = {
  id: 'sr_1b9e77c2f310',
  amountCents: 2500,
  status: 'issued',
  createdAt: '2026-09-26T09:00:00.000Z',
  expiresAt: '2026-09-26T10:00:00.000Z',
  issuedAt: '2026-09-26T09:00:04.000Z',
  capturedAmountCents: null,
  last4: '1881'
}

export const CLI_LIST = { requests: [CLI_REQUEST_CAPTURED, CLI_REQUEST_OPEN] }

export function cli3ds(receivedAt: string, code = '482913', amount = 12) {
  return { codes: [{ code, amount, receivedAt }] }
}

export const CLI_REAUTH = 'HTTP 401: {"message":"REAUTH:abc-123:pat@example.com"}'
export const CLI_NOT_SIGNED_UP = 'HTTP 400: {"message":"Call card signup first."}'
/** The Virtuals CLI when the iNFT's ACP session expired — says nothing about the card. */
export const CLI_NOT_AUTHENTICATED =
  '{"error":"Not authenticated.","code":"NOT_AUTHENTICATED","recovery":"Run `acp configure` to authenticate."}'
