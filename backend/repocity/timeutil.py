"""Month arithmetic in UTC. Months are represented as ``"YYYY-MM"`` strings."""

from __future__ import annotations

from datetime import UTC, datetime


def month_of(ts: int | float) -> str:
    d = datetime.fromtimestamp(ts, tz=UTC)
    return f"{d.year:04d}-{d.month:02d}"


def add_months(month: str, n: int) -> str:
    y, m = int(month[:4]), int(month[5:7])
    total = y * 12 + (m - 1) + n
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def month_start_ts(month: str) -> int:
    y, m = int(month[:4]), int(month[5:7])
    return int(datetime(y, m, 1, tzinfo=UTC).timestamp())


def month_end_ts(month: str) -> int:
    """Last second of the month (inclusive upper bound of a snapshot)."""
    return month_start_ts(add_months(month, 1)) - 1


def month_range(first: str, last: str) -> list[str]:
    out = []
    cur = first
    while cur <= last:
        out.append(cur)
        cur = add_months(cur, 1)
    return out


def months_between(a: str, b: str) -> int:
    """Number of months from ``a`` to ``b`` (b - a)."""
    return (int(b[:4]) * 12 + int(b[5:7])) - (int(a[:4]) * 12 + int(a[5:7]))
