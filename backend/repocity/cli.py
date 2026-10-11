"""Command line entry points.

    python -m repocity.cli serve [--port 8000]
    python -m repocity.cli bundle --repo PATH --url URL --rev HASH --out DIR [--store FILE]
"""

from __future__ import annotations

import argparse
from pathlib import Path

from repocity.api.jobs import slugify
from repocity.pipeline.analyze import ingest, make_predictor
from repocity.pipeline.export import export_bundle
from repocity.store.db import Store


def build_bundle(repo: Path, url: str, rev: str, out: Path | None, store: Path | None, name: str | None = None,
                 extra_meta: dict | None = None, reuse_store: bool = True) -> Path:
    head = rev
    repo_id = slugify(url, head)
    out = out or Path("demo/cache") / repo_id
    store = store or Path("data/stores") / f"{repo.name}.duckdb"
    if not (reuse_store and store.exists()):
        ingest(repo, store, rev, progress=lambda s, f, m: print(f"[{s}] {m}") if f in (0.0, 1.0) else None)
    with Store(store) as st:
        predictor = make_predictor(st)
    export_bundle(
        predictor, out, repo_id=repo_id, name=name or url.rstrip("/").split("/", 3)[-1], url=url, head=head,
        extra_meta=extra_meta,
    )
    print(f"bundle written to {out}")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(prog="repocity")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8000)
    b = sub.add_parser("bundle")
    b.add_argument("--repo", type=Path, required=True)
    b.add_argument("--url", required=True)
    b.add_argument("--rev", required=True)
    b.add_argument("--out", type=Path)
    b.add_argument("--store", type=Path)
    args = ap.parse_args()
    if args.cmd == "serve":
        import uvicorn

        uvicorn.run("repocity.api.app:app", host=args.host, port=args.port)
    else:
        build_bundle(args.repo, args.url, args.rev, args.out, args.store)


if __name__ == "__main__":
    main()
