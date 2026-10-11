# RepoCity algorithms, in plain language

This document explains every algorithm RepoCity uses, in the order the analysis pipeline runs them.
Each section names the code that implements it and the paper it comes from, so you can show the
examiners both the idea and where it lives.

---

## 1. Reading the history

**Code:** `backend/repocity/ingest/history.py`, `ingest/snapshots.py`

### First-parent history

A git repository is a graph: merge commits have two parents. The *first-parent* chain is the sequence
of states the main branch actually went through (each merged pull request is one step). RepoCity
walks exactly this chain:

```
git log --first-parent --diff-merges=first-parent -M --raw --numstat --reverse
```

* `--diff-merges=first-parent` diffs a merge against its first parent, so a merged pull request shows
  up as **one integrated change** containing everything the PR changed.
* `-M` turns on rename detection (a file counts as renamed if its content is at least 50% similar).
* `--raw` gives the change type (Added / Modified / Deleted / Renamed) and exact paths, `--numstat`
  gives lines added and deleted. Git prints both lists in the same order, so they are zipped together.

One `git log` call parses Flask's 2,280 first-parent commits in about a second. PyDriller (the
library the spec suggests) walks commits one by one and is far slower, so it is used as a **test
oracle** instead: `test_read_history_matches_pydriller` checks that both produce the same numbers.

Committer timestamps along the first-parent chain are made monotonic (a running maximum), so clock
skew on a developer's machine can never make time go backwards.

**Privacy.** Author e-mails are replaced by the first 10 hex characters of `sha256(email)`. The UI only
shows these hashes and the author's initials.

### Rename tracking (file identity)

Every source file gets a stable integer `file_id`. When git reports `old.py → new.py`, the identity
moves to the new path, so the file keeps its whole history (commits, bug fixes, authors) across
renames. Inside one commit all removals are processed before additions, which handles swaps
(`a → b` and `b → a` in the same commit). A path that is deleted and later re-created is a **new**
identity: it is a different file that happens to reuse a name.

As a safety net, at every snapshot the tracked set is compared with the real file tree
(`git ls-tree`), and any mismatch is reconciled and counted. On all 12 evaluation repositories the
count was 0.

### Monthly snapshots and static metrics

For every calendar month, the snapshot is the tree at the last commit of that month. Quiet months
repeat the previous state, so the time slider is continuous.

Static metrics come from **lizard**:

| metric | meaning |
|---|---|
| `loc` | NLOC: lines of code without blanks and comments |
| `ccn_total` | sum of McCabe cyclomatic complexity over all functions |
| `ccn_max` | complexity of the most complex function |
| `nfuncs` | number of functions/methods |

**Incremental updates.** A metric only depends on the file's content, so results are cached by the
git *blob hash*. A snapshot only runs lizard on blobs never seen before, so unchanged files are never
re-parsed. Analysis is parallelised across processes.

**Java uses tree-sitter for complexity.** lizard's Java parser silently stops in the middle of some
files, for example after a local-variable annotation followed by a line break. `experiments/check_lizard_coverage.py`
measured this on the files with at least 200 NLOC: 11 of 131 truncated in Commons Lang, 12 of 58 in Gson,
and 0 of 56 in jsoup. tree-sitter builds a full syntax tree, so for Java we count McCabe decision points
on it (`if`, `for`, `while`, `do`, `catch`, `case`, `?:`, `&&`, `||`). On files lizard parses completely,
the two agree within 5% for 116/120 (Commons Lang), 54/56 (jsoup) and 35/46 (Gson) files. LOC still comes
from lizard for every language.

**Source filter.** Only files with a source extension are analysed. Paths containing `node_modules`,
`vendor`, `dist`, `build`, `min`, `third_party` ..., and files like `*.min.js`, `*.d.ts`, `*_pb2.py`
are excluded. Both lists are in `backend/repocity/config.py`.

---

## 2. Finding bug-fix commits

**Code:** `backend/repocity/szz/bugfix.py`, config `experiments/configs/bugfix.yaml`

There is no issue tracker in the loop (no GitHub API), so bug fixes are recognised from commit
messages, as in Mockus & Votta (2000) and the original SZZ paper:

1. A message is a candidate if it contains a keyword as a **whole word**: `fix`, `bug`, `defect`,
   `error`, `crash`, `fault`, `patch`, `resolve(s|d)`, `regression`, `issue #123`, `NPE`, `wrong` ...
   Whole-word matching means `prefix` or `suffix` never match `fix`.
2. **Exclusions** remove well-known false positives *before* matching: "fix typo", "fix docs",
   "fix the build", "fix Checkstyle warnings", "fix lint errors", "resolve merge conflicts",
   "error messages" ... An exclusion only removes its own span, so "Fix typo and fix crash" is still a fix.
3. **Vetoes** reject the whole message: Conventional-Commit types that are not fixes (`docs:`, `chore:`,
   `test:`, `refactor:` ...) and dependency bumps (`fix(deps): ...`, `Bump x from 1.2 to 1.3`).

**Merges.** A merge commit's first line is boilerplate ("Merge pull request #12 from user/branch"), so it
is never used. A merge counts as a bug fix if the pull-request title in its body is a fix, or if any
commit it brings into the main branch is a fix. The integrated commits are found by walking from the
merge's second parent until reaching a commit already on the main line.

**Mass fixes are not bug fixes.** A "fix" commit that touches more than 50 files is almost always
reformatting, a tooling migration or a licence-header change ("feat: implement prettier and fix all
issues", 149 files). Such commits do not count as bug fixes for labels or features (`max_fix_commit_files`).
The same threshold is used by the SZZ large-commit filter below.

**Measuring the heuristic.** `python experiments/spotcheck_bugfix.py sample` draws 100 commits from
Flask and Commons Lang (half flagged as fixes, half not, in shuffled order) into
`experiments/spotcheck/bugfix_spotcheck.csv`. You label them by hand; `run_all.py` then reports precision
with a 95% Wilson confidence interval (experiment E6).

---

## 3. SZZ: where were the bugs born?

**Code:** `backend/repocity/szz/szz.py`

**B-SZZ** (Śliwerski, Zimmermann & Zeller, "When do changes induce fixes?", MSR 2005):

1. Take a bug-fix commit `F` and its (first) parent `P`.
2. Compute the diff `P → F`. The lines `F` *deletes or modifies* are the lines that were wrong (a
   modification appears as a deletion plus an addition, so the deleted side is used).
3. Run `git blame` on those line numbers in `P`. The commit that last touched each line is a
   **bug-introducing candidate**.

```
P (parent of the fix)                  F (the fix)
line 6:  return y * 3   <- blame says commit c2     ->   return y * 2
=> c2 introduced the bug fixed by F
```

`git blame` follows file renames, so a bug introduced in `app.py` and fixed in `core.py` is still found
(this exact case is in the test suite).

**Improvements** (each can be switched off; experiment E5 compares them):

| improvement | what it does | source |
|---|---|---|
| whitespace / comments | ignore deleted lines that are blank or comment-only; blame with `git blame -w` so a pure re-indentation does not "steal" the line | Kim et al., ASE 2006 |
| large commits | skip fix commits touching more than 50 files and discard candidates that touched more than 50 files (refactorings, merges, licence updates) | Kim et al. 2006; da Costa et al., TSE 2017 |
| issue date | discard candidates committed after the bug report was filed | Śliwerski et al. 2005; MA-SZZ (da Costa et al. 2017) |

The issue-date filter needs report dates from an issue tracker. RepoCity deliberately uses no
external APIs, so it is implemented but only active when a mapping is supplied. In E5 it is reported as
"not applicable".

**Limitations** (also in the report's Threats to Validity): fixes that only *add* code (a missing null
check) give B-SZZ nothing to blame; the last change to a line is not necessarily the one that caused the
bug; tangled fix commits contain unrelated changes.

**Where SZZ is used:** as a feature (number of bug-introducing commits per file), and in the timeline,
where buildings flash red in the month a bug was born.

---

## 4. The prediction task (and why there is no leakage)

**Code:** `backend/repocity/models/features.py`, `models/train.py`

Pick a **cutoff month T**:

* **features** use only data up to the end of T;
* the **label** of a file is 1 if a bug-fix commit modifies it in the six months after T, `(T, T + 6m]`;
* only files that exist at T are included. Identities follow renames, so a file renamed after T keeps its label.

**No leakage, by construction:** process features are computed from the prefix of the time-sorted
change table, and static features from the snapshot of month T. One subtle trap is SZZ: a fix in 2024 can
point back to a bug introduced in 2020. Counting that 2020 commit in features at T = 2022 would reveal the
future. So a file's SZZ count at T only uses links whose **fix** happened before T.

The tests prove this in two ways (`tests/test_features.py`):

* features at T computed from the full history equal features computed from a copy of the repository
  **truncated at T**;
* multiplying all churn after T by 100 and marking every later commit as a bug fix leaves features at
  T unchanged.

**Training without looking ahead.** To predict at T, the model trains on past windows
`T' = T-6m, T-12m, T-18m`. Each window's labels come from `(T', T'+6m]`, which ends at or before T.

### Features (20, in 7 groups)

| group | features |
|---|---|
| size | LOC |
| complexity | total CCN, max CCN, number of functions |
| churn | lines added+deleted in the last 3 / 6 / 12 months, commits in the last 12 months |
| people | commits (all time), distinct authors, main author's share of commits (ownership) |
| history | file age, days since last change, past bug fixes (all time, last 12 months), SZZ bug-introducing commits |
| coupling | number of files it changed together with in at least 3 commits over the last 24 months (commits touching more than 30 files are ignored) |
| directory | files in its directory, the directory's bug fixes and churn in the last 12 months |

### Models

* **Logistic regression**: features are log-transformed and standardised, L2 regularisation, and
  `class_weight="balanced"` (bug-fixed files are the minority). Easy to explain: one weight per feature.
* **LightGBM** (gradient-boosted decision trees): 150 small trees (15 leaves), learning rate 0.05,
  `class_weight="balanced"`, fixed seed, `deterministic=True`. Captures non-linear effects and
  interactions.

**Explanations.** For every file, TreeSHAP (Lundberg et al., 2020) splits LightGBM's prediction into one
contribution per feature, measured in log-odds. The UI shows the three largest as "why risky?" bars (red
raises risk, green lowers it).

### Baselines

| baseline | ranking |
|---|---|
| Random | a seeded random order |
| LOC | bigger files first |
| Recent churn | most lines changed in the last 6 months first |
| Hotspot | normalised 12-month revisions × normalised complexity (CodeScene; Tornhill, *Your Code as a Crime Scene*, 2015) |
| FixCache | the BugCache algorithm (Kim, Zimmermann, Whitehead & Zeller, ICSE 2007), see below |
| ManualUp *(extra)* | smallest files first. The classic effort-aware reference (Mende & Koschke 2010), added because effort-aware results cannot be judged without it |

### FixCache (Kim et al. 2007)

**Code:** `backend/repocity/models/fixcache.py`

Idea: bugs are *local*. FixCache keeps a cache of 10% of the files and replays history commit by commit:

* **pre-load**: start with the largest files;
* on every bug-fix commit, each touched file is a **hit** if it is in the cache, otherwise a **miss**. On a
  miss the file is loaded (*temporal locality*), together with the `block size` files that most often
  changed with it (*spatial locality*);
* on every commit, up to `prefetch size` new or changed files are loaded (*new-entity* and
  *changed-entity locality*);
* when the cache is full, the least recently used file is evicted (LRU).

At cutoff T the cache contents are the prediction. To get a full ranking, cached files are ordered by
recency and every other file scores 0.

---

## 5. Evaluation metrics

**Code:** `backend/repocity/models/evaluation.py`

| metric | question it answers |
|---|---|
| ROC-AUC | Pick one fixed and one not-fixed file at random: how often is the fixed one ranked higher? (0.5 = random) |
| PR-AUC | Average precision over all cut-offs. More informative than ROC-AUC when positives are rare. |
| Precision@k | Of the k top-ranked files, what share was really fixed? (k = 10, 20) |
| Recall@20%LOC | Read files in ranked order until 20% of all code has been read. What share of the fixed files did you find? |
| Popt | Area under the "% fixed files found vs % LOC read" curve, normalised between the worst (0) and the optimal (1) ordering (Mende & Koschke 2009) |

**Effort-aware ranking.** Recall@20%LOC and Popt charge every file by its size. A risk model naturally puts
big files first (they have more room for bugs) and spends the 20% budget on a few huge files. Following
Mende & Koschke (2010) and Kamei et al. (2013), we therefore also report both metrics for the ordering by
**risk per line** (`score / LOC`, suffix "risk/LOC"). Both orderings are always reported, since the
choice changes the conclusion.

**Ties.** Coarse scores (FixCache's in/out of cache, a 0 churn) produce ties. They are broken by one fixed
pseudo-random order, the same for every method, so file order in the input never favours anyone.

**Statistics (E2).** Each (repository, cutoff) pair is one paired observation. The Wilcoxon signed-rank test
compares LightGBM with the best baseline (Holm-corrected across metrics). Cliff's δ gives the effect size,
with Romano et al.'s thresholds: |δ| < 0.147 negligible, < 0.33 small, < 0.474 medium, otherwise large. A
rank table gives each method's mean rank per metric, with a Friedman test and the Nemenyi critical
difference (Demšar 2006).

---

## 6. The city layout

**Code:** `backend/repocity/layout/treemap.py`

### Squarified treemap (Bruls, Huizing & van Wijk, 2000)

A treemap splits a rectangle into smaller rectangles whose **areas are proportional to weights**. The
*squarified* variant keeps them close to squares (good building lots):

1. Sort the items by decreasing weight.
2. Place items in a row along the shorter side of the free space. Add the next item to the row only if
   that does **not** worsen the row's worst aspect ratio.
3. Otherwise freeze the row, shrink the free rectangle, and start a new row.

Directories are laid out recursively. Each directory rectangle is shrunk by a padding (the street) and its
files and sub-directories are laid out inside it. These directory rectangles are the **districts**, drawn as
slightly raised plates. Chains of single-child directories (`src/main/java/org/apache/commons/lang3`) are
merged into one district.

Property tests (`tests/test_treemap.py`, hypothesis) check that no two rectangles overlap, every file
stays inside its district, areas match the weights, and the layout does not depend on input order.

### Layout stability over time (the important trade-off)

If the treemap were recomputed every month, every new file would shift every other building: the city
would jump around as the slider moves. Instead the layout is computed **once** from the **union of all
files that ever existed**:

* each file identity owns a fixed lot for the whole history;
* the lot's weight is the file's **maximum** LOC over its lifetime, so it is big enough at every moment;
* in month *t* the building's footprint is `sqrt(LOC(t) / maxLOC)` of the lot side (area ∝ LOC), so files grow
  inside their lot;
* files that do not exist yet, or were deleted, are hidden (their lot stays empty).

**Costs of this choice:** early in history the city has empty lots where later files will appear, and a file
that moved between directories is drawn at its *latest* location for its whole life. In exchange, buildings
never jump, so growth, decay and hotspots can be followed by eye. This is the same reason CodeCity
(Wettel & Lanza 2007) keeps building positions stable across versions.

---

## 7. Rendering

**Code:** `frontend/src/city/*`

* **One draw call for all buildings.** A single `THREE.InstancedMesh` holds every building. Per-instance
  4×4 matrices (position + scale) and colours are written straight into typed arrays, with no JavaScript object
  per building.
* **Animation.** Every frame, each building's height, footprint and colour move a fraction
  `1 − e^(−rate·dt)` of the way to their targets (exponential smoothing). The step is frame-rate independent,
  and after the last change the update loop goes idle.
* **Picking.** three.js ray-casts against the instanced mesh and returns the instance id under the mouse.
* **Labels** are DOM elements positioned by projecting the district centres each frame. Their opacity
  depends on the district's size on screen, so labels fade in as you zoom towards a district and fade out
  when it fills the screen.
* **Adaptive quality.** If the frame rate keeps falling, shadows are switched off and the pixel ratio drops
  to 1 (drei `PerformanceMonitor`).
