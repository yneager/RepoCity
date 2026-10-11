"""API tests with FastAPI's TestClient against a bundle built from the synthetic repository."""

from __future__ import annotations

import shutil
import time

import pytest
from fastapi.testclient import TestClient

from repocity.api import jobs as jobs_mod
from repocity.api.app import create_app
from repocity.api.jobs import JobManager, slugify
from repocity.config import ModelConfig
from repocity.models.train import Predictor
from repocity.pipeline.analyze import load_repo_data
from repocity.pipeline.export import export_bundle
from repocity.store.db import Store

URL = "https://github.com/example/bugrepo"


@pytest.fixture(scope="module")
def client(bug_repo, bug_store, tmp_path_factory):
    demo = tmp_path_factory.mktemp("demo")
    data = tmp_path_factory.mktemp("data")
    head = bug_repo.hashes["c13"]
    with Store(bug_store) as st:
        predictor = Predictor(load_repo_data(st), ModelConfig(min_history_months=1, train_windows=2, horizon_months=3))
    export_bundle(predictor, demo / slugify(URL, head), repo_id=slugify(URL, head), name="example/bugrepo", url=URL, head=head)
    app = create_app(JobManager(data_dir=data, demo_dir=demo))
    with TestClient(app) as c:
        c.analysis_id = slugify(URL, head)
        yield c


def test_health_and_demo(client):
    assert client.get("/api/health").json()["status"] == "ok"
    demos = client.get("/api/demo").json()
    assert [d["id"] for d in demos] == [client.analysis_id]
    assert demos[0]["nCommits"] == 14


def test_layout_and_snapshots(client):
    aid = client.analysis_id
    lay = client.get(f"/api/analyses/{aid}/layout").json()
    n = len(lay["files"]["id"])
    assert n == 3 and set(lay["files"]["path"]) == {"core.py", "util.py", "new.py"}
    idx = client.get(f"/api/analyses/{aid}/snapshots").json()
    assert idx[0]["month"] == "2020-01" and idx[-1]["month"] == "2021-03"
    assert [m["files"] for m in idx][:2] == [2, 2] and idx[-1]["files"] == 2
    snap = client.get(f"/api/analyses/{aid}/snapshots/2020-05").json()
    assert len(snap["loc"]) == n and sum(1 for v in snap["loc"] if v > 0) == 2
    core = lay["files"]["path"].index("core.py")
    assert snap["commits"][core] == 5 and snap["fixes"][core] == 1
    assert client.get(f"/api/analyses/{aid}/snapshots/1999-01").status_code == 404
    assert client.get(f"/api/analyses/{aid}/snapshots/../../etc").status_code in (404, 422)


def test_predictions_and_file_details(client):
    aid = client.analysis_id
    cutoffs = client.get(f"/api/analyses/{aid}/predictions").json()
    assert cutoffs and all("cutoff" in c for c in cutoffs)
    labelled = [c["cutoff"] for c in cutoffs if c["hasLabels"]]
    p = client.get(f"/api/analyses/{aid}/predictions", params={"cutoff": labelled[0]}).json()
    assert len(p["risk"]) == len(p["files"]) == len(p["actual"])
    assert "hotspot" in p["metrics"]
    lay = client.get(f"/api/analyses/{aid}/layout").json()
    fid = lay["files"]["id"][lay["files"]["path"].index("core.py")]
    d = client.get(f"/api/analyses/{aid}/files/{fid}").json()
    assert d["path"] == "core.py" and d["nFixes"] == 3
    assert [h["path"] for h in d["pathHistory"]] == ["app.py", "core.py"]
    assert d["webUrl"].startswith(URL + "/blob/") and d["webUrl"].endswith("/core.py")
    assert all(len(a["initials"]) <= 2 and "@" not in a["id"] for a in d["authors"])
    assert d["nBugsBorn"] == 3
    assert client.get(f"/api/analyses/{aid}/files/99999").status_code == 404


def test_sse_for_finished_analysis(client):
    with client.stream("GET", f"/api/analyses/{client.analysis_id}/events") as r:
        body = "".join(r.iter_text())
    assert "event: done" in body


@pytest.mark.parametrize(
    "url",
    ["http://github.com/a/b", "file:///etc/passwd", "https://user:pw@github.com/a/b", "git@github.com:a/b.git", "https://github.com/../x", "ftp://x/y"],
)
def test_rejects_unsafe_urls(client, url):
    r = client.post("/api/analyses", json={"url": url})
    assert r.status_code == 422


def test_unknown_analysis(client):
    assert client.get("/api/analyses/nope/layout").status_code == 404
    assert client.get("/api/analyses/NOT..VALID/layout").status_code == 404


def test_submit_runs_background_analysis(bug_repo, tmp_path, monkeypatch):
    """The worker pipeline end to end, with clone/ls-remote redirected to the local repo."""
    head = bug_repo.hashes["c13"]
    monkeypatch.setattr(jobs_mod, "remote_head", lambda url: head)
    monkeypatch.setattr(jobs_mod, "clone", lambda url, dest, timeout, rev=None: shutil.copytree(bug_repo.path, dest))
    app = create_app(JobManager(data_dir=tmp_path / "data", demo_dir=tmp_path / "nodemo"))
    with TestClient(app) as c:
        r = c.post("/api/analyses", json={"url": "https://github.com/example/other"})
        assert r.status_code == 202
        aid = r.json()["id"]
        assert aid == slugify("https://github.com/example/other", head)
        deadline = time.time() + 120
        while time.time() < deadline and c.get(f"/api/analyses/{aid}").json()["status"] not in ("done", "error"):
            time.sleep(0.3)
        st = c.get(f"/api/analyses/{aid}").json()
        assert st["status"] == "done", st
        with c.stream("GET", f"/api/analyses/{aid}/events") as resp:
            body = "".join(resp.iter_text())
        for step in ("clone", "history", "snapshots", "szz", "model", "layout"):
            assert f'"step": "{step}"' in body
        # cache by URL + HEAD: re-submitting returns the same finished analysis
        again = c.post("/api/analyses", json={"url": "https://github.com/example/other"}).json()
        assert again["id"] == aid and again["status"] == "done"
        assert c.get(f"/api/analyses/{aid}/layout").status_code == 200


def test_cancel_analysis(bug_repo, tmp_path, monkeypatch):
    head = bug_repo.hashes["c13"]
    monkeypatch.setattr(jobs_mod, "remote_head", lambda url: head)

    def slow_clone(url, dest, timeout, rev=None):
        time.sleep(1.5)
        shutil.copytree(bug_repo.path, dest)

    monkeypatch.setattr(jobs_mod, "clone", slow_clone)
    app = create_app(JobManager(data_dir=tmp_path / "data", demo_dir=tmp_path / "nodemo"))
    with TestClient(app) as c:
        aid = c.post("/api/analyses", json={"url": "https://github.com/example/cancel-me"}).json()["id"]
        assert c.get(f"/api/analyses/{aid}").json()["queuePosition"] == 0
        assert c.post(f"/api/analyses/{aid}/cancel").status_code == 200
        deadline = time.time() + 30
        while time.time() < deadline and c.get(f"/api/analyses/{aid}").json()["status"] != "error":
            time.sleep(0.2)
        st = c.get(f"/api/analyses/{aid}").json()
        assert st["status"] == "error" and st["error"] == "Cancelled"
        assert c.post("/api/analyses/nope/cancel").status_code == 404
