"""Analysis worker process: ``python -m repocity.pipeline.worker '<json args>'``.

The API clones the repository itself and then runs the heavy part of every analysis
(history, snapshots, SZZ, models, layout, export) in a separate process, not in a thread
of the web server: memory is returned to the OS when the analysis ends, a crash cannot
take the server down, and the metric process pool works identically on Windows (spawn)
and Linux. Progress is reported as one JSON object per line on stdout:

    {"kind": "progress", "step": "szz", "f": 0.4, "message": "..."}
    {"kind": "result", "bundle": "..."}
    {"kind": "fatal", "message": "..."}
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path


def emit(step: str, f: float, message: str, kind: str = "progress") -> None:
    print(json.dumps({"kind": kind, "step": step, "f": f, "message": message}), flush=True)


def main(args: dict) -> None:
    from repocity.pipeline.analyze import ingest, make_predictor
    from repocity.pipeline.export import export_bundle
    from repocity.store.db import Store

    work, clone_dir = Path(args["work"]), Path(args["clone_dir"])
    work.mkdir(parents=True, exist_ok=True)
    store_path = work / "store.duckdb"
    if store_path.exists():
        store_path.unlink()
    ingest(clone_dir, store_path, args["head"], szz_modes=("w",), progress=emit)
    emit("model", 0.0, "Training models at each cutoff")
    with Store(store_path) as st:
        predictor = make_predictor(st)
    bundle = work / "bundle"
    shutil.rmtree(bundle, ignore_errors=True)
    export_bundle(predictor, bundle, repo_id=args["id"], name=args["name"], url=args["url"], head=args["head"],
                  progress=emit, extra_meta={"warnings": args.get("warnings", [])})
    print(json.dumps({"kind": "result", "bundle": str(bundle)}), flush=True)


if __name__ == "__main__":
    try:
        main(json.loads(sys.argv[1]))
    except Exception as exc:  # reported to the API as a failed analysis
        print(json.dumps({"kind": "fatal", "message": f"{type(exc).__name__}: {exc}"}), flush=True)
        raise
