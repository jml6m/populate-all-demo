import json
import os
import sys
from datetime import datetime, timezone
from collections import deque

import sqlalchemy
from sqlalchemy import Column, ForeignKey, Integer, String, Table, create_engine, event
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

Base = declarative_base()

RULE_WIDTH = 64
SCENARIO = 'acyclic A->B->C | schema-driven full hydration (no query-time include paths)'
STRATEGY = "session.query(Node).filter(name='a') <- relationship(lazy='selectin') (schema default)"
EXPECTED_ADJ = {'a': ['b'], 'b': ['c'], 'c': []}

node_dependencies = Table(
    'node_dependencies',
    Base.metadata,
    Column('node_id', ForeignKey('nodes.id'), primary_key=True),
    Column('dependency_id', ForeignKey('nodes.id'), primary_key=True),
)


class Node(Base):
    __tablename__ = 'nodes'

    id = Column(Integer, primary_key=True)
    name = Column(String, unique=True, nullable=False)
    dependencies = relationship(
        'Node',
        secondary=node_dependencies,
        primaryjoin=id == node_dependencies.c.node_id,
        secondaryjoin=id == node_dependencies.c.dependency_id,
        backref='dependents',
        lazy='selectin',
    )


def err_detail(error: Exception) -> str:
    return f'{type(error).__name__}: {error}'


def classify_serialization(error: Exception | None) -> str:
    if error is None:
        return 'SERIALIZE_PASS'
    msg = str(error).lower()
    if 'cycle' in msg or 'circular' in msg or 'recursion' in msg:
        return 'SERIALIZE_FAIL_CYCLE'
    return 'SERIALIZE_FAIL_OTHER'


# Keep this rollup logic in sync with supporting-probes/ts/result-builder.ts::buildOutcome.
def build_outcome(findings) -> str:
    if findings['hydration']['result'] == 'FAIL':
        return 'HYDRATION_FAIL'
    if findings['serialize']['result'].startswith('SERIALIZE_FAIL_'):
        return 'SERIALIZE_FAIL'
    all_passed = (
        findings['hydration']['result'] == 'PASS'
        and findings['queryGate']['result'] == 'PASS'
        and findings['smartCheck']['result'] == 'PASS'
        and findings['serialize']['result'] == 'SERIALIZE_PASS'
    )
    return 'PASS' if all_passed else 'MIXED'


def pending_findings():
    detail = 'not run -- a prerequisite stage did not complete'
    return {
        'fetch': {'result': 'NOT_RUN', 'detail': detail},
        'hydration': {'result': 'FAIL', 'detail': detail},
        'queryGate': {'result': 'NOT_RUN', 'detail': detail},
        'smartCheck': {'result': 'NOT_RUN', 'detail': detail},
        'serialize': {'result': 'SERIALIZE_NOT_RUN', 'detail': detail},
    }


def mark_gates_not_run(findings, reason):
    findings['queryGate'] = {'result': 'NOT_RUN', 'detail': reason}
    findings['smartCheck'] = {'result': 'NOT_RUN', 'detail': reason}
    findings['serialize'] = {'result': 'SERIALIZE_NOT_RUN', 'detail': reason}


def smart_check(roots, expected_adj):
    stack = deque(roots)
    visited_ids = set()
    by_name = {}
    edges = 0

    while stack:
        node = stack.pop()
        oid = id(node)
        if oid in visited_ids:
            continue
        visited_ids.add(oid)

        prior = by_name.get(node.name)
        if prior is not None and prior is not node:
            return False, f'id "{node.name}" maps to multiple in-memory instances', len(by_name), len(visited_ids), edges
        by_name[node.name] = node

        actual = {dep.name for dep in node.dependencies}
        expected = set(expected_adj.get(node.name, []))
        if actual != expected:
            return False, f'dependency closure mismatch at "{node.name}"', len(by_name), len(visited_ids), edges

        for dep in node.dependencies:
            edges += 1
            stack.append(dep)

    if len(by_name) != len(expected_adj):
        return False, f'reachable ids mismatch: got {len(by_name)}, expected {len(expected_adj)}', len(by_name), len(visited_ids), edges

    return True, None, len(by_name), len(visited_ids), edges


def _rule(label):
    prefix = f'== {label} '
    return prefix + '=' * max(0, RULE_WIDTH - len(prefix))


def _first_line(detail):
    line = (detail or '').split('\n')[0].strip()
    return (line[:99] + '...') if len(line) > 100 else line


def _derive_verdict(findings):
    if findings['hydration']['result'] == 'PASS':
        if findings['serialize']['result'] == 'SERIALIZE_PASS':
            return 'ACYCLIC_PASS', 'schema-driven full hydration + serialization succeeded'
        return 'ACYCLIC_PASS', f"full hydration succeeded; serialization {findings['serialize']['result']}"
    if findings['smartCheck']['result'] == 'NOT_RUN':
        return 'ACYCLIC_FAIL', _first_line(findings['hydration']['detail']) or 'hydration did not complete'
    if findings['smartCheck']['result'] == 'FAIL':
        return 'ACYCLIC_FAIL', f"smartCheck failed -- {_first_line(findings['smartCheck']['detail'])}"
    if findings['queryGate']['result'] == 'FAIL':
        return 'ACYCLIC_FAIL', f"topology resolved but queryGate failed -- {_first_line(findings['queryGate']['detail'])}"
    return 'ACYCLIC_FAIL', 'hydration failed'


def _observed_line(metrics):
    if not metrics:
        return 'observed : no graph hydrated -- traversal/identity/serialization gates were not run'
    parts = [f"reached {metrics['reached']}/{metrics['expected']} expected nodes from root [a]", f"{metrics['edges']} edges"]
    parts.append('identity stable' if metrics.get('identityStable', True) else 'identity BROKEN (duplicate instances)')
    if metrics.get('extraQueries') is not None:
        parts.append(f"{metrics['extraQueries']} extra queries")
    return 'observed : ' + '; '.join(parts)


def print_report(probe, library, library_version, strategy, findings, json_path, metrics, verdict_reason=None):
    verdict, reason = _derive_verdict(findings)
    if verdict_reason:
        reason = verdict_reason
    print()
    print(_rule(f'{probe} | {library} v{library_version}'))
    print(f'scenario : {SCENARIO}')
    print(f'strategy : {strategy}')
    print(_observed_line(metrics))
    if findings.get('fetch'):
        print(f"  fetch      : {findings['fetch']['result']:<7}  {_first_line(findings['fetch']['detail'])}")
    print(f"  hydration  : {findings['hydration']['result']:<7}  {_first_line(findings['hydration']['detail'])}")
    print(f"  queryGate  : {findings['queryGate']['result']:<7}  {_first_line(findings['queryGate']['detail'])}")
    print(f"  smartCheck : {findings['smartCheck']['result']:<7}  {_first_line(findings['smartCheck']['detail'])}")
    print(f"  serialize  : {findings['serialize']['result']:<7}  {_first_line(findings['serialize']['detail'])}")
    print(f'VERDICT  : {verdict} -- {reason}')
    print(f'json     : {json_path}')


def write_result(result):
    run_id = os.environ.get('PROBE_RUN_ID', '').strip()
    if not run_id:
        run_id = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-nogit')
        os.environ['PROBE_RUN_ID'] = run_id

    out_dir = os.path.join(os.getcwd(), 'results', 'local', run_id)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, 'sqlalchemy.json')
    tmp_path = f'{out_path}.tmp'
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, sort_keys=True)
        f.write('\n')
    os.replace(tmp_path, out_path)
    return out_path


def evaluate_graph(roots, findings, get_query_count):
    # queryGate: traversal must not trigger further SQL if hydration was complete.
    queries_after_hydration = get_query_count()
    for root in roots:
        for dep in root.dependencies:
            _ = len(dep.dependencies)
    extra_queries = get_query_count() - queries_after_hydration
    if extra_queries == 0:
        findings['queryGate'] = {'result': 'PASS', 'detail': 'No additional queries observed during traversal.'}
    else:
        findings['queryGate'] = {
            'result': 'FAIL',
            'extraQueries': extra_queries,
            'detail': f'Expected 0 additional queries during traversal, observed {extra_queries}.',
        }

    # smartCheck: identity + dependency-closure of the reachable graph.
    graph_ok, reason, reached, _, edges = smart_check(roots, EXPECTED_ADJ)
    if graph_ok:
        findings['smartCheck'] = {'result': 'PASS', 'detail': 'Identity and dependency closure checks passed.'}
    else:
        findings['smartCheck'] = {'result': 'FAIL', 'detail': reason or 'Identity/closure check failed.'}

    # hydration rollup: full hydration = complete closure with no extra queries.
    if findings['queryGate']['result'] == 'PASS' and findings['smartCheck']['result'] == 'PASS':
        findings['hydration'] = {'result': 'PASS', 'detail': 'Full hydration achieved from the root fetch (complete acyclic closure, no extra queries).'}
    else:
        findings['hydration'] = {
            'result': 'FAIL',
            'detail': f"Full hydration not achieved: queryGate={findings['queryGate']['result']}, smartCheck={findings['smartCheck']['result']}.",
        }

    # serialize: independent of smartCheck; needs only a materialized graph.
    def _default(obj):
        if isinstance(obj, Node):
            return {'name': obj.name, 'dependencies': obj.dependencies}
        raise TypeError(f'Object of type {type(obj).__name__} is not JSON serializable')

    serialization_error = None
    try:
        json.dumps(roots, default=_default)
    except Exception as error:  # pylint: disable=broad-except
        serialization_error = error

    serialization = classify_serialization(serialization_error)
    if serialization == 'SERIALIZE_PASS':
        findings['serialize'] = {'result': serialization, 'detail': 'JSON serialization passed.'}
    else:
        findings['serialize'] = {'result': serialization, 'detail': err_detail(serialization_error)}

    return {
        'reached': reached,
        'expected': len(EXPECTED_ADJ),
        'edges': edges,
        'extraQueries': extra_queries,
        'identityStable': 'multiple in-memory instances' not in (reason or ''),
    }


def run():
    findings = pending_findings()
    metrics = None
    verdict_reason = None
    query_count = {'n': 0}

    engine = create_engine('sqlite+pysqlite:///:memory:', future=True)

    @event.listens_for(engine, 'before_cursor_execute')
    def _before_cursor_execute(*_):
        query_count['n'] += 1

    session = None

    # ---- Setup (infrastructure — a failure here is an environment problem, not a research result) ----
    setup_ok = True
    try:
        Base.metadata.create_all(engine)
        session = sessionmaker(bind=engine)()
        a = Node(name='a')
        b = Node(name='b')
        c = Node(name='c')
        a.dependencies.append(b)
        b.dependencies.append(c)
        session.add_all([a, b, c])
        session.commit()
    except Exception as setup_error:  # pylint: disable=broad-except
        setup_ok = False
        detail = err_detail(setup_error)
        findings['hydration'] = {'result': 'FAIL', 'detail': f'probe setup failed: {detail}'}
        verdict_reason = f'probe setup failed -- {detail}'

    # ---- Stage 1: the operation under research — schema-driven fetch of root `a` ----
    if setup_ok:
        roots = None
        try:
            roots = session.query(Node).filter(Node.name.in_(['a'])).order_by(Node.name.asc()).all()
            findings['fetch'] = {'result': 'OK', 'detail': f'Schema-driven fetch returned {len(roots)} root row(s).'}
        except Exception as fetch_error:  # pylint: disable=broad-except
            detail = err_detail(fetch_error)
            findings['fetch'] = {'result': 'ERROR', 'detail': detail}
            findings['hydration'] = {'result': 'FAIL', 'detail': 'fetch did not return a graph'}
            mark_gates_not_run(findings, 'not reached -- the schema-driven fetch threw before returning a graph')
            verdict_reason = f'schema-driven fetch threw -- {detail}'

        # ---- Stages 2-4: gates run only against a graph the fetch actually returned ----
        if roots is not None:
            metrics = evaluate_graph(roots, findings, lambda: query_count['n'])

    if session is not None:
        session.close()

    result = {
        'probe': 'sqlalchemy',
        'language': 'python',
        'library': 'SQLAlchemy',
        'libraryVersion': sqlalchemy.__version__,
        'runtimeVersion': sys.version.split()[0],
        'findings': findings,
    }
    result['outcome'] = build_outcome(findings)

    output_path = write_result(result)

    print_report('sqlalchemy', 'SQLAlchemy', sqlalchemy.__version__, STRATEGY, findings, output_path, metrics, verdict_reason)


if __name__ == '__main__':
    run()
