// The row interface and the `bench/2` result schema, validated by hand (the harness adds no dependency).
import { HarnessError } from './stats.mjs'

export const SCHEMA = 'bench/2'
export const LANGS = ['TypeScript', 'Python']
export const MISS_CLASSES = ['cpu', 'io', 'network', 'memory', 'browser']
// A row may measure that its miss belongs to no class (`extra.miss.class`): its time is not attributable to a stage.
// Never declarable as a row's expected miss_class.
export const MEASURED_MISS_CLASSES = [...MISS_CLASSES, 'unattributed']

const ROW_STRINGS = ['id', 'part', 'what', 'hot_path', 'unit', 'risk', 'failure_mode']
const BUDGET_STATS = /^(cold|warm)\.(p50|p95|min|max)$/

/** Throw unless a row module's default export matches the contract interface. */
export function validateRow(row, file) {
  const where = file ? ` (${file})` : ''
  if (!row || typeof row !== 'object') {
    throw new HarnessError(`row module has no default export object${where}`)
  }
  for (const key of ROW_STRINGS) {
    if (typeof row[key] !== 'string' || !row[key].trim()) {
      throw new HarnessError(`row ${row.id ?? '?'}: missing string field "${key}"${where}`)
    }
  }
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(row.id)) {
    throw new HarnessError(`row id must be dotted lower-case: ${row.id}${where}`)
  }
  const b = row.budget
  if (
    !b ||
    typeof b.value !== 'number' ||
    !['<=', '>='].includes(b.op) ||
    !BUDGET_STATS.test(b.stat ?? '') ||
    !b.reason
  ) {
    throw new HarnessError(
      `row ${row.id}: budget needs {value:number, op:'<='|'>=', stat:'cold|warm.p50|p95|min|max', reason}`
    )
  }
  for (const fn of ['measure', 'control']) {
    if (typeof row[fn] !== 'function') {
      throw new HarnessError(`row ${row.id}: missing async ${fn}(ctx)${where}`)
    }
  }
  if (!LANGS.includes(row.lang)) {
    throw new HarnessError(`row ${row.id}: lang must be one of ${LANGS.join(', ')}${where}`)
  }
  if (!MISS_CLASSES.includes(row.miss_class)) {
    throw new HarnessError(`row ${row.id}: miss_class must be one of ${MISS_CLASSES.join(', ')}${where}`)
  }
  if (row.allow_zero !== undefined || row.allow_zero_reason !== undefined) {
    throw new HarnessError(`row ${row.id}: allow_zero is gone; declare allow_nonpositive: { reason }${where}`)
  }
  if (
    row.allow_nonpositive !== undefined &&
    (typeof row.allow_nonpositive !== 'object' ||
      row.allow_nonpositive === null ||
      typeof row.allow_nonpositive.reason !== 'string' ||
      !row.allow_nonpositive.reason.trim())
  ) {
    throw new HarnessError(
      `row ${row.id}: allow_nonpositive must be { reason: '<why 0 or < 0 is a real sample>' }${where}`
    )
  }
  if (row.unmeasurable !== undefined && (typeof row.unmeasurable !== 'string' || !row.unmeasurable.trim())) {
    throw new HarnessError(`row ${row.id}: unmeasurable must be a non-empty reason${where}`)
  }
  if (row.min_n !== undefined && (!Number.isInteger(row.min_n) || row.min_n < 1 || !row.min_n_reason)) {
    throw new HarnessError(`row ${row.id}: min_n must be a positive integer with min_n_reason`)
  }
  return row
}

const SUMMARY_KEYS = ['n', 'p50', 'p95', 'min', 'max']
const VERDICTS = ['MEETS', 'MISSES', 'INVALID', 'UNMEASURABLE', 'ERROR']

function fail(path, why) {
  throw new HarnessError(`results.json invalid at ${path}: ${why}`)
}

function summaryOk(value, path) {
  if (value === null) {
    return
  }
  if (typeof value !== 'object') {
    fail(path, 'summary must be an object or null')
  }
  for (const key of SUMMARY_KEYS) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
      fail(`${path}.${key}`, 'not a finite number')
    }
  }
}

/** Throw unless `doc` is a well-formed `bench/2` document. */
export function validateResult(doc) {
  if (!doc || doc.schema !== SCHEMA) {
    fail('schema', `expected ${SCHEMA}`)
  }
  for (const key of ['started_at', 'finished_at', 'mode']) {
    if (typeof doc[key] !== 'string') {
      fail(key, 'missing string')
    }
  }
  const env = doc.env
  if (!env || typeof env.machine_class !== 'string' || typeof env.git_sha !== 'string' || !env.load) {
    fail('env', 'needs machine_class, git_sha, load')
  }
  if (!['valid', 'invalid', 'harness-error'].includes(doc.status) || !Number.isInteger(doc.exit_code)) {
    fail('status', 'status/exit_code missing')
  }
  if (!Number.isInteger(doc.clean_rows) || !Number.isInteger(doc.rows_total)) {
    fail('status', 'status/exit_code missing')
  }
  if (!Array.isArray(doc.rows)) {
    fail('rows', 'not an array')
  }
  doc.rows.forEach((row, i) => {
    const at = `rows[${i}]`
    for (const key of ROW_STRINGS) {
      if (typeof row[key] !== 'string') {
        fail(`${at}.${key}`, 'missing string')
      }
    }
    if (!VERDICTS.includes(row.verdict)) {
      fail(`${at}.verdict`, row.verdict)
    }
    if (row.verdict === 'MEETS' || row.verdict === 'MISSES') {
      summaryOk(row.cold, `${at}.cold`)
      if (row.cold === null) {
        fail(`${at}.cold`, 'a judged row needs cold samples')
      }
      summaryOk(row.warm, `${at}.warm`)
      if (typeof row.measured !== 'number') {
        fail(`${at}.measured`, 'a judged row carries the measured budget statistic')
      }
    }
    if (row.secondary !== undefined) {
      if (!Array.isArray(row.secondary)) {
        fail(`${at}.secondary`, 'not an array')
      }
      row.secondary.forEach((s, j) => {
        if (
          typeof s.name !== 'string' ||
          !Number.isFinite(s.value) ||
          !Number.isFinite(s.budget) ||
          typeof s.ok !== 'boolean'
        ) {
          fail(`${at}.secondary[${j}]`, 'needs {name, value, unit, budget, op, ok}')
        }
        if (!s.ok && row.verdict === 'MEETS') {
          fail(`${at}.verdict`, `MEETS with a missed secondary budget (${s.name})`)
        }
      })
    }
    const brokenGuard = Array.isArray(row.validity) && row.validity.some(v => v?.ok === false)
    if (row.verdict === 'INVALID' && !brokenGuard) {
      fail(`${at}.verdict`, 'INVALID without a failed validity guard')
    }
    if (brokenGuard && ['MEETS', 'MISSES'].includes(row.verdict)) {
      fail(`${at}.verdict`, `${row.verdict} with a failed validity guard (a run that breaks it does not count)`)
    }
    if (row.control !== null && row.control !== undefined) {
      if (!Array.isArray(row.control) || !row.control.length) {
        fail(`${at}.control`, 'an array of controls')
      }
      row.control.forEach((c, j) => {
        if (typeof c.name !== 'string' || typeof c.ok !== 'boolean' || !('expected' in c) || !('observed' in c)) {
          fail(`${at}.control[${j}]`, 'needs {name, expected, observed, ok}')
        }
        if (!c.skipped && (!Number.isFinite(c.value) || !Number.isFinite(c.threshold))) {
          fail(`${at}.control[${j}]`, 'needs numeric value and threshold')
        }
      })
    }
    if (row.unclean && ['MEETS', 'MISSES'].includes(row.verdict) && !String(row.decision).startsWith('repeat')) {
      fail(`${at}.decision`, 'an unclean row decides nothing (repeat)')
    }
    if (typeof row.unclean !== 'boolean') {
      fail(`${at}.unclean`, 'missing boolean')
    }
  })
  return doc
}
