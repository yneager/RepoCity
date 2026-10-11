"""Evaluation metrics for a ranking of files (higher score = riskier).

* **ROC-AUC** and **PR-AUC** (average precision): threshold-free ranking quality.
* **Recall@20%LOC** (effort-aware; Mende & Koschke 2010, Kamei et al. 2013): inspect
  files in ranked order until 20% of all lines of code have been read; what fraction
  of the buggy files did we find?
* **Popt** (Mende & Koschke, PROMISE 2009): compares the area under the model's
  cumulative "% buggy files found vs. % LOC inspected" curve with the optimal ranking
  (buggy files first, smallest first) and the worst ranking (clean files first, then
  buggy files largest first): ``Popt = 1 - (A_opt - A_model) / (A_opt - A_worst)``.
* **Precision@k**: of the k top-ranked files, how many were actually fixed.

Effort-aware metrics are reported for two orderings of the same scores:

* *by risk* - files in decreasing score order (what a classifier naturally outputs);
* *by risk/LOC* (suffix ``_ea``) - files in decreasing ``score / LOC`` order, i.e. expected
  bugs per line read. This is the standard way to make a risk model effort-aware
  (Mende & Koschke, CSMR 2010; Kamei et al., TSE 2013): ranking by raw risk puts big
  files first and spends the LOC budget quickly.

Ties in a score are broken by a fixed pseudo-random order (seeded), identical for
every method, so that coarse baselines (e.g. FixCache's in/out-of-cache) are not
accidentally advantaged by file order.
"""

from __future__ import annotations

import numpy as np
from sklearn.metrics import average_precision_score, roc_auc_score

from repocity.config import SEED

METRICS = ["roc_auc", "pr_auc", "recall_20loc", "popt", "p_at_10", "p_at_20", "recall_20loc_ea", "popt_ea"]
METRIC_LABELS = {
    "roc_auc": "ROC-AUC",
    "pr_auc": "PR-AUC",
    "recall_20loc": "Recall@20%LOC",
    "popt": "Popt",
    "p_at_10": "Precision@10",
    "p_at_20": "Precision@20",
    "recall_20loc_ea": "Recall@20%LOC (risk/LOC)",
    "popt_ea": "Popt (risk/LOC)",
}


def rank_order(scores: np.ndarray, seed: int = SEED) -> np.ndarray:
    """Indices sorted by descending score, ties broken by a seeded random permutation."""
    rng = np.random.default_rng(seed)
    tiebreak = rng.permutation(len(scores))
    return np.lexsort((tiebreak, -np.asarray(scores, dtype=float)))


def recall_at_effort(y: np.ndarray, loc: np.ndarray, order: np.ndarray, effort: float = 0.2) -> float:
    if y.sum() == 0:
        return float("nan")
    loc = np.maximum(loc, 1.0)
    cum = np.cumsum(loc[order]) / loc.sum()
    inspected = cum <= effort + 1e-12
    return float(y[order][inspected].sum() / y.sum())


def _area(y: np.ndarray, loc: np.ndarray, order: np.ndarray) -> float:
    loc = np.maximum(loc, 1.0)
    x = np.concatenate([[0.0], np.cumsum(loc[order]) / loc.sum()])
    yy = np.concatenate([[0.0], np.cumsum(y[order]) / y.sum()])
    return float(np.trapezoid(yy, x))


def popt(y: np.ndarray, loc: np.ndarray, order: np.ndarray) -> float:
    if y.sum() == 0 or y.sum() == len(y):
        return float("nan")
    l1 = np.maximum(loc, 1.0)
    density = y / l1
    optimal = np.lexsort((l1, -density))  # buggy first, small first
    worst = np.lexsort((-l1, density))  # clean first, then buggy large first
    a_opt, a_worst, a_m = _area(y, loc, optimal), _area(y, loc, worst), _area(y, loc, order)
    if a_opt == a_worst:
        return float("nan")
    return float(1 - (a_opt - a_m) / (a_opt - a_worst))


def precision_at_k(y: np.ndarray, order: np.ndarray, k: int) -> float:
    k = min(k, len(y))
    return float(y[order[:k]].mean()) if k else float("nan")


def evaluate_ranking(y, scores, loc, seed: int = SEED) -> dict[str, float]:
    y = np.asarray(y, dtype=float)
    scores = np.asarray(scores, dtype=float)
    loc = np.asarray(loc, dtype=float)
    order = rank_order(scores, seed)
    order_ea = rank_order(scores / np.maximum(loc, 1.0), seed)
    both = 0 < y.sum() < len(y)
    return {
        "roc_auc": float(roc_auc_score(y, scores)) if both else float("nan"),
        "pr_auc": float(average_precision_score(y, scores)) if both else float("nan"),
        "recall_20loc": recall_at_effort(y, loc, order, 0.2),
        "popt": popt(y, loc, order),
        "p_at_10": precision_at_k(y, order, 10),
        "p_at_20": precision_at_k(y, order, 20),
        "recall_20loc_ea": recall_at_effort(y, loc, order_ea, 0.2),
        "popt_ea": popt(y, loc, order_ea),
    }
