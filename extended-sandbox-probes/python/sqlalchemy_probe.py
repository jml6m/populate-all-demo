"""Supporting SQLAlchemy probe (run externally)."""

from collections import deque
from sqlalchemy import event


def smart_check(roots, expected_adj):
    visited = set()
    by_id = {}
    q = deque(roots)
    edges = 0
    while q:
        node = q.pop()
        oid = id(node)
        if oid in visited:
            continue
        visited.add(oid)

        existing = by_id.get(node.id)
        if existing is not None and existing is not node:
            return False, f"id {node.id} resolved to multiple instances", len(by_id), len(visited), edges
        by_id[node.id] = node

        actual = {d.id for d in node.dependencies}
        expected = set(expected_adj.get(node.id, []))
        if actual != expected:
            return False, f"closure mismatch at {node.id}", len(by_id), len(visited), edges

        for dep in node.dependencies:
            edges += 1
            q.append(dep)

    if len(by_id) != len(expected_adj):
        return False, f"reachable ids {len(by_id)}/{len(expected_adj)}", len(by_id), len(visited), edges
    return True, None, len(by_id), len(visited), edges


def run_probe(session, Node):
    expected_adj = {"a": ["b"], "b": ["a"]}
    query_count = 0

    @event.listens_for(session.bind, "before_cursor_execute")
    def _count_queries(*_):
        nonlocal query_count
        query_count += 1

    roots = session.query(Node).all()  # configure eager loading in external sandbox
    after_fetch = query_count

    for r in roots:
        for d in r.dependencies:
            _ = len(d.dependencies)

    no_extra_queries = query_count == after_fetch
    graph_ok, reason, unique_ids, unique_instances, edges = smart_check(roots, expected_adj)

    hydration = "HYDRATION PASS" if (no_extra_queries and graph_ok) else "HYDRATION FAIL"
    return {
        "hydration": hydration,
        "queryGate": {"pass": no_extra_queries, "reason": None if no_extra_queries else "extra queries during traversal"},
        "graphCheck": {
            "pass": graph_ok,
            "reason": reason,
            "uniqueIds": unique_ids,
            "uniqueInstances": unique_instances,
            "edges": edges,
        },
    }
