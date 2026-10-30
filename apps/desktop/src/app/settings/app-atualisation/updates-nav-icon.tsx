import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { type IconComponent, RefreshCw } from '@/lib/icons'
import { $agentCompatFlag, watchAgentCompatFlag } from '@/store/agent-update'

/**
 * The Updates row of the Settings nav. A RED compatibility verdict for the agent shows as a quiet dot here and as the
 * banner inside the pane — the passive replacement for the old OS notification. The flag is main's local reading.
 */
function UpdatesNavIconView({ className }: { className?: string }) {
  const red = useStore($agentCompatFlag)?.red ?? false

  useEffect(() => watchAgentCompatFlag(), [])

  return (
    <span className="relative inline-flex" data-agent-compat-red={red || undefined}>
      <RefreshCw aria-hidden className={className} />
      {red && (
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-red-400 ring-2 ring-(--ui-bg-primary)"
        />
      )}
    </span>
  )
}

UpdatesNavIconView.displayName = 'UpdatesNavIcon'

export const UpdatesNavIcon = UpdatesNavIconView as IconComponent
