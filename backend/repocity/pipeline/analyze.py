"""End-to-end analysis of one repository: history -> snapshots -> SZZ -> models -> layout.

Used by the web API (background worker) and by ``experiments/run_all.py``. Progress is
reported through a callback ``progress(step, fraction_of_step, message)`` where step is
one of :data:`STEPS`.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

from repocity.config import AnalysisConfig, SZZConfig
from repocity.ingest.snapshots import build_history
from repocity.models.features import RepoData
from repocity.models.train import Predictor
from repocity.store.db import Store
from repocity.szz.bugfix import BugfixClassifier, classify_history, integrated_commits
from repocity.szz.szz import commit_sizes, run_szz, szz_links

STEPS = ["clone", "history", "snapshots", "szz", "model", "layout"]
StepProgress = Callable[[str, float, str], None]


def _noop(_s: str, _f: float, _m: str) -> None:
    pass


@dataclass
class Timings:
    seconds: dict[str, float] = field(default_factory=dict)

    def run(self, name: str):
        timings = self

        class _Ctx:
            def __enter__(self):
                self.t = time.perf_counter()

            def __exit__(self, *exc):
                timings.seconds[name] = timings.seconds.get(name, 0.0) + time.perf_counter() - self.t

        return _Ctx()


def ingest(
    repo: Path,
    store_path: Path,
    rev: str = "HEAD",
    cfg: AnalysisConfig | None = None,
    szz_modes: tuple[str, ...] = ("plain", "w"),
    classifier: BugfixClassifier | None = None,
    progress: StepProgress = _noop,
) -> dict[str, float]:
    """Build the DuckDB store for ``repo`` at ``rev``. Returns step timings in seconds."""
    cfg = cfg or AnalysisConfig()
    clf = classifier or BugfixClassifier()
    t = Timings()
    with t.run("history"):
        h = build_history(
            repo,
            rev,
            workers=cfg.workers,
            progress=lambda f, m: progress("history" if f < 0.5 else "snapshots", f * 2 if f < 0.5 else (f - 0.5) * 2, m),
        )
    with t.run("bugfix"):
        progress("szz", 0.0, "Classifying bug-fix commits")
        mainline = list(h.commits["hash"])
        integ = integrated_commits(repo, mainline)
        branch_msgs = [integ.get(hh, []) for hh in mainline]
        h.commits["is_bugfix"] = classify_history(h.commits["message"], h.commits["is_merge"], branch_msgs, clf)
        h.commits["n_integrated"] = [len(m) for m in branch_msgs]
    with t.run("szz"):
        lines = run_szz(
            repo, h.commits, h.changes, modes=szz_modes, workers=cfg.workers,
            progress=lambda f, m: progress("szz", 0.05 + 0.9 * f, m),
        )
        sizes = commit_sizes(repo, sorted(set(lines["intro_hash"]))) if len(lines) else {}
    with Store(store_path) as st:
        st.write("commits", h.commits)
        st.write("changes", h.changes)
        st.write("files", h.files)
        st.write("snapshots", h.snapshots)
        st.write("snapshot_files", h.snapshot_files)
        st.write("szz_lines", lines)
        st.write("intro_sizes", pd.DataFrame({"hash": list(sizes), "n_files": list(sizes.values())}))
        st.set_meta("rev", rev)
        st.set_meta("head", h.commits["hash"].iloc[-1])
        st.set_meta("szz_modes", list(szz_modes))
        st.set_meta("reconciled", h.reconciled)
        st.set_meta("timings", t.seconds)
    progress("szz", 1.0, f"{int(h.commits['is_bugfix'].sum())} bug-fix commits, {len(lines)} blamed lines")
    return t.seconds


def load_repo_data(store: Store, szz_cfg: SZZConfig | None = None, max_fix_commit_files: int | None = 50) -> RepoData:
    """Load a store into memory and apply one SZZ variant and the large-fix filter."""
    szz_cfg = szz_cfg or SZZConfig()
    commits = store.read("commits")
    sizes = store.read("intro_sizes")
    links = szz_links(store.read("szz_lines"), commits, dict(zip(sizes["hash"], sizes["n_files"])), szz_cfg)
    return RepoData.build(
        commits, store.read("changes"), store.read("files"), store.read("snapshots"), store.read("snapshot_files"), links,
        max_fix_commit_files,
    )


def available_szz_config(store: Store) -> SZZConfig:
    modes = store.get_meta("szz_modes", ["plain", "w"])
    return SZZConfig() if "w" in modes else SZZConfig(ignore_whitespace_comments=False)


def make_predictor(store: Store, cfg: AnalysisConfig | None = None) -> Predictor:
    cfg = cfg or AnalysisConfig()
    return Predictor(load_repo_data(store, available_szz_config(store), cfg.model.max_fix_commit_files), cfg.model)
