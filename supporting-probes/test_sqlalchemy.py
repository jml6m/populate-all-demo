import json
import os
import sys
import traceback
from collections import deque

import sqlalchemy
from sqlalchemy import Column, ForeignKey, Integer, String, Table, create_engine, event
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

Base = declarative_base()

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


def write_result(result):
    run_id = os.environ.get('PROBE_RUN_ID')
    if not run_id:
        raise RuntimeError('PROBE_RUN_ID is required for probe JSON output')

    out_dir = os.path.join(os.getcwd(), 'results', 'local', run_id)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, 'sqlalchemy.json')
    tmp_path = f'{out_path}.tmp'
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, sort_keys=True)
        f.write('\n')
    os.replace(tmp_path, out_path)
    return out_path


def run():
    expected_adj = {'a': ['b'], 'b': ['c'], 'c': []}
    query_count = 0

    findings = {
        'hydration': {'result': 'FAIL', 'detail': ''},
        'queryGate': {'result': 'FAIL', 'detail': ''},
        'smartCheck': {'result': 'FAIL', 'detail': ''},
        'serialize': {'result': 'SERIALIZE_FAIL_OTHER', 'detail': ''},
    }

    engine = create_engine('sqlite+pysqlite:///:memory:', future=True)

    @event.listens_for(engine, 'before_cursor_execute')
    def _before_cursor_execute(*_):
        nonlocal query_count
        query_count += 1

    try:
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)

        with Session() as session:
            a = Node(name='a')
            b = Node(name='b')
            c = Node(name='c')
            a.dependencies.append(b)
            b.dependencies.append(c)
            session.add_all([a, b, c])
            session.commit()

            roots = (
                session.query(Node)
                .filter(Node.name.in_(['a']))
                .order_by(Node.name.asc())
                .all()
            )

            queries_after_hydration = query_count

            for root in roots:
                for dep in root.dependencies:
                    _ = len(dep.dependencies)

            extra_queries = query_count - queries_after_hydration
            if extra_queries == 0:
                findings['queryGate'] = {'result': 'PASS', 'detail': 'No additional queries observed during traversal.'}
            else:
                findings['queryGate'] = {
                    'result': 'FAIL',
                    'extraQueries': extra_queries,
                    'detail': f'Expected 0 additional queries during traversal, observed {extra_queries}.',
                }

            graph_ok, reason, _, _, _ = smart_check(roots, expected_adj)
            if graph_ok:
                findings['smartCheck'] = {'result': 'PASS', 'detail': 'Identity and dependency closure checks passed.'}
            else:
                findings['smartCheck'] = {'result': 'FAIL', 'detail': reason or 'Identity/closure check failed.'}

            if findings['queryGate']['result'] == 'PASS' and findings['smartCheck']['result'] == 'PASS':
                findings['hydration'] = {'result': 'PASS', 'detail': 'Hydration check passed.'}
            else:
                findings['hydration'] = {
                    'result': 'FAIL',
                    'detail': f"Hydration failed: queryGate={findings['queryGate']['result']}, smartCheck={findings['smartCheck']['result']}.",
                }

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
                detail = ''.join(traceback.format_exception(type(serialization_error), serialization_error, serialization_error.__traceback__)) if serialization_error else serialization
                findings['serialize'] = {'result': serialization, 'detail': detail}
    except Exception as error:  # pylint: disable=broad-except
        detail = ''.join(traceback.format_exception(type(error), error, error.__traceback__))
        findings['hydration'] = {'result': 'FAIL', 'detail': detail}
        findings['queryGate'] = {'result': 'FAIL', 'detail': detail}
        findings['smartCheck'] = {'result': 'FAIL', 'detail': detail}
        findings['serialize'] = {'result': 'SERIALIZE_FAIL_OTHER', 'detail': detail}

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

    print('test_sqlalchemy')
    print('hydration:', 'HYDRATION PASS' if findings['hydration']['result'] == 'PASS' else 'HYDRATION FAIL')
    print('queryGate:', findings['queryGate'])
    print('smartCheck:', findings['smartCheck'])
    print('serialization:', findings['serialize']['result'])
    print('json:', output_path)


if __name__ == '__main__':
    run()
