import { useCallback, useEffect, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'

/** The selection a deep link names (?<param>=<id>) on a page that may already be open.
 *  Every navigation that names one selects it, also when it repeats the current URL; a
 *  pick made on the page stands until the next navigation that names one. */
export function useLinkedSelection({
  param
}: {
  param: string
}): readonly [null | string, (id: null | string) => void, null | string] {
  const [searchParams] = useSearchParams()
  // A new key per navigation: the page stays mounted when Settings is already open.
  const { key } = useLocation()
  const linked = searchParams.get(param)
  const [state, setState] = useState({ id: linked, key })

  if (state.key !== key) {
    setState({ id: linked ?? state.id, key })
  }

  const select = useCallback((id: null | string) => setState(previous => ({ ...previous, id })), [])

  // The third entry is the id the current URL names (null when it names none).
  return [state.key === key ? state.id : (linked ?? state.id), select, linked] as const
}

/** What a step named next to a linked selection (?<param>=<id>&step=…) does now: `show` only while
 *  the page's selection IS the linked one; `drop` once the options are known (`options` non-null)
 *  and the link names none of them (the selection fell back) or names nothing; else `wait`. A pick
 *  away from a known link waits, so coming back to it still shows the step. */
export function linkedStepFate({
  linked,
  options,
  selected
}: {
  linked: null | string
  options: null | readonly string[]
  selected: null | string
}): 'drop' | 'show' | 'wait' {
  if (linked !== null && selected === linked) {
    return 'show'
  }

  if (options !== null && (linked === null || !options.includes(linked))) {
    return 'drop'
  }

  return 'wait'
}

/** Applies `linkedStepFate` to the `?<param>=` step: drops it from the URL (replace, no history
 *  entry) when it belongs to no option, and says whether it may be shown now. */
export function useLinkedStep({
  linked,
  options,
  param,
  selected
}: {
  linked: null | string
  options: null | readonly string[]
  param: string
  selected: null | string
}): boolean {
  const [searchParams, setSearchParams] = useSearchParams()
  const fate = searchParams.has(param) ? linkedStepFate({ linked, options, selected }) : 'wait'

  useEffect(() => {
    if (fate !== 'drop') {
      return
    }

    setSearchParams(
      previous => {
        const next = new URLSearchParams(previous)
        next.delete(param)

        return next
      },
      { replace: true }
    )
  }, [fate, param, setSearchParams])

  return fate === 'show'
}
