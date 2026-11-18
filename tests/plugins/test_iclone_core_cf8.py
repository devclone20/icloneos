"""CF8 fix pass (FX-P2): core's fallback hard-link records (no fd 3). D2: the records never answer past
``_CACHE_MAX_AGE_S`` since the last FULL walk; a multi-linked file is kept with its ctime and a change forces a walk; a
run in a root drops its records. L3.2 the records are bounded, L3.3 a directory swapped while it is listed is seen in
that check, L3.4 a listing that hangs is cut off by the caller, L3.5 coarse timestamps are listed again, L6.4 one cap."""
import json
import os
import threading
import time
import types

import pytest

from tests.plugins.test_iclone_launcher import L

core = L.core


@pytest.fixture
def tree(tmp_path):
    core._scan_cache.clear()
    getattr(core, "_abandoned", {}).clear()
    project = tmp_path / "proj"
    for d in ("a/b", "x", "f"):
        (project / d).mkdir(parents=True)
    (project / "a" / "b" / "secret").write_text("inside-secret\n")
    (tmp_path / "outside").mkdir()
    yield tmp_path, project
    for d, _subdirs, _files in os.walk(tmp_path):
        os.chmod(d, 0o755)
    core._scan_cache.clear()
    getattr(core, "_abandoned", {}).clear()


def _index(tmp, **extra):
    spec = {"v": 5, "profilesDir": "/nonexistent", "scratchRoot": "/nonexistent/scratch", "home": "/nonexistent/home",
            "membersDir": "/nonexistent/members", "denied": [], "sha256": {}, "refusalsDir": str(tmp / "refusals"),
            **extra}
    return core.parse_spec(json.dumps(spec))


def _rows(tmp):
    folder = tmp / "refusals"
    if not folder.exists():
        return []
    return [json.loads(line) for name in sorted(os.listdir(folder)) for line in open(folder / name)]


def _paths(linked):
    return [inode["paths"] for inode in linked]


# --- D2 / L3.1 (T1): the age bound, restored ------------------------------------------------------------------------


def test_an_outside_name_for_a_file_with_one_link_is_found_once_the_records_are_old(tree):
    tmp, project = tree
    secret = project / "a" / "b" / "secret"
    at = time.monotonic()
    assert core.linked_inodes(str(project), now=at)[0] == []
    os.link(secret, tmp / "outside" / "O")  # moves no directory inside the root
    linked, cached, _ = core.linked_inodes(str(project), now=at + core._CACHE_MAX_AGE_S + 1)
    assert not cached and _paths(linked) == [[str(secret)]]


def test_the_age_moves_on_a_full_walk_only(tree):
    tmp, project = tree
    secret = project / "a" / "b" / "secret"
    at = time.monotonic()
    core.linked_inodes(str(project), now=at)
    (project / "f" / "new").write_text("y")  # a refresh that lists f again and keeps the records
    assert core.linked_inodes(str(project), now=at + 200)[1] is False
    assert core._scan_cache[str(project)].measured_at == at
    os.link(secret, tmp / "outside" / "O")
    assert _paths(core.linked_inodes(str(project), now=at + core._CACHE_MAX_AGE_S + 1)[0]) == [[str(secret)]]


def test_a_known_linked_file_whose_names_were_swapped_forces_a_walk_and_drops_the_store_pass(tree):
    tmp, project = tree
    store = tmp / "pnpm" / "store" / "v10"
    store.mkdir(parents=True)
    inside = project / "f" / "pkg.js"
    (store / "pkg.js").write_text("store content\n")
    os.link(store / "pkg.js", inside)
    index = _index(tmp, pnpmStoreRoots=[str(store)])
    core.check_hardlinks(index, str(project), "build")  # every other name is in the store: passed
    first = core._scan_cache[str(project)]
    assert first.store_passed
    os.unlink(store / "pkg.js")
    os.link(inside, tmp / "outside" / "O")  # same inode, same link count, other name now outside
    linked, cached, _ = core.linked_inodes(str(project))
    assert not cached and _paths(linked) == [[str(inside)]]
    assert core._scan_cache[str(project)] is not first
    with pytest.raises(core.ConfinementRefused) as refused:
        core.check_hardlinks(index, str(project), "build")
    assert refused.value.code == "hard-links"


def test_a_change_in_a_known_linked_file_walks_the_whole_root(tree, monkeypatch):
    tmp, project = tree
    os.link(project / "a" / "b" / "secret", tmp / "outside" / "O")
    core.linked_inodes(str(project))
    os.link(project / "a" / "b" / "secret", tmp / "outside" / "O2")  # nlink 3: the file's ctime and count move
    walked = []
    real = core._full_walk
    monkeypatch.setattr(core, "_full_walk", lambda root, budget: walked.append(root) or real(root, budget))
    assert core.linked_inodes(str(project))[1] is False
    assert walked == [str(project)]


# --- D2 / L2.1: a run drops the records --------------------------------------------------------------------------------


def test_an_outward_link_made_during_a_run_is_recorded_after_it_and_refuses_the_next_command(tree):
    tmp, project = tree
    secret = project / "a" / "b" / "secret"
    index = _index(tmp)
    core.check_hardlinks(index, str(project))  # clean, and the records are made
    os.link(secret, tmp / "outside" / "planted")  # what the run did: an inside file with one link named outside
    core.check_hardlinks_after_run(index, [str(project)], 4242, "s1")
    rows = [row for row in _rows(tmp) if row["operation"] == "hard-link-appeared"]
    assert [(row["root"], row["target"], row["pid"]) for row in rows] == [(str(project), str(secret), 4242)]
    with pytest.raises(core.ConfinementRefused) as refused:
        core.check_hardlinks(index, str(project))
    assert refused.value.code == "hard-links"


def test_a_walk_that_was_running_when_the_root_was_forgotten_records_nothing(tree, monkeypatch):
    _tmp, project = tree
    real = core.os.scandir

    def forgetting(path):
        if os.fspath(path) == str(project / "x"):
            core.forget_root(str(project))  # a run's after-check, from another thread, in the middle of this walk
        return real(path)

    monkeypatch.setattr(core.os, "scandir", forgetting)
    core.linked_inodes(str(project))
    assert str(project) not in core._scan_cache


# --- L3.2: bounded records -----------------------------------------------------------------------------------------------


def test_the_records_are_bounded_by_roots_and_by_directories(tmp_path, monkeypatch):
    core._scan_cache.clear()
    roots = []
    for i in range(core._CACHE_ROOTS_MAX + 2):
        root = tmp_path / f"r{i}"
        (root / "sub" / "deeper").mkdir(parents=True)
        roots.append(str(root))
        core.linked_inodes(str(root))
    assert list(core._scan_cache) == roots[-core._CACHE_ROOTS_MAX:]
    core.linked_inodes(roots[-core._CACHE_ROOTS_MAX])  # a hit makes it the most recent
    monkeypatch.setattr(core, "_CACHE_DIRS_BUDGET", 7)
    big = tmp_path / "big"
    for d in range(10):
        (big / f"d{d}").mkdir(parents=True)
    core.linked_inodes(str(big))
    assert list(core._scan_cache) == [str(big)]  # the root just measured stays, even alone over the budget
    core._scan_cache.clear()


def test_a_record_is_compact(tree):
    _tmp, project = tree
    core.linked_inodes(str(project))
    folders = core._scan_cache[str(project)].folders
    record = folders[str(project)]
    assert isinstance(record[0], bytes) and len(record[0]) == 24
    keys = {id(key) for key in folders}
    assert record[1] and all(id(sub) in keys for sub in record[1])  # a subdirectory's path is its key, not a copy


# --- L3.3: a directory swapped for a symlink while it is listed ---------------------------------------------------------


def test_a_directory_swapped_for_a_symlink_while_listed_hides_nothing_in_that_check(tree, monkeypatch):
    tmp, project = tree
    outside = tmp / "outside"
    os.link(project / "a" / "b" / "secret", outside / "O")  # the other name, which the swap would make look inside
    (project / "x" / "keep").write_text("k")
    real = core.os.scandir
    swapped = []

    def racing(path):
        if os.fspath(path) == str(project / "x") and not swapped:
            swapped.append(True)
            os.rename(project / "x", tmp / "x-away")
            os.symlink(outside, project / "x")
            def put_back():  # once x's entries were listed and stat-ed through the symlink
                os.unlink(project / "x")
                os.rename(tmp / "x-away", project / "x")
            return _Listing(real(path), put_back)
        return real(path)

    monkeypatch.setattr(core.os, "scandir", racing)
    linked, _cached, unscannable = core.linked_inodes(str(project))
    assert swapped and unscannable == []
    assert _paths(linked) == [[str(project / "a" / "b" / "secret")]]


class _Listing(list):
    def __init__(self, entries, on_exit):
        super().__init__(entries)
        self.on_exit = on_exit

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.on_exit()
        return False


def test_a_directory_that_never_holds_still_while_listed_is_refused_for_that_check(tree, monkeypatch):
    _tmp, project = tree
    real = core.os.scandir
    churn = project / "x"

    def moving(path):
        if os.fspath(path) == str(churn):
            (churn / f"n{time.monotonic_ns()}").write_text("z")
        return real(path)

    monkeypatch.setattr(core.os, "scandir", moving)
    assert core.linked_inodes(str(project))[2] == [str(churn)]


# --- L3.4: a listing that hangs ------------------------------------------------------------------------------------------


def test_a_hung_listing_is_cut_off_by_the_caller_and_holds_one_thread_at_most(tree, monkeypatch):
    _tmp, project = tree
    real = core.os.scandir
    release = threading.Event()
    entered = []

    def hung(path):
        if os.fspath(path) == str(project / "x"):
            entered.append(time.monotonic())
            release.wait(10)
        return real(path)

    monkeypatch.setattr(core.os, "scandir", hung)
    started = time.monotonic()
    with pytest.raises(core.ScanTooLarge):
        core.linked_inodes(str(project), stall_s=0.3)
    assert time.monotonic() - started < 5
    with pytest.raises(core.ScanTooLarge):
        core.linked_inodes(str(project), stall_s=0.3, deadline=time.monotonic() + 30)
    assert len(entered) == 1  # the second check did not start a second walk into the hung folder
    release.set()
    core._abandoned[str(project)].join(10)
    assert core.linked_inodes(str(project), stall_s=0.3)[0] == []
    assert str(project) in core._scan_cache


def test_the_cap_is_judged_while_a_walk_progresses(tree, monkeypatch):
    _tmp, project = tree
    real = core.os.scandir

    def slow(path):
        time.sleep(0.1)  # each folder under the stall: the walk progresses
        return real(path)

    monkeypatch.setattr(core.os, "scandir", slow)
    with pytest.raises(core.ScanTooLarge):
        core.linked_inodes(str(project), stall_s=5.0, deadline=time.monotonic() + 0.25)
    assert str(project) not in core._scan_cache


def test_entries_inside_one_big_directory_count_as_progress(tree, monkeypatch):
    _tmp, project = tree
    big = project / "x"
    for i in range(3 * core._ENTRIES_PER_MARK):
        (big / f"e{i}").write_text("")
    budget = core._Budget(str(project), None, 0.2, None)
    marks = []
    real_mark = budget.mark
    budget.mark = lambda: marks.append(1) or real_mark()
    assert core._list_folder_record(str(big), budget)[2] == 3 * core._ENTRIES_PER_MARK
    assert len(marks) == 3


# --- L3.5: coarse timestamps --------------------------------------------------------------------------------------------


def test_a_directory_with_a_whole_second_ctime_this_close_to_now_is_listed_again(tree):
    _tmp, project = tree
    budget = core._Budget(str(project), None, None, None)
    real = os.lstat(project / "f")
    now_s = time.time_ns() // 1_000_000_000 * 1_000_000_000

    def faked(ctime_ns):
        return types.SimpleNamespace(st_ino=real.st_ino, st_dev=real.st_dev, st_mtime_ns=real.st_mtime_ns,
                                     st_ctime_ns=ctime_ns, st_mode=real.st_mode)

    assert core._list_once(str(project / "f"), faked(now_s), budget)[5] is True
    assert core._list_once(str(project / "f"), faked(now_s + 1), budget)[5] is False  # nanoseconds: APFS
    assert core._list_once(str(project / "f"), faked(now_s - 10_000_000_000), budget)[5] is False


def test_a_record_marked_to_be_listed_again_is_listed_at_the_next_check(tree, monkeypatch):
    _tmp, project = tree
    core.linked_inodes(str(project))
    scan = core._scan_cache[str(project)]
    key = str(project / "f")
    scan.folders[key] = scan.folders[key][:5] + (True,)  # as a whole-second ctime listed in its own tick leaves it
    listed = []
    real = core.os.scandir
    monkeypatch.setattr(core.os, "scandir", lambda path: listed.append(os.fspath(path)) or real(path))
    assert core.linked_inodes(str(project)) == ([], True, [])
    assert listed == [key]
    assert core._scan_cache[str(project)].folders[key][5] is False


# --- L6.4: one cap -------------------------------------------------------------------------------------------------------


def test_the_first_scan_cap_has_one_definition():
    assert not hasattr(core, "FIRST_SCAN_CAP_S")
    assert L.FIRST_SCAN_CAP_S > 0


# --- D4: the Python twin of main's admissibleRoot (core.project_root_refusal) -------------------------------------------


def _home_index(home):
    spec = {"v": 5, "profilesDir": "/nonexistent", "scratchRoot": "/nonexistent/scratch", "home": str(home),
            "membersDir": "/nonexistent/members", "denied": [], "sha256": {}}
    return core.parse_spec(json.dumps(spec))


@pytest.fixture
def admitted(tmp_path):
    home = tmp_path / "home" / "me"
    project = tmp_path / "work" / "proj"
    home.mkdir(parents=True)
    project.mkdir(parents=True)
    index = _home_index(home)
    assert core.project_root_refusal(str(project), index) is None  # the control: an ordinary project is admitted
    return tmp_path, home, project, index


def test_d4_the_disk_root_is_refused(admitted):
    *_rest, index = admitted
    assert core.project_root_refusal("/", index)


def test_d4_every_top_level_folder_is_refused(admitted):
    *_rest, index = admitted
    for top in ("/Applications", "/Volumes", "/Users", "/private", "/Library"):
        if os.path.isdir(top) and not os.path.islink(top):
            assert core.project_root_refusal(top, index), top  # the profile's own rule may speak first (fx18)
            assert "top-level" in core._root_admission_refusal(top, "/nonexistent/home"), top


def test_d4_a_volume_mount_point_is_refused(admitted, monkeypatch):
    _tmp, _home, project, index = admitted
    real_stat = os.stat

    def other_device(path, *a, **k):
        st = real_stat(path, *a, **k)
        if os.fspath(path) == str(project):
            return os.stat_result((st.st_mode, st.st_ino, st.st_dev + 1) + tuple(st)[3:])
        return st

    monkeypatch.setattr(core.os, "stat", other_device)
    assert core.project_root_refusal(str(project), index) == "it is a volume's mount point"


def test_d4_the_data_volume_spelling_is_refused(admitted):
    *_rest, index = admitted
    for root in ("/System/Volumes/Data", "/System/Volumes/Data/private/tmp"):
        if os.path.isdir(root):
            assert core.project_root_refusal(root, index), root
    assert core._root_admission_refusal("/System/Volumes/Data/x", "/nonexistent") is not None


def test_d4_a_root_holding_the_home_is_refused(admitted):
    tmp, home, _project, index = admitted
    assert core.project_root_refusal(str(home.parent), index) == "it is your home folder or a folder above it"
    assert core.project_root_refusal(str(tmp), index) == "it is your home folder or a folder above it"


def test_d4_a_root_holding_the_home_by_its_data_volume_spelling_is_refused(tmp_path, monkeypatch):
    root = tmp_path / "holds"
    root.mkdir()
    home = "/fxp2-home"
    monkeypatch.setattr(core, "DATA_VOLUME", str(tmp_path / "elsewhere"))
    assert core._root_admission_refusal(str(root), home) is None  # the control
    monkeypatch.setattr(core, "DATA_VOLUME", str(root / "Data"))  # now <Data>/fxp2-home lies inside the root
    assert core._root_admission_refusal(str(root), home) == "it is your home folder or a folder above it"


def test_d4_is_judged_on_the_folders_identity_not_its_spelling(admitted, monkeypatch):
    # The runtime may name a project in another case or by a link (fx29); the launcher spells it by the kernel and main
    # refuses any other spelling. Here a spelling is judged as the folder it names: an alias of an admissible folder
    # is admitted, an alias of a refused one (above the home, a top-level folder, a mount point) is refused.
    tmp, home, project, index = admitted
    alias = tmp / "alias"
    alias.symlink_to(project)
    assert core.project_root_refusal(str(alias), index) is None
    above = tmp / "work" / "above-home"
    above.symlink_to(home.parent)
    assert core._root_admission_refusal(str(above), str(home)) == "it is your home folder or a folder above it"
    top = tmp / "work" / "top"
    top.symlink_to("/Applications")
    assert "top-level" in core._root_admission_refusal(str(top), str(home))
    real_stat = os.stat

    def other_device(path, *a, **k):
        st = real_stat(path, *a, **k)
        if os.fspath(path) == str(project):
            return os.stat_result((st.st_mode, st.st_ino, st.st_dev + 1) + tuple(st)[3:])
        return st

    monkeypatch.setattr(core.os, "stat", other_device)
    assert core._root_admission_refusal(str(alias), str(home)) == "it is a volume's mount point"


def test_d4_a_folder_the_runtime_cannot_open_is_judged_by_its_realpath(admitted, monkeypatch):
    # The window project is judged again by the launcher and main; only the runtime falls back, never the launcher.
    _tmp, _home, project, index = admitted
    real_open = os.open

    def eperm(path, flags, *a, **k):
        if os.fspath(path) == str(project):
            raise PermissionError(1, "Operation not permitted", path)
        return real_open(path, flags, *a, **k)

    monkeypatch.setattr(core.os, "open", eperm)
    assert core.project_root_refusal(str(project), index) is None
    monkeypatch.setattr(core.os, "stat", lambda *a, **k: (_ for _ in ()).throw(PermissionError(1, "EPERM")))
    assert core.project_root_refusal(str(project), index) is None  # no stat either: main's guardedRoot judges it
    assert "top-level" in core._root_admission_refusal("/Applications", "/nonexistent/home")
