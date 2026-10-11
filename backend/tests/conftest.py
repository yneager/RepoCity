from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from gitrepo import SyntheticRepo, build_bug_repo  # noqa: E402

from repocity.config import AnalysisConfig  # noqa: E402
from repocity.pipeline.analyze import ingest  # noqa: E402

TEST_CFG = AnalysisConfig(workers=2)


@pytest.fixture(scope="session")
def bug_repo(tmp_path_factory) -> SyntheticRepo:
    return build_bug_repo(tmp_path_factory.mktemp("bugrepo") / "repo")


@pytest.fixture(scope="session")
def bug_store(bug_repo, tmp_path_factory) -> Path:
    path = tmp_path_factory.mktemp("store") / "bug.duckdb"
    ingest(bug_repo.path, path, "HEAD", cfg=TEST_CFG)
    return path
