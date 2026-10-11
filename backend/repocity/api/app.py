"""FastAPI application (Section 6).

All analysis data is served from on-disk bundles of pre-gzipped JSON, so responses
are cheap: the bytes are sent as-is with ``Content-Encoding: gzip``.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections import Counter, OrderedDict
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from repocity.api.jobs import Job, JobManager
from repocity.ingest.gitutil import GitError
from repocity.pipeline.export import read_json
from repocity.timeutil import month_of

MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


class AnalysisRequest(BaseModel):
    url: str


def create_app(manager: JobManager | None = None) -> FastAPI:
    app = FastAPI(title="RepoCity API", version="1.0.0")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])
    jobs = manager or JobManager()
    app.state.jobs = jobs
    file_cache: OrderedDict[str, tuple[dict, dict]] = OrderedDict()

    def job_or_404(analysis_id: str) -> Job:
        job = jobs.get(analysis_id)
        if job is None:
            raise HTTPException(404, "Unknown analysis id")
        return job

    def bundle_of(analysis_id: str) -> Path:
        job = job_or_404(analysis_id)
        if job.status != "done" or job.bundle is None:
            raise HTTPException(409, f"Analysis is {job.status}")
        return job.bundle

    def gz(path: Path, request: Request | None = None) -> Response:
        if not path.exists():
            raise HTTPException(404, "Not found")
        st = path.stat()
        etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
        headers = {"ETag": etag, "Cache-Control": "no-cache", "Vary": "Accept-Encoding"}
        if request is not None and request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers=headers)
        return Response(
            content=path.read_bytes(),
            media_type="application/json",
            headers={**headers, "Content-Encoding": "gzip"},
        )

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok", "analyses": len(jobs.jobs)}

    @app.get("/api/demo")
    def demo() -> list[dict]:
        return jobs.demos()

    @app.post("/api/analyses", status_code=202)
    def start(req: AnalysisRequest) -> dict:
        try:
            job = jobs.submit(req.url)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except GitError as exc:
            raise HTTPException(400, str(exc)) from exc
        return job.summary()

    @app.get("/api/analyses")
    def list_analyses() -> list[dict]:
        return [j.summary() for j in jobs.jobs.values()]

    @app.get("/api/analyses/{analysis_id}")
    def status(analysis_id: str) -> dict:
        job = job_or_404(analysis_id)
        out = job.summary()
        if job.status == "done" and job.bundle:
            out["meta"] = read_json(job.bundle / "meta.json.gz")
        return out

    @app.get("/api/analyses/{analysis_id}/events")
    async def events(analysis_id: str, request: Request) -> StreamingResponse:
        job = job_or_404(analysis_id)

        async def stream():
            sent = 0
            last_beat = time.time()
            while True:
                if await request.is_disconnected():
                    return
                with job.lock:
                    new = job.events[sent:]
                for ev in new:
                    sent += 1
                    yield f"event: {ev['kind']}\ndata: {json.dumps(ev)}\n\n"
                    if ev["kind"] in ("done", "error"):
                        return
                if time.time() - last_beat > 10:
                    last_beat = time.time()
                    yield ": keep-alive\n\n"
                await asyncio.sleep(0.25)

        return StreamingResponse(
            stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
        )

    @app.get("/api/analyses/{analysis_id}/meta")
    def meta(analysis_id: str, request: Request) -> Response:
        return gz(bundle_of(analysis_id) / "meta.json.gz", request)

    @app.get("/api/analyses/{analysis_id}/layout")
    def layout(analysis_id: str, request: Request) -> Response:
        return gz(bundle_of(analysis_id) / "layout.json.gz", request)

    @app.get("/api/analyses/{analysis_id}/snapshots")
    def snapshots(analysis_id: str, request: Request) -> Response:
        return gz(bundle_of(analysis_id) / "snapshots" / "index.json.gz", request)

    @app.get("/api/analyses/{analysis_id}/snapshots/{date}")
    def snapshot(analysis_id: str, date: str, request: Request) -> Response:
        if not MONTH_RE.match(date):
            raise HTTPException(422, "date must be YYYY-MM")
        return gz(bundle_of(analysis_id) / "snapshots" / f"{date}.json.gz", request)

    @app.get("/api/analyses/{analysis_id}/predictions")
    def predictions(analysis_id: str, request: Request, cutoff: str | None = Query(None)) -> Response:
        bundle = bundle_of(analysis_id)
        if cutoff is None:
            m = read_json(bundle / "meta.json.gz")
            return Response(json.dumps(m["cutoffs"]), media_type="application/json")
        if not MONTH_RE.match(cutoff):
            raise HTTPException(422, "cutoff must be YYYY-MM")
        return gz(bundle / "predictions" / f"{cutoff}.json.gz", request)

    def file_data(analysis_id: str) -> tuple[dict, dict]:
        bundle = bundle_of(analysis_id)
        if analysis_id not in file_cache:
            file_cache[analysis_id] = (read_json(bundle / "files.json.gz"), read_json(bundle / "commits.json.gz"))
            while len(file_cache) > 4:
                file_cache.popitem(last=False)
        file_cache.move_to_end(analysis_id)
        return file_cache[analysis_id]

    @app.get("/api/analyses/{analysis_id}/files/{file_id}")
    def file_detail(analysis_id: str, file_id: int) -> dict:
        files, commits = file_data(analysis_id)
        f = files.get(str(file_id))
        if f is None:
            raise HTTPException(404, "Unknown file id")
        meta = read_json(bundle_of(analysis_id) / "meta.json.gz")
        rows = commits["rows"]  # [hash, time, initials, author, fix, subject, merge]

        def commit_info(idx: int) -> dict:
            h, t, ini, _a, fx, subj, merge = rows[idx]
            return {"hash": h, "time": t, "initials": ini, "fix": bool(fx), "subject": subj, "merge": bool(merge)}

        changes = f["changes"]
        months = meta["months"]
        per_month = Counter(month_of(rows[c[0]][1]) for c in changes)
        authors = Counter(rows[c[0]][3] for c in changes)
        initials = {rows[c[0]][3]: rows[c[0]][2] for c in changes}
        total = max(1, len(changes))
        path_history = []
        for c in changes:
            if not path_history or path_history[-1]["path"] != c[4]:
                if c[3] != "D":
                    path_history.append({"path": c[4], "time": rows[c[0]][1]})
        fixes = [commit_info(c[0]) | {"added": c[1], "deleted": c[2]} for c in changes if rows[c[0]][4] and c[3] != "D"]
        recent = [commit_info(c[0]) | {"added": c[1], "deleted": c[2]} for c in changes[-15:]]
        web = meta.get("webUrl")
        return {
            "fileId": file_id,
            "path": f["path"],
            "created": f["created"],
            "webUrl": web.replace("{path}", f["path"]) if web else None,
            "nChanges": len(changes),
            "sparkline": {"months": months, "commits": [per_month.get(m, 0) for m in months]},
            "authors": [
                {"id": a, "initials": initials[a], "commits": n, "share": round(n / total, 3)}
                for a, n in authors.most_common(5)
            ],
            "nAuthors": len(authors),
            "fixes": list(reversed(fixes))[:50],
            "nFixes": len(fixes),
            "recent": list(reversed(recent)),
            "pathHistory": path_history,
            "bugsBorn": [
                {"introHash": ih, "introTime": it, "fix": commit_info(fx)} for fx, ih, it in sorted(f["szz"], key=lambda r: -r[2])[:50]
            ],
            "nBugsBorn": len({s[1] for s in f["szz"]}),
        }

    return app


app = create_app()
