"""Per-file features at a cutoff T and the 6-month bug-fix label (Section 4.4).

**No leakage by construction.** Every feature at cutoff month ``T`` is computed from
rows whose (monotonic) commit time is ``<= end of T``:

* static metrics come from the snapshot of month T (the tree at the last commit <= T);
* process metrics come from the prefix of the time-sorted change table;
* SZZ "bug-introducing" counts only use links whose *fix* happened <= T (a link
  discovered by a later fix would reveal the future, even if the introducing commit
  itself is old).

The label of a file is 1 iff a bug-fix commit modifies it in ``(T, T + horizon]``.
Only files that exist at T are included. File identities follow renames, so a file
renamed after T keeps its label.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath

import numpy as np
import pandas as pd

from repocity.config import ModelConfig
from repocity.timeutil import add_months, month_end_ts

FEATURE_GROUPS: dict[str, list[str]] = {
    "size": ["loc"],
    "complexity": ["ccn_total", "ccn_max", "nfuncs"],
    "churn": ["churn_3m", "churn_6m", "churn_12m", "n_commits_12m"],
    "people": ["n_commits", "n_authors", "ownership"],
    "history": ["age_days", "days_since_change", "n_bugfix", "n_bugfix_12m", "n_szz_intro"],
    "coupling": ["coupling_degree"],
    "directory": ["dir_n_files", "dir_bugfix_12m", "dir_churn_12m"],
}
FEATURES: list[str] = [f for group in FEATURE_GROUPS.values() for f in group]

FEATURE_LABELS: dict[str, str] = {
    "loc": "Lines of code",
    "ccn_total": "Total complexity",
    "ccn_max": "Max function complexity",
    "nfuncs": "Number of functions",
    "churn_3m": "Lines changed (3 mo)",
    "churn_6m": "Lines changed (6 mo)",
    "churn_12m": "Lines changed (12 mo)",
    "n_commits_12m": "Commits (12 mo)",
    "n_commits": "Commits (all time)",
    "n_authors": "Distinct authors",
    "ownership": "Main author's share",
    "age_days": "File age (days)",
    "days_since_change": "Days since last change",
    "n_bugfix": "Past bug fixes",
    "n_bugfix_12m": "Bug fixes (12 mo)",
    "n_szz_intro": "Bug-introducing commits (SZZ)",
    "coupling_degree": "Co-change partners",
    "dir_n_files": "Files in directory",
    "dir_bugfix_12m": "Directory bug fixes (12 mo)",
    "dir_churn_12m": "Directory lines changed (12 mo)",
}


@dataclass
class RepoData:
    """Everything feature extraction needs, loaded once per repository."""

    commits: pd.DataFrame  # idx, time, author, is_bugfix, n_files, ...
    changes: pd.DataFrame  # changes joined with commit time/author/is_bugfix/n_files, sorted by time
    snapshot_files: pd.DataFrame
    months: list[str]
    links: pd.DataFrame  # SZZ links: fix_idx, fix_time, file_id, intro_hash, intro_time (sorted by fix_time)
    created_time: pd.Series  # file_id -> creation time

    @classmethod
    def build(
        cls,
        commits: pd.DataFrame,
        changes: pd.DataFrame,
        files: pd.DataFrame,
        snapshots: pd.DataFrame,
        snapshot_files: pd.DataFrame,
        links: pd.DataFrame,
    ) -> RepoData:
        c = commits.set_index("idx")
        ch = changes.join(c[["time", "author", "is_bugfix", "n_files"]], on="commit_idx")
        ch["churn"] = ch["added"] + ch["deleted"]
        ch = ch.sort_values(["time", "commit_idx"], kind="stable").reset_index(drop=True)
        created = files.set_index("file_id")["created_idx"].map(c["time"])
        return cls(
            commits=commits,
            changes=ch,
            snapshot_files=snapshot_files,
            months=list(snapshots["month"]),
            links=links.sort_values("fix_time", kind="stable").reset_index(drop=True),
            created_time=created,
        )

    def snapshot(self, month: str) -> pd.DataFrame:
        return self.snapshot_files[self.snapshot_files["month"] == month]


def _prefix(df: pd.DataFrame, col: str, t: int) -> pd.DataFrame:
    """Rows with ``df[col] <= t`` (df sorted by col)."""
    return df.iloc[: int(np.searchsorted(df[col].to_numpy(), t, side="right"))]


def build_features(rd: RepoData, month: str, cfg: ModelConfig | None = None) -> pd.DataFrame:
    """Feature matrix (index = file_id) for all files that exist at the end of ``month``."""
    cfg = cfg or ModelConfig()
    t_end = month_end_ts(month)
    snap = rd.snapshot(month).set_index("file_id")
    feats = pd.DataFrame(index=snap.index)
    feats["path"] = snap["path"]
    for col in ("loc", "ccn_total", "ccn_max", "nfuncs"):
        feats[col] = snap[col].astype(float)

    past = _prefix(rd.changes, "time", t_end)
    past = past[past["file_id"].isin(snap.index)]

    def since(months_back: int) -> pd.DataFrame:
        start = month_end_ts(add_months(month, -months_back))
        return past[past["time"] > start]

    g_all = past.groupby("file_id")
    for k in (3, 6, 12):
        feats[f"churn_{k}m"] = since(k).groupby("file_id")["churn"].sum()
    last12 = since(12)
    feats["n_commits_12m"] = last12.groupby("file_id")["commit_idx"].nunique()
    feats["n_commits"] = g_all["commit_idx"].nunique()
    feats["n_authors"] = g_all["author"].nunique()
    top = past.groupby(["file_id", "author"]).size().groupby("file_id").max()
    feats["ownership"] = top / feats["n_commits"]

    created = rd.created_time.reindex(feats.index)
    last_change = g_all["time"].max().reindex(feats.index).fillna(created)
    feats["age_days"] = (t_end - created) / 86400.0
    feats["days_since_change"] = (t_end - last_change) / 86400.0

    fixes = past[past["is_bugfix"] & (past["status"] != "D")]
    feats["n_bugfix"] = fixes.groupby("file_id")["commit_idx"].nunique()
    fixes12 = fixes[fixes["time"] > month_end_ts(add_months(month, -12))]
    feats["n_bugfix_12m"] = fixes12.groupby("file_id")["commit_idx"].nunique()

    links = _prefix(rd.links, "fix_time", t_end)
    feats["n_szz_intro"] = links.groupby("file_id")["intro_hash"].nunique()

    feats["coupling_degree"] = coupling_degree(
        past, month_end_ts(add_months(month, -cfg.coupling_window_months)), cfg
    )

    feats["dir"] = feats["path"].map(lambda p: str(PurePosixPath(p).parent))
    feats = feats.fillna({c: 0.0 for c in FEATURES if c not in ("dir_n_files", "dir_bugfix_12m", "dir_churn_12m")})
    feats["dir_n_files"] = feats.groupby("dir")["loc"].transform("size").astype(float)
    feats["dir_bugfix_12m"] = feats.groupby("dir")["n_bugfix_12m"].transform("sum")
    feats["dir_churn_12m"] = feats.groupby("dir")["churn_12m"].transform("sum")
    feats["ownership"] = feats["ownership"].where(feats["n_commits"] > 0, 1.0)
    feats.index.name = "file_id"
    return feats


def coupling_degree(past: pd.DataFrame, start_ts: int, cfg: ModelConfig) -> pd.Series:
    """Change coupling (Gall et al. 1998; D'Ambros et al. 2009): for each file, the number
    of other files it changed together with in at least ``coupling_min_cochanges`` commits
    within the window. Huge commits (> ``coupling_max_commit_files`` files) are ignored.
    """
    w = past[(past["time"] > start_ts) & (past["n_files"] <= cfg.coupling_max_commit_files)][["commit_idx", "file_id"]]
    w = w.drop_duplicates()
    if w.empty:
        return pd.Series(dtype=float)
    pairs = w.merge(w, on="commit_idx")
    pairs = pairs[pairs["file_id_x"] != pairs["file_id_y"]]
    counts = pairs.groupby(["file_id_x", "file_id_y"]).size()
    strong = counts[counts >= cfg.coupling_min_cochanges]
    return strong.groupby(level=0).size().astype(float)


def build_labels(rd: RepoData, month: str, horizon_months: int = 6) -> pd.Series:
    """1 if the file (existing at T) gets a bug-fix change in (T, T + horizon]."""
    t_end = month_end_ts(month)
    h_end = month_end_ts(add_months(month, horizon_months))
    ids = rd.snapshot(month)["file_id"]
    ch = rd.changes
    fut = ch[(ch["time"] > t_end) & (ch["time"] <= h_end) & ch["is_bugfix"] & (ch["status"] != "D")]
    hit = set(fut["file_id"])
    return pd.Series([1 if f in hit else 0 for f in ids], index=pd.Index(ids, name="file_id"), dtype=int)
