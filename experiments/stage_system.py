"""E7: system performance.

* analysis time and peak memory vs repository size (from the ingestion stage, plus the
  model/export time measured here for every repository);
* API latency of the bundle endpoints (real HTTP against a uvicorn subprocess);
* frontend FPS vs number of buildings, measured in Chromium through Playwright with
  ``requestAnimationFrame`` counts on the synthetic benchmark city (``/#/bench/N``).
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from common import RESULTS, ROOT, load_experiment, load_repos, model_config  # noqa: E402
from repocity.models.train import Predictor  # noqa: E402
from repocity.pipeline.analyze import load_repo_data  # noqa: E402
from repocity.pipeline.export import export_bundle  # noqa: E402
from repocity.store.db import Store  # noqa: E402
from stage_report import COLORS, INK, INK2, save, write_table  # noqa: E402

FRONTEND = ROOT / "frontend"
NPM = "npm.cmd" if os.name == "nt" else "npm"
NPX = "npx.cmd" if os.name == "nt" else "npx"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_http(url: str, timeout: float = 60) -> None:
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if httpx.get(url, timeout=2).status_code < 500:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.3)
    raise TimeoutError(url)


def model_export_times(only=None) -> pd.DataFrame:
    exp = load_experiment()
    rows = []
    for repo in load_repos(only):
        tmp = Path(tempfile.mkdtemp())
        t0 = time.perf_counter()
        with Store(repo.store, read_only=True) as st:
            predictor = Predictor(load_repo_data(st, None, model_config(exp).max_fix_commit_files), model_config(exp))
        export_bundle(predictor, tmp / "b", repo_id="x", name=repo.name, url=repo.url, head=repo.commit)
        rows.append({"repo": repo.name, "model_export_seconds": time.perf_counter() - t0, "cutoffs": len(predictor.app_cutoffs())})
        shutil.rmtree(tmp, ignore_errors=True)
        print(f"  E7 model+export {repo.name}: {rows[-1]['model_export_seconds']:.0f}s", flush=True)
    return pd.DataFrame(rows)


def api_latency(n: int = 60) -> pd.DataFrame:
    port = free_port()
    env = {**os.environ, "REPOCITY_DEMO_DIR": str(ROOT / "demo" / "cache"), "REPOCITY_DATA_DIR": tempfile.mkdtemp()}
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "repocity.api.app:app", "--port", str(port), "--log-level", "warning"],
        cwd=ROOT / "backend", env=env,
    )
    rows = []
    try:
        base = f"http://127.0.0.1:{port}"
        wait_http(f"{base}/api/health")
        demos = httpx.get(f"{base}/api/demo").json()
        with httpx.Client(base_url=base) as c:
            for d in demos:
                meta = c.get(f"/api/analyses/{d['id']}/meta").json()
                last = meta["months"][-1]
                cut = next(x["cutoff"] for x in reversed(meta["cutoffs"]) if x["hasLabels"])
                lay = c.get(f"/api/analyses/{d['id']}/layout").json()
                fid = lay["files"]["id"][len(lay["files"]["id"]) // 2]
                for label, path in [
                    ("GET /demo", "/api/demo"),
                    ("GET meta", f"/api/analyses/{d['id']}/meta"),
                    ("GET layout", f"/api/analyses/{d['id']}/layout"),
                    ("GET snapshot", f"/api/analyses/{d['id']}/snapshots/{last}"),
                    ("GET predictions", f"/api/analyses/{d['id']}/predictions?cutoff={cut}"),
                    ("GET file detail", f"/api/analyses/{d['id']}/files/{fid}"),
                ]:
                    times = []
                    for _ in range(n):
                        t0 = time.perf_counter()
                        r = c.get(path)
                        r.raise_for_status()
                        times.append((time.perf_counter() - t0) * 1000)
                    rows.append({"repo": d["name"], "endpoint": label, "p50_ms": float(np.percentile(times, 50)),
                                 "p95_ms": float(np.percentile(times, 95)), "bytes": len(r.content)})
    finally:
        proc.terminate()
        proc.wait(timeout=20)
    return pd.DataFrame(rows)


FPS_CONFIGS = {
    # name: environment for e2e/fps-bench.mjs
    "gpu": {},  # hardware WebGL, vsync on: what a user sees
    "gpu_uncapped": {"FPS_UNCAPPED": "1"},  # hardware WebGL without the 60 Hz cap: shows headroom
    "software": {"FPS_RENDERER": "swiftshader"},  # CPU-only rendering: lower bound for machines without a usable GPU
}


def fps_benchmark(counts: list[int]) -> dict:
    """Build the frontend, serve it with `vite preview`, and run the Playwright FPS script per renderer."""
    if shutil.which(NPM) is None:
        return {"status": "skipped", "reason": "npm not found"}
    subprocess.run([NPM, "run", "build"], cwd=FRONTEND, check=True, capture_output=True)
    port = free_port()
    server = subprocess.Popen([NPX, "vite", "preview", "--port", str(port), "--strictPort"], cwd=FRONTEND,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    out: dict = {"status": "ok", "configs": {}}
    try:
        wait_http(f"http://127.0.0.1:{port}/")
        for name, env in FPS_CONFIGS.items():
            path = RESULTS / f"e7_fps_{name}.json"
            print(f"  FPS benchmark: {name}", flush=True)
            subprocess.run(["node", "e2e/fps-bench.mjs", f"http://127.0.0.1:{port}", str(path), *map(str, counts)],
                           cwd=FRONTEND, check=True, env={**os.environ, **env})
            out["configs"][name] = json.loads(path.read_text())
    finally:
        server.terminate()
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(server.pid)], capture_output=True)
    return out


def run(only=None, skip_fps: bool = False) -> dict:
    exp = load_experiment()
    ingest = pd.DataFrame(json.loads((RESULTS / "ingest.json").read_text()))
    if only:
        ingest = ingest[ingest.repo.isin(only)]
    me = model_export_times(only)
    perf = ingest.merge(me, on="repo")
    perf["total_seconds"] = perf["wall_seconds"] + perf["model_export_seconds"]
    perf.to_csv(RESULTS / "e7_analysis.csv", index=False)
    write_table(pd.DataFrame({
        "Repository": perf["repo"], "First-parent commits": perf["commits"], "Files (last month)": perf["files_last"],
        "File identities": perf["file_identities"], "Ingest (s)": perf["wall_seconds"].round(1),
        "Models + export (s)": perf["model_export_seconds"].round(1), "Total (s)": perf["total_seconds"].round(1),
        "Peak RSS (MB)": perf["peak_rss_mb"].round(0).astype(int),
    }), "e7_analysis", "E7 analysis time and peak memory (ingestion process tree incl. worker processes)")

    fig, axes = plt.subplots(1, 2, figsize=(10, 3.4))
    for ax, col, label in [(axes[0], "commits", "First-parent commits"), (axes[1], "file_identities", "File identities in history")]:
        ax.scatter(perf[col], perf["total_seconds"], s=36, color=COLORS["lightgbm"], zorder=3)
        for _, r in perf.iterrows():
            ax.annotate(r["repo"], (r[col], r["total_seconds"]), textcoords="offset points", xytext=(4, 3), fontsize=7.5, color=INK2)
        ax.set_xlabel(label)
        ax.set_ylabel("Full analysis time (s)")
    fig.suptitle("E7 analysis time vs repository size", fontsize=11, color=INK)
    fig.tight_layout()
    save(fig, "e7_scaling")

    lat = api_latency()
    lat.to_csv(RESULTS / "e7_api_latency.csv", index=False)
    lat_tab = lat.groupby("endpoint").agg(p50=("p50_ms", "median"), p95=("p95_ms", "max"), size=("bytes", "max")).reset_index()
    write_table(pd.DataFrame({"Endpoint": lat_tab["endpoint"], "p50 latency (ms)": lat_tab["p50"].round(1),
                              "p95 latency (ms, worst demo repo)": lat_tab["p95"].round(1), "Response size (KB, gzip)": (lat_tab["size"] / 1000).round(1)}),
                "e7_api_latency", "E7 API latency over 60 requests per endpoint and demo repository (localhost)")

    fps = {"status": "skipped"} if skip_fps else fps_benchmark(exp["fps_building_counts"])
    if fps.get("status") == "ok":
        cfgs = fps["configs"]
        counts = [r["buildings"] for r in cfgs["gpu"]["results"]]
        table = {"Buildings": counts}
        labels = {"gpu": "GPU, vsync", "gpu_uncapped": "GPU, uncapped", "software": "CPU only (SwiftShader)"}
        for name, cfg in cfgs.items():
            table[f"{labels[name]}: median FPS"] = [round(r["median_fps"], 1) for r in cfg["results"]]
        table["JS update per frame (ms)"] = [round(r["median_update_ms"] or 0, 2) for r in cfgs["gpu_uncapped"]["results"]]
        write_table(pd.DataFrame(table), "e7_fps",
                    f"E7 frontend FPS (median of 1 s samples over 8 s, all buildings animating). GPU = {cfgs['gpu']['renderer']}; "
                    f"{cfgs['gpu']['browser']}")
        fig, axes = plt.subplots(1, 2, figsize=(11, 3.4))
        ax = axes[0]
        for name, color in [("gpu", COLORS["lightgbm"]), ("software", COLORS["logreg"])]:
            ax.plot(counts, [r["median_fps"] for r in cfgs[name]["results"]], marker="o", color=color, linewidth=2, label=labels[name])
        ax.axhline(60, color=INK2, linewidth=0.8, linestyle="--")
        ax.axhline(30, color=INK2, linewidth=0.8, linestyle=":")
        ax.text(counts[-1], 61, "60 fps target", ha="right", va="bottom", fontsize=7.5, color=INK2)
        ax.text(counts[-1], 31, "30 fps usable", ha="right", va="bottom", fontsize=7.5, color=INK2)
        ax.set_ylim(0, 75)
        ax.set_xlabel("Buildings (animated)")
        ax.set_ylabel("Frames per second")
        ax.legend(loc="center right")
        ax.set_title("What the user sees")
        ax = axes[1]
        ax.plot(counts, [r["median_fps"] for r in cfgs["gpu_uncapped"]["results"]], marker="o", color=COLORS["lightgbm"], linewidth=2)
        ax.set_xlabel("Buildings (animated)")
        ax.set_ylabel("Frames per second (uncapped)")
        ax.set_yscale("log")
        ax.set_title("GPU headroom without the 60 Hz cap")
        fig.suptitle("E7 rendering performance", fontsize=11, color=INK)
        fig.tight_layout()
        save(fig, "e7_fps")
    summary = {"analysis": perf.to_dict("records"), "api": lat.to_dict("records"), "fps": fps}
    (RESULTS / "summary_system.json").write_text(json.dumps(summary, indent=1, default=float))
    return summary


if __name__ == "__main__":
    run(sys.argv[1:] or None)
