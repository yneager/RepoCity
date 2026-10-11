"""FixCache / BugCache (Kim, Zimmermann, Whitehead & Zeller, "Predicting Faults from
Cached History", ICSE 2007).

Idea: faults are *local*. A file that had a fault recently, that was changed recently,
that was just created, or that usually changes together with a faulty file, is likely
to have a fault soon. FixCache keeps a fixed-size cache of such files and replays the
history commit by commit:

* **Pre-load**: the cache starts with the largest files (by LOC at the first snapshot).
* **Bug-fix commit** touching file ``f``: if ``f`` is in the cache it is a *hit*,
  otherwise a *miss*; on a miss ``f`` is loaded (temporal locality) together with the
  ``block_size`` files that co-changed with ``f`` most often so far (spatial locality).
* **Any commit**: up to ``prefetch_size`` of the files it adds (new-entity locality) or
  changes (changed-entity locality) are loaded, the most heavily changed first.
* **Replacement**: least-recently-used (LRU) when the cache is full.

At cutoff T the files in the cache are the prediction. To turn the cache into a
ranking we score cached files by recency (most recently used = highest) and give all
other files score 0 (ties broken by the shared seeded order in ``evaluation.py``).

Kim et al. used a cache of 10% of the files; that is our default.
"""

from __future__ import annotations

from collections import Counter, OrderedDict, defaultdict

import pandas as pd


class FixCache:
    def __init__(self, cache_size: int, block_size: int, prefetch_size: int):
        self.size = max(1, cache_size)
        self.block = max(0, block_size)
        self.prefetch = max(0, prefetch_size)
        self.cache: OrderedDict[int, None] = OrderedDict()
        self.cochange: dict[int, Counter] = defaultdict(Counter)
        self.hits = 0
        self.misses = 0

    def _load(self, fid: int) -> None:
        if fid in self.cache:
            self.cache.move_to_end(fid)
            return
        self.cache[fid] = None
        while len(self.cache) > self.size:
            self.cache.popitem(last=False)  # evict least recently used

    def preload(self, file_ids: list[int]) -> None:
        for fid in file_ids[: self.size]:
            self._load(fid)

    def remove(self, fid: int) -> None:
        self.cache.pop(fid, None)

    def commit(self, touched: list[tuple[int, str, int]], is_fix: bool) -> None:
        """Process one commit; ``touched`` = [(file_id, status, lines changed)]."""
        ids = [f for f, s, _ in touched if s != "D"]
        if is_fix:
            for fid in ids:
                if fid in self.cache:
                    self.hits += 1
                    self.cache.move_to_end(fid)
                else:
                    self.misses += 1
                    self._load(fid)
                    for partner, _n in self.cochange[fid].most_common(self.block):
                        self._load(partner)
        if self.prefetch:
            new = [t for t in touched if t[1] == "A"]
            changed = sorted((t for t in touched if t[1] in ("M", "R")), key=lambda t: -t[2])
            for fid, _s, _n in (new + changed)[: self.prefetch]:
                self._load(fid)
        for fid, s, _ in touched:
            if s == "D":
                self.remove(fid)
        if len(ids) <= 30:  # co-change counts for spatial locality (skip huge commits)
            for a in ids:
                for b in ids:
                    if a != b:
                        self.cochange[a][b] += 1

    def ranking(self) -> dict[int, float]:
        """Most recently used file gets the highest score."""
        n = len(self.cache)
        return {fid: 1.0 + (i + 1) / n for i, fid in enumerate(self.cache)}


Stream = list[tuple[int, bool, list[tuple[int, str, int]]]]


def build_stream(changes: pd.DataFrame) -> Stream:
    """Group the change table into [(time, is_fix, [(file_id, status, churn)])] by commit."""
    stream: Stream = []
    for (_idx, t, is_fix), g in changes.groupby(["commit_idx", "time", "is_bugfix"], sort=True):
        stream.append((int(t), bool(is_fix), list(zip(g["file_id"].tolist(), g["status"].tolist(), g["churn"].tolist()))))
    stream.sort(key=lambda r: r[0])
    return stream


def fixcache_scores(
    stream: Stream,
    first_snapshot: pd.DataFrame,
    t_end: int,
    n_files_at_t: int,
    ratio: float = 0.10,
) -> tuple[dict[int, float], float]:
    """Replay history up to ``t_end``; return (file_id -> score, hit rate)."""
    size = max(1, round(ratio * n_files_at_t))
    fc = FixCache(cache_size=size, block_size=max(1, size // 10), prefetch_size=max(1, size // 10))
    fc.preload(list(first_snapshot.sort_values("loc", ascending=False)["file_id"]))
    for t, is_fix, touched in stream:
        if t > t_end:
            break
        fc.commit(touched, is_fix)
    total = fc.hits + fc.misses
    return fc.ranking(), (fc.hits / total if total else float("nan"))
