// The markdown table generated from a `bench/2` document (never edited by hand).

const ELLIPSIS = '…'

/** Where to cut `text` at or before `at`: the last line break, else the last space, in its second half; else `at`. */
function boundary(text, at) {
  for (const re of [/\n/g, /\s/g]) {
    let last = -1
    for (const m of text.slice(0, at + 1).matchAll(re)) {
      last = m.index
    }
    if (last >= at / 2) {
      return last
    }
  }
  return at
}

/** `text` cut to at most `max` characters at a line or word boundary, never mid-word (unless one word is longer). */
export function clip(text, max) {
  const s = String(text)
  if (s.length <= max) {
    return s
  }
  return s.slice(0, boundary(s, max - ELLIPSIS.length - 1)).trimEnd() + ` ${ELLIPSIS}`
}

/** The last `max` characters of `text` (a log's tail), starting at a line or word boundary. */
export function clipTail(text, max) {
  const s = String(text)
  if (s.length <= max) {
    return s
  }
  const rev = [...s].reverse().join('')
  return `${ELLIPSIS} ` + [...rev.slice(0, boundary(rev, max - ELLIPSIS.length - 1))].reverse().join('').trimStart()
}

// An ERROR row's numbers were never judged: the table says so instead of printing them (results.json keeps them).
const UNJUDGED = '(unjudged)'
const ERROR_TEXT_MAX = 400

function fmt(value) {
  if (typeof value !== 'number') {
    return '—'
  }
  return Math.abs(value) >= 100 ? String(Math.round(value)) : String(+value.toPrecision(3))
}

function summaryCell(s) {
  if (!s) {
    return '—'
  }
  return `${fmt(s.p50)} / ${fmt(s.p95)}${s.p95_is_max ? ' (p95=max' : ' ('}${s.p95_is_max ? ', ' : ''}n=${s.n})`
}

function controlCell(list) {
  if (!list?.length) {
    return '—'
  }
  return list
    .map(c =>
      c.skipped
        ? `skipped: ${c.skipped}`
        : `${c.ok ? 'red as required' : '**DID NOT FIRE**'} — ${c.name}: expected ${c.expected}, observed ${c.observed}` +
          ` (${fmt(c.value)} ${c.op} ${fmt(c.threshold)}${c.base ? `, n=${c.base.length} vs ${c.variant.length}` : ''})` +
          (c.checks ?? [])
            .map(k => `; and ${k.name}: ${fmt(k.value)} ${k.op} ${fmt(k.threshold)} ${k.ok ? 'holds' : '**FAILS**'}`)
            .join('')
    )
    .join('; ')
}

function secondaryCell(list) {
  if (!list?.length) {
    return '—'
  }
  return list
    .map(s => `${s.ok ? 'ok' : '**MISS**'} ${s.name}: ${fmt(s.value)} ${s.unit} (${s.op} ${fmt(s.budget)})`)
    .join('; ')
}

const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')

export function renderTable(doc) {
  const head = [
    `# Bench ${doc.started_at} — ${doc.mode}`,
    '',
    `Status: **${doc.status}** (exit ${doc.exit_code}) · ${doc.env.machine_class} · ${doc.env.os} · git ${doc.env.git_sha.slice(0, 10)}` +
      `${doc.env.git_dirty ? ' (dirty)' : ''} · load before ${doc.env.load.before.one} / after ${doc.env.load.after?.one ?? '—'}`,
    '',
    `Clean rows: **${doc.clean_rows}/${doc.rows_total}** (an unclean row is repeated before anything is decided from it).`,
    '',
    '| id | part | cold p50 / p95 | warm p50 / p95 | unit | budget | secondary budgets | verdict | decision | control | clean |',
    '|---|---|---|---|---|---|---|---|---|---|---|'
  ]
  const rows = doc.rows.map(r => {
    const error = r.verdict === 'ERROR'
    const unjudged = cell => (error && cell !== '—' ? UNJUDGED : cell)
    return [
      r.id,
      r.part,
      unjudged(summaryCell(r.cold)),
      unjudged(summaryCell(r.warm)),
      r.unit,
      `${r.budget.stat} ${r.budget.op} ${fmt(r.budget.value)} — ${r.budget.reason}`,
      unjudged(secondaryCell(r.secondary)),
      error
        ? `ERROR: ${clip(r.error, ERROR_TEXT_MAX)}`
        : r.verdict === 'UNMEASURABLE'
          ? `UNMEASURABLE: ${r.unmeasurable}`
          : r.verdict === 'INVALID'
            ? `INVALID: ${r.invalid_reason}`
            : r.verdict,
      r.decision,
      controlCell(r.control),
      r.unclean ? `unclean: ${r.unclean_reason}` : 'clean'
    ]
      .map(esc)
      .join(' | ')
  })
  return [...head, ...rows.map(r => `| ${r} |`), ''].join('\n')
}
