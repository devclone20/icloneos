# Template — the brief of the adversarial critic (fill the <…>; save it as a file and point the agent at it)

Launch: `Agent({ subagent_type: "general-purpose", model: "opus", run_in_background: true, prompt: "<read BRIEF.md …> + the facts below" })`.
Round 2 can continue the same agent (SendMessage) while its context is under ~400 k; otherwise a fresh critic from the written verdicts.

---

# Brief for the adversarial critic — Camera & Action on <project/pages> (round <N>)

You are the adversarial critic of ONE block of work. You did not build it. Find where it is wrong, weak or unproven, with numbers,
and say exactly what to fix. Do not lower the bar; do not be kind; do not invent failures either.

## What was ordered
<the owner's words, translated; the pages; the date>. His standards: world-class on every layer; everything on screen and in code
in English; the page's own look (pixel discipline: text never over text, nothing past its box); honest measurements. His question
that set the bar: "my mouse and the things of my Mac must not appear, right?" — nothing of the computer and none of the recorder's
controls may be in a video.

## What was built
<files: the recorder module, the host hooks, the builder flags, the gate file, the contract section, the owner's manual>.
The pages as delivered BEFORE this work (for "same pixels"): <folder>.

## The builder's claims (try to break each one)
1. No pixel of the recorder, of the OS pointer or of another app can be in a video (by construction + gates <ids>).
2. The page's own canvas is byte-identical to the page without the recorder (idle and with its window open).
3. A take is a real file: <format>, right length, the frames in the file at the video's rate, first frame = the scene.
4. <takes: free, tour, series, pause, hold, recovery, countdown> all work.
5. Any size/aspect lays the scene out whole.
6. Every setting does what its line says, is kept and shared; shortcuts re-bindable; numbers typed.
7. The UI follows the page's look at <sizes>.

## What to do (budget ≈ 70 tool calls; foreground only; never end your turn waiting for a notification)
1. Read the contract, the gates' header, the module and the hooks. Review the LOGIC of every gate: honest threshold? what does it miss?
2. Build your own copies with `--out=<your scratch>` (never deliver; never touch the build's own output folder while the lead uses it).
3. Rerun the builder's gates (full on the main pages; the short-tour gates on the page whose tour is short). Report every line.
4. Write your OWN probes for what the gates do not cover (pick the likeliest to break): a take started while the window is open at
   low opacity with a thumbnail showing; the pointer settings in the page's live mode; every control clicked once; start/stop spam;
   stop during the countdown; a take on a paused page; a resize mid-take; no IndexedDB (stub `indexedDB.open` via
   `Page.addScriptToEvaluateOnNewDocument`); no MediaRecorder; the app's own buttons around the recorder's controls.
5. LOOK at the pictures (crop with PIL to 2–3×): every section, the control idle/recording/paused, the thumbnail, the preview, the
   countdown, at the three sizes.
6. Verdict to `<scratch>/verdict_r<N>.json` and `.md`: `{ approved, score (0–10, honest), gates: [{ id, ok, measured }],
   failures: [{ what, evidence, cause (file + function), fix (concrete), size }], tickets: [≤ 3, by impact], notUnder: [what you
   could not measure and why], visual: [{ where, reference, difference }] }`. Approve only if you would ship it to the owner as is.
   Check your tickets do not contradict each other.

## Rules of the house
- Read-only on the project; write only inside your scratch folder.
- The machine is shared: `uptime` before any rate (1-minute load over 50 → "not measurable now"); if Chrome does not start, wait
  with an `until` loop on the load in the foreground.
- Never `pkill` by a name pattern; end only pids you started. Your own Chrome `tag`.
- Every failure with its probable cause (file / function) and the concrete fix. English in every file you write.
- Final message ≤ 10 lines: approved or not, the score, the tickets (cause + fix + size), what you could not measure.
