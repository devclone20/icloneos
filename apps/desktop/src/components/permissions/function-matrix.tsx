import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import {
  F2_LOOSENING_ENABLED,
  FUNCTION_CEILING_KEYS,
  FUNCTION_LEVELS,
  type FunctionLevel,
  type FunctionLevels,
  levelOffered,
  PERMISSION_FUNCTIONS,
  type PermissionFunction,
  type SetFunctionLevelResultView
} from '@/iclone-shared/permissions'
import { triggerHaptic } from '@/lib/haptics'
import { requestFunctionLevel } from '@/store/permissions'

/**
 * V3-F2 — Settings › Agent › Permissions › Functions: one row per function, one radio cell per level. Every cell carries
 * `data-perm-mode-confirm` and calls main synchronously in its own click handler (main refuses without that click). A
 * raise is confirmed on a system dialog main shows with the old → new level; a lowering applies at once. The window
 * never decides: the marked cell is main's state, re-read after every change main announces.
 */
// r5 contingency: the columns the pane offers (all six, or the three tightening levels) — static class names
const GRID_COLUMNS: Readonly<Record<number, string>> = {
  6: 'grid-cols-[minmax(12rem,1fr)_repeat(6,minmax(3.5rem,auto))]',
  3: 'grid-cols-[minmax(12rem,1fr)_repeat(3,minmax(3.5rem,auto))]'
}

/**
 * V3-ON r2 (lead, minor 3) — the Set up sheet's layout: the names wrap in the space left, every level column keeps its
 * header's own width (never overlapping), and below that minimum the matrix region scrolls sideways. Settings keeps
 * the base layout above (`layout` defaults to 'scroll').
 */
const FIT_GRID: Readonly<Record<number, string>> = {
  6: 'grid w-full grid-cols-[minmax(12rem,1fr)_repeat(6,max-content)]',
  3: 'grid w-full grid-cols-[minmax(12rem,1fr)_repeat(3,max-content)]'
}

export function FunctionMatrix({
  levels,
  ceilings,
  layout = 'scroll',
  sealed,
  unconfirmed = []
}: {
  levels: FunctionLevels
  ceilings: Record<string, 'off' | 'on' | 'undecided'>
  /**
   * False when the master key is not sealed in the system keychain. Every cell stays clickable and the choice is kept
   * (owner's decision) — but nothing wider than Manual is in force, so the matrix says so instead of
   * letting the user believe a marked level is doing something.
   */
  sealed: boolean
  /**
   * Functions whose marked level was chosen while unsealed. No system dialog was shown for it, so it is not in force:
   * the cell reads as pending and a click on it opens the dialog that puts it in force (review s4, M1).
   */
  unconfirmed?: readonly PermissionFunction[]
  /** 'scroll' (Settings, the base): max-content grid. 'fit' (the Set up sheet): names wrap, columns never overlap. */
  layout?: 'fit' | 'scroll'
}) {
  const copy = useI18n().t.settings.permissions.functions
  // r5 contingency: with the loosening levels off, their cells are not offered at all
  const offered = FUNCTION_LEVELS.filter(level => levelOffered(level, F2_LOOSENING_ENABLED))
  const [error, setError] = useState<string | null>(null)

  const settle = (result: Promise<SetFunctionLevelResultView>) =>
    void result.then(
      outcome => {
        if (outcome.ok) {
          setError(null)
          triggerHaptic('success')
        } else if (outcome.error === 'confirm') {
          // "Keep the current level" on the system dialog: the user chose, nothing to explain. Main only returns this
          // for a dialog that was really shown and really answered — a dialog that could not be shown comes back as
          // `invalid` with its own reason, so this branch can no longer hide a cell that simply did nothing.
          setError(null)
        } else {
          // `invalid` names its cause (no dialog could be shown, the level moved meanwhile, …): showing main's own
          // sentence is the difference between an explained refusal and a button that looks broken.
          setError(outcome.error === 'gesture' ? copy.refused.gesture : outcome.message || copy.refused.invalid)
        }
      },
      () => setError(copy.refused.unavailable)
    )

  const choose = (fn: PermissionFunction, level: FunctionLevel) => {
    triggerHaptic('selection')
    settle(requestFunctionLevel({ fn, level }))
  }

  return (
    <div data-permission-functions="">
      <div className="overflow-x-auto">
        <div
          className={`${layout === 'fit' ? FIT_GRID[offered.length] : `grid min-w-max ${GRID_COLUMNS[offered.length]}`} items-start text-[0.8125rem]`}
        >
          <span aria-hidden="true" />
          {offered.map(level => (
            <span
              className="px-1 py-1.5 text-center text-[0.6875rem] leading-4 whitespace-nowrap text-(--ui-text-tertiary)"
              key={level}
              title={copy.levels[level].summary}
            >
              {copy.columns[level]}
            </span>
          ))}
          {PERMISSION_FUNCTIONS.map(fn => {
            const name = copy.functions[fn].name
            // R2-m6: every switch the row can meet; OFF refuses, undecided (or not named) asks first.
            const keys = FUNCTION_CEILING_KEYS[fn]

            const capped = keys.some(key => ceilings[key] === 'off')
              ? copy.capped
              : keys.some(key => (ceilings[key] ?? 'undecided') === 'undecided')
                ? copy.cappedUndecided
                : null

            return (
              <div aria-label={name} className="contents" data-permission-function={fn} key={fn} role="radiogroup">
                <div className="border-t border-(--ui-stroke-tertiary) py-2 pe-3">
                  <div className="leading-5">{name}</div>
                  <div className="text-[0.75rem] leading-4 text-(--ui-text-tertiary)">{copy.functions[fn].detail}</div>
                  {capped ? (
                    <div
                      className={`pt-0.5 text-[0.75rem] leading-4 ${capped === copy.capped ? 'text-destructive' : 'text-(--ui-text-tertiary)'}`}
                      data-permission-capped={capped === copy.capped ? 'off' : 'undecided'}
                    >
                      {capped}
                    </div>
                  ) : null}
                </div>
                {offered.map(level => {
                  const current = levels[fn] === level
                  // Chosen unsealed and never confirmed: marked, not in force, and clicking it asks for the dialog.
                  const pending = current && sealed && unconfirmed.includes(fn)
                  // The level actually in force on a pending row (Manual, ruling 71 as amended): marked so the eye does not
                  // read the dimmed choice as the rule in force.
                  const inForceWhilePending = !current && level === 'manual' && sealed && unconfirmed.includes(fn)

                  return (
                    <div className="flex justify-center border-t border-(--ui-stroke-tertiary) px-1 py-2" key={level}>
                      <Tip label={copy.levels[level].summary}>
                        <Button
                          aria-checked={current}
                          aria-label={(pending ? copy.levelPendingAria : copy.levelAria)(name, copy.levels[level].name)}
                          data-perm-fn-level={level}
                          data-perm-in-force={inForceWhilePending ? '' : undefined}
                          data-perm-mode-confirm=""
                          data-perm-unconfirmed={pending ? '' : undefined}
                          onClick={current && !pending ? undefined : () => choose(fn, level)}
                          role="radio"
                          size="icon-xs"
                          variant="ghost"
                        >
                          <Codicon
                            className={
                              current && !pending
                                ? undefined
                                : inForceWhilePending
                                  ? 'text-(--ui-text-secondary)'
                                  : 'text-(--ui-text-tertiary)'
                            }
                            name={current || inForceWhilePending ? 'circle-large-filled' : 'circle-large-outline'}
                            size="0.875rem"
                          />
                        </Button>
                      </Tip>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
      {sealed ? null : (
        <p className="pt-2 text-[0.75rem] leading-4 text-(--ui-text-tertiary)" data-permission-unsealed="" role="note">
          {copy.unsealed}
        </p>
      )}
      {sealed && unconfirmed.length > 0 ? (
        <p
          className="pt-2 text-[0.75rem] leading-4 text-(--ui-text-tertiary)"
          data-permission-unconfirmed=""
          role="note"
        >
          {copy.unconfirmed(unconfirmed.map(fn => copy.functions[fn].name).join(', '))}
        </p>
      ) : null}
      <p className="pt-2 text-[0.75rem] leading-4 text-(--ui-text-tertiary)">{copy.touchNote}</p>
      {error ? (
        <p className="pt-2 text-[0.75rem] leading-4 text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
