"""Bug-fix commit detection with a keyword heuristic (Section 4.2).

Following Mockus & Votta (2000) and the SZZ paper (Sliwerski, Zimmermann & Zeller 2005),
a commit is a *bug fix* if its message contains a fixing keyword as a **whole word**
(``fix``, ``bug``, ``defect``, ``crash`` ... see :data:`DEFAULT_KEYWORDS`), unless it
matches an exclusion pattern for well-known false positives (``fix typo``,
``fix docs``, ``fix lint`` ...). Whole-word matching means ``prefix`` or ``suffix`` never
match ``fix``. Both lists are configurable (``experiments/configs/bugfix.yaml``).

Merge commits on the first-parent chain carry no change of their own; their message is
mostly boilerplate (``Merge pull request #12 from user/branch``). We therefore never
classify a merge by its first line. A merge counts as a bug fix if the pull-request
title in its body, or any commit it integrates into the main branch, is a bug fix
(see :func:`classify_history`). That way squash-merge, rebase and merge-commit workflows
are treated alike.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from repocity.ingest.gitutil import run_git

DEFAULT_KEYWORDS = [
    "fix", "fixes", "fixed", "fixing", "bugfix", "bugfixes", "hotfix", "bug", "bugs",
    "defect", "defects", "error", "errors", "crash", "crashes", "crashed", "fault", "faults",
    "patch", "patched", "resolve", "resolves", "resolved", "regression", "issue #",
    "npe", "nullpointerexception", "incorrect", "wrong", "broken", "workaround",
]
DEFAULT_EXCLUDES = [
    r"\bfix(e[sd]|ing)?\s+(a\s+|the\s+|some\s+|minor\s+|small\s+)?(typos?|spelling|grammar|wording|whitespace|indent(ation)?|formatting|format|style|lint(ing)?|pep\s?8|flake8|mypy|typing|type hints?|annotations?|imports?)\b",
    r"\bfix(e[sd]|ing)?\s+(a\s+|the\s+|some\s+)?(docs?|documentation|docstrings?|readme|changelog|changes|comments?|links?|urls?|examples?|tutorial|copyright|license|headers?|javadoc|jsdoc)\b",
    r"\bfix(e[sd]|ing)?\s+(a\s+|the\s+)?(ci|build|travis|appveyor|github actions|workflow|tests? names?|coverage|release|version)\b",
    r"\b(error|errors)\s+(messages?|handling|reporting|pages?)\b",
    r"\bresolv(e|es|ed|ing)\s+(the\s+)?(merge\s+)?conflicts?\b",
    r"\bpatch\s+(release|version|level)\b",
]
# A message matching a veto is never a bug fix (Conventional-Commits types that are not fixes).
DEFAULT_VETOES = [r"^\s*(docs?|chore|style|ci|build|test|tests|refactor|perf|release)(\(.*?\))?!?:"]
TRAILER_RE = re.compile(r"^(signed-off-by|co-authored-by|reviewed-by|cc|change-id):.*$", re.I | re.M)


@dataclass
class BugfixClassifier:
    keywords: list[str] = field(default_factory=lambda: list(DEFAULT_KEYWORDS))
    excludes: list[str] = field(default_factory=lambda: list(DEFAULT_EXCLUDES))
    vetoes: list[str] = field(default_factory=lambda: list(DEFAULT_VETOES))

    def __post_init__(self) -> None:
        words = sorted({k.lower() for k in self.keywords}, key=len, reverse=True)
        parts = []
        for w in words:
            if w.endswith("#"):  # "issue #" -> "issue #123"
                parts.append(re.escape(w[:-1].strip()) + r"\s*#\d+")
            else:
                parts.append(re.escape(w))
        self._kw = re.compile(r"\b(" + "|".join(parts) + r")\b", re.I)
        self._ex = [re.compile(p, re.I | re.M) for p in self.excludes]
        self._veto = [re.compile(p, re.I) for p in self.vetoes]

    @classmethod
    def from_yaml(cls, path: str | Path) -> BugfixClassifier:
        data = yaml.safe_load(Path(path).read_text()) or {}
        return cls(
            data.get("keywords", DEFAULT_KEYWORDS),
            data.get("excludes", DEFAULT_EXCLUDES),
            data.get("vetoes", DEFAULT_VETOES),
        )

    def is_bugfix(self, message: str) -> bool:
        """Classify a single (non-merge) commit message."""
        text = TRAILER_RE.sub("", message)
        if not self._kw.search(text) or any(v.search(text) for v in self._veto):
            return False
        # An exclusion only vetoes if no *other* keyword occurrence survives it.
        stripped = text
        for ex in self._ex:
            stripped = ex.sub(" ", stripped)
        return bool(self._kw.search(stripped))

    def is_bugfix_merge(self, message: str) -> bool:
        """Classify a merge by its body only (PR title), never by the boilerplate first line."""
        lines = message.split("\n", 1)
        first = lines[0]
        body = lines[1] if len(lines) > 1 else ""
        if not re.match(r"^(merge|merged)\b", first, re.I):
            return self.is_bugfix(message)  # a custom merge message written by a human
        return self.is_bugfix(body)


def integrated_commits(repo: str | Path, mainline: list[str]) -> dict[str, list[str]]:
    """For every first-parent merge, the messages of the commits it brings into mainline.

    Walk merges oldest-first; from the second parent, follow parents until we hit a
    commit that is already on mainline or already integrated by an earlier merge.
    """
    out = run_git(repo, ["log", "--format=%x1e%H%x1f%P%x1f%B", mainline[-1]])
    parents: dict[str, list[str]] = {}
    messages: dict[str, str] = {}
    for rec in out.split("\x1e"):
        if not rec.strip():
            continue
        h, p, msg = (rec.split("\x1f", 2) + ["", ""])[:3]
        parents[h] = p.split()
        messages[h] = msg.strip()
    on_main = set(mainline)
    seen: set[str] = set()
    result: dict[str, list[str]] = {}
    for h in mainline:
        ps = parents.get(h, [])
        if len(ps) < 2:
            continue
        msgs: list[str] = []
        stack = list(ps[1:])
        while stack:
            c = stack.pop()
            if c in on_main or c in seen or c not in parents:
                continue
            seen.add(c)
            if len(parents[c]) < 2:  # nested merges are walked through, not classified
                msgs.append(messages[c])
            stack.extend(parents[c])
        result[h] = msgs
    return result


def classify_history(
    messages: Iterable[str],
    is_merge: Iterable[bool],
    integrated: list[list[str]] | None,
    clf: BugfixClassifier,
) -> list[bool]:
    """Bug-fix flag for each first-parent commit."""
    flags = []
    integrated = integrated or []
    for i, (msg, merge) in enumerate(zip(messages, is_merge)):
        if not merge:
            flags.append(clf.is_bugfix(msg))
        else:
            branch = integrated[i] if i < len(integrated) else []
            flags.append(clf.is_bugfix_merge(msg) or any(clf.is_bugfix(m) for m in branch))
    return flags
