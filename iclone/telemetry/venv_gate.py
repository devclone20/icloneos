#!/usr/bin/env python3
"""Ruling 57.2 — the packaging gate of the runtime venv the app ships: telemetry is not shipped.

    python3 iclone/telemetry/venv_gate.py <venv> [--json]

Lists every installed distribution and every native library (Mach-O / ELF / .so / .dylib / .pyd) and Python module in
<venv>, and FAILS (exit 1) on:
  * a distribution in the denylist (hermes_cli/iclone_sinks.py TELEMETRY_DISTRIBUTIONS: nemo-relay, the OpenTelemetry
    exporters and protos, langfuse, posthog, sentry, segment, mixpanel, amplitude, datadog, honeycomb, ...);
  * a native library or module that contains an OTLP trace/metrics/logs service path or a known analytics host
    (OTLP_SERVICE_PATHS, ANALYTICS_HOSTS), or a telemetry/analytics module with its own HTTP client. The exceptions
    are files the sink registry names: hermes-agent's (SINKS / REFERENCES) and third-party ones (THIRD_PARTY_SINKS),
    each refused or made inert in code under icloneOS.

The exclusion list the RT pack applies when it builds the venv is runtime-venv-exclusions.txt beside this file
(one distribution per line; e.g. `uv sync --no-install-package <name>` for each). Stdlib only; reads, never writes. Fail closed (ruling 58.1): an unreadable
file, archive or metadata is RED; .pyc/.pyw/.js and archive members (with their metadata) are read.
"""
from __future__ import annotations

import json
import os
import re
import sys
from email.parser import HeaderParser
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
EXCLUSIONS = Path(__file__).resolve().with_name("runtime-venv-exclusions.txt")
NATIVE_SUFFIXES = (".so", ".dylib", ".pyd")
MODULE_SUFFIXES = (".py", ".pyw", ".pyc", ".pyo", ".js", ".mjs", ".cjs")
ARCHIVE_SUFFIXES = (".egg", ".zip", ".whl", ".pyz")
HTTP_CLIENT = re.compile(rb"urllib\.request|urlopen|\brequests\.(?:post|get|put|Session)|\bhttpx\b|\baiohttp\b|http\.client|fetch\(")
MAGICS = (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\x7fELF")


def _denylist():
    sys.path.insert(0, str(REPO))
    try:
        from hermes_cli import iclone_sinks
    finally:
        sys.path.pop(0)
    return iclone_sinks


def _sha256(path: Path) -> str:
    import hashlib

    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return ""


def _walk(root: Path, limit: int = 200_000):
    """Every file under *root*, following symlinked directories (ruling 58.1) — each real directory once, so a link
    loop ends; more than *limit* entries is reported as an error (fail closed)."""
    seen, stack, count = set(), [root], 0
    while stack:
        folder = stack.pop()
        try:
            real = folder.resolve(strict=True)
        except OSError:
            yield folder, OSError("unresolvable directory")
            continue
        if real in seen:
            continue
        seen.add(real)
        try:
            entries = sorted(folder.iterdir())
        except OSError as exc:
            yield folder, exc
            continue
        for entry in entries:
            count += 1
            if count > limit:
                yield entry, OSError("too many entries")
                return
            if entry.is_dir():
                stack.append(entry)
            else:
                yield entry, None


def _site_packages(venv: Path) -> list[Path]:
    return sorted({p for pattern in ("lib/python*/site-packages", "lib64/python*/site-packages", "Lib/site-packages")
                   for p in venv.glob(pattern) if p.is_dir()})


def distributions(venv: Path) -> list[dict]:
    """Every installed distribution: name, version, its meta dir, and the files its RECORD lists."""
    found = []
    for site in _site_packages(venv):
        for meta in sorted(list(site.glob("*.dist-info")) + list(site.glob("*.egg-info"))):
            head = meta / "METADATA" if meta.suffix == ".dist-info" else meta / "PKG-INFO"
            try:
                fields = HeaderParser().parsestr(head.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                # Fail closed (ruling 58.1): a distribution whose metadata cannot be read is named by its folder
                # and reported unreadable — never skipped.
                found.append({"name": meta.name.split("-")[0], "version": "", "meta": str(meta), "files": [],
                              "unreadable": True})
                continue
            record = meta / "RECORD"
            files = []
            if record.is_file():
                files = [str((site / line.split(",", 1)[0]).resolve()) for line in record.read_text().splitlines() if line]
            found.append({"name": fields.get("Name", meta.name), "version": fields.get("Version", ""),
                          "meta": str(meta), "files": files})
    return found


def _is_native(path: Path) -> bool:
    if path.suffix in NATIVE_SUFFIXES:
        return True
    if path.suffix or not os.access(path, os.X_OK):
        return False
    try:
        with path.open("rb") as handle:
            return handle.read(4) in MAGICS
    except OSError:
        return False


def scan(venv: Path) -> dict:
    sinks = _denylist()
    venv = venv.resolve()
    dists = distributions(venv)
    owner = {f: d["name"] for d in dists for f in d["files"]}
    registry = sinks.registered_files()
    needles = [n.encode() for n in sinks.OTLP_SERVICE_PATHS + sinks.ANALYTICS_HOSTS]
    pattern = re.compile(b"|".join(re.escape(n) for n in needles))

    denied = [f"{d['name']}=={d['version']}" for d in dists if sinks.distribution_denied(d["name"])]
    unreadable = [d["meta"] for d in dists if d.get("unreadable")]
    natives, modules, hits, registered = 0, 0, [], []
    for path, walk_error in _walk(venv):
        if walk_error is not None:
            unreadable.append(f"{path.relative_to(venv).as_posix()} ({walk_error})")
            continue
        archive = path.suffix in ARCHIVE_SUFFIXES
        try:
            native = not archive and _is_native(path)
        except OSError:
            native = False
        if not native and not archive and path.suffix not in MODULE_SUFFIXES:
            continue
        natives += native
        modules += not native
        try:
            data = path.read_bytes()  # a symlink is read through: its target ships with the venv
            if archive:
                import io
                import zipfile

                with zipfile.ZipFile(io.BytesIO(data)) as zf:
                    data = b"\0".join(zf.read(n) for n in zf.namelist()
                                       if n.endswith(MODULE_SUFFIXES + NATIVE_SUFFIXES + ("METADATA", "PKG-INFO")))
                    for n in zf.namelist():
                        if n.endswith(("METADATA", "PKG-INFO")):
                            name = HeaderParser().parsestr(zf.read(n).decode("utf-8", "replace")).get("Name", "")
                            if name and sinks.distribution_denied(name):
                                denied.append(f"{name} (inside {path.relative_to(venv).as_posix()})")
        except (OSError, ValueError, RuntimeError) as exc:  # zipfile.BadZipFile is a ValueError... and others
            unreadable.append(f"{path.relative_to(venv).as_posix()} ({type(exc).__name__})")
            continue
        except Exception as exc:  # noqa: BLE001 — fail closed on anything we cannot read
            unreadable.append(f"{path.relative_to(venv).as_posix()} ({type(exc).__name__})")
            continue
        found = sorted({m.group(0).decode() for m in pattern.finditer(data)})
        # r7: a telemetry/analytics module that carries its own HTTP client is a sink whatever host it names
        # (browser-harness posted to PostHog through urllib, with the host in a variable).
        stem = path.name.split(".", 1)[0].lower()
        if (not native and any(w in stem for w in ("telemetry", "analytics", "tracking", "metrics_sender"))
                and HTTP_CLIENT.search(data)):
            found.append("telemetry module with an HTTP client")
        if not found:
            continue
        rel = path.relative_to(venv).as_posix()
        source = path
        package_rel = rel.split("site-packages/", 1)[-1]
        if "__pycache__/" in package_rel:  # a compiled module counts as its source file (and its owner's)
            folder, compiled = package_rel.rsplit("__pycache__/", 1)
            package_rel = folder + compiled.split(".", 1)[0] + ".py"
            source = path.parent.parent / (compiled.split(".", 1)[0] + ".py")
        dist = owner.get(str(path.resolve()), "") or owner.get(str(source.resolve()), "")
        if sinks.normalize_distribution(dist) == "hermes-agent" and package_rel in registry:
            registered.append({"file": rel, "found": found})
            continue
        third = sinks.THIRD_PARTY_SINKS.get(sinks.normalize_distribution(dist), {})
        reviewed = third.get("files", {}).get(package_rel)
        if reviewed and _sha256(source if source.exists() else path) == reviewed:
            # ruling 58.2: allowed by the reviewed BYTES (a compiled module by its source's), never by path alone
            registered.append({"file": rel, "found": found, "third_party": dist})
            continue
        hits.append({"file": rel, "distribution": dist, "native": native, "found": found})
    return {
        "venv": str(venv),
        "distributions": len(dists),
        "natives": natives,
        "modules": modules,
        "denied_distributions": denied,
        "content_hits": hits,
        "unreadable": unreadable,
        "registered_first_party": registered,
        "ok": bool(dists) and not denied and not hits and not unreadable,
    }


def exclusion_list() -> list[str]:  # the file RT reads; equal to iclone_sinks.RUNTIME_VENV_EXCLUSIONS (tested)
    return [line.split("#", 1)[0].strip() for line in EXCLUSIONS.read_text().splitlines()
            if line.split("#", 1)[0].strip()]


def main(argv: list[str]) -> int:
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    report = scan(Path(args[0]))
    if "--json" in argv:
        print(json.dumps(report, indent=2))
    else:
        print(f"venv {report['venv']}: {report['distributions']} distributions, {report['natives']} native libraries, "
              f"{report['modules']} modules")
        for name in report["denied_distributions"]:
            print(f"  DENIED distribution {name}")
        for item in report["unreadable"]:
            print(f"  UNREADABLE {item} (fail closed)")
        for hit in report["content_hits"]:
            kind = "native" if hit["native"] else "module"
            print(f"  DENIED {kind} {hit['file']} ({hit['distribution'] or 'no RECORD'}): {', '.join(hit['found'])}")
        print("GREEN: no telemetry shipped" if report["ok"] else "RED: telemetry would ship")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
