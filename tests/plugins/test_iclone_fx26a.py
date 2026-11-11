"""fx26a: nothing the runtime wrote is a folder or an identity (one table, every place field x every spelling), and a
program's widening writes only the run's own folders and the caches main named."""
import importlib
import importlib.util
import os
import sys
import types
import unicodedata

import pytest

from tests.plugins.test_iclone_launcher import L, w  # noqa: F401


def _plugin_module(name):
    root = os.path.join(os.path.dirname(__file__), "..", "..", "plugins", "iclone-confinement")
    ns = sys.modules.setdefault("hermes_plugins", types.ModuleType("hermes_plugins"))
    ns.__path__ = getattr(ns, "__path__", [])
    pkg = "hermes_plugins.iclone_confinement"
    if pkg not in sys.modules:
        spec = importlib.util.spec_from_file_location(pkg, os.path.join(root, "__init__.py"), submodule_search_locations=[root])
        mod = importlib.util.module_from_spec(spec)
        sys.modules[pkg] = mod
        spec.loader.exec_module(mod)
    return importlib.import_module(f"{pkg}.{name}")


seatbelt = _plugin_module("seatbelt")

FIELDS = ("cwd", "workdir", "PROJECT_ROOT", "SCRATCH", "OUTPUT_DIR", "MEMBER")
SPELLINGS = ("dotdot", "slashes", "nfd", "case", "link", "link_parent", "fifo", "unlinked_token")


def writer_request(world):
    """What the real writer sends: the plugin's argv, the stub's body."""
    env = seatbelt.SeatbeltEnvironment(cwd=str(world.proj), timeout=5, cls="project", index=world.index, task_id="fx26a")
    argv = env.sandbox_argv(["/bin/bash", "-c", "true"], None, str(world.proj))
    return {"v": 1, "argv": argv, "cwd": str(world.proj), "env": {"PATH": "/usr/bin:/bin"}}


def param(req, key):
    return next(a.split("=", 1)[1] for a in req["argv"] if a.startswith(f"{key}="))


def with_param(req, key, value):
    return {**req, "argv": [f"{key}={value}" if a.startswith(f"{key}=") else a for a in req["argv"]]}


def spelled(base, how):
    """``base``, a real folder, gives a real child and this other spelling of a place."""
    base = str(base)
    plain = os.path.join(base, "fx-café")
    os.makedirs(plain, exist_ok=True)
    os.makedirs(os.path.join(base, "realp", "child"), exist_ok=True)
    if how == "dotdot":
        return f"{plain}/../fx-café"
    if how == "slashes":
        return "/" + plain
    if how == "nfd":
        return unicodedata.normalize("NFD", plain)
    if how == "case":
        return plain.replace("fx-café", "FX-CAFÉ")
    if how == "link":
        os.symlink(plain, os.path.join(base, "lnk"))
        return os.path.join(base, "lnk")
    if how == "link_parent":
        os.symlink(os.path.join(base, "realp"), os.path.join(base, "lnkp"))
        return os.path.join(base, "lnkp", "child")
    if how == "fifo":
        os.mkfifo(os.path.join(base, "ff"))
        return os.path.join(base, "ff")
    gone = os.path.join(base, "gone")
    os.mkdir(gone)
    os.rmdir(gone)
    return gone


def spelled_token(token, how):
    folder, name = os.path.split(token)
    gone = os.path.join(folder, name[:-1] + ("0" if name[-1] != "0" else "1"))
    if how == "dotdot":
        return f"{folder}/../{os.path.basename(folder)}/{name}"
    if how == "slashes":
        return f"{folder}//{name}"
    if how == "nfd":
        return f"{folder}/{unicodedata.normalize('NFD', name)}é"
    if how == "case":
        return f"{folder}/{name.upper()}"
    if how == "link":
        os.symlink(token, gone)
        return gone
    if how == "link_parent":
        os.symlink(folder, folder + "-lnk")
        return f"{folder}-lnk/{name}"
    if how == "fifo":
        os.mkfifo(gone)
        return gone
    return gone


def asked(world, req, field, how):
    if field == "cwd":
        return {**req, "cwd": spelled(world.proj, how)}
    if field == "workdir":
        return {**req, "cwd": seatbelt.request_cwd(spelled(world.proj, how))}
    if field == "MEMBER":
        return with_param(req, field, spelled_token(param(req, field), how))
    return with_param(req, field, spelled(param(req, field), how))


def test_the_table_leaves_out_no_field():
    places = {k for k in L.PARAM_KEYS if k not in ("NET", "WRITE_PROJECT", "PROJECT_GIT")}
    assert set(FIELDS) == places | {"cwd", "workdir"} and len(SPELLINGS) == 8


def test_the_writer_itself_is_accepted(w):
    w.policy("acceptEdits", listed=[str(w.proj)])
    assert w.validator().request(writer_request(w))["cwd"] == str(w.proj)


@pytest.mark.parametrize("field", FIELDS)
@pytest.mark.parametrize("how", SPELLINGS)
def test_every_place_in_any_other_spelling_is_refused(w, field, how):
    w.policy("acceptEdits", listed=[str(w.proj)])
    req = writer_request(w)
    if field == "workdir" and how in ("dotdot", "slashes"):
        # The writer's own normalising gives the plain folder: the request names that folder, and only that one.
        plan = w.validator().request(asked(w, req, field, how))
        assert plan["cwd"] == os.path.join(str(w.proj), "fx-café")
        return
    if field != "MEMBER" and how in ("nfd", "case"):
        # fx29 (lead's ruling 1): the kernel owns the folder's identity: the run goes, in the spelling the kernel reports.
        plan = w.validator().request(asked(w, req, field, how))
        plain = os.path.join(str(w.proj) if field in ("cwd", "workdir") else param(req, field), "fx-café")
        got = plan["cwd"] if field in ("cwd", "workdir") else next(a.split("=", 1)[1] for a in plan["argv"] if a.startswith(f"{field}="))
        # A project inside the listed folder is judged as that folder (ruling 2); the other places are the child itself.
        assert got == (str(w.proj) if field == "PROJECT_ROOT" else plain)
        return
    with pytest.raises(L.Refusal) as caught:
        w.validator().request(asked(w, req, field, how))
    # fx28: a working folder that is a link or in a non-normal form has its own row; the rest of the table is malformed.
    is_folder_spelling = field in ("cwd", "workdir") and how in ("dotdot", "slashes", "link", "link_parent")
    # fx32p: a working folder that is not a folder is said as that, not as malformed.
    not_a_folder = field in ("cwd", "workdir") and how in ("fifo", "unlinked_token")
    assert caught.value.code == ("cwd-spelling" if is_folder_spelling else "cwd-gone" if not_a_folder else "bad-request")
    assert "kernel" not in str(caught.value) or not is_folder_spelling


def _write_grant(w, target):
    return w.widened(f'(allow file-read* file-write* (literal "{target}"))')


def test_write_grants_stop_at_the_run_folders_and_named_caches(w):
    held, cache = w.root / "held", w.root / "cache"
    held.mkdir(), cache.mkdir()
    v = L.Validator(w.index, str(w.ledger), ([], [str(held), str(cache)], [str(cache)]))
    params = {"SCRATCH": str(w.root / "s"), "OUTPUT_DIR": str(w.root / "o"), "PROJECT_ROOT": str(w.proj), "WRITE_PROJECT": "0"}
    assert not v.grant_ok(str(held / "out.wav"), "write", params)
    assert v.grant_ok(str(cache / "out.wav"), "write", params)
    assert v.grant_ok(str(held / "sock"), "socket", params)
