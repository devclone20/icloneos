/** The email data module's `addresses` section — its public names are re-exported by ../email-data.ts. */
import { asArray, type Json, str } from '../../cli'

import type { MailAddress } from './types'

// ── addresses ───────────────────────────────────────────────────────────────

/** `Jane Doe <jane@x.com>` → { name, address }; a bare address has no name. */
export function parseAddress(value: string): MailAddress {
  const trimmed = (value ?? '').trim()
  const open = trimmed.lastIndexOf('<')

  if (open >= 0 && trimmed.endsWith('>')) {
    const name = trimmed
      .slice(0, open)
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .trim()

    return { name, address: trimmed.slice(open + 1, -1).trim() }
  }

  return { name: '', address: trimmed }
}

// A transactional sender is a machine id at a notify subdomain
// (`010001a0…-000000@send.notify.agentcard.ai`): the id says nothing, the
// brand does — so the label becomes the registrable domain.
const MACHINE_LOCAL_PART = /^[0-9a-f-]{20,}$/i

export function addressLabel(address: MailAddress): string {
  if (address.name) {
    return address.name
  }

  const at = address.address.indexOf('@')

  if (at > 0 && MACHINE_LOCAL_PART.test(address.address.slice(0, at))) {
    const labels = address.address
      .slice(at + 1)
      .toLowerCase()
      .split('.')

    return labels.slice(-2).join('.')
  }

  return address.address
}

export function recipients(record: Json): MailAddress[] {
  const listed = asArray(record.to).filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  const raw = listed.length > 0 ? listed : str(record, 'toAddress').split(',')

  return raw.map(parseAddress).filter(address => address.address !== '')
}

export function sender(record: Json): MailAddress {
  const display = parseAddress(str(record, 'from'))

  return { name: display.name, address: str(record, 'fromAddress') || display.address }
}
