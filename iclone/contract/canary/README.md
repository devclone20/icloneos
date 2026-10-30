# iclone/contract/canary — the sandboxed canary

Contract decision 13 (`RESUME/contracts/P4_upstream.md`): static rules cannot see a break that keeps every schema
identical, so the canary runs the **candidate** runtime for real, in a sandbox, and records what the app would see.

```sh
node iclone/contract/canary/run.mjs --rev <sha> --out <dir> [--lock <lock.json>] [--python <venv python>]
```

Run from `app/`. `<dir>` must be empty or a previous canary output (`.iclone-canary` marker) and never under
`~/.hermes`; the run takes about 10 s (limit 120 s). Exit 0 = the sandbox held, 1 = it did not, 2 = bad usage.

## What it does

1. **Tree + spec through one git helper.** `served.py --repo <app repo> --rev <sha> --archive <dir>/archive` streams
   `git archive` of the app repo's upstream objects (guarded env: `GIT_NO_LAZY_FETCH=1`, `GIT_OPTIONAL_LOCKS=0`, inherited
   `GIT_DIR`/`GIT_CONFIG_*` dropped, never the runtime clone) and writes that revision's T1 spec to `<dir>/spec.json`.
2. **Sandbox.** The runtime venv python runs `-B` with `PYTHONDONTWRITEBYTECODE=1`, `PYTHONPATH=<archive>`, cwd the
   archive, `HERMES_HOME=<dir>/home`, `HOME=<dir>/user`, `TMPDIR=<dir>/tmp`, a minimal env (no inherited keys) and every
   proxy variable pointed at a closed loopback port, so the only reachable server is the stub LLM.
3. **Origin, fail closed.** Before `tui_gateway.entry` starts, the same process resolves `tui_gateway`, `hermes_cli`,
   `agent`, `tools`, `gateway`, `hermes_bootstrap` and `run_agent`; any origin outside the archive exits 97.
4. **Probe.** The shipped `electron/iclone-compat/probe.ts` runs unchanged (validation-only frames, probe key last).
   Then, in the sandbox only, every locked method that T1 no longer lists gets the same frame: `-32601` is the live
   proof of `M-GONE`. `probe.gone` must equal the `M-GONE` count of `verify.ts` for the same lock and spec, with 0
   result frames (a result frame means a handler ran).
5. **Scenarios.** Each `scenarios/*.json` scripts one tool call for `stub-llm.mjs` (an OpenAI-compatible loopback
   server). The client opens a session, submits the prompt and answers a server request only when the lock's
   `serverRequests.handled` lists it, exactly like the app.

## `canary.json`

| field | meaning |
|---|---|
| `rev`, `describe`, `specTier`, `openrpcSha256` | the candidate revision and its T1 spec |
| `archiveDir`, `hermesHome`, `moduleOrigin`, `origins` | sandbox paths; every origin is inside `archiveDir` |
| `probe.gone`, `probe.goneNames`, `probe.expectedGone` | live gone methods vs the `M-GONE` count |
| `probe.resultFrames` | frames that ran a handler (must be 0) |
| `probe.ok`, `renamed`, `unsafe`, `abortedAt`, `reason`, `abortFrame` | the shipped probe's own report and the frame it stopped on |
| `probe.sandbox` | the sandbox-only pass: `sent`, `servedOutsideT1` (4000 for a method T1 lacks), `other` |
| `scenarios.<id>` | `serverRequestSent`, `appAnswered`, `lockHandles`, `requestKeys`, `llmCalls`, `observed`, `ms` |
| `wallMs`, `failures`, `pass` | the run itself |

A scenario outcome is a finding, not a harness failure: today `clarify` records "server request sent, app answered:
no" because the lock handles no server request. P4c adds the sudo, secret and approval scenarios and turns all four
green.

## Adding a scenario

Drop `scenarios/<id>.json` with `prompt`, `toolCall {name, arguments}` (the tool must be offered to the model by the
candidate), `serverRequest` (the method the tool sends), `answer` (the result the client returns when the lock handles
it) and `timeoutMs`.
