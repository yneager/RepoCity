# RepoCity: progress log

> Read this first when resuming. It records the current phase, decisions, open issues and the next step.

## Current phase

Phase 6/7 in progress (backend phases 1–5 implemented and tested; frontend city renders).

## Completed

- Phase 2: ingestion (`git log --raw --numstat` parser), rename tracking (`IdentityTracker`), monthly snapshots, DuckDB store.
- Phase 3: keyword bug-fix classifier (merge-aware), B-SZZ + whitespace/comment and large-commit improvements.
- Phase 4: features (20, 7 groups), labels, LightGBM + logistic regression, 5 baselines incl. FixCache, SHAP, leakage tests.
- Phase 5: squarified treemap + stable union layout, FastAPI endpoints, SSE progress, gzipped bundle export.
- Backend tests: 42 passing (synthetic repos with known SZZ answers).

## Decisions

- **History parsing uses `git log` directly, not PyDriller.** PyDriller walks commits object by object and is much slower;
  a single `git log --first-parent --diff-merges=first-parent -M --raw --numstat` call parses Flask in about 1 s.
  PyDriller is kept as a test oracle: `test_read_history_matches_pydriller` checks that both agree.
- **First-parent + merge diffs.** Merge commits are diffed against their first parent, so a merged PR is one
  "integrated change". A merge counts as a bug fix if its PR title (body) or any commit it integrates is a fix.
- **Java complexity via tree-sitter.** lizard stops parsing roughly 10–20% of large Java files (commons-lang, gson);
  `experiments/check_lizard_coverage.py` measures this. tree-sitter is used for Java CCN; lizard is used for LOC everywhere.
- **Monotonic time.** Commit times along first-parent are made monotonic (running max) to survive clock skew.
- **Bundles.** The API serves pre-gzipped JSON bundles; the offline demo cache is just three bundles.
- **Risk colour** is the LightGBM probability's percentile within its cutoff (raw probabilities from class-weighted
  models are not calibrated).

## Open issues

- Docker is not installed on the development machine, so `docker compose up` could not be run locally. The files are
  written to standard conventions; please run it once.

## Next step

Experiments config + run_all.py; e2e tests; docs.
