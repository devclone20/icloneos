import type { AutomationBlueprint, AutomationBlueprintField } from '@/hermes'

import { IcSelect, IcTextInput } from '../command-center/ui/field'

// The blueprint catalog is shared with the dashboard, so its deliver slot
// defaults to "origin" (the chat/home-channel a dashboard or gateway job was
// created from). Desktop has no origin chat, so seed the deliver slot to the
// desktop's native target ("local" = This desktop) instead. The dialog then
// renders that slot with the shared DeliverSelect (backend-sourced targets), so
// the raw "origin" option never reaches the desktop UI.
const DELIVER_FIELD = 'deliver'
const DESKTOP_DELIVER_DEFAULT = 'local'

function isDeliverField(field: AutomationBlueprintField): boolean {
  return field.name === DELIVER_FIELD
}

// Initial form state for a blueprint = each field's default (or ''). Pure so the
// suite can assert the form seeds correctly without mounting React. The deliver
// slot is special-cased: an "origin" default (or empty) becomes "local" so a
// desktop-created job delivers to This desktop instead of nowhere.
export function initialBlueprintValues(blueprint: AutomationBlueprint): Record<string, string> {
  const out: Record<string, string> = {}

  for (const field of blueprint.fields) {
    const seeded = field.default ?? ''
    out[field.name] = isDeliverField(field) && (seeded === '' || seeded === 'origin') ? DESKTOP_DELIVER_DEFAULT : seeded
  }

  return out
}

// A slot-level validation error from the backend arrives as "422: <message>"
// (or "<code>: <message>"); strip the leading numeric code for inline display.
export function cleanBlueprintFieldError(message: string): string {
  return message.replace(/^\d+:\s*/, '')
}

// Help text to show under a slot control. The backend deliver help is
// origin/dashboard-centric and even contradicts desktop semantics ("local =
// save only" vs. This desktop), and the DeliverSelect is self-explanatory —
// skip it for the deliver slot.
export function blueprintSlotHelp(field: AutomationBlueprintField): string | undefined {
  return field.help && field.type !== 'text' && !isDeliverField(field) ? field.help : undefined
}

// Renders one blueprint slot's control (enum/weekdays → select, time → time
// input, else text). The deliver slot is handled separately by the dialog's
// shared DeliverCheckboxes, so it's not rendered here.
export function BlueprintSlotControl({
  field,
  id,
  onChange,
  value
}: {
  field: AutomationBlueprintField
  id: string
  onChange: (next: string) => void
  value: string
}) {
  if (field.type === 'enum' || field.type === 'weekdays') {
    return (
      <IcSelect
        id={id}
        onChange={onChange}
        options={field.options.map(option => ({ label: option, value: option }))}
        value={value}
      />
    )
  }

  if (field.type === 'time') {
    return <IcTextInput id={id} onChange={onChange} type="time" value={value} />
  }

  return <IcTextInput id={id} onChange={onChange} placeholder={field.help || field.label} value={value} />
}
