"""Unusual repositories: symlinks/submodules, odd path names, no source files, a single commit."""

from __future__ import annotations

import pytest
from gitrepo import SyntheticRepo

from repocity.config import ModelConfig
from repocity.ingest.snapshots import build_history
from repocity.models.train import Predictor
from repocity.pipeline.analyze import ingest, load_repo_data
from repocity.pipeline.export import export_bundle, read_json
from repocity.store.db import Store


def _cacheinfo(r: SyntheticRepo, mode: str, sha: str, path: str) -> None:
    r.git("update-index", "--add", "--cacheinfo", f"{mode},{sha},{path}")


def test_symlinks_and_submodules_are_not_source_files(tmp_path):
    r = SyntheticRepo(tmp_path / "repo")
    r.write("real.py", "def a():\n    return 1\n")
    r.commit("c1", "init", "2021-01-10")
    blob = r.git("hash-object", "-w", "--stdin")  # empty blob as a symlink target
    _cacheinfo(r, "120000", blob, "link.py")
    _cacheinfo(r, "160000", r.hashes["c1"], "vendored")
    r.git("commit", "-q", "-m", "add link and submodule", env={"GIT_COMMITTER_DATE": "2021-02-10T12:00:00+00:00", "GIT_AUTHOR_DATE": "2021-02-10T12:00:00+00:00"})
    r.write("real.py", "def a():\n    return 2\n")
    r.commit("c3", "Fix bug in a", "2021-03-10")
    h = build_history(r.path, workers=1)
    assert set(h.snapshot_files["path"]) == {"real.py"}
    assert h.reconciled == 0
    assert set(h.files["first_path"]) == {"real.py"}


def test_odd_path_names_rename_and_szz(tmp_path):
    r = SyntheticRepo(tmp_path / "repo")
    r.write("src/my file.py", "def f(x):\n    return x + 1\n")
    r.commit("c1", "init", "2021-01-10")
    r.write("src/my file.py", "def f(x):\n    return x - 1\n")
    r.commit("c2", "Change f", "2021-02-10")
    r.move("src/my file.py", "src/ünïcödé file.py")
    r.commit("c3", "Rename", "2021-03-10")
    r.write("src/ünïcödé file.py", "def f(x):\n    return x + 1\n")
    r.commit("c4", "Fix bug in f", "2021-04-10")
    store = tmp_path / "s.duckdb"
    ingest(r.path, store, "HEAD")
    with Store(store) as st:
        files = st.read("files")
        lines = st.read("szz_lines")
        snaps = st.read("snapshot_files")
    assert len(files) == 1 and files["last_path"][0] == "src/ünïcödé file.py"
    assert set(snaps["path"]) == {"src/my file.py", "src/ünïcödé file.py"}
    assert set(lines["intro_hash"]) == {r.hashes["c2"]}


def test_repository_without_source_files_fails_clearly(tmp_path):
    r = SyntheticRepo(tmp_path / "repo")
    r.write("README.md", "docs only\n")
    r.commit("c1", "init", "2021-01-10")
    with pytest.raises(ValueError, match="No source files"):
        ingest(r.path, tmp_path / "s.duckdb", "HEAD")


def test_single_commit_repository_exports(tmp_path):
    r = SyntheticRepo(tmp_path / "repo")
    r.write("a.py", "def a():\n    return 1\n")
    r.write("lib/b.js", "function b() { return 2 }\n")
    r.commit("c1", "init", "2021-01-10")
    store = tmp_path / "s.duckdb"
    ingest(r.path, store, "HEAD")
    with Store(store) as st:
        p = Predictor(load_repo_data(st), ModelConfig())
    meta = export_bundle(p, tmp_path / "bundle", repo_id="x", name="x", url=None, head=r.hashes["c1"])
    assert meta["months"] == ["2021-01"] and meta["cutoffs"] == [] and meta["nFiles"] == 2
    snap = read_json(tmp_path / "bundle" / "snapshots" / "2021-01.json.gz")
    assert sorted(snap["loc"]) == [1, 2] and all(v == -1 for v in snap["risk"])
