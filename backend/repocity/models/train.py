"""Models, baselines and "predict at cutoff T" (Section 4.4).

Training protocol (no look-ahead): to predict at cutoff ``T`` we train on *past*
windows ``T' = T - 6m, T - 12m, T - 18m``. A window's features use data <= T' and its
labels use bug fixes in ``(T', T' + 6m]``, which is <= T. So the model never sees
anything after T. Predictions are then evaluated against fixes in ``(T, T + 6m]``.

Models:

* **Logistic regression**: log1p + standardisation, L2, ``class_weight="balanced"``.
  Interpretable coefficients.
* **LightGBM**: gradient-boosted trees, ``class_weight="balanced"``, fixed seed and
  ``deterministic=True`` for reproducibility. Per-file explanations with TreeSHAP
  (Lundberg et al. 2020).

Baselines: random, LOC, recent churn (6 months), CodeScene-style hotspot
(normalised 12-month revisions x normalised complexity; Tornhill, *Your Code as a
Crime Scene*, 2015) and FixCache (Kim et al. 2007).
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import FunctionTransformer, StandardScaler

from repocity.config import ModelConfig
from repocity.models.evaluation import evaluate_ranking
from repocity.models.features import FEATURES, RepoData, build_features, build_labels
from repocity.models.fixcache import build_stream, fixcache_scores
from repocity.timeutil import add_months, month_end_ts, months_between

METHODS = ["lightgbm", "logreg", "random", "loc", "churn", "hotspot", "fixcache"]
METHOD_LABELS = {
    "lightgbm": "LightGBM",
    "logreg": "Logistic regression",
    "random": "Random",
    "loc": "LOC",
    "churn": "Recent churn",
    "hotspot": "Hotspot",
    "fixcache": "FixCache",
}
BASELINES = ["random", "loc", "churn", "hotspot", "fixcache"]

warnings.filterwarnings("ignore", message=".*X does not have valid feature names.*")


def _signed_log(x: np.ndarray) -> np.ndarray:
    return np.sign(x) * np.log1p(np.abs(x))


def make_logreg(seed: int) -> object:
    return make_pipeline(
        FunctionTransformer(_signed_log),
        StandardScaler(),
        LogisticRegression(class_weight="balanced", C=0.5, max_iter=5000, random_state=seed),
    )


def make_lightgbm(seed: int) -> LGBMClassifier:
    return LGBMClassifier(
        n_estimators=150,
        learning_rate=0.05,
        num_leaves=15,
        min_child_samples=5,
        subsample=0.8,
        subsample_freq=1,
        colsample_bytree=0.8,
        reg_lambda=1.0,
        class_weight="balanced",
        random_state=seed,
        deterministic=True,
        force_row_wise=True,
        n_jobs=2,
        verbose=-1,
    )


def _minmax(s: pd.Series) -> pd.Series:
    lo, hi = s.min(), s.max()
    return (s - lo) / (hi - lo) if hi > lo else s * 0.0


def baseline_scores(feats: pd.DataFrame, seed: int, month: str) -> dict[str, np.ndarray]:
    rng = np.random.default_rng([seed, int(month.replace("-", ""))])
    complexity = feats["ccn_total"] if feats["ccn_total"].sum() > 0 else feats["loc"]
    return {
        "random": rng.random(len(feats)),
        "loc": feats["loc"].to_numpy(float),
        "churn": feats["churn_6m"].to_numpy(float),
        "hotspot": (_minmax(feats["n_commits_12m"]) * _minmax(complexity)).to_numpy(float),
    }


def shap_top3(model: LGBMClassifier, X: pd.DataFrame, k: int = 3) -> list[list[tuple[str, float, float]]]:
    """Top-k SHAP contributions (feature, feature value, shap value in log-odds) per row."""
    import shap

    explainer = shap.TreeExplainer(model)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        values = explainer.shap_values(X)
    if isinstance(values, list):  # older SHAP: one array per class
        values = values[1]
    values = np.asarray(values)
    if values.ndim == 3:
        values = values[:, :, 1]
    cols = list(X.columns)
    out = []
    xv = X.to_numpy(float)
    for i in range(len(X)):
        idx = np.argsort(-np.abs(values[i]))[:k]
        out.append([(cols[j], float(xv[i, j]), float(values[i, j])) for j in idx])
    return out


@dataclass
class Prediction:
    month: str
    feats: pd.DataFrame
    labels: pd.Series | None
    scores: dict[str, np.ndarray]
    metrics: dict[str, dict[str, float]] = field(default_factory=dict)
    shap: list[list[tuple[str, float, float]]] | None = None
    fixcache_hit_rate: float = float("nan")
    n_train: int = 0
    n_train_pos: int = 0
    trained: bool = False
    train_months: list[str] = field(default_factory=list)


class Predictor:
    """Caches feature matrices per month so many cutoffs can be evaluated cheaply."""

    def __init__(self, rd: RepoData, cfg: ModelConfig | None = None):
        self.rd = rd
        self.cfg = cfg or ModelConfig()
        self._feats: dict[str, pd.DataFrame] = {}
        self._labels: dict[str, pd.Series] = {}
        self._stream = build_stream(rd.changes)
        self.first_month = rd.months[0]
        self.last_month = rd.months[-1]

    def features(self, month: str) -> pd.DataFrame:
        if month not in self._feats:
            self._feats[month] = build_features(self.rd, month, self.cfg)
        return self._feats[month]

    def labels(self, month: str) -> pd.Series:
        if month not in self._labels:
            self._labels[month] = build_labels(self.rd, month, self.cfg.horizon_months)
        return self._labels[month]

    def has_labels(self, month: str) -> bool:
        """Labels are complete only if the whole horizon lies within the analysed history."""
        return add_months(month, self.cfg.horizon_months) <= self.last_month

    def train_months(self, month: str) -> list[str]:
        out = []
        for k in range(1, self.cfg.train_windows + 1):
            m = add_months(month, -self.cfg.horizon_months * k)
            if months_between(self.first_month, m) >= self.cfg.min_history_months:
                out.append(m)
        return out

    def training_set(self, month: str, features: list[str]) -> tuple[pd.DataFrame, np.ndarray]:
        xs, ys = [], []
        for m in self.train_months(month):
            f = self.features(m)
            if len(f) == 0:
                continue
            xs.append(f[features])
            ys.append(self.labels(m).reindex(f.index).to_numpy())
        if not xs:
            return pd.DataFrame(columns=features), np.zeros(0)
        return pd.concat(xs, ignore_index=True), np.concatenate(ys)

    def predict(
        self,
        month: str,
        features: list[str] | None = None,
        with_shap: bool = False,
        methods: list[str] | None = None,
    ) -> Prediction:
        features = features or FEATURES
        methods = methods or METHODS
        cfg = self.cfg
        feats = self.features(month)
        labels = self.labels(month).reindex(feats.index) if self.has_labels(month) else None
        scores: dict[str, np.ndarray] = {}
        pred = Prediction(month, feats, labels, scores)
        if len(feats) == 0:
            return pred
        X = feats[features]
        X_train, y_train = self.training_set(month, features)
        pred.n_train, pred.n_train_pos = len(y_train), int(y_train.sum())
        pred.train_months = self.train_months(month)
        trainable = pred.n_train_pos >= 2 and pred.n_train_pos < pred.n_train
        if trainable and "lightgbm" in methods:
            gbm = make_lightgbm(cfg.seed).fit(X_train, y_train)
            scores["lightgbm"] = gbm.predict_proba(X)[:, 1]
            if with_shap:
                pred.shap = shap_top3(gbm, X)
        if trainable and "logreg" in methods:
            lr = make_logreg(cfg.seed).fit(X_train.to_numpy(float), y_train)
            scores["logreg"] = lr.predict_proba(X.to_numpy(float))[:, 1]
        pred.trained = trainable
        scores.update({k: v for k, v in baseline_scores(feats, cfg.seed, month).items() if k in methods})
        if "fixcache" in methods:
            ranking, hit_rate = fixcache_scores(
                self._stream, self.rd.snapshot(self.first_month), month_end_ts(month), len(feats), cfg.fixcache_ratio
            )
            scores["fixcache"] = np.array([ranking.get(int(f), 0.0) for f in feats.index])
            pred.fixcache_hit_rate = hit_rate
        if labels is not None:
            y = labels.to_numpy()
            loc = feats["loc"].to_numpy(float)
            for name in methods:
                if name in scores:
                    pred.metrics[name] = evaluate_ranking(y, scores[name], loc, cfg.seed)
        return pred

    def eval_cutoffs(self) -> list[str]:
        """E1 cutoffs: every 6 months, the latest one whose 6-month label window is complete."""
        last = add_months(self.last_month, -self.cfg.horizon_months)
        out = []
        for k in range(self.cfg.eval_cutoff_count):
            m = add_months(last, -self.cfg.eval_cutoff_step_months * k)
            if self.train_months(m):
                out.append(m)
        return sorted(out)

    def app_cutoffs(self) -> list[str]:
        """Cutoffs used by the UI: every 3 months back from the last month (a superset of E1's)."""
        out = []
        m = self.last_month
        while months_between(self.first_month, m) >= 0:
            if self.train_months(m):
                out.append(m)
            m = add_months(m, -self.cfg.app_cutoff_step_months)
        return sorted(out)


def rank_normalise(df: pd.DataFrame, features: list[str]) -> pd.DataFrame:
    """Percentile-rank each feature within one (repo, cutoff) frame - used for cross-project
    models so that size/activity differences between projects do not dominate."""
    out = df.copy()
    for f in features:
        out[f] = df[f].rank(pct=True, method="average")
    return out
