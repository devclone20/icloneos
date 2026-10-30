export const meta = {
  name: 'parrallello-block',
  description: 'Parrallello: one block of up to 3 rounds (fresh builders -> independent adversarial critic) for one front',
  phases: [
    { title: 'R1 · build' }, { title: 'R1 · critic' },
    { title: 'R2 · build' }, { title: 'R2 · critic' },
    { title: 'R3 · build' }, { title: 'R3 · critic' },
  ],
}
// Launch: Workflow({ scriptPath: '<root>/CONTROL/run/workflows/block.js', args }) — args in SKILL.md §6.
// Proven on Sample Project 2026-10-04/05 (P1, P2, P3, P7). No filesystem access here: everything comes through args.
const A = args
const R = A.root
const RULES = A.rules || `RULES: before anything else read ${R}/${A.rulesFile || 'CONTROL/run/RULES.md'} once and obey it strictly. Root path is exactly "${R}".`
const bar = p => { const n = Math.max(0, Math.min(20, Math.round(p / 5))); return '█'.repeat(n) + '░'.repeat(20 - n) + ' ' + p + ' %' }
const fp = i => Math.round(A.frontFrom + (A.frontTo - A.frontFrom) * i / 6)
const BUILD = { type: 'object', properties: {
  done: { type: 'array', items: { type: 'string' } },
  not_done: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] } },
  files_changed: { type: 'array', items: { type: 'string' } },
  self_gates: { type: 'string' }, handoff: { type: 'string' } },
  required: ['done', 'not_done', 'files_changed', 'self_gates', 'handoff'] }
const TICKET = { type: 'object', properties: {
  id: { type: 'string' }, owner: { type: 'string' }, severity: { type: 'string' }, goal: { type: 'string' },
  files: { type: 'array', items: { type: 'string' } }, gate: { type: 'string' }, evidence: { type: 'string' } },
  required: ['id', 'owner', 'severity', 'goal', 'files', 'gate'] }
const VERDICT = { type: 'object', properties: {
  approved: { type: 'boolean' }, score_0_10: { type: 'number' },
  open_majors: { type: 'integer' }, open_mediums: { type: 'integer' },
  verdict_file: { type: 'string' }, summary: { type: 'string' },
  tickets: { type: 'array', items: TICKET } },
  required: ['approved', 'score_0_10', 'open_majors', 'open_mediums', 'verdict_file', 'summary', 'tickets'] }
const SEV = { blocker: 0, major: 1, medium: 2, minor: 3 }
const LEAD = A.leadNote ? `\nLEAD DECISIONS (binding): ${A.leadNote}` : ''

let tickets = A.tickets || []
let prev = A.prevVerdict || 'none'
const rounds = []
for (let i = 0; i < (A.maxRounds || 3); i++) {
  const r = A.roundStart + i
  const P1 = `R${i + 1} · build`, P2 = `R${i + 1} · critic`
  phase(P1)
  log(`${A.label} · r${r} build · ${bar(fp(2 * i))}`)
  let built = []
  if (!(i === 0 && A.criticFirst)) {
    // at most maxPerOwner tickets per builder per round, most severe first (stable: the lead's order breaks ties)
    const cap = A.maxPerOwner || 3
    tickets = [...tickets].sort((x, y) => (SEV[x.severity] ?? 9) - (SEV[y.severity] ?? 9))
    const mine = o => tickets.filter(t => t.owner === o).slice(0, cap)
    const owners = [...new Set(tickets.map(t => t.owner))].filter(o => A.owners[o]).slice(0, A.maxOwners || 2)
    const full = (i === 0 && A.ticketsFile) ? `\nFull ticket text (goal/files/evidence): ${R}/${A.ticketsFile} — read only your tickets with jq.` : ''
    built = (await parallel(owners.map(o => () => agent(`${RULES}
ROLE: builder "${o}" of front ${A.front}, round ${r}. Root: ${R}. Contract: ${A.contract} (read only the sections a ticket cites).
You may edit ONLY: ${JSON.stringify(A.owners[o])}. Scratch: ${R}/CONTROL/local.nosync/scratch/${A.front}_${o}_r${r}/. Snapshot first to CONTROL/local.nosync/snap/${A.front}/r${r}_pre/.
Previous handoff notes (if any): ${R}/CONTROL/local.nosync/handoff/${A.front}_${o}_r${r - 1}.md
TICKETS (only these, in this order): ${JSON.stringify(mine(o))}${full}${LEAD}
Iterate with '${A.gatesCmd} --quick'; finish with '${A.gatesCmd} --full' once; put its SUMMARY line + failing ids in self_gates. Wait for or kill every bgjob you started before returning.`,
      { label: `${A.front}:${o}:r${r}`, phase: P1, schema: BUILD })))).filter(Boolean)
  }
  phase(P2)
  log(`${A.label} · r${r} critic · ${bar(fp(2 * i + 1))}`)
  const gatesFile = A.gatesCmd.split(' ').slice(-1)[0]
  const v = await agent(`${RULES}
ROLE: independent ADVERSARIAL CRITIC of front ${A.front}, round ${r}. Root: ${R}. Try to REFUTE that the front meets its targets. Never edit the front's files.
1) Run '${A.gatesCmd} --full' yourself (perf inside gpu_lock); save its RESULT_JSON object to ${R}/CONTROL/local.nosync/gates/${A.front}_r${r}.json. Compare the item count with the previous round: items that silently dropped out are a harness defect — restore them.
2) Probe what the gates cannot see and anything a builder may have gamed; every new probe goes INTO ${gatesFile} as a new gate (dated, round ${r}). Gates scored on rejected/blank frames must FAIL.
3) Eyes last: at most 3 contact sheets (sheet.py). Targets: ${A.targets}. Previous verdict (open items only): ${prev}.${LEAD} Builders said: ${JSON.stringify(built)}.
Write ${R}/CONTROL/sampleproject/${A.front}_critic_r${r}.json {approved, score_0_10, majors, mediums, minors, gate_artefacts, tickets}.
approved=true ONLY with 0 majors, 0 mediums and every gate PASS. tickets: <= 8, owners in ${JSON.stringify(Object.keys(A.owners))}, foundation first, each closing on a named gate.`,
    { label: `${A.front}:critic:r${r}`, phase: P2, schema: VERDICT, effort: 'high' })
  if (!v) { rounds.push({ r, error: 'critic returned nothing' }); break }
  rounds.push({ r, score: v.score_0_10, majors: v.open_majors, mediums: v.open_mediums, file: v.verdict_file, summary: v.summary })
  prev = v.verdict_file
  if (v.approved) { log(`${A.label} · APPROVED at r${r} · ${bar(100)}`); return { approved: true, rounds } }
  tickets = v.tickets
  if (!tickets.length) break
}
return { approved: false, rounds, nextTickets: tickets }
