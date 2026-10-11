"""City layout: a nested *squarified treemap* (Bruls, Huizing & van Wijk, 2000).

**Squarified treemap.** Given weights and a rectangle, children are laid out in rows
along the rectangle's shorter side. Items (sorted by decreasing weight) are added to
the current row as long as that does not make the worst aspect ratio in the row
worse; otherwise the row is frozen and a new one starts in the remaining space. The
result keeps every rectangle's area proportional to its weight while keeping the
rectangles close to square, which makes good building lots.

**Nesting.** Directories become *districts*: a directory's rectangle is shrunk by a
padding (the "street") and its children (sub-directories and files) are laid out
inside it recursively. Chains of single-child directories (``src/main/java/org/x``)
are collapsed into one district so deep Java packages don't waste space.

**Stability over time.** The layout is computed **once** from the union of all files
that ever existed in history, each weighted by its *maximum* LOC over its lifetime,
and placed under its *latest* path. Every file therefore owns a fixed lot for the
whole replay: buildings never jump while the time slider moves; files that do not
exist yet (or were deleted) are hidden / shown as empty lots. The cost is some empty
space early in history and that a file moved between directories is drawn at its
final location. See docs/algorithms.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field

Rect = tuple[float, float, float, float]  # x, y, w, h


def _worst(row: list[float], side: float) -> float:
    """Worst aspect ratio of a row of areas laid along a side of length ``side``."""
    s = sum(row)
    if s <= 0 or side <= 0:
        return float("inf")
    mx, mn = max(row), min(row)
    return max(side * side * mx / (s * s), (s * s) / (side * side * mn))


def squarify(weights: list[float], rect: Rect) -> list[Rect]:
    """Lay out ``weights`` (any order) in ``rect``; returns rectangles in input order."""
    x, y, w, h = rect
    n = len(weights)
    if n == 0:
        return []
    total = float(sum(weights))
    if total <= 0 or w <= 0 or h <= 0:
        return [(x, y, 0.0, 0.0)] * n
    scale = (w * h) / total
    order = sorted(range(n), key=lambda i: (-weights[i], i))
    areas = [weights[i] * scale for i in order]
    out: list[Rect | None] = [None] * n

    i = 0
    while i < n:
        side = min(w, h)
        row = [areas[i]]
        j = i + 1
        while j < n and _worst(row + [areas[j]], side) <= _worst(row, side):
            row.append(areas[j])
            j += 1
        s = sum(row)
        if w >= h:  # lay the row as a column on the left
            col_w = s / h if h > 0 else 0.0
            yy = y
            for k, a in enumerate(row):
                hh = a / col_w if col_w > 0 else 0.0
                out[order[i + k]] = (x, yy, col_w, hh)
                yy += hh
            x, w = x + col_w, max(0.0, w - col_w)
        else:  # lay the row along the top
            row_h = s / w if w > 0 else 0.0
            xx = x
            for k, a in enumerate(row):
                ww = a / row_h if row_h > 0 else 0.0
                out[order[i + k]] = (xx, y, ww, row_h)
                xx += ww
            y, h = y + row_h, max(0.0, h - row_h)
        i = j
    return [r if r is not None else (x, y, 0.0, 0.0) for r in out]


@dataclass
class Node:
    name: str
    path: str
    children: dict[str, Node] = field(default_factory=dict)
    file_id: int | None = None
    weight: float = 0.0

    @property
    def is_file(self) -> bool:
        return self.file_id is not None


def build_tree(files: list[tuple[int, str, float]]) -> Node:
    """Directory tree from (file_id, path, weight); weights are summed upwards."""
    root = Node("", "")
    for fid, path, weight in files:
        parts = path.split("/")
        node = root
        for depth, part in enumerate(parts[:-1]):
            key = part + "/"
            if key not in node.children:
                node.children[key] = Node(part, "/".join(parts[: depth + 1]))
            node = node.children[key]
        # keyed by id: a path deleted and re-created later is a second identity with its own lot
        node.children[f"{parts[-1]}#{fid}"] = Node(parts[-1], path, file_id=fid, weight=max(weight, 1.0))

    def total(n: Node) -> float:
        if n.is_file:
            return n.weight
        n.weight = sum(total(c) for c in n.children.values())
        return n.weight

    total(root)
    return root


def collapse(node: Node) -> Node:
    """Merge chains of directories that contain exactly one sub-directory and nothing else."""
    for key in list(node.children):
        node.children[key] = collapse(node.children[key])
    if not node.is_file and node.path and len(node.children) == 1:
        (only,) = node.children.values()
        if not only.is_file:
            only.name = f"{node.name}/{only.name}"
            return only
    return node


@dataclass
class Layout:
    size: float
    files: dict[int, Rect]  # file_id -> building lot (x, y, w, h)
    districts: list[dict]  # {path, label, x, y, w, h, depth}


def layout_city(files: list[tuple[int, str, float]], size: float = 1000.0) -> Layout:
    """Nested squarified treemap of the whole city in a ``size`` x ``size`` square."""
    root = collapse(build_tree(files))
    lots: dict[int, Rect] = {}
    districts: list[dict] = []
    n_files = max(1, len(files))
    base_pad = size * min(0.012, 0.25 / n_files**0.5)

    def place(node: Node, rect: Rect, depth: int) -> None:
        if node.is_file:
            assert node.file_id is not None
            lots[node.file_id] = rect
            return
        x, y, w, h = rect
        if node.path:
            districts.append({"path": node.path, "label": node.name, "x": x, "y": y, "w": w, "h": h, "depth": depth})
        pad = min(base_pad * (0.85**depth), w * 0.08, h * 0.08)
        inner = (x + pad, y + pad, max(0.0, w - 2 * pad), max(0.0, h - 2 * pad))
        kids = sorted(node.children.values(), key=lambda c: (c.is_file, c.name))
        rects = squarify([c.weight for c in kids], inner)
        for child, r in zip(kids, rects):
            place(child, r, depth + (0 if child.is_file else 1))

    place(root, (0.0, 0.0, size, size), 0)
    return Layout(size, lots, districts)
