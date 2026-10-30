export const meta = {
  name: 'parrallello-prep',
  description: 'Parrallello: one-shot agents that pre-stage future waves (gate, baseline, tickets, non-conflicting code) or rehearse integration in staging',
  phases: [{ title: 'Prep · one pass' }],
}
// args: { root, rulesFile?, running: '<files owned by fronts in flight — never edit>', locks: '<lock / render-slot policy>',
//         jobs: [{ k: 'P4', allowed: ['<files this agent may edit>'], task: '<numbered steps: gate script, baseline -> CONTROL/run/baseline/<k>.json, tickets -> CONTROL/run/tickets/<k>_b1.json, allowed code>' }] }
// Same script for integration rehearsals (assemble / export into CONTROL/local.nosync/stage/, release readiness): put them in jobs.
// Proven: 4 prep agents = 0.77 M tokens, 36 min; 3 integration agents in parallel with 3 running fronts.
const R = args.root
const COMMON = `RULES: before anything else read ${R}/${args.rulesFile || 'CONTROL/run/RULES.md'} once and obey it strictly. Root path is exactly "${R}".
RUNNING FRONTS — NEVER edit: ${args.running}. ${args.locks || 'Heavy jobs: at most 1 concurrent job of yours; never take the exclusive measure lock (running fronts measure performance) — perf items are measured later by the real block. Renders <= 480 px.'}
This is a ONE-PASS agent (no critic now): leave the next wave ready to start instantly. Write live data only if your list allows it; rehearsals go to CONTROL/local.nosync/stage/.`
const DONE = { type: 'object', properties: {
  ok: { type: 'boolean' }, files: { type: 'array', items: { type: 'string' } },
  baseline: { type: 'string' }, tickets_file: { type: 'string' }, notes: { type: 'string' } },
  required: ['ok', 'files', 'baseline', 'tickets_file', 'notes'] }
phase('Prep · one pass')
log(`Prep: ${args.jobs.map(j => j.k).join(' · ')}`)
const out = await parallel(args.jobs.map(j => () => agent(`${COMMON}
ROLE: ${j.k} one-pass agent. You may edit ONLY: ${JSON.stringify(j.allowed)} (snapshot first to CONTROL/local.nosync/snap/${j.k}/r0_pre/).
${j.task}`, { label: `prep:${j.k}`, phase: 'Prep · one pass', schema: DONE })))
return args.jobs.map((j, i) => ({ job: j.k, result: out[i] }))
