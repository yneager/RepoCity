"""Stages E1 (within-project), E3 (feature ablation), E4 (cross-project), E5 (SZZ ablation).

Every function writes its raw per-(repo, cutoff, method) results to ``reports/results``;
tables and figures are derived from those CSVs by ``stage_report.py``.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from common import RESULTS, load_experiment, load_repos, model_config
from repocity.config import SZZConfig
from repocity.models.evaluation import evaluate_ranking
from repocity.models.features import FEATURE_GROUPS, FEATURES
from repocity.models.train import METHODS, Predictor, make_lightgbm, rank_normalise
from repocity.pipeline.analyze import load_repo_data
from repocity.store.db import Store
from repocity.szz.szz import szz_links
from repocity.timeutil import add_months, months_between

SZZ_VARIANTS = {
    "B-SZZ": SZZConfig(ignore_whitespace_comments=False, ignore_large_commits=False),
    "+ws/comments": SZZConfig(ignore_whitespace_comments=True, ignore_large_commits=False),
    "+large commits": SZZConfig(ignore_whitespace_comments=False, ignore_large_commits=True),
    "+both (default)": SZZConfig(ignore_whitespace_comments=True, ignore_large_commits=True),
}
ABLATION_GROUPS = ["size", "complexity", "churn", "people", "history", "coupling", "directory"]


def _predictor(repo, exp, szz: SZZConfig | None = None) -> Predictor:
    szz = szz or SZZConfig(large_commit_files=exp["szz_large_commit_files"])
    with Store(repo.store, read_only=True) as st:
        rd = load_repo_data(st, szz, model_config(exp).max_fix_commit_files)
    return Predictor(rd, model_config(exp))


def e1_within(only=None) -> pd.DataFrame:
    exp = load_experiment()
    rows = []
    for repo in load_repos(only):
        p = _predictor(repo, exp)
        for m in p.eval_cutoffs():
            pred = p.predict(m)
            base = {
                "repo": repo.name, "language": repo.language, "cutoff": m, "n_files": len(pred.feats),
                "n_pos": int(pred.labels.sum()), "n_train": pred.n_train, "n_train_pos": pred.n_train_pos,
                "fixcache_hit_rate": pred.fixcache_hit_rate,
            }
            for method in METHODS:
                if method in pred.metrics:
                    rows.append({**base, "method": method, **pred.metrics[method]})
        print(f"  E1 {repo.name}: {len(p.eval_cutoffs())} cutoffs", flush=True)
    df = pd.DataFrame(rows)
    df.to_csv(RESULTS / "e1_within.csv", index=False)
    return df


def e3_ablation(only=None) -> pd.DataFrame:
    exp = load_experiment()
    rows = []
    for repo in load_repos(only):
        p = _predictor(repo, exp)
        for m in p.eval_cutoffs():
            full = p.predict(m, methods=["lightgbm"]).metrics.get("lightgbm")
            if not full:
                continue
            rows.append({"repo": repo.name, "cutoff": m, "removed": "none (all features)", **full})
            for g in ABLATION_GROUPS:
                feats = [f for f in FEATURES if f not in FEATURE_GROUPS[g]]
                r = p.predict(m, features=feats, methods=["lightgbm"]).metrics.get("lightgbm")
                if r:
                    rows.append({"repo": repo.name, "cutoff": m, "removed": g, **r})
        print(f"  E3 {repo.name}", flush=True)
    df = pd.DataFrame(rows)
    df.to_csv(RESULTS / "e3_ablation.csv", index=False)
    return df


def e4_cross(only=None) -> pd.DataFrame:
    """Leave-one-project-out: train LightGBM on the other projects' windows that end at or
    before the cutoff (calendar time), with features percentile-ranked per (repo, window)."""
    exp = load_experiment()
    repos = load_repos(only)
    preds = {r.name: _predictor(r, exp) for r in repos}
    cfg = model_config(exp)
    rows = []
    for held in repos:
        ph = preds[held.name]
        for m in ph.eval_cutoffs():
            xs, ys = [], []
            for other in repos:
                if other.name == held.name:
                    continue
                po = preds[other.name]
                for k in range(1, cfg.train_windows + 1):
                    t = add_months(m, -cfg.horizon_months * k)
                    if t not in po.rd.months or months_between(po.first_month, t) < cfg.min_history_months:
                        continue
                    if not po.has_labels(t):
                        continue
                    f = po.features(t)
                    if len(f) == 0:
                        continue
                    xs.append(rank_normalise(f, FEATURES)[FEATURES])
                    ys.append(po.labels(t).reindex(f.index).to_numpy())
            y = np.concatenate(ys)
            model = make_lightgbm(cfg.seed).fit(pd.concat(xs, ignore_index=True), y)
            test = ph.features(m)
            scores = model.predict_proba(rank_normalise(test, FEATURES)[FEATURES])[:, 1]
            labels = ph.labels(m).reindex(test.index).to_numpy()
            metrics = evaluate_ranking(labels, scores, test["loc"].to_numpy(float), cfg.seed)
            rows.append({"repo": held.name, "cutoff": m, "setting": "cross-project", "n_train": len(y), **metrics})
        print(f"  E4 {held.name}", flush=True)
    df = pd.DataFrame(rows)
    df.to_csv(RESULTS / "e4_cross.csv", index=False)
    return df


def e5_szz(only=None) -> tuple[pd.DataFrame, pd.DataFrame]:
    exp = load_experiment()
    counts, perf = [], []
    for repo in load_repos(only):
        with Store(repo.store, read_only=True) as st:
            commits = st.read("commits")
            lines = st.read("szz_lines")
            sizes = st.read("intro_sizes")
        size_map = dict(zip(sizes["hash"], sizes["n_files"]))
        n_fixes = int(commits["is_bugfix"].sum())
        for name, base in SZZ_VARIANTS.items():
            v = SZZConfig(
                ignore_whitespace_comments=base.ignore_whitespace_comments,
                ignore_large_commits=base.ignore_large_commits,
                large_commit_files=exp["szz_large_commit_files"],
            )
            links = szz_links(lines, commits, size_map, v)
            counts.append({
                "repo": repo.name, "variant": name, "bugfix_commits": n_fixes,
                "fixes_with_links": links["fix_idx"].nunique(), "links": len(links),
                "introducing_commits": links["intro_hash"].nunique(),
            })
            p = _predictor(repo, exp, v)
            for m in p.eval_cutoffs():
                r = p.predict(m, methods=["lightgbm"]).metrics.get("lightgbm")
                if r:
                    perf.append({"repo": repo.name, "variant": name, "cutoff": m, **r})
        print(f"  E5 {repo.name}", flush=True)
    c, pf = pd.DataFrame(counts), pd.DataFrame(perf)
    c.to_csv(RESULTS / "e5_szz_counts.csv", index=False)
    pf.to_csv(RESULTS / "e5_szz_perf.csv", index=False)
    return c, pf


if __name__ == "__main__":
    import sys

    only = sys.argv[1:] or None
    RESULTS.mkdir(parents=True, exist_ok=True)
    e1_within(only)
    e3_ablation(only)
    e4_cross(only)
    e5_szz(only)
