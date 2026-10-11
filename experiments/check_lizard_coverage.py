"""Diagnostic: how often does lizard stop parsing a file early, and does tree-sitter agree
with lizard on the Java files lizard parses completely?

Usage: python experiments/check_lizard_coverage.py data/clones/apache_commons-lang [more repos...]
Writes nothing; prints a summary that is quoted in docs/algorithms.md.
"""

import sys
from pathlib import Path

import lizard

from repocity.ingest.gitutil import CatFile
from repocity.ingest.history import list_tree
from repocity.metrics.java_complexity import java_complexity


def main(repos: list[str]) -> None:
    for r in repos:
        repo = Path(r)
        tree = list_tree(repo, "HEAD")
        big = truncated = agree = compared = 0
        with CatFile(repo) as cat:
            for path, blob in tree.items():
                data = cat.read(blob)
                info = lizard.analyze_file.analyze_source_code(Path(path).name, data.decode("utf-8", "replace"))
                if info.nloc < 200:
                    continue
                big += 1
                last = max((f.end_line for f in info.function_list), default=0)
                is_trunc = last < 0.6 * data.count(b"\n")
                truncated += is_trunc
                if path.endswith(".java") and not is_trunc:
                    compared += 1
                    lz = sum(f.cyclomatic_complexity for f in info.function_list)
                    ts, _, _ = java_complexity(data)
                    agree += abs(lz - ts) <= max(2, 0.05 * lz)
        print(f"{repo.name}: files>=200 NLOC={big}, lizard truncated={truncated}"
              + (f", Java CCN agreement (within 5%) on untruncated files={agree}/{compared}" if compared else ""))


if __name__ == "__main__":
    main(sys.argv[1:])
