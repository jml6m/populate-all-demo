require 'active_record'
require 'active_support/notifications'
require 'json'
require 'set'
require 'fileutils'

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

# Keep this rollup logic in sync with supporting-probes/ts/result-builder.ts::buildOutcome.
def build_outcome(findings)
  return 'HYDRATION_FAIL' if findings[:hydration][:result] == 'FAIL'
  return 'SERIALIZE_FAIL' if findings[:serialize][:result].start_with?('SERIALIZE_FAIL_')

  all_passed = findings[:hydration][:result] == 'PASS' &&
               findings[:queryGate][:result] == 'PASS' &&
               findings[:smartCheck][:result] == 'PASS' &&
               findings[:serialize][:result] == 'SERIALIZE_PASS'
  all_passed ? 'PASS' : 'MIXED'
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

def write_result(result)
  run_id = ENV['PROBE_RUN_ID']&.strip
  if run_id.nil? || run_id.empty?
    run_id = Time.now.utc.strftime('%Y%m%d-%H%M%S-nogit')
    ENV['PROBE_RUN_ID'] = run_id
  end

  out_dir = File.join(Dir.pwd, 'results', 'local', run_id)
  FileUtils.mkdir_p(out_dir)
  out_path = File.join(out_dir, 'activerecord.json')
  tmp_path = "#{out_path}.tmp"

  sorted = deep_sort(result)
  File.write(tmp_path, JSON.pretty_generate(sorted) + "\n")
  File.rename(tmp_path, out_path)
  out_path
end

def deep_sort(value)
  case value
  when Hash
    value.keys.sort.each_with_object({}) do |key, acc|
      acc[key] = deep_sort(value[key])
    end
  when Array
    value.map { |item| deep_sort(item) }
  else
    value
  end
end

def run
  expected_adj = { 'a' => ['b'], 'b' => ['c'], 'c' => [] }
  query_count = 0

  findings = {
    hydration: { result: 'FAIL', detail: '' },
    queryGate: { result: 'FAIL', detail: '' },
    smartCheck: { result: 'FAIL', detail: '' },
    serialize: { result: 'SERIALIZE_FAIL_OTHER', detail: '' }
  }

  callback = lambda do |_name, _start, _finish, _id, payload|
    query_count += 1 unless payload[:name] == 'SCHEMA'
  end

  begin
    ActiveSupport::Notifications.subscribed(callback, 'sql.active_record') do
      a = Node.create!(name: 'a')
      b = Node.create!(name: 'b')
      c = Node.create!(name: 'c')
      a.dependencies << b
      b.dependencies << c

      roots = Node.where(name: %w[a]).order(:name).to_a
      queries_after_hydration = query_count

      roots.each do |root|
        root.dependencies.each do |dep|
          dep.dependencies.length
        end
      end

      extra_queries = query_count - queries_after_hydration
      findings[:queryGate] = if extra_queries.zero?
                               { result: 'PASS', detail: 'No additional queries observed during traversal.' }
                             else
                               { result: 'FAIL', extraQueries: extra_queries, detail: "Expected 0 additional queries during traversal, observed #{extra_queries}." }
                             end

      graph_ok, reason, = smart_check(roots, expected_adj)
      findings[:smartCheck] = if graph_ok
                                { result: 'PASS', detail: 'Identity and dependency closure checks passed.' }
                              else
                                { result: 'FAIL', detail: reason || 'Identity/closure check failed.' }
                              end

      findings[:hydration] = if findings[:queryGate][:result] == 'PASS' && findings[:smartCheck][:result] == 'PASS'
                               { result: 'PASS', detail: 'Hydration check passed.' }
                             else
                               { result: 'FAIL', detail: "Hydration failed: queryGate=#{findings[:queryGate][:result]}, smartCheck=#{findings[:smartCheck][:result]}." }
                             end

      serialization_error = nil
      begin
        project = nil
        project = lambda do |node|
          { name: node.name, dependencies: node.dependencies.map { |d| project.call(d) } }
        end
        JSON.generate(roots.map { |r| project.call(r) })
      rescue StandardError, SystemStackError => e
        serialization_error = e
      end

      serialization = classify_serialization(serialization_error)
      findings[:serialize] = if serialization == 'SERIALIZE_PASS'
                               { result: serialization, detail: 'JSON serialization passed.' }
                             else
                               { result: serialization, detail: serialization_error.full_message }
                             end
    end
  rescue StandardError, SystemStackError => e
    detail = e.full_message
    findings[:hydration] = { result: 'FAIL', detail: detail }
    findings[:queryGate] = { result: 'FAIL', detail: detail }
    findings[:smartCheck] = { result: 'FAIL', detail: detail }
    findings[:serialize] = { result: 'SERIALIZE_FAIL_OTHER', detail: detail }
  end

  result = {
    probe: 'activerecord',
    language: 'ruby',
    library: 'ActiveRecord',
    libraryVersion: ActiveRecord::VERSION::STRING,
    runtimeVersion: RUBY_VERSION,
    findings: findings
  }
  result[:outcome] = build_outcome(findings)

  output_path = write_result(result)

  puts 'test_activerecord'
  puts "hydration: #{findings[:hydration][:result] == 'PASS' ? 'HYDRATION PASS' : 'HYDRATION FAIL'}"
  puts "queryGate: #{findings[:queryGate]}"
  puts "smartCheck: #{findings[:smartCheck]}"
  puts "serialization: #{findings[:serialize][:result]}"
  puts "json: #{output_path}"
end

run
