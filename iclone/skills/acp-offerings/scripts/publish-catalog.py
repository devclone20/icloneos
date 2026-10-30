#!/usr/bin/env python3
"""publish-catalog.py — turn an iNFT's catalogue file into `acp offering|resource|subscription` calls.

    publish-catalog.py --inft <token|slug> --catalog <file.json> --plan          # dry run
    publish-catalog.py --inft <token|slug> --catalog <file.json> --apply         # create + update, write ids back
    publish-catalog.py --inft <token|slug> --catalog <file.json> --apply --prune # also delete live offerings absent from the file

Runs the Virtuals CLI through iclone os's per-iNFT wrapper (~/.iclone-os/bin/acp, override
with ACP_BIN for tests). Matches live rows to the file by id, then by name. Validates every
JSON schema, refuses to exceed the 40-offering cap, never deletes without --prune, prints the
exact argv of every write, and re-reads the live lists at the end so the file mirrors reality.
Standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from typing import Any

OFFERING_CAP = 40
SLA_MIN = 5
DURATIONS = {7, 15, 30, 90}
NAME_RULE = "3-80 chars, letters/digits/space/_/-/."


def die(message: str) -> None:
    print(f"publish-catalog: {message}", file=sys.stderr)
    sys.exit(2)


def acp_bin() -> list[str]:
    override = os.environ.get("ACP_BIN")
    if override:
        return shlex.split(override)
    return [os.path.expanduser("~/.iclone-os/bin/acp")]


def run(inft: str, args: list[str], *, apply: bool, write: bool) -> Any:
    argv = [*acp_bin(), "--inft", inft, *args, "--json"]
    if write:
        print("  $ acp " + " ".join(shlex.quote(a) for a in argv[1:]))
        if not apply:
            return None
    proc = subprocess.run(argv, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=180)
    out = proc.stdout.strip()
    if proc.returncode != 0 and not out:
        die(f"{' '.join(args[:2])} failed: {proc.stderr.strip()[:400]}")
    start = min([i for i in (out.find("{"), out.find("[")) if i >= 0], default=-1)
    if start < 0:
        die(f"{' '.join(args[:2])} returned no JSON: {out[:200]}")
    data = json.loads(out[start:])
    if isinstance(data, dict) and data.get("error"):
        die(f"{' '.join(args[:2])}: {data['error']}")
    return data


def rows(data: Any, *keys: str) -> list[dict]:
    if isinstance(data, list):
        return [r for r in data if isinstance(r, dict)]
    if isinstance(data, dict):
        for key in keys:
            if isinstance(data.get(key), list):
                return [r for r in data[key] if isinstance(r, dict)]
    return []


def valid_name(name: str) -> bool:
    return 3 <= len(name) <= 80 and name == name.strip() and all(c.isalnum() or c in " _-." for c in name)


def valid_schema(value: Any, where: str) -> None:
    if isinstance(value, str):
        if not value.strip():
            die(f"{where}: empty text")
        return
    if not isinstance(value, dict) or value.get("type") != "object":
        die(f'{where}: a schema must be an object with "type":"object"')
    props = value.get("properties", {})
    if not isinstance(props, dict):
        die(f"{where}: properties must be an object")
    for req in value.get("required", []):
        if req not in props:
            die(f"{where}: required field {req!r} is not in properties")


def as_flag(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, separators=(",", ":"))


def validate(catalog: dict) -> None:
    if catalog.get("version") != 1:
        die("catalog.version must be 1")
    offerings = catalog.get("offerings", [])
    if len(offerings) > OFFERING_CAP:
        die(f"{len(offerings)} offerings in the file — the marketplace caps an agent at {OFFERING_CAP}")
    seen: set[str] = set()
    for o in offerings:
        name = str(o.get("name", ""))
        if not valid_name(name):
            die(f"offering name {name!r}: {NAME_RULE}")
        if name in seen:
            die(f"offering name {name!r} appears twice")
        seen.add(name)
        if not (10 <= len(str(o.get("description", ""))) <= 500):
            die(f"offering {name}: description must be 10-500 chars")
        price = o.get("price")
        if not isinstance(price, dict) or price.get("type") not in ("fixed", "percentage"):
            die(f"offering {name}: price must be {{\"type\": fixed|percentage, \"value\": number}}")
        if not isinstance(price.get("value"), (int, float)) or price["value"] <= 0:
            die(f"offering {name}: price.value must be a positive number")
        if not isinstance(o.get("slaMinutes"), int) or o["slaMinutes"] < SLA_MIN:
            die(f"offering {name}: slaMinutes must be an integer ≥ {SLA_MIN}")
        valid_schema(o.get("requirements"), f"offering {name}.requirements")
        valid_schema(o.get("deliverable"), f"offering {name}.deliverable")
        for key in ("requiredFunds", "hidden"):
            if not isinstance(o.get(key, False), bool):
                die(f"offering {name}: {key} must be true/false")
    for r in catalog.get("resources", []):
        name = str(r.get("name", ""))
        if not valid_name(name):
            die(f"resource name {name!r}: {NAME_RULE}")
        if not str(r.get("url", "")).startswith("https://"):
            die(f"resource {name}: url must be https://")
        valid_schema(r.get("params", {"type": "object", "properties": {}}), f"resource {name}.params")
    for s in catalog.get("subscriptions", []):
        if s.get("durationDays") not in DURATIONS:
            die(f"subscription {s.get('name')}: durationDays must be one of {sorted(DURATIONS)}")
        if not isinstance(s.get("price"), (int, float)) or s["price"] <= 0:
            die(f"subscription {s.get('name')}: price must be a positive number")


def offering_flags(o: dict) -> list[str]:
    return [
        "--name", o["name"],
        "--description", o["description"],
        "--price-type", o["price"]["type"],
        "--price-value", str(o["price"]["value"]),
        "--sla-minutes", str(o["slaMinutes"]),
        "--requirements", as_flag(o["requirements"]),
        "--deliverable", as_flag(o["deliverable"]),
        "--required-funds" if o.get("requiredFunds") else "--no-required-funds",
        "--hidden" if o.get("hidden") else "--no-hidden",
        *(["--subscription-ids", ",".join(o["subscriptionIds"])] if o.get("subscriptionIds") else []),
    ]


def differs(o: dict, live: dict) -> bool:
    live_req = live.get("requirements")
    live_del = live.get("deliverable")
    return (
        o["description"] != live.get("description")
        or o["price"]["type"] != live.get("priceType")
        or float(o["price"]["value"]) != float(live.get("priceValue") or 0)
        or o["slaMinutes"] != live.get("slaMinutes")
        or json.dumps(o["requirements"], sort_keys=True) != json.dumps(live_req, sort_keys=True)
        or json.dumps(o["deliverable"], sort_keys=True) != json.dumps(live_del, sort_keys=True)
        or bool(o.get("requiredFunds")) != bool(live.get("requiredFunds"))
        or bool(o.get("hidden")) != bool(live.get("isHidden"))
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--inft", required=True, help="token number, ACP slug or profile slug of the iNFT")
    ap.add_argument("--catalog", required=True, help="path to the catalogue JSON")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--plan", action="store_true", help="show what would change; run nothing")
    mode.add_argument("--apply", action="store_true", help="create/update, write ids back")
    ap.add_argument("--prune", action="store_true", help="with --apply: delete live offerings missing from the file")
    args = ap.parse_args()

    with open(args.catalog, encoding="utf-8") as fh:
        catalog = json.load(fh)
    validate(catalog)
    apply = args.apply

    live_offerings = rows(run(args.inft, ["offering", "list"], apply=True, write=False), "offerings", "data")
    live_by_id = {str(r.get("id")): r for r in live_offerings if r.get("id")}
    live_by_name = {str(r.get("name")): r for r in live_offerings if r.get("name")}
    print(f"live: {len(live_offerings)} offerings ({OFFERING_CAP - len(live_offerings)} slots free)")

    creates = updates = unchanged = 0
    for o in catalog.get("offerings", []):
        live = live_by_id.get(str(o.get("id"))) or live_by_name.get(o["name"])
        if live is None:
            if len(live_offerings) + creates >= OFFERING_CAP:
                die(f"cannot create {o['name']}: the agent already has {OFFERING_CAP} offerings — delete or hide one first")
            creates += 1
            print(f"CREATE  {o['name']}  {o['price']['type']} {o['price']['value']}  sla {o['slaMinutes']}m  {'hidden' if o.get('hidden') else 'visible'}")
            created = run(args.inft, ["offering", "create", *offering_flags(o)], apply=apply, write=True)
            if created and isinstance(created, dict):
                o["id"] = created.get("id") or (created.get("offering") or {}).get("id") or o.get("id")
        else:
            o["id"] = live.get("id")
            if differs(o, live):
                updates += 1
                print(f"UPDATE  {o['name']}  (id {o['id']})")
                run(args.inft, ["offering", "update", "--offering-id", str(o["id"]), *offering_flags(o)], apply=apply, write=True)
            else:
                unchanged += 1

    file_names = {o["name"] for o in catalog.get("offerings", [])}
    file_ids = {str(o.get("id")) for o in catalog.get("offerings", []) if o.get("id")}
    orphans = [r for r in live_offerings if str(r.get("id")) not in file_ids and str(r.get("name")) not in file_names]
    for r in orphans:
        if args.prune:
            print(f"DELETE  {r.get('name')}  (id {r.get('id')})")
            run(args.inft, ["offering", "delete", "--offering-id", str(r.get("id")), "--force"], apply=apply, write=True)
        else:
            print(f"KEEP    {r.get('name')}  (live, not in the file — pass --prune to delete)")

    live_resources = rows(run(args.inft, ["resource", "list"], apply=True, write=False), "resources", "data")
    res_by_name = {str(r.get("name")): r for r in live_resources}
    for r in catalog.get("resources", []):
        live = res_by_name.get(r["name"])
        if live is None:
            print(f"CREATE  resource {r['name']}  {r['url']}")
            created = run(
                args.inft,
                [
                    "resource", "create",
                    "--name", r["name"],
                    "--description", r["description"],
                    "--url", r["url"],
                    "--params", as_flag(r.get("params", {"type": "object", "properties": {}})),
                    "--hidden" if r.get("hidden") else "--no-hidden",
                ],
                apply=apply,
                write=True,
            )
            if created and isinstance(created, dict):
                r["id"] = created.get("id") or r.get("id")
        else:
            r["id"] = live.get("id")
            if live.get("url") != r["url"] or live.get("description") != r["description"]:
                print(f"NOTE    resource {r['name']} differs live; `resource update` is interactive-only in this CLI — the owner edits it in a terminal")

    live_subs = rows(run(args.inft, ["subscription", "list"], apply=True, write=False), "subscriptions", "data")
    sub_by_name = {str(s.get("name")): s for s in live_subs}
    for s in catalog.get("subscriptions", []):
        live = sub_by_name.get(s["name"])
        if live is None:
            print(f"CREATE  subscription {s['name']}  {s['price']} USDC / {s['durationDays']}d")
            created = run(
                args.inft,
                ["subscription", "create", "--name", s["name"], "--price", str(s["price"]), "--duration-days", str(s["durationDays"])],
                apply=apply,
                write=True,
            )
            if created and isinstance(created, dict):
                s["id"] = created.get("id") or s.get("id")
                s["packageId"] = created.get("packageId", s.get("packageId"))
        else:
            s["id"] = live.get("id")
            s["packageId"] = live.get("packageId", s.get("packageId"))

    print(f"plan: {creates} create · {updates} update · {unchanged} unchanged · {len(orphans)} live-only")
    if apply:
        final = rows(run(args.inft, ["offering", "list"], apply=True, write=False), "offerings", "data")
        by_name = {str(r.get("name")): r for r in final}
        for o in catalog.get("offerings", []):
            if o["name"] in by_name:
                o["id"] = by_name[o["name"]].get("id")
        with open(args.catalog, "w", encoding="utf-8") as fh:
            json.dump(catalog, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        print(f"done: {len(final)} offerings live · ids written back to {args.catalog}")
    else:
        print("dry run — nothing was sent. Re-run with --apply to publish.")


if __name__ == "__main__":
    main()
