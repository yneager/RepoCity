"""History ingestion, rename tracking, churn and monthly snapshots on a known repository."""

from __future__ import annotations

from repocity.ingest.history import (
    FileChange,
    IdentityTracker,
    hash_author,
    initials,
    is_source_file,
    read_history,
)
from repocity.ingest.snapshots import build_history
from repocity.store.db import Store


def test_read_history_order_and_churn(bug_repo):
    commits = read_history(bug_repo.path)
    hashes = [c.hash for c in commits]
    # first-parent only: the branch commit b1 is not on the main line, the merge is
    assert bug_repo.hashes["b1"] not in hashes
    assert bug_repo.hashes["m1"] in hashes
    assert hashes[0] == bug_repo.hashes["c1"] and hashes[-1] == bug_repo.hashes["c13"]
    c2 = commits[hashes.index(bug_repo.hashes["c2"])]
    assert [(ch.status, ch.new_path, ch.added, ch.deleted) for ch in c2.changes] == [("M", "app.py", 1, 1)]
    c4 = commits[hashes.index(bug_repo.hashes["c4"])]
    assert [(ch.status, ch.old_path, ch.new_path) for ch in c4.changes] == [("R", "app.py", "core.py")]
    m1 = commits[hashes.index(bug_repo.hashes["m1"])]
    assert m1.is_merge and [(ch.new_path, ch.added, ch.deleted) for ch in m1.changes] == [("util.py", 1, 1)]


def test_author_privacy(bug_repo):
    commits = read_history(bug_repo.path)
    assert all("@" not in c.author and len(c.author) == 10 for c in commits)
    assert commits[1].author == hash_author("bob@example.com")
    assert initials("Ada Lovelace") == "AL" and initials("bob") == "B"


def test_source_filter():
    assert is_source_file("src/app.py")
    assert not is_source_file("README.md")
    assert not is_source_file("node_modules/x/index.js")
    assert not is_source_file("dist/bundle.js")
    assert not is_source_file("static/jquery.min.js")
    assert not is_source_file("vendor/lib/a.go")


def test_identity_survives_rename_and_swap():
    t = IdentityTracker()
    t.apply(0, [FileChange("A", None, "a.py", 3, 0), FileChange("A", None, "b.py", 3, 0)])
    a, b = t.path_to_id["a.py"], t.path_to_id["b.py"]
    t.apply(1, [FileChange("R", "a.py", "b.py", 0, 0), FileChange("R", "b.py", "a.py", 0, 0)])  # swap
    assert t.path_to_id["b.py"] == a and t.path_to_id["a.py"] == b
    t.apply(2, [FileChange("D", "a.py", None, 0, 3)])
    assert "a.py" not in t.path_to_id and t.files[b].deleted_idx == 2
    t.apply(3, [FileChange("A", None, "a.py", 1, 0)])
    assert t.path_to_id["a.py"] not in (a, b)  # re-created path = new identity


def test_snapshots_and_store(bug_repo, bug_store):
    h = build_history(bug_repo.path, workers=1)
    assert h.reconciled == 0
    months = list(h.snapshots["month"])
    assert months[0] == "2020-01" and months[-1] == "2021-03" and len(months) == 15
    sf = h.snapshot_files
    ids = dict(zip(h.files["first_path"], h.files["file_id"]))
    app = ids["app.py"]
    # the same identity is called app.py before the rename and core.py after it
    assert set(sf[sf.month == "2020-03"]["path"]) == {"app.py", "util.py"}
    assert sf[(sf.month == "2020-05") & (sf.file_id == app)]["path"].item() == "core.py"
    assert set(sf[sf.month == "2021-02"]["path"]) == {"core.py"}
    assert set(sf[sf.month == "2021-03"]["path"]) == {"core.py", "new.py"}
    # quiet months repeat the previous state (Dec 2020 has no commits)
    assert h.snapshots.set_index("month").loc["2020-12", "hash"] == bug_repo.hashes["c11"]
    # lizard metrics: app.py has two functions with complexity 1 each, 4 lines of code
    row = sf[(sf.month == "2020-01") & (sf.file_id == app)].iloc[0]
    assert (row["loc"], row["ccn_total"], row["ccn_max"], row["nfuncs"]) == (4, 2, 1, 2)
    # churn per identity: c1 (+6), c2 (1/1), c3 (1/1), c5 (1/1), c6 (1/1), c7 (1/1), c8 (+1), c9 (1/2)
    ch = h.changes[h.changes.file_id == app]
    assert int(ch["added"].sum()) == 6 + 1 + 1 + 0 + 1 + 1 + 1 + 1 + 1
    with Store(bug_store) as st:
        assert len(st.read("commits")) == len(h.commits)
        assert st.get_meta("szz_modes") == ["plain", "w"]
