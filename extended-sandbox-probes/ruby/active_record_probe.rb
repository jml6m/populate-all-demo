# Supporting ActiveRecord probe (run externally).

require 'json'
require 'set'

module ActiveRecordProbe
  module_function

  def classify_serialization(error)
    return 'SERIALIZE_PASS' if error.nil?
    message = error.message.downcase
    return 'SERIALIZE_FAIL_CYCLE' if message.include?('circular') || message.include?('cycle')

    'SERIALIZE_FAIL_OTHER'
  end

  def smart_check(roots, expected_adj)
    visited = {}
    by_id = {}
    edges = 0
    stack = roots.dup

    until stack.empty?
      node = stack.pop
      oid = node.object_id
      next if visited[oid]
      visited[oid] = true

      prior = by_id[node.id]
      return [false, "id #{node.id} resolved to multiple instances", by_id.length, visited.length, edges] if prior && !prior.equal?(node)
      by_id[node.id] = node

      actual = node.dependencies.map(&:id).to_set
      expected = (expected_adj[node.id] || []).to_set
      return [false, "closure mismatch at #{node.id}", by_id.length, visited.length, edges] unless actual == expected

      node.dependencies.each do |dep|
        edges += 1
        stack << dep
      end
    end

    return [false, "reachable ids #{by_id.length}/#{expected_adj.length}", by_id.length, visited.length, edges] unless by_id.length == expected_adj.length

    [true, nil, by_id.length, visited.length, edges]
  end

  def run_probe(node_scope)
    expected_adj = { 'a' => ['b'], 'b' => ['a'] }
    query_count = 0
    callback = lambda { |_name, _start, _finish, _id, payload| query_count += 1 unless payload[:name] == 'SCHEMA' }
    ActiveSupport::Notifications.subscribed(callback, 'sql.active_record') do
      roots = node_scope.includes(dependencies: :dependencies).to_a
      after_fetch = query_count
      roots.each { |r| r.dependencies.each { |d| d.dependencies.length } }

      no_extra_queries = query_count == after_fetch
      graph_ok, reason, unique_ids, unique_instances, edges = smart_check(roots, expected_adj)

      serialization = begin
        JSON.generate(roots)
        'SERIALIZE_PASS'
      rescue => e
        classify_serialization(e)
      end

      hydration = (no_extra_queries && graph_ok) ? 'HYDRATION PASS' : 'HYDRATION FAIL'
      return {
        hydration: hydration,
        queryGate: { pass: no_extra_queries, reason: no_extra_queries ? nil : 'extra queries during traversal' },
        graphCheck: { pass: graph_ok, reason: reason, uniqueIds: unique_ids, uniqueInstances: unique_instances, edges: edges },
        serialization: serialization
      }
    end
  end
end
