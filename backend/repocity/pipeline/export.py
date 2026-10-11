"""Export an analysed repository as a static *bundle* of gzipped JSON files.

The API serves bundles directly (``Content-Encoding: gzip``), and the offline demo
cache in ``demo/cache`` is nothing but three bundles. Layout of a bundle::

    meta.json.gz                   repo info, months, cutoffs, stats, feature labels
    layout.json.gz                 building lots + districts (computed once, stable)
    snapshots/index.json.gz        per-month totals (files, LOC, commits, fixes)
    snapshots/YYYY-MM.json.gz      per-building arrays for one month
    predictions/YYYY-MM.json.gz    risk, SHAP top-3, actual future fixes, scores
    commits.json.gz                compact first-parent commit list
    files.json.gz                  per-file change list, path history, SZZ links

Per-building arrays are aligned with ``layout.files`` order (index ``i`` = building i).
"""

from __future__ import annotations

import gzip
import json
import math
import time
from collections import defaultdict
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import pandas as pd

from repocity.layout.treemap import layout_city
from repocity.models.evaluation import METRIC_LABELS, rank_order
from repocity.models.features import FEATURE_GROUPS, FEATURE_LABELS
from repocity.models.train import METHOD_LABELS, Predictor
from repocity.timeutil import add_months, month_end_ts, month_of

BUNDLE_VERSION = 1
TOP_K_DEFAULT = 20


def write_json(path: Path, obj: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(obj, separators=(",", ":"), allow_nan=False).encode()
    with open(path, "wb") as fh:
        fh.write(gzip.compress(data, compresslevel=6, mtime=0))


def read_json(path: Path) -> object:
    with open(path, "rb") as fh:
        return json.loads(gzip.decompress(fh.read()))


def _clean(x: float, nd: int = 4) -> float | None:
    if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))):
        return None
    return round(float(x), nd)


def web_url(url: str | None, head: str) -> str | None:
    """Template for linking a file on its remote host (``{path}`` placeholder)."""
    if not url:
        return None
    u = urlparse(url)
    base = url[:-4] if url.endswith(".git") else url
    if u.hostname == "github.com":
        return f"{base}/blob/{head}/{{path}}"
    if u.hostname and "gitlab" in u.hostname:
        return f"{base}/-/blob/{head}/{{path}}"
    return None


def export_bundle(
    predictor: Predictor,
    out: Path,
    *,
    repo_id: str,
    name: str,
    url: str | None,
    head: str,
    progress: Callable[[str, float, str], None] | None = None,
    extra_meta: dict | None = None,
) -> dict:
    prog = progress or (lambda s, f, m: None)
    rd = predictor.rd
    commits = rd.commits
    ch = rd.changes
    sf = rd.snapshot_files
    months = rd.months

    # ---- layout ---------------------------------------------------------------------
    prog("model", 0.0, "Computing squarified treemap layout")
    max_loc = sf.groupby("file_id")["loc"].max()
    last_path = sf.sort_values("month").groupby("file_id")["path"].last()
    file_ids = sorted(max_loc.index.tolist())
    lay = layout_city([(int(f), last_path[f], float(max_loc[f])) for f in file_ids])
    index_of = {fid: i for i, fid in enumerate(file_ids)}
    n = len(file_ids)
    layout = {
        "size": lay.size,
        "files": {
            "id": file_ids,
            "path": [last_path[f] for f in file_ids],
            "x": [round(lay.files[f][0] + lay.files[f][2] / 2, 3) for f in file_ids],
            "z": [round(lay.files[f][1] + lay.files[f][3] / 2, 3) for f in file_ids],
            "w": [round(lay.files[f][2], 3) for f in file_ids],
            "d": [round(lay.files[f][3], 3) for f in file_ids],
            "maxLoc": [int(max_loc[f]) for f in file_ids],
        },
        "districts": [
            {k: (round(v, 3) if isinstance(v, float) else v) for k, v in d.items()} for d in lay.districts
        ],
    }
    write_json(out / "layout.json.gz", layout)
    prog("model", 0.0, f"Layout: {n} buildings, {len(lay.districts)} districts")

    # ---- predictions at app cutoffs ---------------------------------------------------
    cutoffs = predictor.app_cutoffs()
    eval_cutoffs = predictor.eval_cutoffs()
    risk_by_cutoff: dict[str, np.ndarray] = {}
    pred_index = []
    for ci, m in enumerate(cutoffs):
        p = predictor.predict(m, with_shap=True)
        if len(p.feats) == 0:
            continue
        idx = [index_of[int(f)] for f in p.feats.index]
        risk = p.scores.get("lightgbm")
        model = "lightgbm" if risk is not None else "hotspot"
        if risk is None:
            risk = p.scores["hotspot"]
        pct = pd.Series(risk).rank(pct=True).to_numpy()
        arr = np.full(n, -1.0)
        arr[idx] = pct
        risk_by_cutoff[m] = arr
        # exactly the orderings (incl. seeded tie-breaking) used by the evaluation metrics
        order_model = rank_order(risk, predictor.cfg.seed)
        hotspot = p.scores["hotspot"]
        order_hotspot = rank_order(hotspot, predictor.cfg.seed)
        payload = {
            "cutoff": m,
            "horizonEnd": add_months(m, predictor.cfg.horizon_months),
            "hasLabels": p.labels is not None,
            "model": model,
            "trained": p.trained,
            "trainMonths": p.train_months,
            "nTrain": p.n_train,
            "nTrainPos": p.n_train_pos,
            "isEvalCutoff": m in eval_cutoffs,
            "files": idx,
            "risk": [_clean(v) for v in risk],
            "riskPct": [_clean(v, 3) for v in pct],
            "hotspot": [_clean(v) for v in hotspot],
            "actual": [int(v) for v in p.labels.to_numpy()] if p.labels is not None else None,
            "shap": [[[f, _clean(v, 2), _clean(s)] for f, v, s in row] for row in p.shap] if p.shap else None,
            "rankModel": [int(i) for i in order_model[:200]],
            "rankHotspot": [int(i) for i in order_hotspot[:200]],
            "metrics": {k: {mk: _clean(mv) for mk, mv in v.items()} for k, v in p.metrics.items()},
            "fixcacheHitRate": _clean(p.fixcache_hit_rate),
        }
        write_json(out / "predictions" / f"{m}.json.gz", payload)
        pred_index.append(
            {"cutoff": m, "hasLabels": payload["hasLabels"], "isEvalCutoff": payload["isEvalCutoff"], "trained": p.trained}
        )
        prog("model", (ci + 1) / max(1, len(cutoffs)), f"Prediction at {m}: {len(idx)} files")

    # ---- per-month building arrays -----------------------------------------------------
    prog("layout", 0.5, "Exporting monthly snapshots")
    c_time = commits.set_index("idx")["time"]
    created_month = rd.created_time.map(lambda t: month_of(t) if pd.notna(t) else None)
    births = rd.links.drop_duplicates(["file_id", "intro_hash"]).copy()
    births["month"] = births["intro_time"].map(month_of)
    births_by_month = births.groupby("month")
    cum_churn = np.zeros(n)
    cum_commits = np.zeros(n)
    cum_fixes = np.zeros(n)
    cum_born = np.zeros(n)
    maxima = {"churn": 1, "commits": 1, "ccn": 1, "authors": 1, "age": 1, "fixes": 1, "loc": 1}
    authors: list[set] = [set() for _ in range(n)]
    ch_sorted = ch[ch["file_id"].isin(list(index_of))]
    times = ch_sorted["time"].to_numpy()
    ptr = 0
    month_index = []
    sf_by_month = dict(tuple(sf.groupby("month")))
    cutoff_list = sorted(risk_by_cutoff)
    first_commit_time = int(commits["time"].iloc[0])
    for m in months:
        end = month_end_ts(m)
        stop = int(np.searchsorted(times, end, side="right"))
        part = ch_sorted.iloc[ptr:stop]
        ptr = stop
        if len(part):
            ii = part["file_id"].map(index_of).to_numpy()
            np.add.at(cum_churn, ii, part["churn"].to_numpy())
            np.add.at(cum_commits, ii, 1)
            fx = part["is_bugfix"].to_numpy() & (part["status"].to_numpy() != "D")
            np.add.at(cum_fixes, ii[fx], 1)
            for i, a in zip(ii, part["author"]):
                authors[i].add(a)
        snap = sf_by_month.get(m)
        loc = np.zeros(n)
        ccn = np.zeros(n)
        age = np.zeros(n)
        if snap is not None:
            si = snap["file_id"].map(index_of).to_numpy()
            loc[si] = np.maximum(snap["loc"].to_numpy(), 1)
            ccn[si] = snap["ccn_total"].to_numpy()
            cm = created_month.reindex(snap["file_id"]).to_numpy()
            age[si] = [
                (int(m[:4]) * 12 + int(m[5:7]) - (int(c[:4]) * 12 + int(c[5:7]))) if c else 0 for c in cm
            ]
        born = np.zeros(n)
        if m in births_by_month.groups:
            b = births_by_month.get_group(m)
            bi = b["file_id"].map(index_of).dropna().astype(int).to_numpy()
            np.add.at(born, bi, 1)
        cum_born += born
        cands = [c for c in cutoff_list if c <= m]
        risk = risk_by_cutoff[cands[-1]] if cands else np.full(n, -1.0)
        risk_month = cands[-1] if cands else None
        exists = loc > 0
        risk_out = np.where(exists, risk, -1.0)
        payload = {
            "month": m,
            "riskCutoff": risk_month,
            "loc": loc.astype(int).tolist(),
            "ccn": ccn.astype(int).tolist(),
            "churn": np.where(exists, cum_churn, 0).astype(int).tolist(),
            "commits": np.where(exists, cum_commits, 0).astype(int).tolist(),
            "authors": [len(authors[i]) if exists[i] else 0 for i in range(n)],
            "age": age.astype(int).tolist(),
            "fixes": np.where(exists, cum_fixes, 0).astype(int).tolist(),
            "bornTotal": np.where(exists, cum_born, 0).astype(int).tolist(),
            "born": born.astype(int).tolist(),
            "risk": [round(float(r), 3) for r in risk_out],
        }
        write_json(out / "snapshots" / f"{m}.json.gz", payload)
        for key in maxima:
            maxima[key] = max(maxima[key], max(payload[key], default=0))
        n_commits_so_far = int(np.searchsorted(commits["time"].to_numpy(), end, side="right"))
        month_index.append(
            {
                "month": m,
                "files": int(exists.sum()),
                "loc": int(loc.sum()),
                "commits": n_commits_so_far,
                "fixes": int(commits["is_bugfix"].to_numpy()[:n_commits_so_far].sum()),
            }
        )
    write_json(out / "snapshots" / "index.json.gz", month_index)
    prog("layout", 0.8, "Exporting file details")

    # ---- commits + per-file details ----------------------------------------------------------
    commit_rows = [
        [h[:10], int(t), ini, a, int(bool(fx)), (msg.split("\n", 1)[0])[:140], int(bool(mg))]
        for h, t, ini, a, fx, msg, mg in zip(
            commits["hash"], commits["time"], commits["initials"], commits["author"], commits["is_bugfix"],
            commits["message"], commits["is_merge"],
        )
    ]
    write_json(out / "commits.json.gz", {"fields": ["hash", "time", "initials", "author", "fix", "subject", "merge"], "rows": commit_rows})
    per_file: dict[int, dict] = defaultdict(lambda: {"changes": [], "szz": []})
    for cidx, fid, path, status, a, d in zip(ch["commit_idx"], ch["file_id"], ch["path"], ch["status"], ch["added"], ch["deleted"]):
        if fid in index_of:
            per_file[int(fid)]["changes"].append([int(cidx), int(a), int(d), status, path])
    for fidx, fid, ih, it in zip(rd.links["fix_idx"], rd.links["file_id"], rd.links["intro_hash"], rd.links["intro_time"]):
        if fid in index_of:
            per_file[int(fid)]["szz"].append([int(fidx), ih[:10], int(it)])
    files_out = {
        str(fid): {
            "path": last_path[fid],
            "created": created_month.get(fid),
            "changes": per_file[fid]["changes"],
            "szz": per_file[fid]["szz"],
        }
        for fid in file_ids
    }
    write_json(out / "files.json.gz", files_out)

    stats_last = month_index[-1]
    meta = {
        "version": BUNDLE_VERSION,
        "id": repo_id,
        "name": name,
        "url": url,
        "head": head,
        "webUrl": web_url(url, head),
        "months": months,
        "firstCommit": int(first_commit_time),
        "lastCommit": int(c_time.iloc[-1]),
        "nCommits": int(len(commits)),
        "nBugfixes": int(commits["is_bugfix"].sum()),
        "nFiles": n,
        "nBuildingsLast": stats_last["files"],
        "locLast": stats_last["loc"],
        "cutoffs": pred_index,
        "evalCutoffs": eval_cutoffs,
        "horizonMonths": predictor.cfg.horizon_months,
        "topK": TOP_K_DEFAULT,
        "maxima": maxima,
        "featureLabels": FEATURE_LABELS,
        "featureGroups": FEATURE_GROUPS,
        "methodLabels": METHOD_LABELS,
        "metricLabels": METRIC_LABELS,
        "analysedAt": int(time.time()),
        **(extra_meta or {}),
    }
    write_json(out / "meta.json.gz", meta)
    prog("layout", 1.0, "Bundle written")
    return meta
