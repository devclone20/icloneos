export const meta = {
  name: 'parrallello-setup',
  description: 'Parrallello P0: self-test the shared low-token tools, then one gate writer per front (gate script, baseline, block-1 tickets)',
  phases: [{ title: 'P0 · tools' }, { title: 'P0 · gates and tickets' }],
}
// args: { root, rulesFile?, plan: 'CONTROL/SAMPLE_PROJECT.md', suites: '<how to run the project test suites>',
//         fronts: [{ k: 'P1', gates: '<path of the gate script to write>', inputs: '<verdict/targets/docs to read>', owners: '<owner -> files summary>' }] }
const R = args.root
const RULES = `RULES: before anything else read ${R}/${args.rulesFile || 'CONTROL/run/RULES.md'} once and obey it strictly. Root path is exactly "${R}".`
const DONE = { type: 'object', properties: {
  ok: { type: 'boolean' }, files: { type: 'array', items: { type: 'string' } },
  checks: { type: 'string' }, notes: { type: 'string' } }, required: ['ok', 'files', 'checks', 'notes'] }
phase('P0 · tools')
log('P0 ░░░░░░░░░░░░░░░░░░░░ 0 %')
const tools = await agent(`${RULES}
ROLE: tools engineer. Root: ${R}. The parrallello tools are already installed in ${R}/CONTROL/run/tools/ (codemap, q.sh, bgjob, sheet, gpu_lock, verdict_digest, status, progress, cost_mark, keepawake).
1) Self-test each tool with a 3-line smoke (in scratch; env overrides for anything that would touch real locks/jobs). Adapt only what this project needs (process name for gpu_lock via GPU_LOCK_PROC, render-slot dir, CONTROL/run/fronts.json with order/weight/planned/start from ${args.plan} §6).
2) Hygiene listed in ${args.plan} (if any). 3) Run the project's suites via q.sh: ${args.suites || 'discover them (package.json scripts, pytest, etc.)'}.
Return files + a one-line check per tool + the suites' counts.`,
  { label: 'P0:tools', phase: 'P0 · tools', schema: DONE })
log('P0 ██████████░░░░░░░░░░ 50 %')
phase('P0 · gates and tickets')
const gates = await parallel(args.fronts.map(f => () => agent(`${RULES}
ROLE: gate writer for front ${f.k}. Root: ${R}. Inputs: ${f.inputs}. Plan: ${args.plan} (section 2 row ${f.k}). File owners: ${f.owners}.
1) Write ${f.gates}: every numeric target of ${f.k} as a gate item, reusing existing measurement scripts/artefacts where they exist; --quick (iteration subset, < 5 min) and --full; perf items only inside gpu_lock; output RESULT_JSON {"pass","items":[{id,value,target,pass}]} + 'SUMMARY n/m PASS'; stable hierarchical ids; --only <glob>. Freeze the metric code (builders never edit it).
2) Run --full on the CURRENT code as baseline (long jobs via bgjob.py). Save CONTROL/run/baseline/${f.k}.json.
3) Write CONTROL/run/tickets/${f.k}_b1.json: {"tickets":[...]} <= 8 tickets {id, owner, severity, goal, files, gate, evidence}, grouped by file owner, foundation first, each closing on named gate ids.`,
  { label: `P0:gates:${f.k}`, phase: 'P0 · gates and tickets', schema: DONE })))
log('P0 ████████████████████ 100 %')
return { tools, gates }
