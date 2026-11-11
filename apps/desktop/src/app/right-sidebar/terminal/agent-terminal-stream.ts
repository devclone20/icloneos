/** Legacy module path. The iT terminal engine moved to
 *  `@/app/home/it/engine` (E3c, contract E3 §3) — this file only re-exports it
 *  so the module path stays identical (PLANO L §2.2) for the consumers owned by
 *  other fronts. Delete it with the last of those imports; the list is in
 *  the E3c r1 hand-off note.
 */
export * from '@/app/home/it/engine/agent-terminal-stream'
