# iclone/legal — the bundled policy (generated, never edited by hand)

The ONE source of the policy is the site's `legal/icloneos-privacy.html` (https://cloneframe.io/privacy/). This folder is a copy of it,
shipped inside the app (`extraResources` → `<resources>/legal`) so the policy can be read offline.

- `icloneos-privacy.html` — verbatim copy of the site fragment.
- `policy-version.json` — version, effective date and sha256, parsed from the fragment's `p-meta` line.
- `apps/desktop/electron/policy-version.generated.ts` — the same facts plus the §2 short version and the §9 rows.

When the policy changes: update the site file first (bump `p-meta`, per the site's `legal/README.md`), then run
`node apps/desktop/scripts/sync-legal.mjs [--from <site html>]`. `--check` fails when this copy drifts; the electron test
`iclone-consent-policy.test.ts` fails too. A newer version makes the app show the acceptance step again on next launch.
