"""FixCache, evaluation metrics and the predictor on known inputs."""

from __future__ import annotations

import numpy as np
import pytest

from repocity.config import ModelConfig
from repocity.models.evaluation import evaluate_ranking, popt, precision_at_k, rank_order, recall_at_effort
from repocity.models.fixcache import FixCache
from repocity.models.train import METHODS, Predictor
from repocity.pipeline.analyze import load_repo_data
from repocity.store.db import Store


def test_fixcache_hits_misses_lru():
    fc = FixCache(cache_size=2, block_size=0, prefetch_size=0)
    fc.commit([(1, "M", 5)], is_fix=True)  # miss, load 1
    fc.commit([(2, "M", 5)], is_fix=True)  # miss, load 2
    fc.commit([(1, "M", 5)], is_fix=True)  # hit, 1 becomes most recent
    fc.commit([(3, "M", 5)], is_fix=True)  # miss, evicts LRU = 2
    assert (fc.hits, fc.misses) == (1, 3)
    assert list(fc.cache) == [1, 3]
    assert fc.ranking()[3] > fc.ranking()[1]


def test_fixcache_spatial_locality_and_prefetch():
    fc = FixCache(cache_size=3, block_size=1, prefetch_size=0)
    fc.commit([(1, "M", 1), (2, "M", 1)], is_fix=False)  # 1 and 2 co-change
    fc.commit([(1, "M", 1), (2, "M", 1)], is_fix=False)
    fc.commit([(1, "M", 1), (3, "M", 1)], is_fix=False)
    fc.commit([(1, "M", 1)], is_fix=True)  # miss on 1 -> also loads its strongest partner, 2
    assert set(fc.cache) == {1, 2}
    pf = FixCache(cache_size=2, block_size=0, prefetch_size=1)
    pf.commit([(7, "A", 10), (8, "M", 50)], is_fix=False)  # new files are prefetched first
    assert list(pf.cache) == [7]
    pf.commit([(7, "D", 0)], is_fix=False)
    assert 7 not in pf.cache  # deleted files leave the cache


def test_effort_metrics_by_hand():
    y = np.array([1, 0, 1, 0])
    loc = np.array([10.0, 10.0, 10.0, 70.0])
    perfect = rank_order(np.array([4, 2, 3, 1]))  # 0, 2, 1, 3
    assert recall_at_effort(y, loc, perfect, 0.2) == 1.0  # files 0 and 2 = 20% of LOC
    worst = rank_order(np.array([1, 3, 0, 4]))
    assert recall_at_effort(y, loc, worst, 0.2) == 0.0
    assert popt(y, loc, perfect) == pytest.approx(1.0)
    assert popt(y, loc, worst) == pytest.approx(0.0)
    assert precision_at_k(y, perfect, 2) == 1.0
    m = evaluate_ranking(y, [4, 2, 3, 1], loc)
    assert m["roc_auc"] == 1.0 and m["pr_auc"] == 1.0


def test_tie_breaking_is_deterministic():
    a = rank_order(np.zeros(50))
    b = rank_order(np.zeros(50))
    assert (a == b).all() and sorted(a) == list(range(50))


def test_predictor_on_synthetic_repo(bug_store):
    with Store(bug_store) as st:
        rd = load_repo_data(st)
    p = Predictor(rd, ModelConfig(min_history_months=1, train_windows=2, horizon_months=3))
    pred = p.predict("2020-09", with_shap=False)
    # baselines are always available; the models need >= 2 positive training rows
    for name in ["random", "loc", "churn", "hotspot", "fixcache"]:
        assert len(pred.scores[name]) == len(pred.feats)
    assert set(pred.metrics) <= set(METHODS)
    assert pred.labels is not None and pred.labels.sum() == 1  # c10 fixes util.py in Oct
