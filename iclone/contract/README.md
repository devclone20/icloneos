# iclone/contract — the runtime contract

The app's dependency on the Hermes runtime, written down as data and checked against the runtime's own spec.
Contract: `RESUME/contracts/P4_upstream.md` (v2). Nothing here merges upstream code; upstream is a reference.

| file | role | edited by |
|---|---|---|
| `extract.mjs` | Consumer extractor. Reads the app's code (renderer + electron TS Programs, every shipped `.js/.mjs/.cjs`). | engine |
| `runtime.lock.json` | **Reviewed.** What the app consumes: names and types only (`lockVersion 1`). | generated |
| `runtime.lock.sites.json` | Unreviewed call sites (`file:line`) for each locked name. | generated |
| `../../apps/desktop/electron/iclone-compat/lock.generated.ts` | The lock as a typed const, bundled by esbuild. | generated |
| `served.py` | Provider spec (`spec@1`) of the runtime at any revision: T1 OpenRPC, T2 AST. | engine |
| `runtime.spec.json` | Pinned spec at the verified runtime revision: the whole `served.py --runtime` output (every schema, so no `$ref` dangles). | generated |
| `extract-allow.json` | Names that look like runtime names but are not sent, allowlisted unresolved sites (`{file, fn}`), env keys set for a non-runtime child (`{file, name}`), and event positions that are another protocol's discriminant (`events`, `{file, name}`; never a provider event), each with its reason. An entry that matches nothing fails the run. No directory is excluded from the scan. | review |
| `waivers.json` | Time-boxed waivers `{name, reason, ticket, expires}` (IPC pairs today). | review |

## Commands (from `app/`)

```sh
node iclone/contract/extract.mjs                       # regenerate the lock, sites and lock.generated.ts
node iclone/contract/extract.mjs --out <dir> --cache <dir>   # write elsewhere; an empty cache dir = cold run
python3 -B iclone/contract/served.py --runtime ~/.hermes/hermes-agent --out spec.json   # HEAD, files only
python3 -B iclone/contract/served.py --repo . --rev <rev> --out spec.json               # app repo's upstream objects
python3 -B iclone/contract/served.py --runtime ~/.hermes/hermes-agent --out iclone/contract/runtime.spec.json \
  && node iclone/contract/gen-types.mjs                # refresh the pinned spec, then the generated types
node iclone/contract/gen-types.mjs --check             # staleness: exit 1 if spec or types lag the runtime
node iclone/contract/canary/run.mjs --rev <sha> --out <dir>   # sandboxed canary (see canary/README.md)
```

## How recall is proved

- **Sinks.** Seeds are the gateway client's `request` (the type behind `$gateway.get()`) and the plugin SDK's
  `host.request` / `host.requestProfile`. A call is a sink when its callee (by symbol or by resolved signature) is a
  sink, or when its signature is RPC-shaped (`method` followed by `params`). A function that forwards a parameter
  (or a rest argument) into a sink's method slot becomes a sink; a property read at a sink (`surface.rpc`) makes every
  object literal typed by that property a source. Names come from literal types, so `as const` descriptors, unions and
  conditionals resolve without running anything.
- **JS.** Every shipped `.js/.mjs/.cjs` gets a syntactic pass with the same fixpoint inside the file
  (`requestForBot(bot, method, params)` → `host.request`). Methods seen only there carry `via: "js"`.
- **Nets.** A literal that the pinned spec knows as a method but that reaches no sink is an *orphan*; a sink whose
  method cannot be traced is *unresolved*. Both go to `extract-report.json`; the gate wants zero outside the allowlist.
- **Cache.** The TS pass is keyed by the hash of every input file and both tsconfigs; the per-file passes by file
  hash. A cold run is bounded at 15 s.

The runtime is never written: `served.py --runtime` reads files only, and other revisions come from the app repo
with `GIT_NO_LAZY_FETCH=1` and `GIT_OPTIONAL_LOCKS=0`.
