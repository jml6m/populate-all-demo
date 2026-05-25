import json
from collections import deque

from sqlalchemy import Column, ForeignKey, Integer, String, Table, create_engine, event
from sqlalchemy.orm import declarative_base, relationship, selectinload, sessionmaker

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
    )


def classify_serialization(error: Exception | None) -> str:
    if error is None:
        return 'SERIALIZE_PASS'
    msg = str(error).lower()
    if 'cycle' in msg or 'circular' in msg or 'recursion' in msg:
        return 'SERIALIZE_FAIL_CYCLE'
    return 'SERIALIZE_FAIL_OTHER'


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


def run():
    expected_adj = {'a': ['b'], 'b': ['a']}
    query_count = 0

    engine = create_engine('sqlite+pysqlite:///:memory:', future=True)

    @event.listens_for(engine, 'before_cursor_execute')
    def _before_cursor_execute(*_):
        nonlocal query_count
        query_count += 1

    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    with Session() as session:
        a = Node(name='a')
        b = Node(name='b')
        a.dependencies.append(b)
        b.dependencies.append(a)
        session.add_all([a, b])
        session.commit()

        roots = (
            session.query(Node)
            .options(selectinload(Node.dependencies).selectinload(Node.dependencies))
            .filter(Node.name.in_(['a', 'b']))
            .order_by(Node.name.asc())
            .all()
        )

        queries_after_hydration = query_count

        for root in roots:
            for dep in root.dependencies:
                _ = len(dep.dependencies)

        query_gate = {
            'pass': query_count == queries_after_hydration,
            'reason': None if query_count == queries_after_hydration else f'expected no additional queries during traversal, saw +{query_count - queries_after_hydration}',
        }

        graph_ok, reason, unique_ids, unique_instances, edges = smart_check(roots, expected_adj)
        graph_check = {
            'pass': graph_ok,
            'reason': reason,
            'uniqueIds': unique_ids,
            'uniqueInstances': unique_instances,
            'edgesTraversed': edges,
        }

        hydration = 'HYDRATION PASS' if query_gate['pass'] and graph_check['pass'] else 'HYDRATION FAIL'

        serialization_error = None
        try:
            payload = {}
            payload['self'] = payload
            json.dumps(payload)
        except Exception as error:
            serialization_error = error

        serialization = classify_serialization(serialization_error)

        print('test_sqlalchemy')
        print('hydration:', hydration)
        print('queryGate:', query_gate)
        print('smartCheck:', graph_check)
        print('serialization:', serialization)


if __name__ == '__main__':
    run()
