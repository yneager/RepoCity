"""Export the demo repositories as offline bundles into demo/cache, and check that the
Prediction-vs-Reality score card numbers equal the E1 evaluation numbers."""

from __future__ import annotations

import json
import shutil
import time

import pandas as pd

from common import RESULTS, ROOT, load_experiment, load_repos, model_config
from repocity.api.jobs import slugify
from repocity.models.train import Predictor
from repocity.pipeline.analyze import load_repo_data
from repocity.pipeline.export import export_bundle, read_json
from repocity.store.db import Store

DEMO = ROOT / "demo" / "cache"
DESCRIPTIONS = {
    "flask": "The Python micro web framework. A compact city with a long history (2010 onwards).",
    "express": "Fast, minimalist web framework for Node.js. Watch lib/ and test/ grow since 2009.",
    "jsoup": "Java HTML parser. A dense Java city: one big package district, many large parsers.",
}


def run() -> list[dict]:
    exp = load_experiment()
    names = exp["demo_repos"]
    e1 = pd.read_csv(RESULTS / "e1_within.csv") if (RESULTS / "e1_within.csv").exists() else None
    DEMO.mkdir(parents=True, exist_ok=True)
    keep = set()
    report = []
    for repo in load_repos(names):
        rid = slugify(repo.url, repo.commit)
        keep.add(rid)
        out = DEMO / rid
        shutil.rmtree(out, ignore_errors=True)
        t0 = time.perf_counter()
        with Store(repo.store, read_only=True) as st:
            predictor = Predictor(load_repo_data(st, None, model_config(exp).max_fix_commit_files), model_config(exp))
        export_bundle(
            predictor, out, repo_id=rid, name=repo.url.split("github.com/")[-1], url=repo.url, head=repo.commit,
            extra_meta={"language": repo.language, "description": DESCRIPTIONS.get(repo.name, "")},
        )
        seconds = time.perf_counter() - t0
        size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
        checked = mismatches = 0
        if e1 is not None:
            for c in predictor.eval_cutoffs():
                card = read_json(out / "predictions" / f"{c}.json.gz")["metrics"]
                for method, metrics in card.items():
                    row = e1[(e1.repo == repo.name) & (e1.cutoff == c) & (e1.method == method)]
                    for k, v in metrics.items():
                        if row.empty:
                            continue
                        ref = row.iloc[0][k]
                        checked += 1
                        if not ((v is None and pd.isna(ref)) or (v is not None and abs(v - ref) < 1e-3)):
                            mismatches += 1
        report.append({"repo": repo.name, "id": rid, "bundle_mb": size / 1e6, "export_seconds": seconds,
                       "scorecard_values_checked": checked, "scorecard_mismatches": mismatches})
        print(f"  demo {rid}: {size / 1e6:.1f} MB, {seconds:.0f}s, score card check {checked - mismatches}/{checked} equal", flush=True)
        if mismatches:
            raise SystemExit(f"score card numbers differ from E1 for {repo.name}")
    for d in DEMO.iterdir():
        if d.is_dir() and d.name not in keep:
            shutil.rmtree(d)
    (RESULTS / "demo_cache.json").write_text(json.dumps(report, indent=1))
    return report


if __name__ == "__main__":
    run()
