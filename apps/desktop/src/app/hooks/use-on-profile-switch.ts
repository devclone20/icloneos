import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'

import { $activeGatewayProfile } from '@/store/profile'

/** Run `onSwitch` when the active gateway profile changes — never on first
 *  mount. For dropping per-profile view state (probes, cached usage, drafts)
 *  when the backend the app talks to swaps underneath a still-mounted view.
 *
 *  The guard remembers the profile it last SAW, not "have I run before".
 *  A boolean latch is wrong under StrictMode: React mounts, unmounts and
 *  re-mounts every effect on the first commit, so the second invocation found
 *  the latch already down and fired a switch that never happened — wiping the
 *  freshly seeded state of every consumer (Settings' config draft went null
 *  and the pane sat on its skeleton forever, whenever the config query was
 *  already warm). Comparing the value is idempotent: a repeated mount sees the
 *  same profile and does nothing; a real switch still fires exactly once. */
export function useOnProfileSwitch(onSwitch: () => void): void {
  const profile = useStore($activeGatewayProfile)
  const seenProfile = useRef(profile)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (seenProfile.current === profile) {
      return
    }

    seenProfile.current = profile
    onSwitch()
    // Fire on profile change only; onSwitch identity is intentionally ignored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile])
}
