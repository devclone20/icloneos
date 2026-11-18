"""CF8 PERF.launcher: the launcher's interpreter entry in the perf world only, to count its directory listings.

    <python> -I -S launcher-shim.py <listings.json> -I -S <launcher.py> [launcher args...]

Main starts the launcher as `<python> -I -S launcher.py`; the perf driver points main's launcher interpreter at a
wrapper that execs this file first (same process: exec, not a child), so the launcher runs unchanged under
runpy.run_path with one audit hook (PEP 578) recording every os.scandir / os.listdir (os.walk and os.fwalk list
through them): its wall time (time.time()) and its absolute target, or "<fd>" for an open directory fd. The launcher
starts before the world's project is known, so the shim judges nothing: the gate keeps the listings inside the project.
The total and the first 200 000 listings are rewritten atomically to <listings.json> every 50 ms when they change.
Never shipped: nothing in the app or the runtime imports it.
"""
import json
import os
import runpy
import sys
import threading
import time

LISTING_EVENTS = {"os.scandir", "os.listdir"}
TIMES_CAP = 200_000
FLUSH_S = 0.05


def main() -> None:
    out_path = sys.argv[1]
    rest = sys.argv[2:]

    while rest and rest[0].startswith("-"):
        rest = rest[1:]

    if not rest:
        raise SystemExit("launcher-shim: no launcher script after the interpreter flags")

    state = {"total": 0, "listings": [], "dirty": True}
    lock = threading.Lock()

    def hook(event, args):
        if event not in LISTING_EVENTS:
            return
        target = args[0] if args else "."
        if isinstance(target, int):
            target = "<fd>"
        else:
            if isinstance(target, os.PathLike):
                target = os.fspath(target)
            if isinstance(target, bytes):
                target = os.fsdecode(target)
            if target in (None, "."):
                target = os.getcwd()
            elif not os.path.isabs(target):
                target = os.path.join(os.getcwd(), target)
        with lock:
            state["total"] += 1
            if len(state["listings"]) < TIMES_CAP:
                state["listings"].append([time.time(), target])
            state["dirty"] = True

    def flush() -> None:
        with lock:
            if not state["dirty"]:
                return
            body = {"pid": os.getpid(), "total": state["total"], "listings": list(state["listings"])}
            state["dirty"] = False
        tmp = f"{out_path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(body, handle)
        os.replace(tmp, out_path)

    def flusher() -> None:
        while True:
            time.sleep(FLUSH_S)
            flush()

    sys.addaudithook(hook)
    flush()
    threading.Thread(target=flusher, name="perf-shim-flush", daemon=True).start()
    sys.argv = rest
    try:
        runpy.run_path(rest[0], run_name="__main__")
    finally:
        flush()


if __name__ == "__main__":
    main()
