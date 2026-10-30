# Contributing to icloneOS

Thank you for looking. icloneOS is a small project; this page says where things go and what a change needs
before it can land.

## Before you start

- **Security problems** go through private reporting, never a public issue: see [`SECURITY.md`](SECURITY.md).
- **A bug in the Hermes runtime itself** (anything outside `apps/desktop/`, `iclone/`, `packages/` and
  `packaging/`) is usually upstream's: report it to
  [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent). icloneOS takes upstream changes by
  studying them and writing them again (see "Two tracks" in [`iclone/README.md`](iclone/README.md)), never by
  merging.
- Search the open and closed issues of this repository first.

## Where code goes

| You are changing | It lives in |
|---|---|
| The desktop app (Electron main, preload, React renderer) | `apps/desktop/` |
| Anything icloneOS adds that is not app code: runtime contract, theme, skills, plugins, brand | `iclone/` |
| The terminal launchers, the Homebrew cask, release tooling | `packages/icloneos-cli/`, `packaging/` |

## What a change needs

- **Tests with the change.** A behaviour change comes with a test that fails without it.
- **Every check green** in `apps/desktop/`: `npm run typecheck`, `npx tsc -p tsconfig.electron.strict.json --noEmit`,
  `npm run lint` (eslint and the style ratchet), `npx prettier --check` on the files you touched, and `npx vitest run`
  for the areas you touched. Python changes run `pytest` for the touched package.
- **No new colours, radii or shadows.** The design tokens are fixed; the style ratchet fails on a new literal.
- **User-facing text** goes through the i18n catalogues in `apps/desktop/src/i18n/`, never a literal in a component.
- **No secrets, personal paths or real wallet data** in code, fixtures or commit messages.
- **The licence stays intact.** Keep the MIT `LICENSE` with both copyright lines, and add a row to
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for any third-party code you vendor.

## The Hermes runtime's own rules

The runtime code imported from upstream (the Python agent, gateway, tools and TUI) keeps upstream's engineering
rules: the critical rules, file encoding, the skill-or-tool decision, cross-platform notes and security
considerations. They are in the upstream contributing guide, kept at
[`docs/upstream/CONTRIBUTING.md`](docs/upstream/CONTRIBUTING.md). Code comments that say "see CONTRIBUTING.md"
for those topics mean that file.

## Licence

By contributing you agree that your contribution is licensed under the MIT License of this repository
([`LICENSE`](LICENSE)).
