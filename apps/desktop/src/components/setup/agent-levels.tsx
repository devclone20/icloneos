import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { FunctionMatrix } from '@/components/permissions/function-matrix'
import { useI18n } from '@/i18n'
import { F2_LOOSENING_ENABLED, FUNCTION_LEVELS, levelOffered } from '@/iclone-shared/permissions'
import { $permissions, watchPermissions } from '@/store/permissions'

import { useSetupCopy } from './copy'

const NOTE = 'pt-2 text-[0.75rem] leading-4 text-(--ui-text-tertiary)'
const GROUP_TITLE = 'pt-4 pb-1 text-[0.6875rem] font-medium tracking-[0.08em] text-(--ui-text-tertiary) uppercase'
const ITEM = 'text-[0.75rem] leading-4 text-(--ui-text-tertiary)'

/**
 * V3-ON section (c): the per-function levels through the SAME matrix Settings › Agent › Permissions shows (same
 * setter, same lock: each cell is the user's own click, a raise is confirmed on main's native old → new dialog, a
 * lowering applies at once). Nothing is pre-selected here: the marked cell is main's stored level, which ships at
 * Follow mode over the standing Manual mode (every action asks). The never list is read-only.
 */
export function SetupAgentLevels() {
  const copy = useSetupCopy()
  const permissions = useI18n().t.settings.permissions
  const { state, status } = useStore($permissions)

  useEffect(() => watchPermissions(null), [])

  if (status === 'unavailable') {
    return <p className={NOTE}>{copy.agent.unavailable}</p>
  }

  if (!state) {
    return null
  }

  const offered = FUNCTION_LEVELS.filter(level => levelOffered(level, F2_LOOSENING_ENABLED))

  return (
    <div data-setup-rows="agent">
      <FunctionMatrix
        ceilings={state.ceilings}
        layout="fit"
        levels={state.functions}
        sealed={state.sealed}
        unconfirmed={state.unconfirmed}
      />
      <p className={NOTE}>{copy.agent.raise}</p>
      <h4 className={GROUP_TITLE}>{copy.agent.levels}</h4>
      <ul className="grid gap-1.5" data-setup-levels="">
        {offered.map(level => (
          <li className={ITEM} data-setup-level={level} key={level}>
            <span className="font-medium text-foreground">{permissions.functions.levels[level].name}</span>{' '}
            {permissions.functions.levels[level].summary}
          </li>
        ))}
      </ul>
      <h4 className={GROUP_TITLE}>{permissions.floor.title}</h4>
      <ul className="grid gap-1.5" data-setup-floors="">
        {permissions.floor.items.map(item => (
          <li className={ITEM} key={item}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}
