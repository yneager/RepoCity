"""Central configuration for RepoCity.

Everything that changes analysis results lives here (or in the YAML files under
``experiments/configs``) so that runs are reproducible. Environment variables only
control *where* things are stored and safety limits for the web API.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

SEED = 42


def _env_path(name: str, default: Path) -> Path:
    value = os.environ.get(name)
    return Path(value).resolve() if value else default


DATA_DIR = _env_path("REPOCITY_DATA_DIR", REPO_ROOT / "data")
DEMO_DIR = _env_path("REPOCITY_DEMO_DIR", REPO_ROOT / "demo" / "cache")

# Safety limits for user-submitted analyses (the experiment runner ignores them).
MAX_COMMITS = int(os.environ.get("REPOCITY_MAX_COMMITS", "30000"))
MAX_REPO_MB = int(os.environ.get("REPOCITY_MAX_REPO_MB", "1500"))
CLONE_TIMEOUT_S = int(os.environ.get("REPOCITY_CLONE_TIMEOUT", "900"))
HUGE_REPO_WARN_COMMITS = 15000

# Source-file filter (Section 4.1). Extensions supported by lizard.
SOURCE_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".py", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".java", ".kt", ".kts", ".scala",
        ".go", ".rb", ".php", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".cs",
        ".swift", ".rs", ".m", ".mm", ".lua", ".erl", ".sol", ".zig", ".pl", ".pm",
    }
)
# Any path segment equal to one of these excludes the file (vendored / generated / build output).
EXCLUDED_DIRS: frozenset[str] = frozenset(
    {
        "node_modules", "vendor", "vendors", "third_party", "third-party", "thirdparty", "dist",
        "build", "bower_components", "min", ".git", "site-packages", "__pycache__", "external",
        "generated", "gen",
    }
)
# File-name suffixes that mark minified / generated / lock files.
EXCLUDED_SUFFIXES: tuple[str, ...] = (
    ".min.js", "-min.js", ".bundle.js", ".min.mjs", "_pb2.py", "_pb2_grpc.py", ".pb.go",
    ".generated.ts", ".generated.js", ".d.ts", "package-lock.json", "yarn.lock",
)
MAX_ANALYSED_BLOB_BYTES = 1_000_000  # larger files are counted by lines only (likely generated)


@dataclass(frozen=True)
class SZZConfig:
    """Switches for the SZZ improvements (each one can be ablated, Section 4.3)."""

    ignore_whitespace_comments: bool = True
    ignore_large_commits: bool = True
    large_commit_files: int = 50
    use_issue_dates: bool = False  # needs an issue-tracker export; see docs/algorithms.md

    @property
    def name(self) -> str:
        if not (self.ignore_whitespace_comments or self.ignore_large_commits):
            return "B-SZZ"
        parts = []
        if self.ignore_whitespace_comments:
            parts.append("ws")
        if self.ignore_large_commits:
            parts.append("large")
        return "B-SZZ+" + "+".join(parts)


@dataclass(frozen=True)
class ModelConfig:
    horizon_months: int = 6  # label window (T, T + horizon]
    train_windows: int = 3  # number of past windows (T-6m, T-12m, ...) used for training
    min_history_months: int = 6  # a training cutoff needs at least this much history before it
    app_cutoff_step_months: int = 3  # spacing of risk predictions shown in the app
    eval_cutoff_step_months: int = 6  # spacing of evaluation cutoffs (E1)
    eval_cutoff_count: int = 6  # 6 cutoffs x 6 months = the last 3 years
    fixcache_ratio: float = 0.10  # FixCache cache size = 10% of files
    coupling_min_cochanges: int = 3
    coupling_max_commit_files: int = 30
    coupling_window_months: int = 24
    seed: int = SEED


@dataclass(frozen=True)
class AnalysisConfig:
    szz: SZZConfig = field(default_factory=SZZConfig)
    model: ModelConfig = field(default_factory=ModelConfig)
    workers: int = max(2, min(8, (os.cpu_count() or 4)))
