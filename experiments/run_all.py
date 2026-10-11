"""Regenerate every table and figure in reports/ (and the offline demo cache) from scratch.

    python experiments/run_all.py                 # everything (clone if needed, re-ingest, E1-E7, report)
    python experiments/run_all.py --reuse-stores  # skip re-ingesting repositories that are already in data/stores
    python experiments/run_all.py --skip-fps      # skip the browser FPS benchmark (needs Node + Playwright)
    python experiments/run_all.py --repos flask jsoup   # a subset (quick check)

Stages: ingest -> E1 within-project -> E3 ablation -> E4 cross-project -> E5 SZZ ablation ->
demo cache (+ score-card consistency check) -> E2 statistics, tables, figures -> E6 spot-check
-> E7 system performance -> screenshots -> reports/report_draft.md.
Raw results land in reports/results/, tables in reports/tables/, figures in reports/figures/.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_demo_cache  # noqa: E402
import make_report  # noqa: E402
import spotcheck_bugfix  # noqa: E402
import stage_eval  # noqa: E402
import stage_ingest  # noqa: E402
import stage_report  # noqa: E402
import stage_system  # noqa: E402
from common import FIGURES, RESULTS, ROOT, TABLES  # noqa: E402


def banner(text: str) -> None:
    print(f"\n=== {text} ===", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repos", nargs="*", help="only these repositories (names from repos.yaml)")
    ap.add_argument("--reuse-stores", action="store_true", help="do not re-ingest repositories that already have a store")
    ap.add_argument("--skip-fps", action="store_true", help="skip the Playwright FPS benchmark")
    ap.add_argument("--skip-demo", action="store_true", help="do not rebuild demo/cache")
    args = ap.parse_args()
    only = args.repos or None
    t0 = time.time()
    if not args.reuse_stores:
        for d in (TABLES, FIGURES):
            shutil.rmtree(d, ignore_errors=True)
    for d in (RESULTS, TABLES, FIGURES):
        d.mkdir(parents=True, exist_ok=True)

    banner("Stage 1: clone + ingest (history, snapshots, SZZ)")
    stage_ingest.run(only, reuse=args.reuse_stores)
    banner("E1 within-project prediction")
    stage_eval.e1_within(only)
    banner("E3 feature-group ablation")
    stage_eval.e3_ablation(only)
    banner("E4 cross-project generalisation")
    stage_eval.e4_cross(only)
    banner("E5 SZZ ablation")
    stage_eval.e5_szz(only)
    if not args.skip_demo and not only:
        banner("Demo cache (offline bundles) + score card consistency check")
        build_demo_cache.run()
    banner("E2 statistics, tables and figures")
    stage_report.run()
    banner("E6 bug-fix heuristic spot-check")
    if not (ROOT / "experiments" / "spotcheck" / "bugfix_spotcheck.csv").exists():
        spotcheck_bugfix.sample()
    spotcheck_bugfix.score()
    banner("E7 system performance")
    stage_system.run(only, skip_fps=args.skip_fps)
    banner("City screenshots for the report")
    copy_screenshots()
    banner("Report")
    make_report.run()
    (RESULTS / "run_info.json").write_text(json.dumps({"seconds": time.time() - t0, "finished": time.strftime("%Y-%m-%d %H:%M:%S")}, indent=1))
    print(f"\nDone in {(time.time() - t0) / 60:.1f} min. See reports/report_draft.md", flush=True)


def copy_screenshots() -> None:
    """Report figures reuse the Playwright e2e screenshots (docs/screenshots)."""
    src = ROOT / "docs" / "screenshots"
    picks = ["02-city-latest", "04-timeline-middle", "06-file-panel", "11-pvr-revealed"]
    found = 0
    for name in picks:
        f = src / f"{name}.png"
        if f.exists():
            shutil.copy(f, FIGURES / f"city_{name}.png")
            found += 1
    print(f"  copied {found}/{len(picks)} screenshots (run `npx playwright test` in frontend/ to refresh them)")


if __name__ == "__main__":
    main()
