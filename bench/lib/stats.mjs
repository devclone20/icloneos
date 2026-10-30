// Sample statistics for the bench harness. Percentiles use the nearest-rank method (no interpolation): the reported
// p95 is always a value that was actually observed.

export class HarnessError extends Error {
  constructor(message) {
    super(message)
    this.name = 'HarnessError'
  }
}

/** The p-th percentile (0 < p <= 100) of an ascending array by nearest rank: the value at rank ceil(p/100 * n). */
export function nearestRank(sorted, p) {
  if (!(p > 0 && p <= 100)) {
    throw new HarnessError(`percentile out of range: ${p}`)
  }
  if (!sorted.length) {
    throw new HarnessError('percentile of an empty sample')
  }
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

/** Nearest-rank percentile of an unsorted array (sorts a copy). The one percentile helper rows use. */
export function percentile(samples, p) {
  return nearestRank(
    [...samples].sort((a, b) => a - b),
    p
  )
}

/** Nearest-rank median (the lower middle for an even n): an observed value, never an average. */
export function median(samples) {
  return percentile(samples, 50)
}

/**
 * Validate one sample array and summarise it. A timing that is 0, negative, NaN or infinite is a broken instrument,
 * never a fast result; fewer samples than `minN` is not a measurement either. A deviation metric (lateness, drift) or a
 * paired difference (A - B of one pair) may legitimately be 0 or negative: a row that declares `allow_nonpositive`
 * passes `allowNonpositive`, which then only refuses non-finite values.
 * With nearest rank, p95 of n < 20 samples is the sample maximum; `p95_is_max` says so.
 */
export function summarize(samples, { minN, label, allowNonpositive = false }) {
  if (!Array.isArray(samples)) {
    throw new HarnessError(`${label}: samples must be an array, got ${typeof samples}`)
  }
  const bad = samples.filter(v => typeof v !== 'number' || !Number.isFinite(v) || (!allowNonpositive && v <= 0))
  if (bad.length) {
    throw new HarnessError(
      `${label}: ${bad.length} invalid sample(s) (0, negative, NaN or non-numeric): ${bad.slice(0, 3)}`
    )
  }
  if (samples.length < minN) {
    throw new HarnessError(`${label}: n=${samples.length} < required ${minN}`)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p95_is_max: sorted.length < 20,
    samples
  }
}

/** Compare a summary statistic with a budget `{ value, op, stat }`; returns the verdict and the signed deficit. */
export function judge(budget, summaries) {
  const [phase, stat] = budget.stat.split('.')
  const summary = summaries[phase]
  if (!summary || typeof summary[stat] !== 'number') {
    throw new HarnessError(`budget statistic ${budget.stat} was not measured`)
  }
  const measured = summary[stat]
  const meets = budget.op === '<=' ? measured <= budget.value : measured >= budget.value
  return { measured, meets, deficit: budget.op === '<=' ? measured - budget.value : budget.value - measured }
}
