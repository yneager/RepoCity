"""Squarified treemap properties (hypothesis) and layout stability."""

from __future__ import annotations

import random

from hypothesis import given, settings
from hypothesis import strategies as st

from repocity.layout.treemap import layout_city, squarify

EPS = 1e-6


def overlap(a, b) -> bool:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return ax + aw > bx + EPS and bx + bw > ax + EPS and ay + ah > by + EPS and by + bh > ay + EPS


weights_st = st.lists(st.floats(min_value=0.5, max_value=1e4, allow_nan=False), min_size=1, max_size=60)
rect_st = st.tuples(st.floats(0, 100), st.floats(0, 100), st.floats(1, 500), st.floats(1, 500))


@given(weights_st, rect_st)
@settings(max_examples=200, deadline=None)
def test_squarify_no_overlap_and_area_ratios(weights, rect):
    rects = squarify(weights, rect)
    assert len(rects) == len(weights)
    x, y, w, h = rect
    total = sum(weights)
    for (rx, ry, rw, rh), wt in zip(rects, weights):
        assert rx >= x - 1e-6 and ry >= y - 1e-6
        assert rx + rw <= x + w + 1e-6 * (1 + w) and ry + rh <= y + h + 1e-6 * (1 + h)
        # area proportional to weight
        assert abs(rw * rh - wt / total * w * h) <= 1e-6 * w * h + 1e-9
    for i in range(len(rects)):
        for j in range(i + 1, len(rects)):
            assert not overlap(rects[i], rects[j])


paths_st = st.lists(
    st.lists(st.sampled_from(["src", "lib", "a", "b", "core", "util", "tests"]), min_size=0, max_size=3),
    min_size=1,
    max_size=40,
)


def _files(dirs, seed=0):
    rnd = random.Random(seed)
    return [(i, "/".join(d + [f"f{i}.py"]), float(rnd.randint(1, 500))) for i, d in enumerate(dirs)]


@given(paths_st)
@settings(max_examples=100, deadline=None)
def test_city_layout_no_overlap_and_inside_districts(dirs):
    files = _files(dirs)
    lay = layout_city(files, size=1000)
    assert set(lay.files) == {f[0] for f in files}
    lots = list(lay.files.values())
    for i in range(len(lots)):
        x, y, w, h = lots[i]
        assert -EPS <= x and x + w <= 1000 + 1e-6 and -EPS <= y and y + h <= 1000 + 1e-6
        for j in range(i + 1, len(lots)):
            assert not overlap(lots[i], lots[j])
    paths = {fid: p for fid, p, _ in files}
    for d in lay.districts:
        for fid, (x, y, w, h) in lay.files.items():
            if paths[fid].startswith(d["path"] + "/"):
                assert x >= d["x"] - 1e-6 and y >= d["y"] - 1e-6
                assert x + w <= d["x"] + d["w"] + 1e-6 and y + h <= d["y"] + d["h"] + 1e-6


@given(paths_st, st.randoms())
@settings(max_examples=50, deadline=None)
def test_layout_is_deterministic_and_order_independent(dirs, rnd):
    files = _files(dirs)
    shuffled = files[:]
    rnd.shuffle(shuffled)
    assert layout_city(files).files == layout_city(shuffled).files


def test_layout_stable_when_files_appear_over_time():
    """Lots are computed from the union of all files ever seen, so the position of a file is
    the same at every moment of the replay, no matter which files exist at that time."""
    history = [
        [(0, "src/a.py", 100.0), (1, "src/b.py", 50.0)],
        [(0, "src/a.py", 100.0), (1, "src/b.py", 50.0), (2, "lib/c.py", 70.0)],
        [(0, "src/a.py", 100.0), (2, "lib/c.py", 70.0), (3, "src/d.py", 10.0)],  # b.py deleted
    ]
    union = {}
    for snap in history:
        for fid, path, w in snap:
            union[fid] = (fid, path, max(w, union.get(fid, (0, "", 0))[2]))
    lay = layout_city(list(union.values()))
    for snap in history:
        visible = {fid: lay.files[fid] for fid, _, _ in snap}
        for fid, rect in visible.items():
            assert rect == lay.files[fid]
    assert len(lay.files) == 4


def test_single_child_directories_collapse():
    lay = layout_city([(0, "src/main/java/org/x/A.java", 10.0), (1, "src/main/java/org/x/B.java", 5.0)])
    assert [d["label"] for d in lay.districts] == ["src/main/java/org/x"]
