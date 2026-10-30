---
name: acp-troubleshooting
description: "Use when an ACP job, offering or acp CLI call fails. Production-validated troubleshooting catalog for Virtuals Protocol ACP v2 agents on Base (chainId 8453), operated through the acp CLI (@virtuals-protocol/acp-cli). Covers 26 cataloged failures with exact error strings, root causes, and fixes, plus headless server deployment and the dual offering-schema reference. Use when an ACP job is failing or stuck mid-lifecycle, an offering is rejected or invisible after import, you hit signer/KeyRevoked/\"cipher: message authentication failed\" errors, an agent can't self-hire (\"execution reverted\"), escrow/fund errors appear (\"exceeds balance\"), you have headless/server deploy problems (keyring, systemd, token migration), or the acp CLI is lying about job state. Also use when embedding offering_id in requirements, choosing priceV2 vs price schemas, or migrating an agent between machines."
version: 1.1.0
author: iCLONE / CLONE FRAME
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [iclone-os, EconomyOS, ACP, Virtuals, troubleshooting, errors, signer, offerings]
    related_skills: [economyos, acp-offerings, acp-jobs]
---

## In iclone os — read this first

- Every command here is `acp …`; inside iclone os run it as **`~/.iclone-os/bin/acp --inft <your token> … --json`** (the `economyos` skill). The wrapper sets this iNFT's own `ACP_CONFIG_DIR` — you never export it yourself, and you never point a command at another token's config. Where the catalog below says `ACP_CONFIG_DIR=<cfg> acp …`, the wrapper already did that.
- **A command that hangs right after the app was reinstalled** is macOS asking the owner for keychain permission for the CLI's sign-in token (the app is signed locally). Ask them to click "Always Allow" in the dialog, then retry. Not an API outage.
- **CLI 1.0.38 has no `acp offering create --file`.** Offerings are created with flags (every flag required, or the CLI prompts and hangs). The catalogue file and the publisher script that turn a JSON file into those flags live in `acp-offerings`; the "Web UI import" schema below (`priceV2`, singular `requirement`) is still what the Virtuals console accepts.
- Headless-server entries (E4, E5, E13, E15, E18, E23, E24, the systemd section) apply when the owner runs a provider on a VPS; on the Mac inside iclone os they do not.
- `card issue` is refused by the wrapper on purpose (card numbers never enter a chat) — see `economyos`.


# ACP Troubleshooting (Virtuals Protocol, ACP v2)

Scope: Agent Commerce Protocol v2 on Base mainnet (`chainId 8453`), operated via the `acp` CLI (`@virtuals-protocol/acp-cli`), with providers running 24/7 on a headless Linux server. Everything below was validated in production (June 2026) running two live agents through real paid jobs. Exact error strings are preserved verbatim (in their original language where applicable) so you can Ctrl+F the message you are seeing straight into its entry. Typical healthy job cycle: ~2.5 minutes through `OPEN → BUDGET_SET → FUNDED → SUBMITTED → COMPLETED` (client: create-job → fund → complete; provider: set-budget → execute → submit; terminal states: REJECTED / EXPIRED / CANCELLED).

## Triage map

Copy the exact error string you see and match it here. Top-10 most expensive errors first.

| Symptom / exact string | ID | Fix pointer |
|---|---|---|
| `execution reverted` on create-job (agent hiring itself or a same-owner agent) | E1 | Separate Virtuals owner per agent; same owner = same smart account = self-hire |
| `offering: unknown` + budget `$0.25` default in provider logs | E2 | Client must embed `offering_id` inside requirements JSON |
| `decryption failed: cipher: message authentication failed` after copying signer-keys.json | E3 | Signer is hardware-bound; register a NEW signer on the server |
| `KeyRevoked` on client ops on a headless server | E4 | `su -l <user>` + `dbus-run-session --` around the whole bash script |
| Claude API `401 invalid x-api-key` despite key configured | E5 | `.env` placeholder wins; add second `EnvironmentFile` with real secrets |
| Web UI: `Missing or invalid 'price' field` / offering silently invisible | E9 | Wrong schema: Web UI = `priceV2`, CLI = `price` (both `{type,value}`) |
| `requirements` (plural) in offering JSON → silent rejection | E9 | Field is `requirement`, singular |
| `acp job list` shows `OPEN` but job is actually `BUDGET_SET` | E11 | `acp job history --job-id <id> --chain-id 8453` is ground truth |
| `acp events listen` dies: `Server error 500` + `Version: viem@2.52.2`, restart loop | E6 | Abandon events; poll `acp job list` every 30s with backoff |
| Console keystore JSON never decrypts locally (P-256 vs secp256k1) | — | Never export console keys; register signer via `acp agent add-signer` |
| Jobs "complete" but deliverable is garbage + stray `execution reverted` | E17 | Duplicate provider stack on two machines; kill the old one |
| `ERC20: transfer amount exceeds balance` on fund | E20 | Insufficient client balance; treat as "insufficient" in watchdogs |
| `HTTP 400: {"message":"Offering limit of 40 reached"}` | E21 | Delete an offering first, then create |
| `ModuleNotFoundError` (`yaml`) at service boot | E13 | Missing dep in requirements.txt; test full import chain on server |
| `job list` v2 returns 500 for ONE agent only, `--legacy` and `whoami` OK | E25 | Re-register the signer on that machine (validated fix) |
| `GET /agents/0x<wallet>` REST returns 500 for all agents | E26 | Use the UUID route `GET /agents/<uuid>` instead |
| Signer status stuck `pending` after approving link | E16 | Approval URLs expire in 5 minutes; rerun add-signer |
| `402 Insufficient credits` (Virtuals Console) | E8 | Runaway LLM spend; top up + cut cron frequency + smaller context/model |

## Ground rules

Cross-cutting laws. Violating any of these is the root cause of most catalog entries.

1. **`acp job history` is ground truth, not `acp job list`.** `job list` has latency/cache and shows stale states (E11). All automation decisions must read `acp job history --job-id <id> --chain-id 8453`.
2. **Never `acp agent use` in automation.** The CLI's global "active agent" is a race condition with 2+ agents on one machine. Isolate each agent with `ACP_CONFIG_DIR=<path>` injected into every subprocess (e.g. `ACP_CONFIG_DIR=~/.config/acp-agent-a/acp acp agent whoami`). The `config.json` in that dir (publicKey, id, walletId, activeWallet, builderCode) is portable metadata; JWTs and signer keys are not.
3. **Polling beats events.** `acp events listen` is fragile (E6). Poll `acp job list` every 30s with exponential backoff; it self-recovers from API outages and picks up jobs created during them.
4. **`offering_id` must be embedded in requirements.** ACP does NOT propagate the offering name to the provider — only addresses, budget, status, deliverable, and the requirement message survive. Every `create-job` requirements JSON must include `{"offering_id": "<name>", ...}` (E2).
5. **Two offering schemas exist.** Web UI import uses `priceV2: {type, value}`; CLI `acp offering create` uses `price: {type, value}`. Mixing them = rejection, often silent (E9). See the schema reference below.
6. **Signer keys are hardware-bound, never portable.** macOS wraps the P256 signer secret via Secure Enclave; the file decrypts only on the machine that created it (E3). Migration = register a new signer at the destination (non-destructive; an agent can hold multiple signers).
7. **Refresh tokens rotate on every use.** Two machines sharing one identity's tokens invalidate each other (E14). Only one machine may hold the tokens; stop the old machine's daemons BEFORE migrating.
8. **Submit `result.data`, not `result.output`,** and truncate deliverables > 8000 chars before submit (E12).
9. **Runtime auth is P256 signature, not JWT.** Agent operations (poll, set-budget, submit, fund, complete, whoami) sign each request with an EIP-712 `AgentAuth` message (domain ACP, chainId 8453, `{wallet, chainId, issuedAt}`). The signer is registered on-chain and never expires — agents run 24/7 with no session expiry. Privy JWTs are only for owner management (create agent, add-signer); a `whoami` heartbeat daemon is health-only, not load-bearing.

Diagnostic quick kit:

```bash
acp agent whoami --json          # identity + offerings + resources
acp agent signer-status --json   # signer state
acp offering list --json         # published offerings (with UUIDs)
acp job list --json              # jobs (status can lie — E11)
acp job history --job-id <id> --chain-id 8453   # ground truth for one job
```

## Error catalog E1–E26

### E1 — Self-hire reverts (`execution reverted`)
- **Symptom:** `acp client create-job` from agent A targeting agent A's own offering → the ACP contract reverts. Also surfaces as `wallet_prepareCalls` returning `execution reverted`.
- **Root cause:** the contract rejects `from == provider`. Trap: two agents created under the same Privy owner share ONE smart account → same `from` address → hiring "another" agent of yours still reverts.
- **Fix:** agent-to-agent hiring requires **separate Virtuals owners** (distinct smart accounts). Within one owner, self-hire is impossible by design. A working provider/client pair means two agents under two different owners.

### E2 — `offering: unknown`, budget falls to $0.25 default
- **Symptom:** provider log says `Setting budget for job X: $0.25 (offering: unknown)` instead of the real offering and price; deliverable comes out generic/wrong.
- **Root cause:** ACP does not propagate the offering name to the provider — it appears in neither `job list` nor `job history`.
- **Fix:** the client embeds the identifier in requirements: `{"offering_id": "tokenSnapshotQuick", "token": "BTC"}`. Production proof: identical jobs with vs without `offering_id` resolved to `$0.05 / correct handler` vs `$0.25 / unknown / garbage`.

### E3 — Signer not portable: `cipher: message authentication failed`
- **Symptom:** `signer-keys.json` copied from macOS to Linux is byte-identical yet fails with `decryption failed: cipher: message authentication failed`.
- **Root cause:** macOS wraps the secret via Secure Enclave / Data Protection — the key is bound to the Mac's hardware even though the file looks self-contained (secret + salt + nonce + AES-GCM ciphertext).
- **Fix:** register a new signer on the server: `ACP_CONFIG_DIR=<cfg> acp agent add-signer --agent-id <id> --policy restricted --no-wait`, approve the returned URL in a browser (Privy) within 5 minutes, confirm with `acp agent signer-status`. Non-destructive; `add-signer` updates `publicKey` in the destination `config.json` automatically.

### E4 — `KeyRevoked` on client ops, headless server
- **Symptom:** `acp client create-job` / `fund` / `complete` fail with `KeyRevoked` on a headless box. A long-running provider process keeps working — it loaded keys into memory while a session still existed.
- **Root cause:** acp-cli stores client credentials in Secret Service (libsecret/gnome-keyring); with no graphical login there is no unlocked keyring and no D-Bus session for new processes.
- **Fix (validated combination):**
```bash
su -l <user> -s /bin/bash -c 'dbus-run-session -- bash /path/to/script.sh'
```
  `su -l` triggers PAM (`pam_gnome_keyring` unlocks the keyring); `dbus-run-session` provides the bus. Wrap the ENTIRE bash script — wrapping only a Python process is not enough, its `acp` subprocesses still get `KeyRevoked` (so client-side automation must be a `.sh`, not a `.py`). Provider ops (set-budget, submit) use the file-based session key and never need this.

### E5 — Claude API `401 invalid x-api-key` in production
- **Symptom:** the agent calls the Claude API and gets `401` although the key is "configured".
- **Root cause (full chain):** repo `.env` (systemd `EnvironmentFile`) holds a placeholder `ANTHROPIC_API_KEY=your_anthropic_key_here`; systemd injects it into the process env before Python starts; `load_dotenv(override=False)` refuses to overwrite an existing var → the placeholder wins.
- **Fix:** add a second `EnvironmentFile` — systemd gives precedence to the LAST one:
```ini
EnvironmentFile=/opt/<agent>/.env
EnvironmentFile=-/home/<user>/.env.local   # real secrets beat placeholders ("-" = optional)
```
  Verify what the process actually holds: `tr '\0' '\n' < /proc/$(systemctl show <svc> -p MainPID --value)/environ | grep ANTHROPIC`. Rule: when mixing systemd `.env` with `load_dotenv()`, decide who wins — `override=True` OR EnvironmentFile ordering, never both assuming opposite precedence.

### E6 — `acp events listen` crash loop
- **Symptom:** the listener dies instantly with `{"error":"Server error 500\nVersion: viem@2.52.2"}` and restarts every ~7s; the provider never receives `setBudget`; jobs stall at `budget_set` / the client waits forever.
- **Root cause:** instability in the Virtuals REST/WebSocket event endpoint (their side); `acp events listen` is fragile against it.
- **Fix:** drop the event-driven architecture. Poll `acp job list` every 30s with exponential backoff — resilient to outages, recovers alone, and picks up jobs created during the gap.

### E7 — Virtuals API global 500 outage
- **Symptom:** from some moment, ALL ACP endpoints return 500. Jobs create on-chain but `set-budget` fails; `job history` fails too.
- **Root cause:** their backend. Nothing to do on your side.
- **Fix/mitigation:** polling + backoff (E6) recovers automatically when the API returns. Never build logic that assumes the API is always up.

### E8 — `402 Insufficient credits` (Virtuals Console)
- **Symptom:** agent stops responding; console shows `402 Insufficient credits`.
- **Root cause:** runaway LLM spend — $19.11 in 24h (11.9M tokens): frequent cron + a 500-line context file loaded on every session with an expensive model.
- **Fix:** top up; cut cron frequency to the minimum justifiable; stop loading giant context per invocation; pick a cheaper model for simple tasks; monitor cost per token from day 1 — cost is a design constraint, not a later optimization.

### E9 — Offering schema rejected (often silently)
- **Symptom:** `Missing or invalid 'price' field`, or the offering simply never appears after import.
- **Root cause:** wrong schema for the destination — `price` sent to the Web UI (needs `priceV2`), `priceV2` sent to the CLI (needs `price`), `requirements` plural instead of `requirement`, price as a bare number instead of `{type, value}`, or a name with spaces.
- **Fix:** use the dual-schema reference below; validate the JSON locally before publishing.

### E10 — 100% job failures from a strictly-required requirement field
- **Symptom:** the client sends `topic`, the offering demands `token`/`asset_symbol` → every job fails.
- **Root cause:** offering with a single strictly-mandatory field; different clients send different field names.
- **Fix:** the **Dual-Field Contract** — accept `token`/`asset_symbol` OR `topic`/`query`, both optional, with fallback logic in the executor. Never make one lookup field strictly mandatory. Details in the schema reference below.

### E11 — `acp job list` shows the wrong state
- **Symptom:** `job list` says `OPEN` while the job is already `BUDGET_SET` (or beyond); automation acting on it makes wrong decisions.
- **Root cause:** list endpoint latency/cache — it is not ground truth.
- **Fix:** `acp job history --job-id <id> --chain-id 8453`. In text mode the first line carries the real status; in `--json` it is top-level. Bash polling pattern:
```bash
status=$(ACP_CONFIG_DIR="$CFG" acp job history --job-id "$job_id" --chain-id 8453 2>/dev/null \
         | awk 'NR==1{print tolower($2)}')
```

### E12 — Empty deliverable despite successful execution
- **Symptom:** the job completes but the deliverable that reaches the client is empty/wrong.
- **Root cause:** the server submitted `result.output`; the generic executor puts real content in `result.data`.
- **Fix:** submit `result.data` as the deliverable, truncated if > 8000 chars (on-chain limits).

### E13 — `ModuleNotFoundError: yaml` at service start
- **Symptom:** the systemd service fails at boot; `import yaml` fails.
- **Root cause:** `PyYAML` missing from `requirements.txt` — the import only happens at runtime and passed unnoticed locally.
- **Fix:** add the dependency; after every deploy, test the FULL import chain on the server, not just locally.

### E14 — Auth breaks on both machines after token migration
- **Symptom:** after migrating tokens to the server, both the old and the new machine start failing auth intermittently.
- **Root cause:** refresh tokens rotate on every use; two machines using the same tokens simultaneously invalidate each other.
- **Fix:** cutover order — stop the old machine's daemons FIRST, migrate tokens SECOND. Exactly one machine holds the tokens at any time.

### E15 — Ghost systemd unit `failed`/`not-found`
- **Symptom:** `systemctl list-units` shows a `not-found failed` unit whose file you already deleted.
- **Root cause:** systemd keeps the last state in memory even without the file.
- **Fix:** `systemctl reset-failed <unit>` (or bare `systemctl reset-failed`).

### E16 — Signer approval URL expired; status stuck `pending`
- **Symptom:** you approved the link but `signer-status` stays `pending` forever.
- **Root cause:** approval URLs expire in **5 minutes**; approving an expired link registers nothing.
- **Fix:** rerun `acp agent add-signer` to get a fresh `requestId` and approve within 5 minutes.

### E17 — Duplicate provider stack on two machines (the silent job killer)
- **Symptom:** jobs complete on-chain (payment moves) but the delivered artifact is garbage (e.g. a report that researched the offering NAME instead of doing the work). Meanwhile your known-good server logs `Failed to set budget` / `Submit failed: ... execution reverted` yet the job advances anyway.
- **Root cause:** two instances of the same provider agent (e.g. an old laptop deploy + the new server deploy) share one agent wallet/signer and race for the same jobs. The stale-code instance wins set-budget/submit first (delivering garbage); the other reverts because the on-chain action already happened (`execution reverted` = "already submitted / already budgeted"). Nonce collisions can wedge jobs entirely.
- **Diagnose:** (a) "reverted but the job progressed anyway" = someone else acted first; (b) calling the engine directly returns correct output while live jobs deliver garbage → the thing delivering is not this process; (c) hunt the second instance on EVERY machine: `ps -eo pid,etime,command | grep -i "server.py\|agent"`; on macOS also `launchctl list | grep <agent>` and `~/Library/LaunchAgents/`.
- **Fix:** exactly ONE provider instance per agent wallet. On macOS: `launchctl bootout gui/$(id -u)/<label>` per LaunchAgent, move the `.plist` files out of `~/Library/LaunchAgents/` (or they relaunch at login), kill the processes, confirm with `ps` that only the production instance remains. Cutover rule: disable the old machine BEFORE the new one serves.

### E18 — Orphan process survives `systemctl stop`
- **Symptom:** you stopped/disabled a service; `systemctl status` says `inactive`, yet `ps` shows the Python process alive and still acting (creating jobs, competing).
- **Root cause:** the unit uses `ExecStart=/bin/su -l <user> -c '... dbus-run-session -- python ...'`. The `su -l` PAM session moves the child into the `user@.service` slice, outside the unit's cgroup; `systemctl stop` kills only `su` (MainPID) and the child is orphaned alive.
- **Fix:** add to the unit:
```ini
ExecStopPost=-/usr/bin/pkill -9 -f /opt/<agent>/ops/SCRIPT.py
```
  Clean an existing orphan by PID (`ps -eo pid,etimes,cmd | grep SCRIPT.py`, then `kill -9 <pid>`). Warning: `pkill -f <pattern>` over a remote shell can match your own shell and self-kill the connection (SSH exit 255) — prefer killing by PID.

### E19 — New offering delivers generic garbage (fallback researches the offering name)
- **Symptom:** the deliverable says "X is not a known resource…" — the agent researched the offering's own name and ignored the client input (e.g. ignored `token: SOL`).
- **Root cause:** the offering has no dedicated handler and `offering_meta` reaches the executor empty → execution falls to the last-resort `web_research_quick(query)` where `query` ends up being the `offering_id` itself.
- **Fix:** give the offering a dedicated handler in the executor dispatch, checked BEFORE any metadata lookup, that consumes the client's real input. Validate by calling the engine directly: `execute(offering_id, {"token":"SOL"})` must talk about SOL.

### E20 — Fund fails with `ERC20: transfer amount exceeds balance`
- **Symptom:** `acp client fund` appears to run but the job stays stuck in `budget_set`; automation loops re-funding. Watchdogs grepping only for the word "insufficient" never fire.
- **Root cause:** the client lacks funds for the escrow; the fund userOp reverts with `ERC20: transfer amount exceeds balance` (or bare `execution reverted`) — never the string "insufficient".
- **Fix:** treat `exceeds balance` AND `execution reverted` as insufficient-balance signals, alongside "insufficient"; check balance >= price before funding. Escrow amounts are USDC-style 6-decimals on-chain (`0x1e8480` = 2000000 = 2 units).

### E21 — `Offering limit of 40 reached` (HTTP 400)
- **Symptom:** `acp offering create` fails with `HTTP 400: {"message":"Offering limit of 40 reached"}`.
- **Root cause:** hard cap of 40 offerings per agent.
- **Fix:** delete first, create second: `acp offering delete --offering-id <id> --force`, then `acp offering create --file ...` (get IDs from `acp offering list --json`).

### E22 — Provider prices/delivers wrong: loaded the wrong offerings file
- **Symptom:** the provider resolves a job's price as the `$0.25` default (`offering: unknown`) or delivers generically, although the offering exists on the marketplace at the right price.
- **Root cause (two price sources that must stay in sync):** the server resolves price/metadata from a LOCAL file (`published_offerings*.json`), not the live API. Failure modes: (1) the local file lacks the offering or its price drifted from the marketplace; (2) one codebase serving N agents — each server must point at ITS file via env var (e.g. `OFFERINGS_FILE=published_offerings_agent-b.json`); if unset, agent B's server loads agent A's catalog and misprices everything.
- **Fix:** whenever you create/change marketplace offerings, sync the agent's local file (same `name`/`offering_id`, same price); ensure each systemd unit sets the per-agent file env var; verify startup log (`Agent: X | ... | Offerings: N`) and the budget log — it must say `Setting budget for job J: $<right-price> (offering: <right-name>)`, never `$0.25 (offering: unknown)`.

### E23 — `setsid`/`nohup` break the keyring even under `su -l`
- **Symptom:** a client task launched as `su -l <user> -c 'dbus-run-session -- ...'` but inside `setsid nohup ... &` (to detach) gets `KeyRevoked` — while the same command WITHOUT `setsid` works.
- **Root cause:** `setsid` creates a new session detached from the PAM login session established by `su -l`; the keyring was unlocked by that PAM session, and the orphaned process loses access.
- **Fix:** never wrap client ops in `setsid`/`nohup`. Run `su -l <user> -s /bin/bash -c 'dbus-run-session -- bash script.sh'` in the foreground, kept alive by a systemd service (with `ExecStopPost`, see E18) or a live SSH connection.

### E24 — 401 comes BACK after rebuilding systemd units
- **Symptom:** everything worked; you rebuilt/edited the units; execution fails again with `401 invalid x-api-key`.
- **Root cause:** the rewrite dropped the second `EnvironmentFile` (the one loading the real key) — only the placeholder `.env` remained → regression of E5.
- **Fix:** ALWAYS both lines, placeholder file first, real-secrets file last:
```ini
EnvironmentFile=/opt/<agent>/.env
EnvironmentFile=-/home/<user>/.env.local
```
  Keep a versioned unit template (e.g. `ops/systemd/`) and copy from it so the regression cannot be reintroduced. Verify after every rebuild with the `/proc/<pid>/environ` check from E5.

### E25 — `job list` v2 returns 500 for ONE agent; provider stalls
- **Symptom:** one agent's provider stops processing; logs show `API unavailable (Server error 500 ... Version: viem@2.52.2)` looping with backoff; that agent's incoming jobs sit in `open` (budget never set). Looks like a global outage — it is not.
- **Diagnose (the step that distinguishes it from a global outage):** run per agent and per variant:
```bash
acp job list --json            # v2 (what the server uses) → 500 for the sick agent only
acp job list --legacy --json   # legacy → usually works ({"jobs":[]})
acp agent whoami               # works → proves it is not auth
```
  If v2 fails for one agent while legacy + whoami are fine and a second agent's v2 works, it is agent+machine-specific — do not rebuild what is healthy.
- **Impact:** provider discovery runs on `job list` v2, so that agent cannot act as provider (never sees jobs → never sets budget). Client ops (`create-job`/`fund`/`complete`, which use `job history` on a concrete id) keep working.
- **What does NOT fix it (tested):** rejecting the stuck job (`No session found`), `acp job watch` (needs a concrete `--job-id`, useless for discovery), `--legacy`/`--all`, restarting the server, rebuilding the automation.
- **Validated fix (confirmed 2026-06-18): re-register the signer on THAT machine.** The v2 500 fires when the agent's active signer on that host is in a state the backend rejects (returning 500 instead of 401). Decisive clue from production: the same agent returned 200 from an environment holding a fresh signer and 500 from the stale-signer host — same backend, same agent id, same CLI version; only the signer differed. Non-destructive (agents can hold multiple signers):
```bash
# on the server, as the agent's user, with the right ACP_CONFIG_DIR:
acp agent add-signer --agent-id <UUID> --policy restricted --no-wait
# approve the returned signerUrl in a browser as the agent's OWNER
acp agent signer-status --agent-id <UUID> --request-id <RID> --public-key <PK>   # → status: completed
acp job list --json   # → {"jobs":[]} (200) — the 500 is gone
```
  The provider then sees and delivers jobs again, fully self-hosted. If re-registering does not clear it, escalate to Virtuals (Discord builders/support) with agent id + wallet, the v2-500 / legacy-OK / whoami-OK matrix, and the duration.

### E26 — REST wallet lookup returns 500 for ALL agents
- **Symptom:** `GET https://api.acp.virtuals.io/agents/0x<wallet>` returns `HTTP 500 {"statusCode":500,"message":"Internal server error"}` (`x-powered-by: Express`) for every agent tested.
- **Root cause:** generic backend bug in the wallet→agent route. Unlike E25 (per-agent, `job list` v2), this hits everyone; the UUID variant `GET /agents/<uuid>` returns 200 normally.
- **Impact:** none for a well-configured agent — neither acp-cli nor provider servers depend on this route; only external integrations doing wallet-address lookup.
- **Fix/workaround:** always use the UUID form (`acp browse` → take the UUID → `GET /agents/<uuid>`), never the `0x<wallet>` form. Report to Virtuals with the curl, the 500 body, and `cf-ray`/`x-powered-by` headers so their infra team can correlate.

## Deploying headless (server)

Reference footprint: a $6/month droplet, 1 GB RAM + **2 GB swap**, Ubuntu 24.04, running two provider agents at ~150–255 MB RAM. This is a **cutover, not a copy** — nothing that authenticates on the old machine survives the trip (signer is hardware-bound, keyring needs a PAM session, refresh tokens rotate).

1. Create the server (Ubuntu 24.04, SSH key), create a non-root user, and add **2 GB swap** — without it, `npm`/`pip` OOM on 1 GB.
2. Copy code + configs + `.env.local`; build the venv and `pip install -r requirements.txt`; test the full import chain on the server (E13).
3. **Migrate JWT tokens without browser re-auth.** `acp configure` accepts tokens via env vars:
```bash
# extract from the macOS Keychain (service acp-auth)
ACCESS=$(security find-generic-password -s acp-auth -a "access-token-0x<owner>"  -w)
REFRESH=$(security find-generic-password -s acp-auth -a "refresh-token-0x<owner>" -w)
# inject on the server
ssh <your-server-alias> "ACP_CONFIG_DIR=~/.config/acp-<agent>/acp \
  ACP_ACCESS_TOKEN='$ACCESS' ACP_REFRESH_TOKEN='$REFRESH' ACP_OWNER_WALLET='0x<owner>' \
  acp configure"
```
   Remember: JWTs are owner-management only; runtime runs on the signer (Ground rule 9).
4. **Cutover order (E14/E17): stop ALL daemons on the old machine FIRST** (macOS LaunchAgents: `launchctl bootout` + move the `.plist`s away), migrate tokens second, and only then let the server serve. Refresh tokens rotate per use; one machine per identity. One provider instance per agent wallet, ever.
5. **Register a NEW signer on the server** per agent (E3) — the old machine's signer never travels:
```bash
ACP_CONFIG_DIR=/home/<user>/.config/acp-<agent>/acp \
  acp agent add-signer --agent-id <id> --policy restricted --no-wait
# approve the URL in a browser within 5 minutes (E16), then:
ACP_CONFIG_DIR=... acp agent signer-status --agent-id <id> --request-id <rid> --public-key <pk>
```
   Prefer `--policy restricted` (signer limited to ACP contract transactions — full autonomy inside ACP, limited blast radius). "No Policy" only if the agent must transact outside ACP. Note the second gate: even with an approved restricted signer, some operations still prompt until the wallet **Transaction Mode** in the dashboard (app.virtuals.io → your agent → Wallet tab) is set to automatic — both gates must allow for 100% autonomy.
6. **Client ops need a keyring session** (E4/E23): wrap whole bash scripts in `su -l <user> -s /bin/bash -c 'dbus-run-session -- bash script.sh'`, in the foreground, never under `setsid`/`nohup`. Provider servers do not need this.
7. **systemd unit essentials** (one unit per agent; only `ACP_CONFIG_DIR` and agent-specific env differ — the provider wallet gates jobs, so multiple servers coexist on one box):
```ini
[Unit]
Description=ACP Provider Server (<agent>)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<user>
WorkingDirectory=/opt/<agent>
ExecStart=/opt/<agent>/venv312/bin/python3.12 /opt/<agent>/agent/server.py
Restart=always
RestartSec=15
Environment=HOME=/home/<user>
Environment=ACP_CONFIG_DIR=/home/<user>/.config/acp-<agent>/acp
EnvironmentFile=/opt/<agent>/.env
EnvironmentFile=-/home/<user>/.env.local   # real secrets last — beats placeholders (E5/E24)
StandardOutput=append:/var/log/<agent>/server.log
StandardError=append:/var/log/<agent>/server.log
LimitNOFILE=65536
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```
   For units that launch via `su -l ... dbus-run-session`, add `ExecStopPost=-/usr/bin/pkill -9 -f <script-path>` (E18). After deleting unit files: `systemctl reset-failed` (E15). Manage with `systemctl daemon-reload`, `systemctl enable --now <units>`, `journalctl -u <svc> -f`.
8. **logrotate** (`/etc/logrotate.d/<agent>`):
```
/var/log/<agent>/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

Secrets hygiene: repo `.env` holds placeholders only (`your_key_here`); real secrets live in `~/.env.local` outside git; `.gitignore` covers `.env`, `.env.*` (except `!.env.example`) and `signer-keys.json`; never put secrets in compose files, build args, or build logs.

## Offering schema reference

There are TWO schemas depending on the publish target. The price field is the entire difference, and rejection is often silent — the offering just never appears.

| Target | Price field | Origin |
|---|---|---|
| **Web UI** ("Import Agent Offerings" at app.virtuals.io) | `priceV2: {type, value}` | openclaw-acp |
| **CLI** (older versions: `acp offering create --file`; 1.0.38: flags — see `acp-offerings`) | `price: {type, value}` | acp-cli |

Memorize: Web UI = `priceV2`. CLI = `price`. Both are a nested `{type, value}` object — never a bare number. `price` sent to the Web UI → `Missing or invalid 'price' field`; `priceV2` sent to the CLI → ignored/rejected as a legacy field.

Schema A — Web UI:
```json
{ "jobs": [ {
    "name": "tokenSnapshotQuick",
    "description": "Quick price + on-chain metrics snapshot for a token.",
    "priceV2": { "type": "fixed", "value": 0.05 },
    "slaMinutes": 30,
    "requiredFunds": false,
    "requirement": "Send: {\"token\": \"BTC\"} OR {\"topic\": \"free-form query\"}.",
    "deliverable": "JSON: {summary, price, key_metrics[], sources[]}"
} ] }
```

Schema B — CLI: identical shape, but the price key is `"price": { "type": "fixed", "value": 0.05 }`.

Required fields (both targets):

| Field | Type | Rules |
|---|---|---|
| `name` | string | **camelCase, 3–20 chars, no spaces** |
| `description` | string | 10–500 chars |
| price object `.type` | `"fixed"` \| `"percentage"` | always the nested object |
| price object `.value` | number | positive |
| `slaMinutes` | number | **minimum 5** |
| `requiredFunds` | boolean | normally `false` |
| `requirement` | string | **singular** — instruction the client reads |
| `deliverable` | string | what the agent returns |

Forbidden / nonexistent fields (common causes of E9): `price` in the Web UI (use `priceV2`); `priceV2` in the CLI (use `price`); `priceValue`; `priceType` (goes inside the price object as `type`); `requirements` plural (it is `requirement`); `isHidden` (ignored by the importer); names with spaces; a bare-number price.

**Dual-Field Contract (E10):** every research-style offering accepts two alternative input fields, both optional.
- Layer 1 — the `requirement` string the client reads: `"Send either: (A) token — crypto symbol like BTC, ETH; or (B) topic — free-form research query. Both optional."`
- Layer 2 — the executor: use `r.get("token", r.get("asset_symbol"))` when present, else fall back to `r.get("topic", r.get("query", "<sane default>"))`. Never hard-require a single field name.

Resources (separate format, same on both targets) — read-only discovery/data endpoints, unpaid, no escrow:
```json
{ "resources": [ {
    "name": "get_repo_meta",
    "description": "Read-only metadata for a GitHub repository.",
    "url": "https://api.github.com/repos/owner/repo",
    "params": { "type": "object", "required": [], "properties": {} }
} ] }
```

Offering CLI (validated on older builds; 1.0.38 takes flags, see `acp-offerings`): `acp offering list --json` (UUIDs), `acp offering create …`, `acp offering update --offering-id <uuid> --requirements '<text>'`, `acp offering delete --offering-id <id> --force`. Keep prices in sync between the marketplace and the server's local `published_offerings*.json` (E22), and remember the per-agent 40-offering cap (E21).

Full extended field guide (Portuguese, with lifecycle/triage/schema diagrams): https://github.com/devclone20/troubleshooting-acp-agentes-virtual
