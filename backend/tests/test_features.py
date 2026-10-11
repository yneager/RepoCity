"""Features, labels and the no-leakage guarantee."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from repocity.config import ModelConfig
from repocity.ingest.history import read_history
from repocity.models.features import FEATURES, build_features, build_labels
from repocity.pipeline.analyze import ingest, load_repo_data
from repocity.store.db import Store


@pytest.fixture(scope="module")
def rd(bug_store):
    with Store(bug_store) as st:
        return load_repo_data(st)


def _ids(rd):
    files = rd.snapshot_files.drop_duplicates("file_id").set_index("path")["file_id"]
    return int(files["app.py"]), int(files["util.py"])


def test_features_known_values(rd):
    app, util = _ids(rd)
    f = build_features(rd, "2020-06").loc[app]
    assert f["path"] == "core.py"
    assert f["n_commits"] == 6  # c1..c6 (the rename keeps the identity)
    assert f["n_bugfix"] == 2  # c3, c6
    assert f["n_authors"] == 2
    assert f["ownership"] == pytest.approx(4 / 6)
    assert f["n_szz_intro"] == 2  # c2 (fixed by c3) and c5 (fixed by c6)
    assert f["churn_3m"] == 4  # c4 rename (0) + c5 (1+1) + c6 (1+1)
    assert f["loc"] == 4 and f["ccn_total"] == 2
    assert f["days_since_change"] == pytest.approx((pd.Timestamp("2020-06-30 23:59:59") - pd.Timestamp("2020-06-08 12:00")).total_seconds() / 86400)
    assert f["coupling_degree"] == 0  # c1 is the only commit touching both files
    g = build_features(rd, "2020-06")
    assert set(g.columns) >= set(FEATURES)
    assert g.loc[util, "dir_n_files"] == 2


def test_labels(rd):
    app, util = _ids(rd)
    lab = build_labels(rd, "2020-02", 6)  # fixes in Mar..Aug: c3, c6, c9 touch app/core
    assert lab[app] == 1 and lab[util] == 0
    lab = build_labels(rd, "2020-08", 6)  # Sep..Feb: c10 fixes util
    assert lab[app] == 0 and lab[util] == 1
    lab = build_labels(rd, "2020-03", 1)  # (end Mar, end Apr]: only the rename -> no fix
    assert lab.sum() == 0


def test_szz_counts_only_known_fixes(rd):
    """A fix after T must not reveal the introducing commit before T."""
    app, _ = _ids(rd)
    assert build_features(rd, "2020-02").loc[app, "n_szz_intro"] == 0  # c2 is only discovered by c3 in March
    assert build_features(rd, "2020-03").loc[app, "n_szz_intro"] == 1


@pytest.mark.parametrize("cutoff,last_label", [("2020-06", "c6"), ("2020-09", "m1"), ("2020-11", "c11")])
def test_no_leakage(bug_repo, rd, tmp_path, cutoff, last_label):
    """Features at T computed from the full history equal features computed from a repository
    truncated at T: nothing after T can influence them."""
    trunc = tmp_path / "trunc.duckdb"
    ingest(bug_repo.path, trunc, bug_repo.hashes[last_label])
    with Store(trunc) as st:
        rd_trunc = load_repo_data(st)
    assert rd_trunc.months[-1] == cutoff
    full = build_features(rd, cutoff)
    part = build_features(rd_trunc, cutoff)
    pd.testing.assert_frame_equal(full[FEATURES].sort_index(), part[FEATURES].sort_index())


def test_future_commits_do_not_change_features(rd):
    """Directly perturb everything after T (more fixes, more churn) and check invariance."""
    from repocity.models.features import RepoData
    from repocity.timeutil import month_end_ts

    t_end = month_end_ts("2020-06")
    ch = rd.changes.copy()
    future = ch["time"] > t_end
    ch.loc[future, "added"] *= 100
    ch.loc[future, "churn"] *= 100
    ch.loc[future, "is_bugfix"] = True
    links = rd.links.copy()
    links.loc[links["fix_time"] > t_end, "intro_hash"] = "x" * 40
    perturbed = RepoData(rd.commits, ch, rd.snapshot_files, rd.months, links, rd.created_time)
    a = build_features(rd, "2020-06")[FEATURES]
    b = build_features(perturbed, "2020-06")[FEATURES]
    pd.testing.assert_frame_equal(a, b)
    assert np.isfinite(a.to_numpy(float)).all()


def test_eval_and_app_cutoffs(rd):
    from repocity.models.train import Predictor

    p = Predictor(rd, ModelConfig(min_history_months=1, train_windows=2))
    assert set(p.eval_cutoffs()) <= set(p.app_cutoffs())
    for m in p.eval_cutoffs():
        assert p.has_labels(m)
        for t in p.train_months(m):
            assert t < m  # training windows are strictly in the past


def test_read_history_matches_pydriller(bug_repo):
    """Cross-check our fast git-log parser against PyDriller on the synthetic repository."""
    from pydriller import Repository

    ours = {c.hash: {(ch.new_path or ch.old_path, ch.added, ch.deleted) for ch in c.changes} for c in read_history(bug_repo.path)}
    for c in Repository(str(bug_repo.path), only_no_merge=True, only_in_branch="main").traverse_commits():
        if c.hash not in ours:
            continue  # branch commit (not first-parent)
        theirs = {((m.new_path or m.old_path).replace("\\", "/"), m.added_lines, m.deleted_lines) for m in c.modified_files}
        assert ours[c.hash] == theirs
