"""DuckDB store: one database file per analysed repository.

Tables (all written from pandas DataFrames):

=================  ==========================================================================
``meta``           key/value pairs (url, head commit, analysis config, timings ...)
``commits``        first-parent commits: idx, hash, parents, time (monotonic), author (hashed),
                   initials, message, is_merge, n_files, n_files_all, is_bugfix
``changes``        per (commit, file_id): path after change, status A/M/D/R, added, deleted
``files``          file identities: first/last path, created/deleted commit index
``snapshots``      month -> commit index / hash / end timestamp
``snapshot_files`` month x file_id -> path, blob, loc, ccn_total, ccn_max, nfuncs
``szz_lines``      blamed lines of bug fixes (both blame modes, for the SZZ ablation)
``intro_sizes``    files changed by each bug-introducing candidate commit
=================  ==========================================================================
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd

TABLES = ["commits", "changes", "files", "snapshots", "snapshot_files", "szz_lines", "intro_sizes"]


class Store:
    def __init__(self, path: str | Path, read_only: bool = False):
        self.path = Path(path)
        if not read_only:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self.con = duckdb.connect(str(self.path), read_only=read_only)
        if not read_only:
            self.con.execute("CREATE TABLE IF NOT EXISTS meta (key VARCHAR PRIMARY KEY, value VARCHAR)")

    def close(self) -> None:
        self.con.close()

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def write(self, name: str, df: pd.DataFrame) -> None:
        self.con.register("_tmp_df", df)
        self.con.execute(f'CREATE OR REPLACE TABLE "{name}" AS SELECT * FROM _tmp_df')
        self.con.unregister("_tmp_df")

    def read(self, name: str) -> pd.DataFrame:
        return self.con.execute(f'SELECT * FROM "{name}"').df()

    def has(self, name: str) -> bool:
        q = "SELECT count(*) FROM information_schema.tables WHERE table_name = ?"
        return self.con.execute(q, [name]).fetchone()[0] > 0

    def query(self, sql: str, params: list[Any] | None = None) -> pd.DataFrame:
        return self.con.execute(sql, params or []).df()

    def set_meta(self, key: str, value: Any) -> None:
        self.con.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", [key, json.dumps(value)])

    def get_meta(self, key: str, default: Any = None) -> Any:
        row = self.con.execute("SELECT value FROM meta WHERE key = ?", [key]).fetchone()
        return json.loads(row[0]) if row else default
