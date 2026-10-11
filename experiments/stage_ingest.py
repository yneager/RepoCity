"""Stage 1: clone (once) and ingest every repository; records timings and peak memory (used by E7)."""

from __future__ import annotations

import json

from common import RESULTS, ensure_clone, ingest_measured, load_repos


def run(only: list[str] | None = None, reuse: bool = False) -> list[dict]:
    RESULTS.mkdir(parents=True, exist_ok=True)
    path = RESULTS / "ingest.json"
    previous = {r["repo"]: r for r in json.loads(path.read_text())} if path.exists() else {}
    results = []
    for repo in load_repos(only):
        ensure_clone(repo)
        if reuse and repo.store.exists() and repo.name in previous:
            print(f"  {repo.name}: reusing existing store", flush=True)
            results.append(previous[repo.name])
            continue
        print(f"  ingesting {repo.name} @ {repo.commit[:10]}", flush=True)
        r = ingest_measured(repo)
        print(f"    {r['commits']} commits, {r['files_last']} files, {r['bugfix_commits']} fixes, "
              f"{r['wall_seconds']:.0f}s, peak {r['peak_rss_mb']:.0f} MB", flush=True)
        results.append(r)
        previous[repo.name] = r
        path.write_text(json.dumps(sorted(previous.values(), key=lambda x: x["repo"]), indent=1))
    return results


if __name__ == "__main__":
    import sys

    run(sys.argv[1:] or None)
