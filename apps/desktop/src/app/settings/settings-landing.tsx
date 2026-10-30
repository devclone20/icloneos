import { Codicon } from '@/components/ui/codicon'

import { OVERLAY_FOCUS_OUTLINE } from '../overlays/overlay-split-layout'

import type { SettingsGroupDoor, SettingsPaneId } from './panes'
import { SettingsContent } from './primitives'

/**
 * What Settings shows when it opens with no destination (lead decision S8.5,
 * 2026-10-20): no pane, no current rail row — the four groups as doors, each
 * its name and one sentence. A door opens its group and that group's first pane.
 */
export function SettingsLanding({
  doors,
  onOpen
}: {
  doors: readonly SettingsGroupDoor[]
  onOpen: (pane: SettingsPaneId) => void
}) {
  return (
    <SettingsContent>
      <nav className="flex max-w-2xl flex-col gap-1 pt-2" data-settings-landing="">
        {doors.map(door => (
          <button
            className={`group/door -mx-2 flex items-center gap-4 rounded-(--ic-radius-md) px-2 py-3 text-start outline-none transition-colors duration-(--ic-dur-fast) ease-(--ic-ease-std) hover:bg-(--ic-fill-hover) focus-visible:bg-(--ic-fill-hover) motion-reduce:transition-none ${OVERLAY_FOCUS_OUTLINE}`}
            data-settings-door={door.id}
            key={door.id}
            onClick={() => onOpen(door.firstPane)}
            type="button"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[length:var(--conversation-text-font-size)] leading-snug font-medium text-(--ic-text-1)">
                {door.label}
              </span>
              <span className="mt-0.5 block text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ic-text-2)">
                {door.sentence}
              </span>
            </span>
            <Codicon
              aria-hidden
              className="shrink-0 text-(--ic-text-3) transition-colors group-hover/door:text-(--ic-text-2) rtl:rotate-180"
              name="chevron-right"
              size="1em"
            />
          </button>
        ))}
      </nav>
    </SettingsContent>
  )
}
