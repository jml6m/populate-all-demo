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

RULE_WIDTH = 64
SCENARIO = 'acyclic A->B->C | schema-driven full hydration (no query-time include paths)'.freeze
STRATEGY = "Node.where(name:'a') <- has_and_belongs_to_many, no .includes (schema default, lazy)".freeze
EXPECTED_ADJ = { 'a' => ['b'], 'b' => ['c'], 'c' => [] }.freeze

def err_detail(error)
  "#{error.class}: #{error.message}"
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

def pending_findings
  detail = 'not run -- a prerequisite stage did not complete'
  {
    fetch: { result: 'NOT_RUN', detail: detail },
    hydration: { result: 'FAIL', detail: detail },
    queryGate: { result: 'NOT_RUN', detail: detail },
    smartCheck: { result: 'NOT_RUN', detail: detail },
    serialize: { result: 'SERIALIZE_NOT_RUN', detail: detail }
  }
end

def mark_gates_not_run(findings, reason)
  findings[:queryGate] = { result: 'NOT_RUN', detail: reason }
  findings[:smartCheck] = { result: 'NOT_RUN', detail: reason }
  findings[:serialize] = { result: 'SERIALIZE_NOT_RUN', detail: reason }
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

def rule_line(label)
  prefix = "== #{label} "
  prefix + ('=' * [0, RULE_WIDTH - prefix.length].max)
end

def first_line(detail)
  line = (detail || '').split("\n").first.to_s.strip
  line.length > 100 ? "#{line[0, 99]}..." : line
end

def derive_verdict(findings)
  if findings[:hydration][:result] == 'PASS'
    return ['ACYCLIC_PASS', 'schema-driven full hydration + serialization succeeded'] if findings[:serialize][:result] == 'SERIALIZE_PASS'

    return ['ACYCLIC_PASS', "full hydration succeeded; serialization #{findings[:serialize][:result]}"]
  end

  return ['ACYCLIC_FAIL', first_line(findings[:hydration][:detail]).empty? ? 'hydration did not complete' : first_line(findings[:hydration][:detail])] if findings[:smartCheck][:result] == 'NOT_RUN'
  return ['ACYCLIC_FAIL', "smartCheck failed -- #{first_line(findings[:smartCheck][:detail])}"] if findings[:smartCheck][:result] == 'FAIL'
  return ['ACYCLIC_FAIL', "topology resolved but not schema-driven (lazy N+1) -- #{first_line(findings[:queryGate][:detail])}"] if findings[:queryGate][:result] == 'FAIL'

  ['ACYCLIC_FAIL', 'hydration failed']
end

def observed_line(metrics)
  return 'observed : no graph hydrated -- traversal/identity/serialization gates were not run' unless metrics

  parts = ["reached #{metrics[:reached]}/#{metrics[:expected]} expected nodes from root [a]", "#{metrics[:edges]} edges"]
  parts << (metrics[:identityStable] == false ? 'identity BROKEN (duplicate instances)' : 'identity stable')
  parts << "#{metrics[:extraQueries]} extra queries" unless metrics[:extraQueries].nil?
  "observed : #{parts.join('; ')}"
end

def print_report(probe, library, library_version, strategy, findings, json_path, metrics, verdict_reason = nil)
  verdict, reason = derive_verdict(findings)
  reason = verdict_reason if verdict_reason
  puts
  puts rule_line("#{probe} | #{library} v#{library_version}")
  puts "scenario : #{SCENARIO}"
  puts "strategy : #{strategy}"
  puts observed_line(metrics)
  puts "  fetch      : #{findings[:fetch][:result].ljust(7)}  #{first_line(findings[:fetch][:detail])}" if findings[:fetch]
  puts "  hydration  : #{findings[:hydration][:result].ljust(7)}  #{first_line(findings[:hydration][:detail])}"
  puts "  queryGate  : #{findings[:queryGate][:result].ljust(7)}  #{first_line(findings[:queryGate][:detail])}"
  puts "  smartCheck : #{findings[:smartCheck][:result].ljust(7)}  #{first_line(findings[:smartCheck][:detail])}"
  puts "  serialize  : #{findings[:serialize][:result].ljust(7)}  #{first_line(findings[:serialize][:detail])}"
  puts "VERDICT  : #{verdict} -- #{reason}"
  puts "json     : #{json_path}"
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

def evaluate_graph(roots, findings)
  # queryGate: traversal must not trigger further SQL if hydration was complete.
  queries_after_hydration = yield
  roots.each do |root|
    root.dependencies.each do |dep|
      dep.dependencies.length
    end
  end
  extra_queries = yield - queries_after_hydration
  findings[:queryGate] = if extra_queries.zero?
                           { result: 'PASS', detail: 'No additional queries observed during traversal.' }
                         else
                           { result: 'FAIL', extraQueries: extra_queries, detail: "Expected 0 additional queries during traversal, observed #{extra_queries}." }
                         end

  # smartCheck: identity + dependency-closure of the reachable graph.
  graph_ok, reason, reached, _visited, edges = smart_check(roots, EXPECTED_ADJ)
  findings[:smartCheck] = if graph_ok
                            { result: 'PASS', detail: 'Identity and dependency closure checks passed.' }
                          else
                            { result: 'FAIL', detail: reason || 'Identity/closure check failed.' }
                          end

  # hydration rollup: full hydration = complete closure with no extra queries.
  findings[:hydration] = if findings[:queryGate][:result] == 'PASS' && findings[:smartCheck][:result] == 'PASS'
                           { result: 'PASS', detail: 'Full hydration achieved from the root fetch (complete acyclic closure, no extra queries).' }
                         else
                           { result: 'FAIL', detail: "Full hydration not achieved: queryGate=#{findings[:queryGate][:result]}, smartCheck=#{findings[:smartCheck][:result]}." }
                         end

  # serialize: independent of smartCheck; needs only a materialized graph.
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
                           { result: serialization, detail: err_detail(serialization_error) }
                         end

  {
    reached: reached,
    expected: EXPECTED_ADJ.length,
    edges: edges,
    extraQueries: extra_queries,
    identityStable: !(reason || '').include?('multiple in-memory instances')
  }
end

def run
  findings = pending_findings
  metrics = nil
  verdict_reason = nil
  query_count = 0

  callback = lambda do |_name, _start, _finish, _id, payload|
    query_count += 1 unless payload[:name] == 'SCHEMA'
  end

  ActiveSupport::Notifications.subscribed(callback, 'sql.active_record') do
    # ---- Setup (infrastructure — a failure here is an environment problem, not a research result) ----
    setup_ok = true
    begin
      a = Node.create!(name: 'a')
      b = Node.create!(name: 'b')
      c = Node.create!(name: 'c')
      a.dependencies << b
      b.dependencies << c
    rescue StandardError, SystemStackError => e
      setup_ok = false
      detail = err_detail(e)
      findings[:hydration] = { result: 'FAIL', detail: "probe setup failed: #{detail}" }
      verdict_reason = "probe setup failed -- #{detail}"
    end

    # ---- Stage 1: the operation under research — schema-driven fetch of root `a` ----
    if setup_ok
      roots = nil
      begin
        roots = Node.where(name: %w[a]).order(:name).to_a
        findings[:fetch] = { result: 'OK', detail: "Schema-driven fetch returned #{roots.length} root row(s)." }
      rescue StandardError, SystemStackError => e
        detail = err_detail(e)
        findings[:fetch] = { result: 'ERROR', detail: detail }
        findings[:hydration] = { result: 'FAIL', detail: 'fetch did not return a graph' }
        mark_gates_not_run(findings, 'not reached -- the schema-driven fetch threw before returning a graph')
        verdict_reason = "schema-driven fetch threw -- #{detail}"
      end

      # ---- Stages 2-4: gates run only against a graph the fetch actually returned ----
      metrics = evaluate_graph(roots, findings) { query_count } unless roots.nil?
    end
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

  print_report('activerecord', 'ActiveRecord', ActiveRecord::VERSION::STRING, STRATEGY, findings, output_path, metrics, verdict_reason)
end

run
