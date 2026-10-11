"""Ingest one repository into its DuckDB store (run as a child process by run_all.py).

Prints one JSON line with step timings and size statistics on stdout.
"""

from __future__ import annotations

import json
import sys
import time

from common import CONFIGS, analysis_config, load_experiment, load_repos
from repocity.pipeline.analyze import ingest
from repocity.store.db import Store
from repocity.szz.bugfix import BugfixClassifier


def main(name: str) -> None:
    (repo,) = load_repos([name])
    exp = load_experiment()
    cfg = analysis_config(exp)
    clf = BugfixClassifier.from_yaml(CONFIGS / "bugfix.yaml")
    if repo.store.exists():
        repo.store.unlink()
    t0 = time.perf_counter()
    timings = ingest(repo.clone_dir, repo.store, repo.commit, cfg=cfg, szz_modes=("plain", "w"), classifier=clf,
                     progress=lambda s, f, m: print(f"    [{s}] {m}", file=sys.stderr) if f in (0.0, 1.0) else None)
    total = time.perf_counter() - t0
    with Store(repo.store) as st:
        st.set_meta("url", repo.url)
        n_commits = int(st.query("SELECT count(*) AS n FROM commits")["n"][0])
        n_files = int(st.query("SELECT count(*) AS n FROM files")["n"][0])
        n_fixes = int(st.query("SELECT count(*) AS n FROM commits WHERE is_bugfix")["n"][0])
        last = st.query("SELECT max(month) AS m FROM snapshots")["m"][0]
        n_last = int(st.query("SELECT count(*) AS n FROM snapshot_files WHERE month = ?", [last])["n"][0])
    print(json.dumps({
        "repo": name, "ingest_seconds": total, "steps": timings, "commits": n_commits,
        "file_identities": n_files, "files_last": n_last, "bugfix_commits": n_fixes,
    }))


if __name__ == "__main__":
    main(sys.argv[1])
