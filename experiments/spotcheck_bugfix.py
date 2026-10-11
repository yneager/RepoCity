"""E6: manual spot-check of the bug-fix keyword heuristic.

``python experiments/spotcheck_bugfix.py sample`` writes
``experiments/spotcheck/bugfix_spotcheck.csv`` with 100 first-parent commits (50 per
repository from ``spotcheck_repos`` in experiment.yaml): 25 the heuristic labels as bug
fixes and 25 it labels as non-fixes, drawn with a fixed seed. Fill in the
``manual_is_bugfix`` column with 1 / 0 (leave blank if you cannot tell) - this is the
only manual labelling in the project. The sampler never overwrites a file that already
contains manual labels.

``python experiments/spotcheck_bugfix.py score`` (also called by run_all.py) computes
precision (of commits flagged as fixes, how many really are) and the miss rate among
commits flagged as non-fixes, with Wilson 95% confidence intervals.
"""

from __future__ import annotations

import json
import math
import sys

import pandas as pd
from common import RESULTS, ROOT, load_experiment, load_repos

from repocity.store.db import Store

OUT = ROOT / "experiments" / "spotcheck" / "bugfix_spotcheck.csv"


def sample() -> None:
    exp = load_experiment()
    if OUT.exists() and pd.read_csv(OUT)["manual_is_bugfix"].notna().any():
        print(f"{OUT} already contains manual labels; not overwriting.")
        return
    per = exp["spotcheck_per_repo"] // 2
    frames = []
    for repo in load_repos(exp["spotcheck_repos"]):
        with Store(repo.store, read_only=True) as st:
            c = st.read("commits")
        for flag in (True, False):
            pool = c[c["is_bugfix"] == flag]
            s = pool.sample(n=min(per, len(pool)), random_state=exp["seed"])
            frames.append(pd.DataFrame({
                "repo": repo.name,
                "hash": s["hash"],
                "commit_url": [f"{repo.url}/commit/{h}" for h in s["hash"]],
                "date": pd.to_datetime(s["time"], unit="s").dt.date.astype(str),
                "is_merge": s["is_merge"],
                "heuristic_is_bugfix": int(flag),
                "message": s["message"].str.replace(r"\s+", " ", regex=True).str.slice(0, 400),
            }))
    df = pd.concat(frames).sample(frac=1, random_state=exp["seed"]).reset_index(drop=True)  # hide the label order
    df["manual_is_bugfix"] = ""
    df["notes"] = ""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT, index=False, encoding="utf-8")
    print(f"wrote {len(df)} commits to {OUT}")


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (centre - half, centre + half)


def score() -> dict:
    if not OUT.exists():
        result = {"status": "missing", "message": "Run `python experiments/spotcheck_bugfix.py sample` first."}
    else:
        df = pd.read_csv(OUT)
        lab = df[pd.to_numeric(df["manual_is_bugfix"], errors="coerce").isin([0, 1])].copy()
        lab["manual"] = pd.to_numeric(lab["manual_is_bugfix"]).astype(int)
        if lab.empty:
            result = {"status": "pending", "n_sampled": len(df),
                      "message": "No manual labels yet: fill in manual_is_bugfix (1/0) in experiments/spotcheck/bugfix_spotcheck.csv."}
        else:
            pos = lab[lab["heuristic_is_bugfix"] == 1]
            neg = lab[lab["heuristic_is_bugfix"] == 0]
            tp, fp = int((pos["manual"] == 1).sum()), int((pos["manual"] == 0).sum())
            fn = int((neg["manual"] == 1).sum())
            result = {
                "status": "done", "n_labelled": len(lab), "n_sampled": len(df),
                "precision": tp / max(1, tp + fp), "precision_ci": wilson(tp, tp + fp),
                "miss_rate_among_negatives": fn / max(1, len(neg)), "miss_rate_ci": wilson(fn, len(neg)),
                "per_repo": {r: {"precision": float((g[g.heuristic_is_bugfix == 1]["manual"] == 1).mean())} for r, g in lab.groupby("repo")},
            }
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "e6_spotcheck.json").write_text(json.dumps(result, indent=1))
    print(json.dumps(result, indent=1))
    return result


if __name__ == "__main__":
    {"sample": sample, "score": score}[sys.argv[1] if len(sys.argv) > 1 else "score"]()
