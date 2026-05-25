require 'active_record'
require 'active_support/notifications'
require 'json'
require 'set'

ActiveRecord::Base.establish_connection(adapter: 'sqlite3', database: ':memory:')

ActiveRecord::Schema.define do
  create_table :nodes, force: true do |t|
    t.string :name, null: false
  end

  create_table :node_dependencies, id: false, force: true do |t|
    t.integer :node_id, null: false
    t.integer :dependency_id, null: false
  end
end

class Node < ActiveRecord::Base
  has_and_belongs_to_many :dependencies,
                          class_name: 'Node',
                          join_table: 'node_dependencies',
                          foreign_key: 'node_id',
                          association_foreign_key: 'dependency_id'
end

def classify_serialization(error)
  return 'SERIALIZE_PASS' if error.nil?

  msg = error.message.downcase
  return 'SERIALIZE_FAIL_CYCLE' if msg.include?('cycle') || msg.include?('circular') || msg.include?('recursion')

  'SERIALIZE_FAIL_OTHER'
end

def smart_check(roots, expected_adj)
  stack = roots.dup
  visited = {}
  by_name = {}
  edges = 0

  until stack.empty?
    node = stack.pop
    oid = node.object_id
    next if visited[oid]

    visited[oid] = true

    prior = by_name[node.name]
    return [false, "id \"#{node.name}\" maps to multiple in-memory instances", by_name.length, visited.length, edges] if prior && !prior.equal?(node)

    by_name[node.name] = node
    actual = node.dependencies.map(&:name).to_set
    expected = (expected_adj[node.name] || []).to_set
    return [false, "dependency closure mismatch at \"#{node.name}\"", by_name.length, visited.length, edges] unless actual == expected

    node.dependencies.each do |dep|
      edges += 1
      stack << dep
    end
  end

  return [false, "reachable ids mismatch: got #{by_name.length}, expected #{expected_adj.length}", by_name.length, visited.length, edges] unless by_name.length == expected_adj.length

  [true, nil, by_name.length, visited.length, edges]
end

def run
  expected_adj = { 'a' => ['b'], 'b' => ['a'] }
  query_count = 0

  callback = lambda do |_name, _start, _finish, _id, payload|
    query_count += 1 unless payload[:name] == 'SCHEMA'
  end

  ActiveSupport::Notifications.subscribed(callback, 'sql.active_record') do
    a = Node.create!(name: 'a')
    b = Node.create!(name: 'b')
    a.dependencies << b
    b.dependencies << a

    roots = Node.includes(dependencies: :dependencies).where(name: %w[a b]).order(:name).to_a
    queries_after_hydration = query_count

    roots.each do |root|
      root.dependencies.each do |dep|
        dep.dependencies.length
      end
    end

    query_gate = if query_count == queries_after_hydration
                   { pass: true, reason: nil }
                 else
                   { pass: false, reason: "expected no additional queries during traversal, saw +#{query_count - queries_after_hydration}" }
                 end

    graph_ok, reason, unique_ids, unique_instances, edges = smart_check(roots, expected_adj)
    graph_check = {
      pass: graph_ok,
      reason: reason,
      uniqueIds: unique_ids,
      uniqueInstances: unique_instances,
      edgesTraversed: edges
    }

    hydration = query_gate[:pass] && graph_check[:pass] ? 'HYDRATION PASS' : 'HYDRATION FAIL'

    serialization_error = nil
    begin
      payload = {}
      payload['self'] = payload
      JSON.generate(payload)
    rescue StandardError => e
      serialization_error = e
    end

    serialization = classify_serialization(serialization_error)

    puts 'test_activerecord'
    puts "hydration: #{hydration}"
    puts "queryGate: #{query_gate}"
    puts "smartCheck: #{graph_check}"
    puts "serialization: #{serialization}"
  end
end

run
