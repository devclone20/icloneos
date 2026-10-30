import type { CronDeliveryTarget } from '@/hermes'
import type { Translations } from '@/i18n'

import { IcCheck, IcChecks } from '../command-center/ui/field'

import { parseCronDeliveryTargets, toggleCronDeliveryTarget } from './cron-job-model'

// Label a cron delivery target: 'local' → localized "This desktop", known
// platforms → their delivery label, anything else → the backend name. Configured
// platforms without a cron home channel get a "set a home channel first" hint.
function deliverTargetLabel(target: CronDeliveryTarget, c: Translations['cron']): string {
  const base = target.id === 'local' ? c.deliveryLabels.local : (c.deliveryLabels[target.id] ?? target.name)

  return target.id !== 'local' && !target.home_target_set ? `${base} — ${c.deliverNeedsHomeChannel}` : base
}

// The delivery-target checkbox group, shared by the manual cron editor and the
// blueprint form. The scheduler accepts comma-separated targets, so users can
// keep results local while also sending them to connected platforms. Preserve
// selected targets missing from discovery so editing never drops a saved route.
export function DeliverCheckboxes({
  c,
  id,
  onChange,
  targets,
  value
}: {
  c: Translations['cron']
  id: string
  onChange: (next: string) => void
  targets: CronDeliveryTarget[]
  value: string
}) {
  const selected = parseCronDeliveryTargets(value)
  const knownIds = new Set(targets.map(target => target.id))

  const options = [
    ...targets,
    ...selected
      .filter(target => !knownIds.has(target))
      .map(target => ({ home_env_var: null, home_target_set: true, id: target, name: target }))
  ]

  return (
    <IcChecks id={id} labelledBy={`${id}-label`}>
      {options.map((target, index) => (
        <IcCheck
          checked={selected.includes(target.id)}
          id={`${id}-${index}`}
          key={target.id}
          label={deliverTargetLabel(target, c)}
          onChange={next => onChange(toggleCronDeliveryTarget(value, target.id, next))}
        />
      ))}
    </IcChecks>
  )
}
