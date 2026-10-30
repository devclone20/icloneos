"""pytest plugin of the bench `gates.suite` row: drop the collected items whose node id is EXACTLY a line of the file
given by --bench-exact-deselect ('#' lines are comments). pytest's own --deselect matches by prefix, which would also
drop every parametrisation a bare name prefixes. Load it attached (`-pbench_exact_deselect`): hermes_cli.main scans
sys.argv for a detached `-p <profile>` at import time.

With --bench-module-roots=<file> it also appends, at session end, where the already-imported `pm` and `hermes_cli`
came from (read from sys.modules: nothing is imported, nothing is timed), so the row can prove the tests ran the
clone's code and not an editable install of another checkout.

With --bench-stats=<file> it appends one JSON line per pytest process after collection (`collected`: the items left
after deselection) and one at session end (`finished`: per-test outcomes, setup failures counted as failed, setup
skips as skipped, a failed teardown as failed). A process that never reaches session end leaves only the first line,
so the row can tell a run that was cut short from a complete one without reading pytest's printed text.
"""

import json
import os
import sys

ROOT_MODULES = ("pm", "hermes_cli")
_OUTCOMES = {}


def _append(path, record):
    # One short line per write, opened for append: lines from parallel pytest processes do not interleave.
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")


def pytest_addoption(parser):
    group = parser.getgroup("bench")
    group.addoption("--bench-exact-deselect", default="")
    group.addoption("--bench-module-roots", default="")
    group.addoption("--bench-stats", default="")


def pytest_collection_finish(session):
    path = session.config.getoption("--bench-stats")
    if path and not session.config.option.collectonly:
        _append(
            path, {"kind": "collected", "pid": os.getpid(), "n": len(session.items)}
        )


def pytest_runtest_logreport(report):
    if report.when == "call" or (report.when == "setup" and not report.passed):
        _OUTCOMES[report.nodeid] = report.outcome
    elif report.when == "teardown" and report.failed:
        _OUTCOMES[report.nodeid] = "failed"


def pytest_sessionfinish(session):
    stats = session.config.getoption("--bench-stats")
    if stats and not session.config.option.collectonly:
        counts = {"passed": 0, "failed": 0, "skipped": 0}
        for outcome in _OUTCOMES.values():
            counts[outcome] += 1
        _append(stats, {"kind": "finished", "pid": os.getpid(), **counts})
    path = session.config.getoption("--bench-module-roots")
    if not path:
        return
    lines = []
    for name in ROOT_MODULES:
        origin = getattr(sys.modules.get(name), "__file__", None)
        if origin:
            lines.append(f"{name}\t{os.path.realpath(origin)}\n")
    if lines:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write("".join(lines))


def pytest_collection_modifyitems(config, items):
    path = config.getoption("--bench-exact-deselect")
    if not path:
        return
    with open(path, encoding="utf-8") as fh:
        wanted = {
            line.strip() for line in fh if line.strip() and not line.startswith("#")
        }
    keep = [item for item in items if item.nodeid not in wanted]
    dropped = [item for item in items if item.nodeid in wanted]
    if dropped:
        config.hook.pytest_deselected(items=dropped)
        items[:] = keep
