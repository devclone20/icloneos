/**
 * iclone os — an expired Virtuals session is a verdict, not a symptom.
 *
 * The CLI refreshes its access token on its own and rotates the refresh token
 * when it does: a read that raced another call's refresh, or hit a network
 * blip mid-refresh, prints the same "Session expired." as a dead session. One
 * such answer used to put "Sign in again" on every Dock app. Now an expiry
 * answer is a verdict only when it closes a RUN of expiry answers for that
 * iNFT that spans at least `gapMs` with no other answer in between: a first
 * sighting is retried at once (alone), and once more when the retry failed
 * before the gap had passed; any other answer ends the run, and so does a
 * successful write (`settled`: the sign-in wizard is a write). A run nobody
 * sighted for `staleMs` is over, and a sighting that comes more than `gapMs`
 * after the run's last one is retried once before it may close the run (a
 * sign-in may have happened that the gate never saw). Reads run in parallel, so a retry that
 * fails after another read SUCCEEDED in the meantime is not consecutive: it is
 * handed back through `unconfirmed`, never as a verdict. Writes are never
 * retried. Pure — the caller injects the clock and the wait.
 */
import { sleep as defaultSleep } from '../src/iclone-shared/async'

/** The Virtuals CLI's words for an expired per-iNFT ACP session (mirrors ACP_SESSION_EXPIRED in econ/cli.ts). */
export const ACP_SESSION_EXPIRED_RE =
  /not authenticated|NOT_AUTHENTICATED|session expired|not logged in|login required/i

const EXPIRY_CONFIRM_GAP_MS = 1_500
const EXPIRY_RUN_STALE_MS = 60_000

interface ExpiryGateDeps {
  gapMs?: number
  staleMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

type Call<R> = () => Promise<R>

interface ExpiryGate {
  /** Run a READ; an expiry answer is returned only once confirmed (`retry` runs at most twice). An expiry
   *  answer that cannot be confirmed comes back as `unconfirmed(answer)`. */
  confirm<R>(
    slug: string,
    first: Call<R>,
    retry: Call<R>,
    expired: (r: R) => boolean,
    unconfirmed: (r: R) => R
  ): Promise<R>
  /** Without `unconfirmed`, an expiry answer that cannot be confirmed comes back as `undefined`. */
  confirm<R>(slug: string, first: Call<R>, retry: Call<R>, expired: (r: R) => boolean): Promise<R | undefined>
  /** A call that is not a read succeeded (a sign-in among them): it ends the run like a read's success. */
  settled(slug: string): void
  /** When the open run of expiry answers for this iNFT started (tests, diagnostics). */
  suspectSince(slug: string): number | undefined
}

interface ExpiryRun {
  since: number
  last: number
}

export function createExpiryGate({
  gapMs = EXPIRY_CONFIRM_GAP_MS,
  staleMs = EXPIRY_RUN_STALE_MS,
  now = Date.now,
  sleep = defaultSleep
}: ExpiryGateDeps = {}): ExpiryGate {
  const runs = new Map<string, ExpiryRun>()
  // Bumped by every non-expiry answer: two sightings are consecutive only under the same generation.
  const generations = new Map<string, number>()
  const generation = (slug: string) => generations.get(slug) ?? 0

  const answered = (slug: string) => {
    runs.delete(slug)
    generations.set(slug, generation(slug) + 1)
  }

  // A sighting joins the open run while it is live, else it starts a new one.
  const sighted = (slug: string): ExpiryRun => {
    const at = now()
    const open = runs.get(slug)
    const run = open && at - open.last <= staleMs ? { since: open.since, last: at } : { since: at, last: at }

    runs.set(slug, run)

    return run
  }

  async function confirm<R>(
    slug: string,
    first: Call<R>,
    retry: Call<R>,
    expired: (r: R) => boolean,
    unconfirmed?: (r: R) => R
  ): Promise<R | undefined> {
    const result = await first()

    if (!expired(result)) {
      answered(slug)

      return result
    }

    const before = generation(slug)

    // A retry's answer: a success ends the run; a failure after another read's success is not consecutive.
    const judge = (answer: R): R | undefined => {
      if (!expired(answer)) {
        answered(slug)

        return answer
      }

      const consecutive = generation(slug) === before

      sighted(slug)

      return consecutive ? answer : unconfirmed?.(answer)
    }

    const previous = runs.get(slug)?.last
    const run = sighted(slug)

    // A failure that closes a live run spanning the gap is the verdict; a quiet run is retried first.
    if (previous !== undefined && run.last - previous < gapMs && run.last - run.since >= gapMs) {
      return result
    }

    // Retry at once: the retry runs alone, after every call in flight (a refresh among them).
    const again = await retry()

    if (!expired(again) || generation(slug) !== before) {
      return judge(again)
    }

    const wait = sighted(slug).since + gapMs - now()

    if (wait <= 0) {
      return again
    }

    await sleep(wait)

    return judge(await retry())
  }

  return {
    confirm: confirm as ExpiryGate['confirm'],
    settled: answered,
    suspectSince: slug => runs.get(slug)?.since
  }
}
