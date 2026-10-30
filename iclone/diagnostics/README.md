# Diagnostics packs

One folder per pack, `pack.json` = the catalogue (checks, fixes, risk, consent). Code lives in
`apps/desktop/electron/iclone-doctor-{checks,fixes}.ts` (`impl` names a function there). Validate with
`node apps/desktop/scripts/doctor-catalog.mjs`. Agent guide: `iclone/skills/diagnostics/SKILL.md`.
