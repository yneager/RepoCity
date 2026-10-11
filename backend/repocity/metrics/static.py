"""Static per-file metrics computed with lizard (multi-language).

* ``loc``       - lizard's NLOC: lines of code without blanks and comments.
* ``ccn_total`` - sum of McCabe cyclomatic complexity over all functions in the file.
* ``ccn_max``   - the most complex function's cyclomatic complexity.
* ``nfuncs``    - number of functions/methods lizard found.

For Java, complexity and function counts come from tree-sitter instead (see
:mod:`repocity.metrics.java_complexity` for why); LOC always comes from lizard.

Metrics are a pure function of (file name extension, blob content), so they are cached
by git blob hash: a monthly snapshot only analyses blobs it has not seen before, which
makes snapshotting incremental (unchanged files are never re-parsed).
"""

from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor
from pathlib import PurePosixPath

import lizard

from repocity import config
from repocity.metrics.java_complexity import java_complexity

Metrics = tuple[int, int, int, int]  # loc, ccn_total, ccn_max, nfuncs


def analyse_source(path: str, data: bytes) -> Metrics:
    """Run lizard on one file's content. Very large files fall back to a line count."""
    if len(data) > config.MAX_ANALYSED_BLOB_BYTES or b"\x00" in data[:8000]:
        lines = sum(1 for ln in data.splitlines() if ln.strip())
        return (lines, 0, 0, 0)
    text = data.decode("utf-8", "replace")
    try:
        info = lizard.analyze_file.analyze_source_code(PurePosixPath(path).name, text)
    except Exception:  # lizard can choke on exotic syntax; never fail the analysis
        lines = sum(1 for ln in text.splitlines() if ln.strip())
        return (lines, 0, 0, 0)
    if path.lower().endswith(".java"):
        try:
            total, worst, nfuncs = java_complexity(data)
            return (int(info.nloc), total, worst, nfuncs)
        except Exception:  # pragma: no cover - fall back to lizard's numbers
            pass
    ccns = [f.cyclomatic_complexity for f in info.function_list]
    return (int(info.nloc), int(sum(ccns)), int(max(ccns, default=0)), len(ccns))


def _analyse_batch(items: list[tuple[str, bytes]]) -> list[Metrics]:
    return [analyse_source(p, d) for p, d in items]


def analyse_many(items: list[tuple[str, bytes]], workers: int = 4) -> list[Metrics]:
    """Analyse many (path, content) pairs, in parallel processes when worthwhile."""
    if len(items) < 64 or workers <= 1:
        return _analyse_batch(items)
    chunk = max(16, len(items) // (workers * 4))
    batches = [items[i : i + chunk] for i in range(0, len(items), chunk)]
    out: list[Metrics] = []
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for res in pool.map(_analyse_batch, batches):
            out.extend(res)
    return out
