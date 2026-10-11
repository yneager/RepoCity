"""Analysis jobs: a registry of analyses, a background worker and progress events.

An analysis is identified by ``<owner>-<repo>-<head[:8]>``, so the cache key is
"URL + HEAD commit": submitting a URL whose HEAD has not moved returns the existing
analysis immediately. Finished analyses are bundles on disk (see
:mod:`repocity.pipeline.export`) and are re-discovered at start-up, including the
pre-analysed demo bundles in ``demo/cache``.
"""

from __future__ import annotations

import re
import shutil
import threading
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path

from repocity import config
from repocity.ingest.gitutil import GitError, clone, remote_head, repo_size_mb, run_git, validate_url
from repocity.pipeline.analyze import STEPS, ingest, make_predictor
from repocity.pipeline.export import export_bundle, read_json
from repocity.store.db import Store

ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,120}$")
STEP_WEIGHTS = {"clone": 0.15, "history": 0.15, "snapshots": 0.2, "szz": 0.2, "model": 0.2, "layout": 0.1}


def slugify(url: str, head: str) -> str:
    path = url.rstrip("/").removesuffix(".git").split("://", 1)[-1].split("/", 1)[-1]
    slug = re.sub(r"[^a-z0-9]+", "-", path.lower()).strip("-")[:80] or "repo"
    return f"{slug}-{head[:8]}"


@dataclass
class Job:
    id: str
    url: str | None
    name: str
    status: str = "queued"  # queued | running | done | error
    bundle: Path | None = None
    events: list[dict] = field(default_factory=list)
    error: str | None = None
    warnings: list[str] = field(default_factory=list)
    created: float = field(default_factory=time.time)
    demo: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def emit(self, step: str, step_progress: float, message: str, kind: str = "progress") -> None:
        done_before = sum(STEP_WEIGHTS[s] for s in STEPS[: STEPS.index(step)]) if step in STEPS else 0.0
        overall = done_before + STEP_WEIGHTS.get(step, 0.0) * max(0.0, min(1.0, step_progress))
        if kind == "done":
            overall = 1.0
        with self.lock:
            self.events.append(
                {
                    "seq": len(self.events),
                    "kind": kind,
                    "step": step,
                    "stepProgress": round(step_progress, 3),
                    "progress": round(overall, 3),
                    "message": message,
                    "time": time.time(),
                }
            )

    def summary(self) -> dict:
        last = self.events[-1] if self.events else None
        return {
            "id": self.id,
            "url": self.url,
            "name": self.name,
            "status": self.status,
            "error": self.error,
            "warnings": self.warnings,
            "progress": last["progress"] if last else 0.0,
            "demo": self.demo,
        }


class JobManager:
    def __init__(self, data_dir: Path | None = None, demo_dir: Path | None = None):
        self.data_dir = data_dir or config.DATA_DIR
        self.demo_dir = demo_dir or config.DEMO_DIR
        self.jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._run_lock = threading.Semaphore(1)  # analyses are CPU/disk heavy: one at a time
        self.discover()

    # ---- discovery ------------------------------------------------------------------
    def discover(self) -> None:
        for base, demo in ((self.demo_dir, True), (self.data_dir / "analyses", False)):
            if not base.exists():
                continue
            for d in sorted(base.iterdir()):
                bundle = d if demo else d / "bundle"
                meta_path = bundle / "meta.json.gz"
                if meta_path.exists() and ID_RE.match(d.name):
                    meta = read_json(meta_path)
                    job = Job(d.name, meta.get("url"), meta.get("name", d.name), status="done", bundle=bundle, demo=demo)
                    job.emit("layout", 1.0, "Loaded from cache", kind="done")
                    self.jobs.setdefault(d.name, job)

    def demos(self) -> list[dict]:
        out = []
        for job in self.jobs.values():
            if job.demo and job.bundle:
                m = read_json(job.bundle / "meta.json.gz")
                out.append(
                    {
                        "id": job.id,
                        "name": m["name"],
                        "url": m.get("url"),
                        "nCommits": m["nCommits"],
                        "nFiles": m["nFiles"],
                        "firstMonth": m["months"][0],
                        "lastMonth": m["months"][-1],
                        "language": m.get("language"),
                        "description": m.get("description"),
                    }
                )
        return sorted(out, key=lambda d: d["name"])

    def get(self, job_id: str) -> Job | None:
        if not ID_RE.match(job_id):
            return None
        return self.jobs.get(job_id)

    # ---- submission ------------------------------------------------------------------
    def submit(self, url: str) -> Job:
        url = validate_url(url)
        head = remote_head(url)  # raises GitError for missing / private repositories
        job_id = slugify(url, head)
        with self._lock:
            existing = self.jobs.get(job_id)
            if existing and existing.status in ("queued", "running", "done"):
                return existing
            name = url.rstrip("/").removesuffix(".git").split("/", 3)[-1]
            job = Job(job_id, url, name)
            self.jobs[job_id] = job
        threading.Thread(target=self._run, args=(job, head), daemon=True).start()
        return job

    def _run(self, job: Job, head: str) -> None:
        job.emit("clone", 0.0, "Queued")
        with self._run_lock:
            job.status = "running"
            work = self.data_dir / "analyses" / job.id
            clone_dir = self.data_dir / "clones" / job.id
            try:
                self._analyse(job, head, work, clone_dir)
                job.status = "done"
                job.emit("layout", 1.0, "Analysis complete", kind="done")
            except Exception as exc:  # report every failure to the client
                job.status = "error"
                job.error = str(exc) if isinstance(exc, (GitError, ValueError)) else f"{type(exc).__name__}: {exc}"
                job.emit("clone", 0.0, job.error, kind="error")
                traceback.print_exc()
            finally:
                shutil.rmtree(clone_dir, ignore_errors=True)

    def _analyse(self, job: Job, head: str, work: Path, clone_dir: Path) -> None:
        assert job.url
        job.emit("clone", 0.05, f"Cloning {job.url}")
        clone(job.url, clone_dir, timeout=config.CLONE_TIMEOUT_S)
        size = repo_size_mb(clone_dir)
        if size > config.MAX_REPO_MB:
            raise ValueError(f"Repository is too large ({size:.0f} MB > {config.MAX_REPO_MB} MB limit)")
        n = int(run_git(clone_dir, ["rev-list", "--count", "--first-parent", head]).strip())
        if n > config.MAX_COMMITS:
            raise ValueError(f"Repository has {n} first-parent commits; the limit is {config.MAX_COMMITS}")
        if n > config.HUGE_REPO_WARN_COMMITS:
            job.warnings.append(f"Large repository ({n} commits): analysis may take several minutes.")
            job.emit("clone", 1.0, job.warnings[-1], kind="warning")
        job.emit("clone", 1.0, f"Cloned ({size:.0f} MB, {n} first-parent commits)")
        work.mkdir(parents=True, exist_ok=True)
        store_path = work / "store.duckdb"
        if store_path.exists():
            store_path.unlink()
        ingest(clone_dir, store_path, head, szz_modes=("w",), progress=job.emit)
        job.emit("model", 0.0, "Training models at each cutoff")
        with Store(store_path) as st:
            predictor = make_predictor(st)
        bundle = work / "bundle"
        shutil.rmtree(bundle, ignore_errors=True)
        export_bundle(
            predictor, bundle, repo_id=job.id, name=job.name, url=job.url, head=head,
            progress=job.emit, extra_meta={"warnings": job.warnings},
        )
        job.bundle = bundle
