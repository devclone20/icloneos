# claude-code — Hermes model-provider plugin (iclone os)

Optional engine: the user's own `claude` CLI (their Claude subscription) answers model calls over stdio.
Nous stays the default; every existing provider, key, OAuth account and custom endpoint is untouched.

- Source of truth: `app/iclone/hermes-plugins/claude-code/`. The desktop app copies it atomically into
  `$HERMES_HOME/plugins/model-providers/claude-code/` at startup (`electron/iclone-claude-code.ts`, marker `.iclone-plugin.json`).
- `client.py` — `ClaudeCodeClient`: lean argv (no built-in tools, no MCP, no settings, `--restricted`, `dontAsk`), one process
  per Hermes session, delta turns, 10-min idle kill, `--resume` with identical argv, classified failures retried once on Nous.
- `compat.py` — claude-code-only seam for Hermes builds without `ProviderProfile.create_client`.
- Files the plugin writes next to itself: `status.json` (usage window + last fallback, no content), `work/` (the claude cwd;
  its transcripts live in `~/.claude/projects/…`, the user's own Claude Code data). The app writes `binary.json` and `fallback.json`.
- Tests: `../../../venv/bin/python -m unittest discover -s tests` (stdlib unittest; fakes only, never the real CLI).
