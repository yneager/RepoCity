"""Shared helpers for the experiment scripts: configuration, clones, stores, ingestion."""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import psutil
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from repocity.config import AnalysisConfig, ModelConfig, SZZConfig  # noqa: E402
from repocity.ingest.gitutil import run_git  # noqa: E402

CONFIGS = ROOT / "experiments" / "configs"
CLONES = ROOT / "data" / "clones"
STORES = ROOT / "data" / "stores"
REPORTS = ROOT / "reports"
TABLES = REPORTS / "tables"
FIGURES = REPORTS / "figures"
RESULTS = REPORTS / "results"  # raw CSV/JSON results behind every table and figure


@dataclass(frozen=True)
class RepoSpec:
    name: str
    url: str
    commit: str
    language: str
    license: str

    @property
    def clone_dir(self) -> Path:
        slug = self.url.rstrip("/").split("github.com/")[-1].replace("/", "_")
        return CLONES / slug

    @property
    def store(self) -> Path:
        return STORES / f"{self.name}.duckdb"


def load_repos(only: list[str] | None = None) -> list[RepoSpec]:
    data = yaml.safe_load((CONFIGS / "repos.yaml").read_text())
    repos = [RepoSpec(**r) for r in data["repos"]]
    return [r for r in repos if not only or r.name in only]


def load_experiment() -> dict:
    return yaml.safe_load((CONFIGS / "experiment.yaml").read_text())


def model_config(exp: dict) -> ModelConfig:
    return ModelConfig(
        horizon_months=exp["horizon_months"],
        train_windows=exp["train_windows"],
        eval_cutoff_step_months=exp["eval_cutoff_step_months"],
        eval_cutoff_count=exp["eval_cutoff_count"],
        seed=exp["seed"],
        max_fix_commit_files=exp["max_fix_commit_files"],
    )


def analysis_config(exp: dict) -> AnalysisConfig:
    return AnalysisConfig(szz=SZZConfig(large_commit_files=exp["szz_large_commit_files"]), model=model_config(exp))


def ensure_clone(repo: RepoSpec) -> None:
    """Clone once (full history, no checkout) and make sure the pinned commit is present."""
    if not (repo.clone_dir / ".git").exists() and not (repo.clone_dir / "HEAD").exists():
        repo.clone_dir.parent.mkdir(parents=True, exist_ok=True)
        print(f"  cloning {repo.url}", flush=True)
        subprocess.run(["git", "clone", "-q", "--no-checkout", repo.url, str(repo.clone_dir)], check=True)
    try:
        run_git(repo.clone_dir, ["cat-file", "-e", f"{repo.commit}^{{commit}}"])
    except Exception:
        subprocess.run(["git", "-C", str(repo.clone_dir), "fetch", "-q", "origin"], check=True)
        run_git(repo.clone_dir, ["cat-file", "-e", f"{repo.commit}^{{commit}}"])


def ingest_measured(repo: RepoSpec) -> dict:
    """Run ingestion in a child process; returns timings, peak memory and repo size."""
    STORES.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, str(ROOT / "experiments" / "ingest_one.py"), repo.name]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True)
    peak = 0
    stop = threading.Event()

    def sample() -> None:
        nonlocal peak
        p = psutil.Process(proc.pid)
        while not stop.is_set():
            try:
                rss = p.memory_info().rss + sum(c.memory_info().rss for c in p.children(recursive=True))
                peak = max(peak, rss)
            except psutil.Error:
                pass
            time.sleep(0.1)

    t = threading.Thread(target=sample, daemon=True)
    t.start()
    t0 = time.perf_counter()
    out, _ = proc.communicate()
    wall = time.perf_counter() - t0
    stop.set()
    t.join()
    if proc.returncode != 0:
        raise RuntimeError(f"ingestion of {repo.name} failed")
    result = json.loads(out.strip().splitlines()[-1])
    result.update({"wall_seconds": wall, "peak_rss_mb": peak / 1e6})
    return result
