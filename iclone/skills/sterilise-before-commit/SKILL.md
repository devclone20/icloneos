---
name: sterilise-before-commit
description: "Use when you commit or push to a shared or public repo. The ordered checklist with exact commands: status and diff review, gitleaks on staged changes, a personal-data grep, .gitignore hygiene, a noreply commit identity, a pre-commit hook and what to do once a secret is in git's history."
version: 1.0.0
author: iCLONE / CLONE FRAME
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [iclone-os, git, security, secrets, gitleaks, hygiene]
    related_skills: [secret-rotation, release-publish, agent-self-repo, github, consent]
---

# Sterilise before commit — nothing private leaves the machine

## When to use

Before every commit or push to a repo other people can read (public, shared, an iNFT's own repo). Run the steps in order; any finding stops the commit until it is fixed.

## Prerequisites

- `git` and `gitleaks` 8.19+ (`gitleaks version`). Installing gitleaks → `~/.iclone-os/bin/acp consent request installSoftware --reason "Install gitleaks to scan commits for secrets"`. Truth: `git help <cmd>`, `gitleaks git --help`.
- The owner's real name, e-mail, user name and host names, known only at run time. Put them in shell variables, never in a file in the repo.

## Quick reference

status → diff review → gitleaks staged → personal-data grep → `.gitignore` + tracked junk → identity → index check → commit the index, no pathspec. History already dirty → `secret-rotation`.

## Procedure

1. **See exactly what will ship.**

   ```sh
   git status --short && git diff --cached --stat  # example
   ```

   Read `git diff --cached` in full. Unstage anything you did not mean: `git restore --staged <path>`.

2. **Secret scan of the staged changes.** Run it alone and read its exit code — never pipe it (a pipe hides the failure):

   ```sh
   gitleaks git --staged --no-banner --redact; echo "exit=$?"  # example
   ```

   `exit=0` = clean, `exit=1` = a leak. On older gitleaks the same is `gitleaks protect --staged --no-banner --redact`. Before a repo goes public scan the whole history too: `gitleaks git --no-banner --redact .` (`# example`).

3. **Personal data in the added lines.** One `-e` per value, filled at run time; `-F` matches each value literally (a `+` or `.` in an e-mail is not a pattern). Drop the ones you do not have — an empty `-e ''` matches every line:

   ```sh
   git diff --cached -U0 --no-color | grep '^+' | grep -v '^+++' | grep -n -i -F -e '/Users/<user>' -e '/home/<user>' -e '<name>' -e '<email>' -e '<host>' && echo "STOP: personal data staged"  # example
   ```

   Also look for test users, real e-mails, phone numbers, wallet addresses and dev tokens in fixtures and seeds; replace them with placeholders.

4. **Files that must never be tracked.** `.gitignore` covers at least: `.env` and `.env.*` (but keep `.env.example` with empty values), `*.pem`, `*.key`, `id_*`, `*.log`, `*.db`, `*.sqlite*`, `node_modules/`, `.venv/`, `dist/`, `build/`, `coverage/`, `.DS_Store`, `.idea/`, `.vscode/`. Check what is already tracked:

   ```sh
   git ls-files | grep -E '(^|/)\.env($|\.)|(^|/)id_[a-z0-9]+(\.pub)?$|\.pem$|\.key$|\.log$|\.db$|\.sqlite' | grep -v '\.env\.example$'  # example
   ```

   A hit: `git rm --cached <path>`, add it to `.gitignore`. If it held a secret, the secret is burned → `secret-rotation`.

5. **Dependencies.** Run the ecosystem's audit (`npm audit --omit=dev`, `pip-audit`, `cargo audit`; `# example`) and report highs to the owner.

6. **Commit identity.** Use a noreply identity, never a personal e-mail:

   ```sh
   git config user.name && git config user.email  # example
   ```

   GitHub's form is `<id>+<login>@users.noreply.github.com`. Set it per repo with `git config user.email <noreply-email>`.

   Commit the **index** you scanned, with no pathspec: a pathspec re-reads the working tree and re-adds a file you `git rm --cached` in step 4 (the deletion is staged, the file is still on disk). List the index first; every path must be one you meant — a stray one: `git restore --staged <path>` and redo steps 1–4:

   ```sh
   git diff --cached --name-only  # example
   git commit -m "<msg>"  # example
   ```

7. **Optional: make it automatic.** Writing a hook is a file write → `~/.iclone-os/bin/acp consent request fileWriting --reason "Add a pre-commit secret guard to <repo>"`. `.git/hooks/pre-commit` (mode 0755):

   ```sh
   #!/bin/sh
   set -e
   gitleaks git --staged --no-banner --redact >/dev/null 2>&1 || { echo "pre-commit: secret in staged changes" >&2; exit 1; }
   if git diff --cached -U0 --no-color | grep '^+' | grep -v '^+++' | grep -q -i -F -e "<personal-value>"; then echo "pre-commit: personal data staged" >&2; exit 1; fi
   case "$(git config user.email)" in *@users.noreply.github.com) ;; *) echo "pre-commit: use a noreply identity" >&2; exit 1;; esac
   ```

   Repeat `-e "<personal-value>"` once per value, as in step 3.

8. **A secret was already committed or pushed.** Deleting the file does not help — it stays in history. Stop and follow `secret-rotation` (revoke first).

## Pitfalls

- `git commit -a` and `git add -A` sweep in files you never read; a pathspec commit (`git commit -- <path>`) ships the working tree, not the scanned index.
- `--no-verify` skips the hook; never use it to "get past" a finding.
- Screenshots, recordings, logs and SQLite files carry secrets too; the scanner cannot read pixels.
- Vendored third-party bundles can trip gitleaks; add a reviewed `.gitleaksignore` entry (fingerprint), never turn the scan off.

## Never

- Never commit `.env`, keys, logs, databases or a home path.
- Never push after a finding that is not fixed.

## Verification

`gitleaks git --staged --no-banner --redact` exits `0`, the personal-data grep prints nothing, and `git config user.email` ends in `@users.noreply.github.com`.
