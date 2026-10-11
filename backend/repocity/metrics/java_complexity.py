"""Java cyclomatic complexity with tree-sitter.

Why this exists: lizard's Java front-end silently stops parsing some files (e.g. after
a local-variable annotation followed by a line break). On Apache Commons Lang and Gson
about 10-20% of large Java files were truncated, under-counting their functions and
complexity (measured by ``experiments/check_lizard_coverage.py``). tree-sitter builds a
real syntax tree, so for Java we take complexity from it while lizard still provides
LOC (NLOC) for every language.

McCabe's cyclomatic complexity (McCabe 1976) of a method = 1 + number of decision
points. We count the same decision points lizard counts for Java: ``if``, ``for``,
enhanced ``for``, ``while``, ``do``, ``catch``, ``case`` labels, the ternary ``?:`` and
the short-circuit operators ``&&`` / ``||``. Methods of anonymous/nested classes are
separate functions and are not added to the enclosing method.
"""

from __future__ import annotations

from functools import lru_cache

FUNCTION_NODES = {"method_declaration", "constructor_declaration", "compact_constructor_declaration"}
DECISION_NODES = {
    "if_statement", "for_statement", "enhanced_for_statement", "while_statement",
    "do_statement", "catch_clause", "ternary_expression",
}


@lru_cache(maxsize=1)
def _parser():
    from tree_sitter_language_pack import get_parser

    return get_parser("java")


def _method_ccn(method) -> int:
    ccn = 1
    stack = [c for c in method.children]
    while stack:
        node = stack.pop()
        t = node.type
        if t in FUNCTION_NODES:
            continue  # nested function: counted on its own
        if t in DECISION_NODES:
            ccn += 1
        elif t == "switch_label" and node.child_count and node.children[0].type == "case":
            ccn += 1
        elif t == "binary_expression":
            op = node.child_by_field_name("operator")
            if op is not None and op.type in ("&&", "||"):
                ccn += 1
        stack.extend(node.children)
    return ccn


def java_complexity(data: bytes) -> tuple[int, int, int]:
    """Return (ccn_total, ccn_max, nfuncs) for a Java source file."""
    tree = _parser().parse(data)
    ccns: list[int] = []
    stack = [tree.root_node]
    while stack:
        node = stack.pop()
        if node.type in FUNCTION_NODES:
            ccns.append(_method_ccn(node))
        stack.extend(node.children)
    return (sum(ccns), max(ccns, default=0), len(ccns))
