# RepoCity: progress log

> Read this first when resuming. It records the current phase, decisions, open issues and the next step.

## Current phase

**All 10 phases implemented.** Remaining items need the author: the E6 manual labels and running Docker once (see
Open issues).

## Phase status

| Phase | Status | Evidence |
|---|---|---|
| 1 Scaffold, Docker Compose, CI | done; Docker **not run locally** (Docker is not installed on the dev machine) | `docker-compose.yml`, `backend/Dockerfile`, `frontend/Dockerfile`, `.github/workflows/ci.yml` |
| 2 Ingestion, renames, snapshots, DuckDB | done | `tests/test_history.py`; Flask ingests in about 15 s, Commons Lang (9.4k commits) in about 90 s; 0 tree reconciliations on all 12 repos |
| 3 Bug-fix detection, SZZ, spot-check CSV | done | `tests/test_szz.py` asserts exact introducing commits (incl. across a rename, a whitespace-only change, a comment line, a merged branch) |
| 4 Features, models, baselines, SHAP, leakage tests | done | `tests/test_features.py` (truncation and perturbation leakage tests), `tests/test_models.py` |
| 5 Stable treemap + API | done | `tests/test_treemap.py` (hypothesis), `tests/test_api.py` (incl. background worker + SSE) |
| 6 3D city, encodings, picking, file panel, search | done | Playwright `e2e/city.spec.ts`, screenshots 02, 06–09 |
| 7 Timeline playback | done | screenshots 03–05 show growth; play/pause tested |
| 8 Prediction vs Reality | done | e2e checks hits@k and Recall@20%LOC against the API; `build_demo_cache.py` checks all 1,136 score-card values against E1 (0 mismatches) |
| 9 Experiments E1–E7, figures, report | done | `python experiments/run_all.py` ran end to end from scratch in 14.3 min |
| 10 Polish, offline demo cache, docs, QA | done | `demo/cache` (Flask, Express, jsoup), README, `docs/*.md`, adaptive quality, error states |

Test totals: backend 43 (pytest + hypothesis), frontend 12 (Vitest), e2e 3 (+1 opt-in live test that analyses
`pallets/click` over the network, which passed).

## Decisions (with reasons)

- **History via `git log`, not PyDriller.** A single `git log --first-parent --diff-merges=first-parent -M --raw --numstat`
  call is orders of magnitude faster. PyDriller is kept as a test oracle (`test_read_history_matches_pydriller`).
- **First-parent + merge diffs.** A merged PR is one "integrated change". A merge is a bug fix if its PR title or an
  integrated commit is a fix.
- **Java complexity via tree-sitter** (allowed by the spec when lizard is insufficient): lizard stops parsing about 10–20%
  of large Java files (`experiments/check_lizard_coverage.py`). LOC still comes from lizard for every language.
- **Bug fixes touching more than 50 files are not counted as fixes** (labels, features, FixCache, visualisation). Inspection
  found mass "fix" commits such as "feat: implement prettier and fix all issues" (149 files) and "Fix deprecation comments"
  (164 files). The raw heuristic flag is kept for the E6 spot-check.
- **Classifier exclusions** were extended after inspecting flagged commits: tooling/lint/static-analysis fixes,
  dependency bumps, Conventional-Commit `chore:`/`docs:`/`test:` vetoes. This is documented as a threat to validity
  (developed on the evaluated projects); the spot-check sample is drawn after these changes.
- **Effort-aware ranking (risk/LOC)** added after the first E1 run showed probability ranking is worse than random on
  Recall@20%LOC/Popt (the known Mende & Koschke effect). Both orderings are always reported. This is stated in the report.
- **ManualUp added as an extra reference baseline**, beyond the five required: without it, effort-aware results cannot be
  judged.
- **E2 compares each model with the best baseline per metric** (chosen on the same data, so conservative for the models).
- **Cross-project (E4)** uses per-(repo, window) percentile-rank features and only windows ending at or before the cutoff.
- **Analyses run in a worker subprocess.** Under `python -m uvicorn` on Windows, spawn-based process pools inherit
  uvicorn's package dir on `sys.path` (`uvicorn/logging.py` shadows `logging`); the subprocess also isolates memory and crashes.
- **Bundles** (gzipped JSON, served as-is with ETags) are the API's storage and the offline demo format.
- **Layout** is computed once over the union of all file identities (max LOC, latest path), so it is stable over time.
- **Risk colour** = percentile of the LightGBM probability within its cutoff (class-weighted probabilities are not calibrated).
- **Adaptive render quality** (drei PerformanceMonitor): shadows off and DPR 1 when the frame rate declines.
- **Moment** kept in the dataset although it is in maintenance mode (few recent fixes, so few evaluable windows). Commander.js was
  considered as a replacement but has only 1.5k commits (below the ~2k guideline).

## Open issues / needs the author

1. **Docker could not be run here** (not installed). The Dockerfiles follow standard patterns and the Linux native npm
   bindings are present in the lockfile, but please run `docker compose up --build` once and check http://localhost:5173.
2. **E6 needs manual labels**: fill `manual_is_bugfix` (1/0) in `experiments/spotcheck/bugfix_spotcheck.csv`, then run
   `python experiments/run_all.py --reuse-stores` (or just `python experiments/spotcheck_bugfix.py score` and
   `python experiments/make_report.py`). The CSV is redrawn on every run until it contains labels, then it is never overwritten.
3. **FPS on a "normal laptop"** was not measured: the dev machine has a desktop GPU (RX 9070 XT). Measured: 60 fps (vsync) up
   to 20k buildings, 584 fps uncapped at 20k, and a CPU-only (SwiftShader) lower bound of 3–18 fps. To measure on a laptop:
   `cd frontend && npm run build && npx vite preview`, then `node e2e/fps-bench.mjs http://localhost:4173 out.json 1000 5000 20000`.
4. **CI** has not run on GitHub (no remote configured). The same commands pass locally.
5. `[TODO: author]` sections in `reports/report_draft.md` (motivation, design rationale, reflections, E6 result, laptop FPS).

## Proposed (not built, per the scope rule)

- A bundled cross-project model for young repositories (E4 suggests it would work well).
- Effort-aware training objective instead of post-hoc risk/LOC ranking.
- Level-of-detail rendering for weak GPUs.

## Final summary

**What works:** paste-a-URL analysis with live SSE progress (validated on `pallets/itsdangerous` and `pallets/click`);
three offline demo cities that load in about 1 s; 3D city with instanced buildings, encodings, legend, district labels that fade
with zoom, hover tooltip, click-to-inspect file panel (metrics, sparkline, pseudonymous authors, bug fixes, SZZ origins, SHAP
bars, GitHub link), search with camera fly-to, reset view; timeline with play/pause, speed and smooth animations plus "bug born"
sparks; Prediction vs Reality with cutoff and k selection, top-k outlines, reveal animation and a score card that matches the
backend; full experiment pipeline regenerating every table and figure.

**Headline results** (12 projects, 61–67 evaluation windows; `reports/report_draft.md`):
- Within-project, LightGBM (ROC-AUC 0.786) and logistic regression (0.793) are **not** better than the best simple baseline:
  LOC has ROC-AUC 0.803, hotspots the best PR-AUC and precision@k (differences negligible to small, mostly not significant).
- Ranking by raw risk is worse than random on effort-aware metrics; ManualUp wins there. Ranking by **risk/LOC** makes the
  models the best methods: logistic regression Recall@20%LOC 0.351 and Popt 0.663, significantly better than ManualUp
  on Popt (Holm p < 0.001, Cliff's δ = 0.25, small).
- **Cross-project** LightGBM generalises: ROC-AUC 0.818 vs 0.786 within-project (p = 0.002).
- Feature-group ablation and SZZ variants change results by at most about 2 points.
- Analysis: 17–109 s per repository; API p50 below 1 ms; 60 fps at 20k buildings on the GPU.

**Known limitations:** keyword-based labels (precision pending E6), B-SZZ limitations, no issue-tracker data, Docker and
laptop FPS unverified on this machine, the treemap draws moved files at their final location.

## Next step

Author: run Docker once, label the E6 CSV, fill the `[TODO: author]` sections, push to GitHub to run CI.
