"""Bench harness for the `install.first_launch` row (driven by install.first_launch.mjs).

Times the runtime install the app runs on first launch -- `pm.cli._install_names` over the tool closure, then
`pm.cli._install_defaults` over the optional defaults, exactly the calls `pm install` makes -- per package and per
stage. The artifacts are served by a loopback Range server (the one `tests/pm` uses) behind a shared token bucket, so
bandwidth and latency are fixed and a before/after comparison is reproducible.

What is blocked, and how: inside this (sample) process an audit hook refuses non-loopback sockets and name resolution
-- it covers this Python interpreter's own sockets only. Child processes are outside it: the wrapper gives them
HTTP(S)_PROXY/ALL_PROXY pointing at an unreachable loopback port (NO_PROXY keeps loopback direct), npm runs
`--offline` by product code, and pm strips UV_OFFLINE from uv's environment, so for uv the proxy is the only guard.
`prime` and the venv warm-up (`--uv-cache-ship`) reach the real network on purpose.

Sub-commands:
  prime   --cache DIR                       fetch missing pinned artifacts once from the real network (declared)
  sample  --cache DIR --work DIR --phase cold|warm --out FILE [--packages a,b] [--bandwidth B/s] [--latency-ms N]
          [--inject-delay-s S --inject-package NAME] [--profile a,b]
          [--venv (--uv-cache-ship DIR | --uv-cache-payload DIR)]

--venv times the venv stage (python + uv + `uv sync` of uv.lock) from a marked throwaway clone. With --uv-cache-ship
(warm-up, real network) the machine uv cache is staged as the desktop bundle does (scripts/bundles/native.py
stage_uv_cache) but NOT pruned: the bundle's prune_uv_cache_to_lock drops entries an offline `uv sync` of this
checkout still needs (observed: ruamel-yaml, and the build requirements setuptools/wheel), so a pruned cache makes
every network-free sample fail; the prune count is recorded instead. With --uv-cache-payload the shipped cache is cloned to the payload root
(`uv-cache/` beside the store) where pm.packages.uv_cache_dir() copies it out on its first call: inside the timed
stage for --phase cold, before timing for --phase warm. The sample then needs the unreachable proxy (checked).

Instrumentation is wrapping only (stage boundaries are the package hooks `pm.install._install` calls); no product code
changes. Besides the per-package spans, every sample records its own timeline (`events`: each `Store.fetch_many` call
with the packages whose artifacts it fetched, each unpack/stage/verify/publish/digest hook and each `_install` span, in
ms from the sample start) and the order `_install` was entered (`order`). A download is attributed to the package whose
artifacts it fetched, never to the package being installed when it ran: an installer that prefetches the next archive
runs that download inside the previous package's turn. The wrapper (install.first_launch.mjs) reads the timeline to
decide whether per-stage times are attributable; the remainder `other` is computed there, never here. Shell activation and the python launchers are not run: both write into the runtime tree.
"""

from __future__ import annotations

import argparse
import contextlib
import cProfile
import io
import json
import os
import pstats
import shutil
import subprocess
import sys
import threading
import time
from collections import defaultdict
from contextlib import contextmanager
from http.server import ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

STAGES = ("download", "unpack", "stage", "verify", "publish")
LOOPBACK = {"127.0.0.1", "::1", "localhost"}
UNREACHABLE_PROXY = "http://127.0.0.1:9"


def _ms(ns: int) -> float:
    return ns / 1e6


def _closure():
    from pm.defaults import default_packages
    from pm.install import _lockfile
    from pm.registry import source_install_packages, tool_roots

    names = _lockfile().names()
    return tool_roots(source_install_packages(names)), default_packages(names)


def _artifacts(package_names):
    from pm.install import _lockfile
    from pm.registry import walk
    from pm.store import current_target

    lockfile, target, out = _lockfile(), current_target(), []
    for package in walk(package_names):
        for artifact in lockfile.artifacts(package.name, target):
            out.append((package.name, artifact))
    return out


def _cached(cache: Path, artifact: dict) -> Path:
    return cache / artifact["sha256"] / artifact["url"].rsplit("/", 1)[-1]


# --- prime ------------------------------------------------------------------------------------------------------------


def cmd_prime(args) -> dict:
    """Fill the artifact cache through pm's own downloader (hash-verified), one artifact at a time, real network."""
    from pm.artifact_mirror import pinned_source
    from pm.downloader import Download

    tools, defaults = _closure()
    cache = Path(args.cache)
    report = {}
    # uv is the venv stage's only artifact (pm.packages.Venv.deps); it is not in the tool closure.
    for name, artifact in _artifacts(tools + defaults + ["uv"]):
        dest = _cached(cache, artifact)
        if dest.is_file():
            report[artifact["sha256"]] = {
                "package": name,
                "bytes": dest.stat().st_size,
                "real_network_ms": None,
            }
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        t0 = time.perf_counter_ns()
        Download([pinned_source(artifact["url"], dest, artifact["sha256"])]).run()
        report[artifact["sha256"]] = {
            "package": name,
            "bytes": dest.stat().st_size,
            "real_network_ms": _ms(time.perf_counter_ns() - t0),
        }
    (cache / "manifest.json").write_text(json.dumps(report, indent=1))
    import hashlib
    import platform

    exe = Path(os.path.realpath(sys.executable))
    return {
        "python_version": platform.python_version(),
        "python_sha256": hashlib.sha256(exe.read_bytes()).hexdigest(),
        "artifacts": report,
    }


# --- the simulated network --------------------------------------------------------------------------------------------


class _Pacer:
    """One token bucket shared by every connection: the aggregate rate is fixed however many ranges run at once."""

    def __init__(self, bandwidth: float):
        self.bandwidth, self.lock, self.next_free = bandwidth, threading.Lock(), 0.0

    def wait(self, nbytes: int) -> None:
        with self.lock:
            start = max(time.monotonic(), self.next_free)
            self.next_free = start + nbytes / self.bandwidth
            due = self.next_free
        delay = due - time.monotonic()
        if delay > 0:
            time.sleep(delay)


class _PacedWriter:
    PIECE = 64 * 1024

    def __init__(self, raw, pacer: _Pacer):
        self._raw, self._pacer = raw, pacer

    def write(self, data) -> int:
        view = memoryview(data)
        for offset in range(0, len(view), self.PIECE):
            piece = view[offset : offset + self.PIECE]
            self._pacer.wait(len(piece))
            self._raw.write(piece)
        return len(view)

    def __getattr__(self, name):
        return getattr(self._raw, name)


def _start_server(
    cache: Path, artifacts, bandwidth: float, latency_s: float, delays: dict
):
    try:
        import pytest  # noqa: F401 - the shared server module decorates its fixture with it
    except ImportError:
        # The runtime interpreter carries no pytest; the server class needs only the fixture decorator to import.
        import types

        sys.modules["pytest"] = types.SimpleNamespace(fixture=lambda fn: fn)
    from tests.pm._range_server import RangeHandler

    pacer = _Pacer(bandwidth)

    class Handler(RangeHandler):
        requests: list = []

        def setup(self):
            super().setup()
            self.wfile = _PacedWriter(self.wfile, pacer)

        def do_GET(self):  # noqa: N802 - http.server API
            time.sleep(latency_s + delays.get(self.path, 0.0))
            Handler.requests.append(self.path)
            super().do_GET()

    Handler.payloads = {
        f"/{a['sha256']}/{_cached(cache, a).name}": _cached(cache, a).read_bytes()
        for _, a in artifacts
    }
    Handler.ranges_seen, Handler.abort_after, Handler.no_range, Handler.etags = (
        [],
        None,
        False,
        True,
    )
    Handler.slow_per_chunk, Handler.chunk = 0.0, 1 << 20
    # The downloader opens parallel ranged connections; the default backlog (5) resets some of them on macOS.
    ThreadingHTTPServer.request_queue_size = 128
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, Handler


def _block_network() -> None:
    """Refuse non-loopback sockets and name resolution in THIS interpreter (audit hook); subprocesses are not covered."""

    def guard(event, args):
        if event == "socket.connect":
            address = args[1]
            if isinstance(address, tuple) and address[0] not in LOOPBACK:
                raise PermissionError(f"bench: network refused ({address[0]})")
        elif (
            event == "socket.getaddrinfo"
            and args[0] not in LOOPBACK
            and args[0] is not None
        ):
            raise PermissionError(f"bench: name resolution refused ({args[0]})")

    sys.addaudithook(guard)


# --- the timed sample -------------------------------------------------------------------------------------------------


def _assert_writes_under_work(work: Path) -> None:
    """Check that HOME, the hermes root and every pm root this process can write resolve under the sample's work dir.

    A path check only; it does not restrict what the process can reach."""
    from hermes_constants import get_default_hermes_root
    from pm import paths

    work = work.resolve()
    for label, path in (
        ("HOME", Path(os.environ["HOME"])),
        ("hermes root (machine uv cache)", get_default_hermes_root()),
        ("store", paths.store_root()),
        ("writable store", paths.writable_store_root()),
        ("partials", paths.partials_root()),
    ):
        if not path.resolve().is_relative_to(work):
            raise SystemExit(
                f"bench: {label} resolves outside the sample work dir; refusing to install"
            )


def _place_uv_cache(shipped: Path, work: Path, phase: str) -> dict:
    """Put the shipped uv cache where a sealed install carries it: `uv-cache/` at the payload root (store's parent)."""
    import pm.packages
    from pm.paths import store_root

    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        if os.environ.get(key) != UNREACHABLE_PROXY:
            raise SystemExit(
                f"bench: --uv-cache-payload needs {key}={UNREACHABLE_PROXY} (network-free sample)"
            )
    if "127.0.0.1" not in os.environ.get("NO_PROXY", "").split(","):
        raise SystemExit(
            "bench: --uv-cache-payload needs NO_PROXY to keep 127.0.0.1 direct (loopback Range server)"
        )
    if not shipped.is_dir() or not any(shipped.iterdir()):
        raise SystemExit(f"bench: shipped uv cache missing or empty: {shipped.name}")
    payload = store_root().parent / "uv-cache"
    if not payload.resolve().is_relative_to(work.resolve()):
        raise SystemExit("bench: payload uv-cache resolves outside the sample work dir")
    payload.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["/bin/cp", "-c", "-R", str(shipped), str(payload)], check=True)
    if phase == "warm":
        # Warm: the first-call copy-out already happened (a second install on the same machine); untimed.
        pm.packages.uv_cache_dir()
    return {
        "placed": "payload uv-cache/ beside the store (as the desktop bundle ships it)",
        "copied_out": "before timing"
        if phase == "warm"
        else "inside the timed venv stage",
        "shipped_bytes": _tree_bytes(shipped),
    }


def _ship_uv_cache(dest: Path) -> dict:
    """After the warm-up: stage the machine uv cache as the bundle does; record (not apply) the bundle's prune."""
    import pm.packages
    from pm.uv_cache_prune import prune_uv_cache_to_lock

    if str(REPO) not in sys.path:
        sys.path.append(str(REPO))
    from scripts.bundles.native import stage_uv_cache

    machine = pm.packages.uv_cache_dir()
    stage_uv_cache(machine, dest)
    probe = dest.with_name(dest.name + ".prune-probe")
    shutil.rmtree(probe, ignore_errors=True)
    subprocess.run(["/bin/cp", "-c", "-R", str(dest), str(probe)], check=True)
    try:
        would_prune = prune_uv_cache_to_lock(probe, REPO)
        pruned_bytes = _tree_bytes(probe)
    finally:
        shutil.rmtree(probe, ignore_errors=True)
    return {
        "staged_by": "scripts/bundles/native.py stage_uv_cache",
        "prune_to_lock": {
            "applied": False,
            "would_prune_entries": would_prune,
            "pruned_bytes": pruned_bytes,
            "reason": "the pruned cache misses entries an offline uv sync needs; see module docstring",
        },
        "shipped_bytes": _tree_bytes(dest),
    }


def _tree_bytes(root: Path) -> int:
    return sum(
        p.stat().st_size for p in root.rglob("*") if p.is_file() and not p.is_symlink()
    )


def _profile_rows(profile: cProfile.Profile, limit: int = 12) -> list:
    stats = pstats.Stats(profile, stream=io.StringIO())
    rows = []
    for (file, line, func), (cc, nc, tt, ct, _) in stats.stats.items():
        where = file
        for root in (str(REPO) + os.sep, sys.prefix, sys.base_prefix):
            where = where.replace(root, "")
        rows.append({
            "func": f"{where}:{line}({func})",
            "calls": nc,
            "tottime_ms": round(tt * 1e3, 1),
            "cumtime_ms": round(ct * 1e3, 1),
        })
    rows.sort(key=lambda r: r["tottime_ms"], reverse=True)
    return rows[:limit]


def cmd_sample(args) -> dict:
    import pm.cli
    import pm.install
    import pm.packages
    from pm.store import Store

    work, cache = Path(args.work), Path(args.cache)
    _assert_writes_under_work(work)
    tools, defaults = _closure()
    if args.venv:
        # The venv stage: uv + `uv sync` of uv.lock into REPO (pm.packages.Venv). It writes into the project root, so
        # it only runs from a throwaway clone that the wrapper marked; never against a real checkout.
        if not (REPO / ".bench-clone").is_file():
            raise SystemExit(
                "bench: --venv writes into the project root; run it from a marked clone only"
            )
        tools, defaults = ["python", "uv", "venv"], []
    elif args.packages:
        wanted = args.packages.split(",")
        tools, defaults = (
            [n for n in tools if n in wanted],
            [n for n in defaults if n in wanted],
        )
    artifacts = _artifacts([n for n in tools + defaults if n != "venv"])
    missing = [a["url"] for _, a in artifacts if not _cached(cache, a).is_file()]
    if missing:
        raise SystemExit(
            f"bench: artifact cache incomplete ({len(missing)} missing); run prime first"
        )
    package_of = {a["sha256"]: name for name, a in artifacts}
    delays = {
        f"/{a['sha256']}/{_cached(cache, a).name}": args.inject_delay_s
        for name, a in artifacts
        if name == args.inject_package
    }
    server, handler = _start_server(
        cache, artifacts, args.bandwidth, args.latency_ms / 1e3, delays
    )
    base = f"http://127.0.0.1:{server.server_port}"
    uv_cache = None
    if args.venv and args.uv_cache_payload:
        uv_cache = _place_uv_cache(Path(args.uv_cache_payload), work, args.phase)
    _block_network()

    store_root = Path(os.environ["HERMES_RUNTIME_DIR"])
    if args.phase == "warm":
        # Warm = the verified download cache already holds every archive (what a pre-fetch leaves behind).
        for _, a in artifacts:
            entry = store_root / f"fetch-{a['sha256']}"
            entry.mkdir(parents=True, exist_ok=True)
            shutil.copy2(_cached(cache, a), entry / _cached(cache, a).name)

    spans = defaultdict(lambda: defaultdict(int))
    current = [None]
    # The sample's own timeline; a prefetching installer calls fetch_many from another thread, hence the lock.
    events, install_order, lock = [], [], threading.Lock()

    def record(kind, t0_ns, t1_ns, **who):
        with lock:
            events.append({"kind": kind, "t0_ns": t0_ns, "t1_ns": t1_ns, **who})

    profiles, subprocess_ms, profile_names = (
        {},
        defaultdict(int),
        set(filter(None, args.profile.split(","))),
    )

    import pm.artifact_mirror
    from pm.downloader import Source

    pm.artifact_mirror.pinned_source = lambda url, dest, sha256: Source(
        url, dest, sha256, fallbacks=()
    )
    original_fetch_many = Store.fetch_many

    def fetch_many(self, items, scratch, **kw):
        local = [
            {**a, "url": f"{base}/{a['sha256']}/{a['url'].rsplit('/', 1)[-1]}"}
            for a in items
        ]
        lockfile_url = {b["url"]: a["url"] for a, b in zip(items, local)}
        progress = kw.get("progress")
        if progress is not None:
            # Progress speaks lockfile URLs (store.fetch_many does the same for mirrors).
            kw["progress"] = lambda done, total, ranges: progress(
                done,
                total,
                {lockfile_url.get(url, url): rows for url, rows in ranges.items()},
            )
        owners = sorted(
            {package_of.get(a["sha256"], current[0]) for a in items} - {None}
        )
        t0 = time.perf_counter_ns()
        try:
            return original_fetch_many(self, local, scratch, **kw)
        finally:
            t1 = time.perf_counter_ns()
            record("download", t0, t1, packages=owners)
            if len(owners) == 1:
                # One call for several packages has no per-package time: the timeline carries it, the spans do not.
                with lock:
                    spans[owners[0]]["download"] += t1 - t0

    Store.fetch_many = fetch_many

    original_run = subprocess.run

    def timed_run(*a, **kw):
        t0 = time.perf_counter_ns()
        try:
            return original_run(*a, **kw)
        finally:
            subprocess_ms[current[0]] += time.perf_counter_ns() - t0

    pm.packages.subprocess.run = timed_run

    def timed(stage, fn):
        def wrapper(*a, **kw):
            name = current[0]
            profiler = (
                cProfile.Profile()
                if stage == "unpack" and name in profile_names
                else None
            )
            t0 = time.perf_counter_ns()
            if profiler:
                profiler.enable()
            try:
                return fn(*a, **kw)
            finally:
                t1 = time.perf_counter_ns()
                if profiler:
                    profiler.disable()
                    profiles[name] = _profile_rows(profiler)
                record(stage, t0, t1, package=name)
                with lock:
                    spans[name][stage] += t1 - t0

        return wrapper

    original_install = pm.install._install

    def install(package, *a, **kw):
        current[0] = package.name
        install_order.append(package.name)
        hooks = {
            stage: getattr(package, stage) for stage in ("unpack", "stage", "verify")
        }
        for stage, fn in hooks.items():
            object.__setattr__(package, stage, timed(stage, fn))
        t0 = time.perf_counter_ns()
        try:
            return original_install(package, *a, **kw)
        except BaseException as exc:
            # pm folds the cause into a one-line InstallError; keep the chain for the bench log.
            import traceback

            traceback.print_exception(exc, file=sys.stderr)
            raise
        finally:
            t1 = time.perf_counter_ns()
            record("install", t0, t1, package=package.name)
            with lock:
                spans[package.name]["total"] += t1 - t0
            for stage in hooks:
                object.__delattr__(package, stage)

    pm.install._install = install

    original_publish = pm.install._publish_entry

    @contextmanager
    def publish_entry(*a, **kw):
        t0 = time.perf_counter_ns()
        try:
            with original_publish(*a, **kw) as value:
                yield value
        finally:
            t1 = time.perf_counter_ns()
            record("publish", t0, t1, package=current[0])
            with lock:
                spans[current[0]]["publish"] += t1 - t0

    pm.install._publish_entry = publish_entry

    original_digest = pm.install.tree_digest

    def tree_digest(root):
        t0 = time.perf_counter_ns()
        try:
            return original_digest(root)
        finally:
            t1 = time.perf_counter_ns()
            record("digest", t0, t1, package=current[0])
            with lock:
                spans[current[0]]["digest"] += t1 - t0

    pm.install.tree_digest = tree_digest

    import hermes_cli.venv_sync

    # Writes launchers into the runtime tree (here: the repository); not part of what this row times.
    hermes_cli.venv_sync.publish_launchers = lambda *a, **kw: None

    if args.venv:
        # A state package never reaches pm.install._install; its span is the whole ensure("venv") (uv sync).
        original_ensure = pm.cli.ensure

        def ensure(name, *a, **kw):
            if name != "venv":
                return original_ensure(name, *a, **kw)
            current[0] = name
            install_order.append(name)
            t0 = time.perf_counter_ns()
            try:
                return original_ensure(name, *a, **kw)
            finally:
                t1 = time.perf_counter_ns()
                record("install", t0, t1, package=name)
                spans[name]["total"] += t1 - t0

        pm.cli.ensure = ensure

    log = io.StringIO()
    t0 = time.perf_counter_ns()
    with contextlib.redirect_stdout(log):
        failed = pm.cli._install_names(tools)
        t_tools = time.perf_counter_ns()
        if not failed:
            pm.cli._install_defaults(defaults, verify=True)
    total_ns = time.perf_counter_ns() - t0
    server.shutdown()
    failed_lines = [
        line for line in log.getvalue().splitlines() if line.startswith(("✗", "⚠"))
    ]

    packages = {}
    for name, rec in spans.items():
        if name is None:
            continue
        row = {
            stage: round(_ms(rec[stage]), 1) for stage in (*STAGES, "digest", "total")
        }
        if subprocess_ms.get(name):
            row["subprocess_in_hooks"] = round(_ms(subprocess_ms[name]), 1)
        row["bytes"] = sum(
            _cached(cache, a).stat().st_size for n, a in artifacts if n == name
        )
        packages[name] = row
    result = {
        "phase": args.phase,
        "total_ms": round(_ms(total_ns), 1),
        "tools_ms": round(_ms(t_tools - t0), 1),
        # The order `_install` (or ensure("venv")) was entered: the install order, whatever a prefetch did meanwhile.
        "order": list(dict.fromkeys(install_order)),
        "packages": packages,
        "events": [
            {
                **{k: v for k, v in e.items() if k not in ("t0_ns", "t1_ns")},
                "t0": round(_ms(e["t0_ns"] - t0), 1),
                "t1": round(_ms(e["t1_ns"] - t0), 1),
            }
            for e in sorted(events, key=lambda e: e["t0_ns"])
        ],
        "failed": failed_lines,
        "requests": len(handler.requests),
        "network": {
            "bandwidth_bytes_per_s": args.bandwidth,
            "latency_ms": args.latency_ms,
            "injected_delay_s": args.inject_delay_s,
            "injected_package": args.inject_package,
        },
    }
    if args.venv and args.uv_cache_ship and not failed_lines:
        uv_cache = _ship_uv_cache(Path(args.uv_cache_ship))
    if uv_cache is not None:
        result["uv_cache"] = uv_cache
    if profiles:
        result["profiles"] = profiles
        result["first_exec"] = _first_exec(store_root, work)
    return result


def _first_exec(store_root: Path, work: Path) -> dict:
    """Wall time of a freshly written copy of the staged node binary, first exec vs second (macOS scans new binaries)."""
    nodes = sorted(store_root.glob("node-*/bin/node"))
    if not nodes:
        return {}
    fresh = work / "fresh-node"
    shutil.copy2(nodes[0], fresh)
    times = []
    for _ in range(3):
        t0 = time.perf_counter_ns()
        subprocess.run([str(fresh), "--version"], capture_output=True, check=True)
        times.append(round(_ms(time.perf_counter_ns() - t0), 1))
    return {
        "node_bytes": fresh.stat().st_size,
        "exec_ms_first_second_third": times,
        "xattrs_on_staged_node": subprocess.run(
            ["/usr/bin/xattr", str(nodes[0])], capture_output=True, text=True
        ).stdout.split(),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    prime = sub.add_parser("prime")
    prime.add_argument("--cache", required=True)
    prime.add_argument("--out", required=True)
    sample = sub.add_parser("sample")
    sample.add_argument("--cache", required=True)
    sample.add_argument("--work", required=True)
    sample.add_argument("--out", required=True)
    sample.add_argument("--phase", choices=("cold", "warm"), required=True)
    sample.add_argument("--packages", default="")
    sample.add_argument("--bandwidth", type=float, default=12_500_000.0)
    sample.add_argument("--latency-ms", type=float, default=20.0)
    sample.add_argument("--inject-delay-s", type=float, default=0.0)
    sample.add_argument("--inject-package", default="")
    sample.add_argument("--profile", default="")
    sample.add_argument(
        "--venv",
        action="store_true",
        help="time the venv stage (python + uv + venv) from a marked throwaway clone",
    )
    uv = sample.add_mutually_exclusive_group()
    uv.add_argument(
        "--uv-cache-ship",
        default="",
        help="warm-up (real network): stage the resulting uv cache in shipped form into DIR",
    )
    uv.add_argument(
        "--uv-cache-payload",
        default="",
        help="network-free: place the shipped uv cache DIR at the payload root before the stage",
    )
    args = parser.parse_args(argv)
    result = cmd_prime(args) if args.cmd == "prime" else cmd_sample(args)
    Path(args.out).write_text(json.dumps(result, indent=1), encoding="utf-8")
    return 1 if args.cmd == "sample" and result["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
