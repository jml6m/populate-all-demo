import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import jakarta.persistence.*;
import org.hibernate.cfg.AvailableSettings;
import org.hibernate.cfg.Configuration;
import org.hibernate.resource.jdbc.spi.StatementInspector;

import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class Main {
  private static final AtomicInteger QUERY_COUNT = new AtomicInteger(0);
  private static final int RULE_WIDTH = 64;
  private static final String SCENARIO = "acyclic A->B->C | schema-driven full hydration (no query-time include paths)";
  private static final String STRATEGY = "select n from Node n where n.name='a' <- @ManyToMany(fetch=EAGER) (schema default)";

  public static void main(String[] args) throws Exception {
    var expectedAdj = Map.of("a", Set.of("b"), "b", Set.of("c"), "c", Set.<String>of());
    var findings = pendingFindings();
    Map<String, Object> metrics = null;
    String verdictReason = null;
    String proof = null;

    var configuration = new Configuration();
    configuration.setProperty(AvailableSettings.JAKARTA_JDBC_DRIVER, "org.h2.Driver");
    configuration.setProperty(AvailableSettings.JAKARTA_JDBC_URL, "jdbc:h2:mem:probe;DB_CLOSE_DELAY=-1");
    configuration.setProperty(AvailableSettings.HBM2DDL_AUTO, "create-drop");
    configuration.setProperty(AvailableSettings.SHOW_SQL, "false");
    configuration.setProperty(AvailableSettings.STATEMENT_INSPECTOR, QueryInspector.class.getName());
    configuration.addAnnotatedClass(Node.class);

    org.hibernate.SessionFactory sessionFactory = null;
    boolean setupOk = true;

    // ---- Setup (infrastructure — a failure here is an environment problem, not a research result) ----
    try {
      sessionFactory = configuration.buildSessionFactory();
      try (var session = sessionFactory.openSession()) {
        var tx = session.beginTransaction();
        var a = new Node("a");
        var b = new Node("b");
        var c = new Node("c");
        a.getDependencies().add(b);
        b.getDependencies().add(c);
        session.persist(a);
        session.persist(b);
        session.persist(c);
        tx.commit();
      }
    } catch (Exception setupError) {
      setupOk = false;
      var detail = errDetail(setupError);
      findings.hydration = mapOf("detail", "probe setup failed: " + detail, "result", "FAIL");
      verdictReason = "probe setup failed -- " + detail;
    }

    // ---- Stage 1: the operation under research — schema-driven fetch of root `a` ----
    if (setupOk) {
      List<Node> roots = null;
      try {
        try (var session = sessionFactory.openSession()) {
          roots = session.createQuery(
              "select n from Node n where n.name in (:names)",
              Node.class)
            .setParameter("names", List.of("a"))
            .getResultList();
        }
        findings.fetch = mapOf("detail", "Schema-driven fetch returned " + roots.size() + " root row(s).", "result", "OK");
      } catch (Exception fetchError) {
        var detail = errDetail(fetchError);
        findings.fetch = mapOf("detail", detail, "result", "ERROR");
        findings.hydration = mapOf("detail", "fetch did not return a graph", "result", "FAIL");
        markGatesNotRun(findings, "not reached -- the schema-driven fetch threw before returning a graph");
        verdictReason = "schema-driven fetch threw -- " + detail;
      }

      // ---- Stages 2-4: gates run only against a graph the fetch actually returned ----
      if (roots != null) {
        metrics = evaluateGraph(roots, findings, expectedAdj);
        // Proof: serialize the fetched graph so the admin can see it is fully wired a->b->c.
        if ("PASS".equals(findings.hydration.get("result"))) {
          try {
            proof = new ObjectMapper().writeValueAsString(roots);
          } catch (Exception ignored) {
            // best-effort; the serialize gate already recorded the authoritative result
          }
        }
      }
    }

    if (sessionFactory != null) {
      sessionFactory.close();
    }

    var result = new TreeMap<String, Object>();
    result.put("findings", findings.toMap());
    result.put("language", "java");
    result.put("library", "Hibernate");
    result.put("libraryVersion", hibernateVersionFromPom());
    result.put("outcome", buildOutcome(findings));
    result.put("probe", "hibernate");
    result.put("runtimeVersion", System.getProperty("java.version"));

    var outputPath = writeResult(result, "hibernate");

    printReport("hibernate", "Hibernate", hibernateVersionFromPom(), STRATEGY, findings, outputPath, metrics, verdictReason, proof);
  }

  private static Map<String, Object> evaluateGraph(List<Node> roots, Findings findings, Map<String, Set<String>> expectedAdj) {
    // queryGate: traversal must not trigger further SQL if hydration was complete.
    int queriesAfterHydration = QUERY_COUNT.get();
    for (var root : roots) {
      for (var dep : root.getDependencies()) {
        dep.getDependencies().size();
      }
    }
    int extraQueries = QUERY_COUNT.get() - queriesAfterHydration;
    if (extraQueries == 0) {
      findings.queryGate = mapOf("detail", "No additional queries observed during traversal.", "result", "PASS");
    } else {
      findings.queryGate = mapOf(
        "detail", "Expected 0 additional queries during traversal, observed " + extraQueries + ".",
        "extraQueries", extraQueries,
        "result", "FAIL"
      );
    }

    // smartCheck: identity + dependency-closure of the reachable graph.
    var graphCheck = smartCheck(roots, expectedAdj);
    if (Boolean.TRUE.equals(graphCheck.get("pass"))) {
      findings.smartCheck = mapOf("detail", "Identity and dependency closure checks passed.", "result", "PASS");
    } else {
      findings.smartCheck = mapOf("detail", graphCheck.get("reason"), "result", "FAIL");
    }

    // hydration rollup: full hydration = complete closure with no extra queries.
    if ("PASS".equals(findings.queryGate.get("result")) && "PASS".equals(findings.smartCheck.get("result"))) {
      findings.hydration = mapOf("detail", "Full hydration achieved from the root fetch (complete acyclic closure, no extra queries).", "result", "PASS");
    } else {
      findings.hydration = mapOf(
        "detail", "Full hydration not achieved: queryGate=" + findings.queryGate.get("result") + ", smartCheck=" + findings.smartCheck.get("result") + ".",
        "result", "FAIL"
      );
    }

    // serialize: independent of smartCheck; needs only a materialized graph.
    try {
      new ObjectMapper().writeValueAsString(roots);
      findings.serialize = mapOf("detail", "JSON serialization passed.", "result", "SERIALIZE_PASS");
    } catch (Exception e) {
      var msg = (e.getMessage() == null ? "" : e.getMessage()).toLowerCase(Locale.ROOT);
      var serialization = (msg.contains("cycle") || msg.contains("circular") || msg.contains("recursion"))
        ? "SERIALIZE_FAIL_CYCLE"
        : "SERIALIZE_FAIL_OTHER";
      findings.serialize = mapOf("detail", stackDetail(e), "result", serialization);
    }

    return mapOf(
      "reached", graphCheck.get("reached"),
      "expected", expectedAdj.size(),
      "edges", graphCheck.get("edges"),
      "extraQueries", extraQueries,
      "identityStable", !String.valueOf(graphCheck.get("reason")).contains("multiple in-memory instances")
    );
  }

  private static String rule(String label) {
    var prefix = "== " + label + " ";
    var fill = Math.max(0, RULE_WIDTH - prefix.length());
    return prefix + "=".repeat(fill);
  }

  private static String firstLine(Object detail) {
    var text = detail == null ? "" : String.valueOf(detail);
    var line = text.split("\\R", 2)[0].trim();
    return line.length() > 100 ? line.substring(0, 99) + "..." : line;
  }

  private static String[] deriveVerdict(Findings findings) {
    if ("PASS".equals(findings.hydration.get("result"))) {
      if ("SERIALIZE_PASS".equals(findings.serialize.get("result"))) {
        return new String[] { "ACYCLIC_PASS", "schema-driven full hydration + serialization succeeded" };
      }
      return new String[] { "ACYCLIC_PASS", "full hydration succeeded; serialization " + findings.serialize.get("result") };
    }

    // A staged probe marks downstream gates NOT_RUN and puts the real cause in hydration.detail.
    if ("NOT_RUN".equals(findings.smartCheck.get("result"))) {
      var reason = firstLine(findings.hydration.get("detail"));
      return new String[] { "ACYCLIC_FAIL", reason.isEmpty() ? "hydration did not complete" : reason };
    }
    if ("FAIL".equals(findings.smartCheck.get("result"))) {
      return new String[] { "ACYCLIC_FAIL", "smartCheck failed -- " + firstLine(findings.smartCheck.get("detail")) };
    }
    if ("FAIL".equals(findings.queryGate.get("result"))) {
      return new String[] { "ACYCLIC_FAIL", "topology resolved but queryGate failed -- " + firstLine(findings.queryGate.get("detail")) };
    }
    return new String[] { "ACYCLIC_FAIL", "hydration failed" };
  }

  private static String observedLine(Map<String, Object> metrics) {
    if (metrics == null) {
      return "observed : no graph hydrated -- traversal/identity/serialization gates were not run";
    }
    var parts = new ArrayList<String>();
    parts.add("reached " + metrics.get("reached") + "/" + metrics.get("expected") + " expected nodes from root [a]");
    parts.add(metrics.get("edges") + " edges");
    parts.add(Boolean.FALSE.equals(metrics.get("identityStable")) ? "identity BROKEN (duplicate instances)" : "identity stable");
    if (metrics.get("extraQueries") != null) {
      parts.add(metrics.get("extraQueries") + " extra queries");
    }
    return "observed : " + String.join("; ", parts);
  }

  private static void printReport(String probe, String library, String libraryVersion, String strategy,
      Findings findings, String jsonPath, Map<String, Object> metrics, String verdictReason, String proof) {
    var verdict = deriveVerdict(findings);
    var reason = verdictReason != null ? verdictReason : verdict[1];
    System.out.println();
    System.out.println(rule(probe + " | " + library + " v" + libraryVersion));
    System.out.println("scenario : " + SCENARIO);
    System.out.println("strategy : " + strategy);
    System.out.println(observedLine(metrics));
    if (findings.fetch != null) {
      System.out.println("  fetch      : " + String.format("%-7s", findings.fetch.get("result")) + "  " + firstLine(findings.fetch.get("detail")));
    }
    System.out.println("  hydration  : " + String.format("%-7s", findings.hydration.get("result")) + "  " + firstLine(findings.hydration.get("detail")));
    System.out.println("  queryGate  : " + String.format("%-7s", findings.queryGate.get("result")) + "  " + firstLine(findings.queryGate.get("detail")));
    System.out.println("  smartCheck : " + String.format("%-7s", findings.smartCheck.get("result")) + "  " + firstLine(findings.smartCheck.get("detail")));
    System.out.println("  serialize  : " + String.format("%-7s", findings.serialize.get("result")) + "  " + firstLine(findings.serialize.get("detail")));
    if (proof != null) {
      System.out.println("proof    : populated graph from the schema-driven fetch = " + proof);
    }
    System.out.println("VERDICT  : " + verdict[0] + " -- " + reason);
    System.out.println("json     : " + jsonPath);
  }

  // Keep this rollup logic in sync with supporting-probes/ts/result-builder.ts::buildOutcome.
  private static String buildOutcome(Findings findings) {
    if ("FAIL".equals(findings.hydration.get("result"))) {
      return "HYDRATION_FAIL";
    }

    var serializeResult = String.valueOf(findings.serialize.get("result"));
    if (serializeResult.startsWith("SERIALIZE_FAIL_")) {
      return "SERIALIZE_FAIL";
    }

    boolean allPassed =
      "PASS".equals(findings.hydration.get("result")) &&
      "PASS".equals(findings.queryGate.get("result")) &&
      "PASS".equals(findings.smartCheck.get("result")) &&
      "SERIALIZE_PASS".equals(findings.serialize.get("result"));

    return allPassed ? "PASS" : "MIXED";
  }

  private static Findings pendingFindings() {
    var findings = new Findings();
    var detail = "not run -- a prerequisite stage did not complete";
    findings.fetch = mapOf("detail", detail, "result", "NOT_RUN");
    findings.hydration = mapOf("detail", detail, "result", "FAIL");
    findings.queryGate = mapOf("detail", detail, "result", "NOT_RUN");
    findings.smartCheck = mapOf("detail", detail, "result", "NOT_RUN");
    findings.serialize = mapOf("detail", detail, "result", "SERIALIZE_NOT_RUN");
    return findings;
  }

  private static void markGatesNotRun(Findings findings, String reason) {
    findings.queryGate = mapOf("detail", reason, "result", "NOT_RUN");
    findings.smartCheck = mapOf("detail", reason, "result", "NOT_RUN");
    findings.serialize = mapOf("detail", reason, "result", "SERIALIZE_NOT_RUN");
  }

  private static String errDetail(Throwable error) {
    var message = error.getMessage() == null ? "" : error.getMessage();
    return error.getClass().getSimpleName() + ": " + message;
  }

  private static String hibernateVersionFromPom() {
    try {
      var pom = Files.readString(Path.of("pom.xml"), StandardCharsets.UTF_8);
      var pattern = Pattern.compile("<artifactId>hibernate-core</artifactId>\\s*<version>([^<]+)</version>", Pattern.MULTILINE);
      Matcher matcher = pattern.matcher(pom);
      if (matcher.find()) {
        return matcher.group(1).trim();
      }
    } catch (IOException ignored) {
      // fall through
    }
    return "unknown";
  }

  private static String writeResult(Map<String, Object> result, String probeName) throws IOException {
    var runId = System.getenv("PROBE_RUN_ID");
    if (runId == null || runId.isBlank()) {
      runId = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss-'nogit'")
        .format(ZonedDateTime.now(ZoneOffset.UTC));
    }

    var outputDir = Path.of("results", "local", runId);
    Files.createDirectories(outputDir);

    var outputPath = outputDir.resolve(probeName + ".json");
    var tmpPath = outputDir.resolve(probeName + ".json.tmp");

    var mapper = new ObjectMapper();
    mapper.enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);
    mapper.enable(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY);
    var payload = mapper.writerWithDefaultPrettyPrinter().writeValueAsString(result) + "\n";
    Files.writeString(tmpPath, payload, StandardCharsets.UTF_8);
    try {
      Files.move(tmpPath, outputPath, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    } catch (IOException ignored) {
      Files.move(tmpPath, outputPath, StandardCopyOption.REPLACE_EXISTING);
    }

    return outputPath.toString();
  }

  private static LinkedHashMap<String, Object> mapOf(Object... kv) {
    var map = new LinkedHashMap<String, Object>();
    for (int i = 0; i < kv.length; i += 2) {
      map.put(String.valueOf(kv[i]), kv[i + 1]);
    }
    return map;
  }

  private static String stackDetail(Throwable error) {
    var sw = new StringWriter();
    error.printStackTrace(new PrintWriter(sw));
    var lines = sw.toString().split("\\R");
    var maxLines = Math.min(lines.length, 13);
    var sb = new StringBuilder();
    for (int i = 0; i < maxLines; i++) {
      sb.append(lines[i]);
      if (i + 1 < maxLines) {
        sb.append(System.lineSeparator());
      }
    }
    return sb.toString();
  }

  private static Map<String, Object> smartCheck(List<Node> roots, Map<String, Set<String>> expectedAdj) {
    var stack = new ArrayDeque<>(roots);
    var visited = Collections.newSetFromMap(new IdentityHashMap<Node, Boolean>());
    var byName = new HashMap<String, Node>();
    int edges = 0;

    while (!stack.isEmpty()) {
      var node = stack.pop();
      if (!visited.add(node)) {
        continue;
      }

      var prior = byName.get(node.getName());
      if (prior != null && prior != node) {
        return mapOf("pass", false, "reason", "id \"" + node.getName() + "\" maps to multiple in-memory instances", "reached", byName.size(), "edges", edges);
      }

      byName.put(node.getName(), node);
      var actual = new HashSet<String>();
      for (var dep : node.getDependencies()) {
        actual.add(dep.getName());
      }
      var expected = expectedAdj.getOrDefault(node.getName(), Set.of());
      if (!actual.equals(expected)) {
        return mapOf("pass", false, "reason", "dependency closure mismatch at \"" + node.getName() + "\"", "reached", byName.size(), "edges", edges);
      }

      for (var dep : node.getDependencies()) {
        edges += 1;
        stack.push(dep);
      }
    }

    if (byName.size() != expectedAdj.size()) {
      return mapOf("pass", false, "reason", "reachable ids mismatch: got " + byName.size() + ", expected " + expectedAdj.size(), "reached", byName.size(), "edges", edges);
    }

    return mapOf("pass", true, "reason", null, "reached", byName.size(), "edges", edges);
  }

  public static class QueryInspector implements StatementInspector {
    @Override
    public String inspect(String sql) {
      QUERY_COUNT.incrementAndGet();
      return sql;
    }
  }

  @Entity(name = "Node")
  @Table(name = "nodes")
  public static class Node {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(unique = true, nullable = false)
    private String name;

    @ManyToMany(fetch = FetchType.EAGER)
    @JoinTable(name = "node_dependencies",
      joinColumns = @JoinColumn(name = "node_id"),
      inverseJoinColumns = @JoinColumn(name = "dependency_id"))
    private Set<Node> dependencies = new HashSet<>();

    @ManyToMany(mappedBy = "dependencies")
    private Set<Node> dependents = new HashSet<>();

    public Node() {}

    public Node(String name) {
      this.name = name;
    }

    public String getName() {
      return name;
    }

    public Set<Node> getDependencies() {
      return dependencies;
    }
  }

  private static final class Findings {
    private LinkedHashMap<String, Object> fetch;
    private LinkedHashMap<String, Object> hydration;
    private LinkedHashMap<String, Object> queryGate;
    private LinkedHashMap<String, Object> smartCheck;
    private LinkedHashMap<String, Object> serialize;

    private Map<String, Object> toMap() {
      var map = new TreeMap<String, Object>();
      map.put("fetch", fetch);
      map.put("hydration", hydration);
      map.put("queryGate", queryGate);
      map.put("serialize", serialize);
      map.put("smartCheck", smartCheck);
      return map;
    }
  }
}
